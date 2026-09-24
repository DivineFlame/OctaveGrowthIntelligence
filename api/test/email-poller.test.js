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

// Regression test for the real bug a live deployment hit: the same
// message coming back as a brand-new lead on every single poll, even
// though it was already ingested (a real Hostinger welcome email showed
// up 6+ times, ~10 minutes apart, matching the poll interval exactly).
// Root cause was passing a search-criteria object directly to fetch()'s
// range argument instead of search()-ing for UIDs first - this exercises
// pollProductMailbox()'s actual search/fetch/dedup/mark-seen logic
// end-to-end against a fake ImapFlow-shaped client (real mailparser still
// runs against a real raw-email string), so a regression here fails a
// test instead of only showing up against a live mailbox again.
const { pollProductMailbox } = require('../src/email-poller');

const RAW_EMAIL = [
  'From: "Hostinger" <team@email.hostinger.com>',
  'To: lead@example.com',
  'Subject: Welcome to Hostinger Email!',
  '',
  'Welcome to Hostinger Email!'
].join('\r\n');

// allUidsInMailbox defaults to uidsStillUnseen when not given - a test
// that only cares about the unseen/dedup behavior doesn't need to also
// think about the separate "does this UID still exist at all" query the
// deletion-reconcile pass makes; a test that specifically exercises
// reconciliation passes allUidsInMailbox explicitly.
function makeFakeImapClient({ uidsStillUnseen, allUidsInMailbox }) {
  const flaggedSeen = [];
  const allUids = allUidsInMailbox || uidsStillUnseen;
  return {
    on: () => {},
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    search: async (query) => (query && query.all ? allUids : uidsStillUnseen),
    fetch: async function* (uids) {
      for (const uid of uids) {
        yield { uid, source: Buffer.from(RAW_EMAIL) };
      }
    },
    messageFlagsAdd: async (uid) => { flaggedSeen.push(uid); },
    logout: async () => {},
    _flaggedSeen: flaggedSeen
  };
}

function makeFakeStore() {
  const leads = []; // { id, product_id, source_channel, source_uid }
  let nextId = 1;
  const pool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT id FROM leads WHERE product_id=$1 AND source_channel=\'email\' AND source_uid=$2')) {
        const [productId, sourceUid] = params;
        const hit = leads.find((l) => l.product_id === productId && l.source_uid === sourceUid);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (sql.includes('SELECT id, source_uid FROM leads WHERE product_id=$1')) {
        const [productId] = params;
        return { rows: leads.filter((l) => l.product_id === productId).map((l) => ({ id: l.id, source_uid: l.source_uid })) };
      }
      if (sql.trim().startsWith('DELETE FROM leads')) {
        const idx = leads.findIndex((l) => l.id === params[0]);
        if (idx >= 0) leads.splice(idx, 1);
        return { rows: [] };
      }
      throw new Error(`fake pool: unexpected query: ${sql}`);
    }
  };
  const ingestInboundLead = async ({ productId, sourceUid }) => {
    const id = `lead-${nextId++}`;
    leads.push({ id, product_id: productId, source_channel: 'email', source_uid: sourceUid });
    return { leadId: id, isDuplicate: false, isInquiry: null };
  };
  return { pool, ingestInboundLead, leads };
}

test('pollProductMailbox: the same still-unseen UID across two polls creates exactly one lead, not a duplicate', async () => {
  const { pool, ingestInboundLead, leads } = makeFakeStore();
  const product = { id: 'product-1', name: 'RamRaj Design House' };
  const config = { imap_host: 'imap.example.com', imap_user: 'u', imap_pass: 'p' };

  // First poll: message uid 42 is genuinely new.
  const fakeClient1 = makeFakeImapClient({ uidsStillUnseen: [42] });
  const first = await pollProductMailbox(pool, product, config, ingestInboundLead, { createClient: () => fakeClient1 });
  assert.equal(first.processed, 1);
  assert.equal(first.skippedAlready, 0);
  assert.equal(leads.length, 1, 'exactly one lead should exist after the first poll');
  assert.deepEqual(fakeClient1._flaggedSeen, [42]);

  // Second poll: server still reports uid 42 as unseen (the real-world
  // failure mode - the \\Seen flag from the first poll didn't stick).
  // This must NOT create a second lead for the same message.
  const fakeClient2 = makeFakeImapClient({ uidsStillUnseen: [42] });
  const second = await pollProductMailbox(pool, product, config, ingestInboundLead, { createClient: () => fakeClient2 });
  assert.equal(second.processed, 0, 'must not re-ingest an already-known message');
  assert.equal(second.skippedAlready, 1);
  assert.equal(leads.length, 1, 'still exactly one lead after a second poll that sees the same uid');
  assert.deepEqual(fakeClient2._flaggedSeen, [42], 'should re-attempt marking it seen so it eventually stops coming back');
});

