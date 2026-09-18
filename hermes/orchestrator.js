const redis = require('redis');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect();

// Two real jobs left here - 'scout', 'transformer' and 'compliance' used to
// exist as agent types too, but they only ever returned hardcoded canned
// data ({ brand_kit: { colors: ['#00a884'] }, ... } / { compliant: true })
// that nothing persisted anywhere, and 'transformer' raced with
// transformer-worker over the exact same `transformer:queue` Redis list -
// both containers' BRPOP would compete for the same jobs, so which one
// actually handled a given upload was non-deterministic. Real per-channel
// transformation now happens synchronously inside POST
// /content/:assetId/transform (api/src/server.js calls Paperclip directly
// and persists the real result) - nothing pushes to `transformer:queue`
// any more, so there's nothing left here to consume it for. Removed
// rather than left running idle.
async function runAgent(type, payload) {
  console.log(`[Hermes] ${type} processing tenant ${payload.tenant_id}`);
  if (type === 'publisher') {
    // Calls api's internal publish route (server-to-server, shared-secret
    // auth - see internalMiddleware in api/src/server.js), which actually
    // posts through the configured channel integration
    // (api/src/channels.js) instead of faking success with a fabricated
    // YouTube URL. payload is { variant_id, tenant_id } - pushed by
    // POST /content/variants/:variantId/approve when a variant is approved.
    try {
      const resp = await fetch(`${process.env.API_INTERNAL_URL || 'http://api:3000'}/internal/content-variants/${payload.variant_id}/publish`, {
        method: 'POST',
        headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: payload.tenant_id })
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
  if (type === 'lead_intake') {
    // The webhook route (api/src/server.js: /webhooks/:tenantId/:webhookSecret/:channel)
    // already validates the tenant, dedupes, and INSERTs the lead synchronously
    // before this job is even queued — payload here is just { lead_id, tenant_id, channel }.
    // This calls api's internal auto-run-agent route (server-to-server, shared-secret
    // auth - see internalMiddleware in api/src/server.js) which actually runs a real
    // LLM call through the tenant's Premium agent when exactly one product
    // unambiguously matches the channel; otherwise it reports back why it didn't.
    try {
      const resp = await fetch(`${process.env.API_INTERNAL_URL || 'http://api:3000'}/internal/leads/${payload.lead_id}/auto-run-agent`, {
        method: 'POST',
        headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: payload.tenant_id })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { console.log(`[Hermes] lead_intake ${payload.lead_id}: auto-run-agent HTTP ${resp.status} - ${data.error || 'unknown error'}`); return { enriched: false, lead_id: payload.lead_id }; }
      console.log(`[Hermes] lead_intake ${payload.lead_id}: ${data.ran ? `agent ran (run ${data.run_id}, status ${data.status})` : `not run - ${data.reason}`}`);
      return { enriched: !!data.ran, lead_id: payload.lead_id };
    } catch(e) {
      console.log(`[Hermes] lead_intake ${payload.lead_id}: could not reach api for auto-run-agent (${e.message})`);
      return { enriched: false, lead_id: payload.lead_id };
    }
  }
  return {};
}

async function loop() {
  console.log('Hermes Agents started - publisher, lead_intake');
  while (true) {
    try {
      const pub = await redisClient.brPop('publisher:queue', 1);
      if (pub) await runAgent('publisher', JSON.parse(pub.element));
      const lead = await redisClient.brPop('webhook:incoming', 1);
      if (lead) await runAgent('lead_intake', JSON.parse(lead.element));
    } catch(e){ console.error('Hermes error', e.message); await new Promise(r=>setTimeout(r,1000)); }
  }
}
loop();
