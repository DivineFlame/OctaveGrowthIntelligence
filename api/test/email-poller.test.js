// Unit tests for api/src/email-poller.js's two pieces that don't need a
// real IMAP connection: cleanEmailText() (pure function) and
// reconcileDeletedLeads() (takes an injected pool + a minimal
// ImapFlow-shaped client, same fake-injection pattern channels.test.js
// uses for encrypt/decrypt - no real Postgres or mailbox needed).
//
// Run with: npm test (from api/), or `node --test test/` directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanEmailText, reconcileDeletedLeads } = require('../src/email-poller');

test('cleanEmailText strips the zero-width/combining-mark padding real marketing templates use to hide preheader text', () => {
  // The exact pattern a real Hostinger "Welcome to Hostinger Email"
  // message surfaced this bug with: U+FEFF (zero-width no-break space)
  // and U+0350 (a combining mark with no base character) repeated as
  // invisible filler around real, visible copy.
  const junk = '﻿ ͐   ﻿ ͐  Welcome to Hostinger Email!  ﻿ ͐   ﻿ ͐';
  assert.equal(cleanEmailText(junk), 'Welcome to Hostinger Email!');
});

test('cleanEmailText collapses excess whitespace left behind by stripping, without eating real newlines', () => {
  const text = 'Hello\n\n\n\nWorld​​  -  see you soon';
  assert.equal(cleanEmailText(text), 'Hello\n\nWorld - see you soon');
});

test('cleanEmailText leaves ordinary plain text completely untouched', () => {
  const text = 'Hi, I would like a quote for 500 units. Thanks - Priya';
  assert.equal(cleanEmailText(text), text);
});

test('cleanEmailText handles empty/null/undefined input without throwing', () => {
  assert.equal(cleanEmailText(''), '');
  assert.equal(cleanEmailText(null), '');
  assert.equal(cleanEmailText(undefined), '');
});

test('reconcileDeletedLeads deletes leads whose source_uid is no longer in the mailbox, leaves the rest', async () => {
  const deletedIds = [];
  const fakePool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id, source_uid')) {
        return {
          rows: [
            { id: 'lead-1', source_uid: 100 },
            { id: 'lead-2', source_uid: 200 }, // will be "deleted" from the mailbox
            { id: 'lead-3', source_uid: 300 }
          ]
        };
      }
      if (sql.trim().startsWith('DELETE FROM leads')) {
        deletedIds.push(params[0]);
        return { rows: [] };
      }
      throw new Error(`unexpected query in test: ${sql}`);
    }
  };
  const fakeClient = { search: async () => [100, 300] }; // 200 is missing - deleted in the person's own mail client

  const result = await reconcileDeletedLeads(fakePool, { id: 'product-1' }, fakeClient);
  assert.equal(result.deleted, 1);
  assert.deepEqual(deletedIds, ['lead-2']);
});

test('reconcileDeletedLeads is a no-op (and never calls search) when this product has no known IMAP-sourced leads yet', async () => {
  let searchCalled = false;
  const fakePool = { query: async () => ({ rows: [] }) };
  const fakeClient = { search: async () => { searchCalled = true; return []; } };

  const result = await reconcileDeletedLeads(fakePool, { id: 'product-1' }, fakeClient);
  assert.equal(result.deleted, 0);
  assert.equal(searchCalled, false, 'should skip the mailbox round trip entirely when there is nothing to check');
});

test('reconcileDeletedLeads deletes nothing when every known source_uid is still present', async () => {
  const fakePool = {
    query: async (sql) => {
      if (sql.includes('SELECT id, source_uid')) {
        return { rows: [{ id: 'lead-1', source_uid: 100 }] };
      }
      throw new Error(`unexpected DELETE - nothing should be deleted: ${sql}`);
    }
  };
  const fakeClient = { search: async () => [100] };

  const result = await reconcileDeletedLeads(fakePool, { id: 'product-1' }, fakeClient);
  assert.equal(result.deleted, 0);
});
