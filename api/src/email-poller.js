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
//
// Every ingested lead records the IMAP UID it came from (leads.source_uid
// - see migrate-email-source-uid.sql) - each poll also reconciles that
// against what's still actually in the mailbox, and deletes a lead whose
// source email was deleted (in the person's own mail client, not through
// this app) rather than leaving it around forever pointing at a message
// that no longer exists.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

// Strips the invisible-character padding some marketing/transactional
// email templates use to control their inbox preview snippet (a real one
// - Hostinger's "Welcome to Hostinger Email" - is what surfaced this:
// repeated zero-width space + combining-mark sequences that render as
// nothing in an email client but come through as visible junk once
// pulled out as plain text). Applied regardless of source (parsed.text,
// or mailparser's own html-to-text fallback when there's no text/plain
// part), then whitespace left behind by stripping them is collapsed.
function cleanEmailText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[​-‍﻿­]/g, '') // zero-width space/joiner/non-breaking space, soft hyphen
    .replace(/[̀-ͯ]/g, '') // combining marks left with no visible base char after the strip above
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Deletes any lead this poller previously created from `product`'s
// mailbox whose source message no longer exists in it. UID SEARCH ALL
// returns just the UID numbers (not full messages), so this stays cheap
// even against a mailbox with thousands of messages. Must run against the
// same mailbox that was actually polled - the caller holds that lock open
// across both this and the ingest loop below.
async function reconcileDeletedLeads(pool, product, client) {
  const { rows: known } = await pool.query(
    `SELECT id, source_uid FROM leads WHERE product_id=$1 AND source_channel='email' AND source_uid IS NOT NULL`,
    [product.id]
  );
  if (!known.length) return { deleted: 0 };

  const existingUids = new Set((await client.search({ all: true }, { uid: true })) || []);
  let deleted = 0;
  for (const row of known) {
    if (existingUids.has(Number(row.source_uid))) continue;
    // ON DELETE CASCADE on lead_messages.lead_id removes its messages too
    // (see postgres/init-secure.sql). audit_logs.resource_id has no FK to
    // leads, so the fact this lead once existed stays in the audit trail
    // even after the row itself is gone.
    await pool.query('DELETE FROM leads WHERE id=$1', [row.id]);
    deleted++;
  }
  return { deleted };
}