test('pollProductMailbox: a genuinely new message on a later poll is ingested as its own lead', async () => {
  const { pool, ingestInboundLead, leads } = makeFakeStore();
  const product = { id: 'product-1', name: 'RamRaj Design House' };
  const config = { imap_host: 'imap.example.com', imap_user: 'u', imap_pass: 'p' };

  const fakeClient1 = makeFakeImapClient({ uidsStillUnseen: [42], allUidsInMailbox: [42] });
  await pollProductMailbox(pool, product, config, ingestInboundLead, { createClient: () => fakeClient1 });

  // A second, different message arrives - uid 43, alongside 42 which is
  // still in the mailbox (just no longer unseen - it was marked seen and
  // this poll's \\Seen did stick this time).
  const fakeClient2 = makeFakeImapClient({ uidsStillUnseen: [43], allUidsInMailbox: [42, 43] });
  const second = await pollProductMailbox(pool, product, config, ingestInboundLead, { createClient: () => fakeClient2 });
  assert.equal(second.processed, 1);
  assert.equal(second.skippedAlready, 0);
  assert.equal(leads.length, 2);
});

// Connection-retry behavior (added after a live deploy against a
// Cloudflare-fronted Hostinger mailbox showed every scheduled poll
// timing out while a manual one-off connection with identical
// credentials succeeded immediately - consistent with an intermittently
// bad edge node on the proxy in front of the real mail server, not the
// mailbox/credentials themselves being wrong). connectWithRetry() is not
// exported directly; exercised here through pollProductMailbox's
// deps.createClient/deps.retryDelayMs/deps.connectAttempts seams instead,
// the same way its search/fetch/dedup logic already is above.
function makeFailingThenWorkingClientFactory(failuresBeforeSuccess, workingClient) {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failuresBeforeSuccess) {
      return {
        on: () => {},
        connect: async () => { throw new Error(`simulated bad edge node (attempt ${calls})`); },
        close: () => {}
      };
    }
    return workingClient;
  };
}

test('pollProductMailbox retries a transient connect failure and succeeds on a later attempt', async () => {
  const { pool, ingestInboundLead, leads } = makeFakeStore();
  const product = { id: 'product-1', name: 'RamRaj Design House' };
  const config = { imap_host: 'imap.hostinger.com', imap_user: 'u', imap_pass: 'p' };

  const workingClient = makeFakeImapClient({ uidsStillUnseen: [42] });
  let factoryCalls = 0;
  const createClient = () => {
    factoryCalls++;
    return factoryCalls === 1
      ? { on: () => {}, connect: async () => { throw new Error('simulated bad edge node'); }, close: () => {} }
      : workingClient;
  };

  const result = await pollProductMailbox(pool, product, config, ingestInboundLead, {
    createClient,
    retryDelayMs: 0 // skip the real backoff wait - only the retry logic itself is under test
  });

  assert.equal(factoryCalls, 2, 'should have created a second client after the first connect() failed');
  assert.equal(result.processed, 1);
  assert.equal(leads.length, 1);
});

test('pollProductMailbox gives up and throws after exhausting all connect attempts', async () => {
  const { pool, ingestInboundLead } = makeFakeStore();
  const product = { id: 'product-1', name: 'RamRaj Design House' };
  const config = { imap_host: 'imap.hostinger.com', imap_user: 'u', imap_pass: 'p' };

  const createClient = makeFailingThenWorkingClientFactory(Infinity, null);

  await assert.rejects(
    () => pollProductMailbox(pool, product, config, ingestInboundLead, {
      createClient,
      retryDelayMs: 0,
      connectAttempts: 3
    }),
    /connect to imap\.hostinger\.com:993 failed after 3 attempts/
  );
});

// Regression test for the real root cause of the "poller hangs for ~20s
// on every real deploy, never reproduces in a one-off manual script"
// bug: pollProductMailbox() used to call messageFlagsAdd() (a STORE
// command) from inside the for-await loop still iterating fetch()'s
// result stream. ImapFlow's own docs call this out as a deadlock, not
// an error - IMAP does not allow overlapping commands - which is why it
// never surfaced as a thrown error, just silence until the client's own
// socketTimeout eventually killed the connection. The fix drains
// fetch() into an array first, then processes each message with plain
// sequential commands afterward. This fake client can't reproduce an
// actual protocol deadlock (it's not a real IMAP server), but it can
// prove the *call order* the fix depends on: every fetch-yielded
// message is fully collected before any messageFlagsAdd/STORE call is
// made, for every message, not just the first.
test('pollProductMailbox fully drains fetch() before issuing any messageFlagsAdd/STORE call', async () => {
  const { pool, ingestInboundLead, leads } = makeFakeStore();
  const product = { id: 'product-1', name: 'RamRaj Design House' };
  const config = { imap_host: 'imap.hostinger.com', imap_user: 'u', imap_pass: 'p' };

  const callOrder = [];
  const fakeClient = {
    on: () => {},
    connect: async () => {},
    getMailboxLock: async () => ({ release: () => {} }),
    search: async () => [1, 2, 3],
    fetch: async function* (uids) {
      for (const uid of uids) {
        callOrder.push(`yielded-${uid}`);
        yield { uid, source: Buffer.from(RAW_EMAIL) };
      }
    },
    messageFlagsAdd: async (uid) => {
      callOrder.push(`store-${uid}`);
    },
    logout: async () => {}
  };

  const result = await pollProductMailbox(pool, product, config, ingestInboundLead, { createClient: () => fakeClient });

  assert.equal(result.processed, 3);
  assert.equal(leads.length, 3);
  const lastYieldIndex = callOrder.lastIndexOf('yielded-3');
  const firstStoreIndex = callOrder.findIndex((entry) => entry.startsWith('store-'));
  assert.ok(
    firstStoreIndex > lastYieldIndex,
    `every fetch yield must happen before any STORE call - got order: ${callOrder.join(', ')}`
  );
});
