'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createLimiters } = require('../src/rate-limiters');

// A real Redis instance isn't available in this environment (no
// Docker/Redis in CI or local dev containers for this repo - see
// README "Hardening notes"), and the actual increment/expiry logic lives
// in rate-limit-redis's own Lua script, which is that package's job to
// test, not this one's. What's genuinely this repo's responsibility to
// verify is the wiring: that createLimiters() produces usable Express
// middleware, and specifically that passOnStoreError actually does what
// rate-limiters.js's comments say it does - a broken/unreachable Redis
// must not turn every request into a 500. That's directly testable with
// a fake client whose sendCommand always rejects.

function fakeRedisClient({ shouldFail } = { shouldFail: true }) {
  return {
    sendCommand: async () => {
      if (shouldFail) throw new Error('ECONNREFUSED (fake redis, always down for this test)');
      return 'OK';
    },
  };
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('createLimiters: returns all four limiters as usable Express middleware', () => {
  const limiters = createLimiters(fakeRedisClient());
  for (const name of ['authLimiter', 'uploadLimiter', 'webhookLimiter', 'generalLimiter']) {
    assert.equal(typeof limiters[name], 'function', `${name} should be a middleware function`);
    assert.equal(limiters[name].length, 3, `${name} should have (req, res, next) arity`);
  }
});

test('generalLimiter: fails OPEN when the Redis store errors (passOnStoreError) - request still succeeds', async () => {
  const { generalLimiter } = createLimiters(fakeRedisClient({ shouldFail: true }));
  const app = express();
  app.use(generalLimiter);
  app.get('/ping', (req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/ping`);
    assert.equal(res.status, 200, 'a Redis-store failure must not turn into a 500 or a block');
    const body = await res.json();
    assert.deepEqual(body, { ok: true });
  });
});

test('authLimiter: also fails open on a Redis store error, under the tighter auth limit config', async () => {
  const { authLimiter } = createLimiters(fakeRedisClient({ shouldFail: true }));
  const app = express();
  app.use(authLimiter);
  app.post('/auth/login', (req, res) => res.json({ token: 'fake' }));

  await withServer(app, async (base) => {
    // Several rapid requests - if passOnStoreError were false (or missing),
    // the *first* request would already 500 because the store itself
    // cannot be reached, well before any real rate limit is hit.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/auth/login`, { method: 'POST' });
      assert.equal(res.status, 200);
    }
  });
});

test('createLimiters: each limiter targets Redis through the given client, not a fresh connection', async () => {
  let calls = 0;
  const client = {
    sendCommand: async () => {
      calls += 1;
      throw new Error('fake redis down');
    },
  };
  const { generalLimiter } = createLimiters(client);
  const app = express();
  app.use(generalLimiter);
  app.get('/ping', (req, res) => res.json({ ok: true }));

  await withServer(app, async (base) => {
    await fetch(`${base}/ping`);
  });

  assert.ok(calls > 0, 'the limiter should have tried to use the injected client, proving it is wired to it and not some other store');
});
