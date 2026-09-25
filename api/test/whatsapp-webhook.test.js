// Unit tests for api/src/whatsapp-webhook.js's extractInboundWhatsAppMessages -
// pure function, no DB/network, tested against real-shaped Vobiz webhook
// payloads (per docs.vobiz.ai/whatsapp/webhooks/events).
//
// Run with: npm test (from api/), or `node --test test/` directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractInboundWhatsAppMessages } = require('../src/whatsapp-webhook');

function makeInboundPayload({ wabaId = 'waba-1', phoneNumberId = 'pnid-1', from = '918888888888', name = 'Asha', messageId = 'wamid.ABC123', text = 'Hi, is my order shipped?', timestamp = '1711360800' } = {}) {
  return {
    event_id: 'evt-1',
    event_type: 'message.inbound',
    account_id: 'MA_TEST',
    occurred_at: '2026-03-25T10:00:00Z',
    payload: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '919876543210', phone_number_id: phoneNumberId },
                contacts: [{ wa_id: from, profile: { name } }],
                messages: [{ from, id: messageId, timestamp, type: 'text', text: { body: text } }]
              }
            }
          ]
        }
      ]
    }
  };
}

test('extractInboundWhatsAppMessages parses a real-shaped single inbound text message', () => {
  const messages = extractInboundWhatsAppMessages(makeInboundPayload());
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    wabaId: 'waba-1',
    phoneNumberId: 'pnid-1',
    from: '918888888888',
    contactName: 'Asha',
    messageId: 'wamid.ABC123',
    text: 'Hi, is my order shipped?',
    timestamp: '1711360800'
  });
});

test('extractInboundWhatsAppMessages returns nothing for a message.status delivery receipt', () => {
  const statusEvent = { event_type: 'message.status', account_id: 'MA_TEST', payload: { status: 'delivered' } };
  assert.deepEqual(extractInboundWhatsAppMessages(statusEvent), []);
});

test('extractInboundWhatsAppMessages returns nothing for a call.* event', () => {
  const callEvent = { event_type: 'call.connect', account_id: 'MA_TEST', payload: {} };
  assert.deepEqual(extractInboundWhatsAppMessages(callEvent), []);
});

test('extractInboundWhatsAppMessages handles null/undefined/empty input without throwing', () => {
  assert.deepEqual(extractInboundWhatsAppMessages(null), []);
  assert.deepEqual(extractInboundWhatsAppMessages(undefined), []);
  assert.deepEqual(extractInboundWhatsAppMessages({}), []);
});

test('extractInboundWhatsAppMessages skips a non-text message (image/interactive/etc.) instead of crashing', () => {
  const payload = makeInboundPayload();
  payload.payload.entry[0].changes[0].value.messages = [
    { from: '918888888888', id: 'wamid.IMG1', timestamp: '1711360800', type: 'image', image: { id: 'media-1' } }
  ];
  assert.deepEqual(extractInboundWhatsAppMessages(payload), []);
});

test('extractInboundWhatsAppMessages walks every entry/change/message when Meta batches several into one delivery', () => {
  const payload = makeInboundPayload({ from: '918888888888', messageId: 'wamid.ONE', text: 'First' });
  // A second entry - a different WABA entirely - batched into the same webhook delivery.
  payload.payload.entry.push({
    id: 'waba-2',
    changes: [
      {
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: 'pnid-2' },
          contacts: [{ wa_id: '917777777777', profile: { name: 'Rohit' } }],
          messages: [{ from: '917777777777', id: 'wamid.TWO', timestamp: '1711360900', type: 'text', text: { body: 'Second' } }]
        }
      }
    ]
  });
  const messages = extractInboundWhatsAppMessages(payload);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].wabaId, 'waba-1');
  assert.equal(messages[0].text, 'First');
  assert.equal(messages[1].wabaId, 'waba-2');
  assert.equal(messages[1].text, 'Second');
});

test('extractInboundWhatsAppMessages falls back to an empty contact name when no matching contact profile is present', () => {
  const payload = makeInboundPayload();
  payload.payload.entry[0].changes[0].value.contacts = [];
  const messages = extractInboundWhatsAppMessages(payload);
  assert.equal(messages[0].contactName, '');
});

test('extractInboundWhatsAppMessages skips a malformed message missing an id or from', () => {
  const payload = makeInboundPayload();
  payload.payload.entry[0].changes[0].value.messages.push({ type: 'text', text: { body: 'no id or from' } });
  const messages = extractInboundWhatsAppMessages(payload);
  assert.equal(messages.length, 1, 'the malformed second message must be skipped, not crash or get ingested with missing fields');
});
