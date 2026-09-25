'use strict';
// Parses Vobiz's real inbound-WhatsApp webhook payload (see
// docs.vobiz.ai/whatsapp/webhooks/events) into a flat list of messages
// this app can turn into leads - the other half of channels.js's
// publishWhatsApp() (which only ever handled the OUTBOUND side; nothing
// in this codebase understood an inbound WhatsApp message at all before
// this, which is why messages sent to the lead's WhatsApp number never
// showed up in the Inbox no matter what was configured).
//
// Vobiz wraps Meta's own WhatsApp Cloud API webhook shape almost
// verbatim inside an envelope: { event_type, account_id, payload: { entry: [...] } }.
// Meta can (and routinely does) batch several messages - from different
// contacts, even different WABAs - into a single webhook delivery, so
// this walks every entry/change/message rather than assuming exactly
// one, and only ever returns type:"text" messages (image/audio/
// location/interactive/etc. aren't handled yet - skipped, not crashed
// on, so a mixed batch still yields whatever text messages it contains).
//
// Pure and side-effect-free on purpose (no DB, no network) so it can be
// unit tested directly against real-shaped fixture payloads, the same
// reasoning email-poller.js's cleanEmailText()/reconcileDeletedLeads()
// are kept pure.
function extractInboundWhatsAppMessages(body) {
  if (!body || typeof body !== 'object') return [];
  if (body.event_type !== 'message.inbound') return []; // message.status (delivery receipts) and call.* events have nothing to ingest
  const entries = (body.payload && body.payload.entry) || [];
  const out = [];

  for (const entry of entries) {
    const wabaId = entry.id || null;
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = (change && change.value) || {};
      const phoneNumberId = (value.metadata && value.metadata.phone_number_id) || null;

      const nameByWaId = new Map();
      for (const c of value.contacts || []) {
        if (c && c.wa_id) nameByWaId.set(c.wa_id, (c.profile && c.profile.name) || '');
      }

      for (const msg of value.messages || []) {
        if (!msg || msg.type !== 'text' || !msg.id || !msg.from) continue;
        out.push({
          wabaId,
          phoneNumberId,
          from: msg.from,
          contactName: nameByWaId.get(msg.from) || '',
          messageId: msg.id,
          text: (msg.text && msg.text.body) || '',
          timestamp: msg.timestamp || null
        });
      }
    }
  }

  return out;
}

module.exports = { extractInboundWhatsAppMessages };
