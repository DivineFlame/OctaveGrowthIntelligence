const redis = require('redis');
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect();

// Heartbeat file for Docker's HEALTHCHECK (see Dockerfile) - this is a
// background worker with no HTTP server to poll, so `restart:
// unless-stopped` alone only catches an actual process crash, not a hang
// (e.g. stuck waiting on a Redis call that never resolves or rejects).
// Touched once per loop iteration below; the healthcheck fails once the
// file goes stale.
const HEARTBEAT_FILE = '/tmp/heartbeat';
function beat() { try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (e) {} }

// One real job left here - 'scout', 'transformer', 'compliance', and
// 'lead_intake' used to exist too. 'scout'/'transformer'/'compliance' only
// ever returned hardcoded canned data that nothing persisted anywhere (and
// 'transformer' raced with transformer-worker over the same
// `transformer:queue` Redis list - non-deterministic which container
// handled a given upload); real per-channel transformation now happens
// synchronously inside POST /content/:assetId/transform (api/src/server.js
// calls Paperclip directly and persists the real result). 'lead_intake'
// called an internal auto-run-agent route that no longer exists - the
// Agents feature (LLM connections, per-product enable/run) is removed
// from the UI/API for now, deferred to a future version (see README.md
// "Hardening notes"); nothing pushes to `webhook:incoming` any more either,
// since real-time lead enrichment (language/GSTIN detection, Sarvam
// inquiry classification) now happens synchronously inside
// handleInboundWebhook itself (api/src/server.js), not via this queue.
// Removed rather than left running idle/unreachable.
async function runAgent(type, payload) {
  console.log(`[Hermes] ${type} processing payload ${JSON.stringify(payload)}`);
  if (type === 'publisher') {
    // Calls api's internal publish route (server-to-server, shared-secret
    // auth - see internalMiddleware in api/src/server.js), which actually
    // posts through the configured channel integration
    // (api/src/channels.js) instead of faking success with a fabricated
    // YouTube URL. payload is { variant_id } - pushed by
    // POST /content/variants/:variantId/approve when a variant is approved.
    try {
      const resp = await fetch(`${process.env.API_INTERNAL_URL || 'http://api:3000'}/internal/content-variants/${payload.variant_id}/publish`, {
        method: 'POST',
        headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { console.log(`[Hermes] publisher ${payload.variant_id}: HTTP ${resp.status} - ${data.error || 'unknown error'}`); return { published: false, variant_id: payload.variant_id, error: data.error }; }
      console.log(`[Hermes] publisher ${payload.variant_id}: published to ${data.channel}${data.external_url ? ' - ' + data.external_url : ''}`);
      return { published: true, variant_id: payload.variant_id, url: data.external_url };
    } catch(e) {
      console.log(`[Hermes] publisher ${payload.variant_id}: could not reach api (${e.message})`);
      return { published: false, variant_id: payload.variant_id, error: e.message };
    }
  }
  return {};
}

// Graceful shutdown - a redeploy sends SIGTERM to every container, and
// without this the loop (and whatever runAgent() call is mid-flight) just
// gets cut off wherever it happens to be, every single time this service
// restarts - not only on a crash. BRPOP is a destructive pop with no ack,
// so a job already popped off the list when the process dies is gone; this
// doesn't fix that (a reliable queue would need BRPOPLPUSH + an ack step,
// a bigger change), but it does stop routine deploys from being a source
// of dropped jobs: the flag is checked at the top of each iteration, so a
// SIGTERM finishes whatever's already in flight (bounded by the two 1s
// BRPOP timeouts plus one runAgent() call, typically well under a couple
// of seconds) before exiting, instead of being killed mid-iteration.
let shuttingDown = false;
function shutdown(signal) {
  console.log(`[Hermes] received ${signal}, finishing current iteration then exiting...`);
  shuttingDown = true;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function loop() {
  console.log('Hermes Agents started - publisher');
  beat();
  while (!shuttingDown) {
    try {
      const pub = await redisClient.brPop('publisher:queue', 1);
      if (pub) await runAgent('publisher', JSON.parse(pub.element));
      beat();
    } catch(e){ console.error('Hermes error', e.message); await new Promise(r=>setTimeout(r,1000)); }
  }
  console.log('[Hermes] loop exited, closing connections');
  try { await redisClient.quit(); } catch (e) { console.error('Error closing redis client:', e.message); }
  try { await pool.end(); } catch (e) { console.error('Error closing pg pool:', e.message); }
  process.exit(0);
}
loop();
