'use strict';

const { rateLimit } = require('express-rate-limit');
// This package ships as { RedisStore, default: RedisStore } under CJS,
// not a bare `module.exports = RedisStore` - destructure explicitly
// rather than using `require('rate-limit-redis')` directly, which is an
// object, not a constructor, and fails with a confusing "is not a
// constructor" error the moment a limiter is actually created.
const { RedisStore } = require('rate-limit-redis');

// Builds the app's rate limiters, backed by Redis instead of each
// limiter's default in-memory Map. The API only ever runs as a single
// replica today (nothing in docker-compose.vps.yml sets `replicas > 1`),
// so the in-memory store happened to work - but it's a silent trap: the
// moment this service is scaled to N replicas, each one keeps its own
// separate count, so the *effective* limit becomes N times what's
// configured, with no error or warning anywhere to notice it by. A
// Redis-backed store makes the limit real regardless of how many
// replicas are running, which is what horizontal scaling actually needs.
//
// Takes the app's existing `redis` v4 client (already created and
// `.connect()`ed in server.js for the queue/session work) rather than
// opening a second connection just for this.
function createLimiters(redisClient) {
  const store = (prefix) => {
    const s = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix,
    });
    // RedisStore's constructor eagerly kicks off `SCRIPT LOAD` for its two
    // Lua scripts and stores the *unawaited* promises on
    // incrementScriptSha/getScriptSha (see loadIncrementScript() in
    // rate-limit-redis's source) - if Redis isn't reachable at that exact
    // instant (including at server boot, before redisClient.connect() has
    // resolved - see server.js), that promise rejects with nothing
    // consuming it yet, which Node treats as an unhandled rejection and,
    // depending on Node's unhandledRejection policy, can crash the whole
    // process. That would make Redis being briefly unready at boot fatal,
    // which is strictly worse than the in-memory store this replaces ever
    // was. Attaching a no-op .catch() here only marks the promise
    // "handled" for that detector - it does not consume it, so
    // rate-limit-redis's own later `await this.incrementScriptSha` (inside
    // retryableIncrement, reached per-request) still sees the same
    // rejection and is still what passOnStoreError catches.
    if (s.incrementScriptSha && typeof s.incrementScriptSha.catch === 'function') {
      s.incrementScriptSha.catch(() => {});
    }
    if (s.getScriptSha && typeof s.getScriptSha.catch === 'function') {
      s.getScriptSha.catch(() => {});
    }
    return s;
  };

  // Before this file existed, there was no store to fail at all - a
  // limiter never blocked traffic because Redis was unreachable, it just
  // didn't rate-limit. `passOnStoreError: true` keeps that same fallback:
  // if Redis is down or a call to it errors, the request is allowed
  // through (fails open) instead of every request 500ing (fail closed).
  // Losing rate limiting during a Redis outage is the same risk profile
  // this app already had before Redis was ever in the loop here; turning
  // a Redis blip into a full outage of the API would be strictly worse.
  const common = { standardHeaders: 'draft-8', legacyHeaders: false, passOnStoreError: true };

  const authLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    store: store('rl:auth:'),
    message: { error: 'Too many attempts, try again later' },
  });
  const uploadLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000, // 1 minute
    limit: 10,
    store: store('rl:upload:'),
    message: { error: 'Too many uploads, slow down' },
  });
  const webhookLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 120,
    store: store('rl:webhook:'),
    message: { error: 'Too many requests' },
  });
  const generalLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 300,
    store: store('rl:general:'),
    message: { error: 'Too many requests' },
  });

  return { authLimiter, uploadLimiter, webhookLimiter, generalLimiter };
}

module.exports = { createLimiters };
