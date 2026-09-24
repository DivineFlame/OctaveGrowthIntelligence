'use strict';
// Real IMAP polling for the Email channel's inbound side. Configuring
// Email previously only set up outbound SMTP (see channels.js's
// publishEmail) - there was no code anywhere that turned a reply into a
// lead. This is the other half: for every product's Email channel that
// has imap_host/imap_user/imap_pass set (see channels.js CHANNEL_SPECS -
// these are optional, a send-only channel is left alone), log into that
// mailbox over IMAP, pull down unseen messages, and turn each one into a
// lead + inbound lead_message via the same ingestInboundLead() path every
// other channel's webhook already uses (same dedup, GSTIN/language
// detection, Sarvam classification, audit log) - an email lead looks and
// behaves exactly like a WhatsApp/Facebook one, not a second-class
// citizen bolted on separately.
//
// A message is only marked \Seen AFTER it's successfully turned into a
// lead - if ingestInboundLead throws (a transient DB error, say), the
// message stays unread and gets retried on the next poll instead of being
// silently dropped. The real limitation worth knowing: IMAP's "unread"
// flag is shared mailbox state, not something this app owns - if a human
// reads the message in their own mail client before the next poll runs,
// it's invisible to this poller from then on. Use a dedicated mailbox for
// lead intake if you can (documented in the channel's help text and
// README.md), not a personal inbox someone else also reads.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Polls one product's mailbox. Never throws for a single bad message
// (logged and skipped, loop continues) - only a connection-level failure
// (bad host/credentials, network down) propagates, so the caller can log
// it against that one product without losing the others.
async function pollProductMailbox(product, config, ingestInboundLead) {
  const host = (config.imap_host || '').trim();
  const user = (config.imap_user || '').trim();
  const pass = config.imap_pass || '';
  if (!host || !user || !pass) return { skipped: true, processed: 0, failed: 0 };

  const client = new ImapFlow({
    host,
    port: Number(config.imap_port) || 993,
    secure: String(config.imap_secure || 'true') !== 'false',
    auth: { user, pass },
    logger: false
  });
  // ImapFlow emits an 'error' event on things like an unexpected
  // disconnect mid-poll - without a listener, that's an unhandled event
  // that can crash the whole api process, not just this one poll. A
  // single misconfigured/unreachable mailbox must never take api down.
  client.on('error', (err) => {
    console.warn(`[email-poller] product ${product.id}: IMAP connection error: ${err.message}`);
  });

  let processed = 0, failed = 0;
  await client.connect();
  try {
    const mailbox = (config.imap_mailbox || 'INBOX').trim() || 'INBOX';
    const lock = await client.getMailboxLock(mailbox);
    try {
      for await (const msg of client.fetch({ seen: false }, { uid: true, envelope: true, source: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
          const body = String(parsed.text || parsed.subject || '').slice(0, 5000);
          await ingestInboundLead(
            {
              channel: 'email',
              companyName: '',
              contactName: from.name || from.address || 'Email lead',
              phone: '',
              email: (from.address || '').toLowerCase(),
              message: body,
              productId: product.id
            },
            { ip: 'internal-imap-poll', headers: {} }
          );
          await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          processed++;
        } catch (e) {
          failed++;
          console.warn(`[email-poller] product ${product.id}: failed to ingest message uid=${msg.uid}: ${e.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { skipped: false, processed, failed };
}

// Polls every product's Email channel that has IMAP fields configured.
// A single mailbox failing to connect (bad credentials, host unreachable)
// is logged and skipped, never allowed to stop the rest from being
// polled - this is a background job, not a request a caller is waiting
// synchronously on.
async function pollAllEmailChannels(pool, { decryptSecret, ingestInboundLead, channelsLib }) {
  const { rows } = await pool.query(
    `SELECT pc.product_id, pc.config, p.name FROM product_channels pc
     JOIN products p ON p.id = pc.product_id
     WHERE pc.channel='email' AND pc.status='configured'`
  );
  let mailboxesPolled = 0, totalProcessed = 0, totalFailed = 0;
  for (const row of rows) {
    let config;
    try {
      config = channelsLib.decryptChannelSecrets('email', row.config, decryptSecret);
    } catch (e) {
      console.warn(`[email-poller] product ${row.product_id}: could not decrypt channel config: ${e.message}`);
      continue;
    }
    if (!config.imap_host) continue; // send-only email channel - nothing to poll, not a misconfiguration
    try {
      const result = await pollProductMailbox({ id: row.product_id, name: row.name }, config, ingestInboundLead);
      if (!result.skipped) {
        mailboxesPolled++;
        totalProcessed += result.processed;
        totalFailed += result.failed;
      }
    } catch (e) {
      console.warn(`[email-poller] product ${row.product_id} (${row.name}): IMAP poll failed: ${e.message}`);
    }
  }
  return { mailboxesPolled, totalProcessed, totalFailed };
}

module.exports = { pollAllEmailChannels, pollProductMailbox };