// A single failed connect() to a Cloudflare-fronted mail host (Hostinger's
// imap.hostinger.com resolves behind Cloudflare, confirmed via a manual
// connection landing on a 172.65.x.x address) can be a bad edge node on
// that one attempt rather than the mailbox actually being unreachable -
// a fresh DNS lookup + connection on the next try often lands on a
// healthy edge. Retries up to 3 times total with a short backoff before
// giving up and letting the caller log/skip this product for this poll
// cycle. Each attempt gets its own fresh client (a client whose connect()
// failed is not reused - ImapFlow's own internal timers/state for that
// attempt are already torn down) and its own 'error' listener, so an
// unhandled event from an earlier failed attempt can never crash the
// process once a later attempt succeeds.
async function connectWithRetry(createClient, clientOpts, target, product, attempts = 3, retryDelayMs = 2000) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = createClient(clientOpts);
    client.on('error', (err) => {
      console.warn(`[email-poller] product ${product.id}: IMAP connection error (${target}), attempt ${attempt}/${attempts}: ${err.message}`);
    });
    try {
      await client.connect();
      return client;
    } catch (e) {
      lastErr = e;
      try { client.close(); } catch (_) { /* best effort */ }
      if (attempt < attempts) {
        console.warn(`[email-poller] product ${product.id}: connect attempt ${attempt}/${attempts} to ${target} failed (${e.message}), retrying...`);
        // retryDelayMs is a test-only seam (deps.retryDelayMs below) so
        // regression tests can exercise multi-attempt retry/give-up
        // behavior without actually waiting through the real backoff.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }
  throw new Error(`connect to ${target} failed after ${attempts} attempts: ${lastErr.message}`);
}

// Polls one product's mailbox. Never throws for a single bad message
// (logged and skipped, loop continues) - only a connection-level failure
// (bad host/credentials, network down) propagates, so the caller can log
// it against that one product without losing the others.
// `deps.createClient` is an injection seam for tests only (defaults to
// the real ImapFlow constructor) - lets a test exercise this function's
// actual search/fetch/dedup/mark-seen logic end to end against a fake
// mailbox, without a real IMAP server. Production code never passes it.
async function pollProductMailbox(pool, product, config, ingestInboundLead, deps = {}) {
  const host = (config.imap_host || '').trim();
  const user = (config.imap_user || '').trim();
  const pass = config.imap_pass || '';
  if (!host || !user || !pass) return { skipped: true, processed: 0, failed: 0, deleted: 0 };

  const port = Number(config.imap_port) || 993;
  const target = `${host}:${port}`;
  const createClient = deps.createClient || ((opts) => new ImapFlow(opts));
  const clientOpts = {
    host,
    port,
    secure: String(config.imap_secure || 'true') !== 'false',
    auth: { user, pass },
    logger: false,
    // ImapFlow's own default (5 minutes) is generous enough for a slow
    // server, but leaves a poll silently hanging for most of its own
    // interval when the mailbox is actually unreachable (wrong host,
    // network/firewall blocking the port, provider-side throttling).
    // Failing faster means one bad mailbox loses ~20s per poll instead
    // of stalling near the full cycle, and the timeout error below is
    // what actually distinguishes "unreachable" from "slow" in the logs.
    socketTimeout: 20000,
    greetingTimeout: 20000
  };

  let processed = 0, failed = 0, skippedAlready = 0, deletedCount = 0;
  const client = await connectWithRetry(createClient, clientOpts, target, product, deps.connectAttempts || 3, deps.retryDelayMs != null ? deps.retryDelayMs : 2000);
  try {
    const mailbox = (config.imap_mailbox || 'INBOX').trim() || 'INBOX';
    const lock = await client.getMailboxLock(mailbox);
    try {
      // search() first, then fetch() the specific UIDs it returns -
      // passing a search-criteria object straight to fetch()'s range
      // argument is what caused the real bug this fixes (the same
      // message coming back as a fresh lead on every poll, seen or not):
      // fetch()'s range must be an explicit UID/sequence range or array,
      // not a query object, so it was not actually limiting to unseen
      // messages the way it looked like it should.
      const uids = await client.search({ seen: false }, { uid: true });
      if (uids && uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true }, { uid: true })) {
          try {
            // Belt-and-suspenders against the same failure mode from the
            // other direction: if this exact message was already turned
            // into a lead on an earlier poll (its \Seen flag didn't
            // stick for whatever reason - some IMAP servers/proxies are
            // unreliable about persisting it), don't create a second
            // lead for it. Just re-mark it seen and move on, so it stops
            // showing up as "new" on every future poll too.
            const already = await pool.query(
              `SELECT id FROM leads WHERE product_id=$1 AND source_channel='email' AND source_uid=$2 LIMIT 1`,
              [product.id, msg.uid]
            );
            if (already.rows.length) {
              await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true }).catch(() => {});
              skippedAlready++;
              continue;
            }

            const parsed = await simpleParser(msg.source);
            const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
            const body = cleanEmailText(parsed.text || parsed.subject || '').slice(0, 5000);
            await ingestInboundLead(
              {
                channel: 'email',
                companyName: '',
                contactName: from.name || from.address || 'Email lead',
                phone: '',
                email: (from.address || '').toLowerCase(),
                message: body,
                productId: product.id,
                sourceUid: msg.uid
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
      }

      try {
        const result = await reconcileDeletedLeads(pool, product, client);
        deletedCount = result.deleted;
      } catch (e) {
        console.warn(`[email-poller] product ${product.id}: reconcile-deleted pass failed: ${e.message}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { skipped: false, processed, failed, skippedAlready, deleted: deletedCount };
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
  let mailboxesPolled = 0, totalProcessed = 0, totalFailed = 0, totalSkippedAlready = 0, totalDeleted = 0;
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
      const result = await pollProductMailbox(pool, { id: row.product_id, name: row.name }, config, ingestInboundLead);
      if (!result.skipped) {
        mailboxesPolled++;
        totalProcessed += result.processed;
        totalFailed += result.failed;
        totalSkippedAlready += result.skippedAlready || 0;
        totalDeleted += result.deleted;
      }
    } catch (e) {
      console.warn(`[email-poller] product ${row.product_id} (${row.name}): IMAP poll failed: ${e.message}`);
    }
  }
  return { mailboxesPolled, totalProcessed, totalFailed, totalSkippedAlready, totalDeleted };
}

module.exports = { pollAllEmailChannels, pollProductMailbox, cleanEmailText, reconcileDeletedLeads };
