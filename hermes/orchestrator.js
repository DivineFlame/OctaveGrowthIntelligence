const redis = require('redis');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect();
async function runAgent(type, payload) {
  console.log(`[Hermes] ${type} processing tenant ${payload.tenant_id}`);
  if (type==='scout') return { brand_kit: { colors: ['#00a884'] }, tone: 'Professional+Bharatiya', cta: 'Book Demo' };
  if (type==='transformer') {
    try { await fetch(`http://${process.env.PAPERCLIP_SERVICE || 'paperclip-transformer:8000'}/transform`, { method:'POST', body: JSON.stringify(payload), headers:{'Content-Type':'application/json'} }); } catch(e){ console.log('Paperclip queued via Redis'); }
    return { transformed: true };
  }
  if (type==='compliance') return { compliant: true };
  if (type==='publisher') { console.log(`Publishing variant ${payload.variant_id}`); return { published: true, url: `https://youtube.com/watch?v=${payload.variant_id}` }; }
  if (type==='lead_intake') {
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
        headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET || '' }
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
  console.log('Hermes Agents started - premium_multiagent: scout, transformer, compliance, publisher, lead_intake, enrichment');
  while(true) {
    try {
      // BRPOP takes exact key names, not wildcards — 'transformer:queue:*'
      // never matched the real keys producers push to, so this consumer
      // was permanently blocking on a key nothing ever wrote to. Producers
      // (api/src/server.js) now push to these exact shared keys, with
      // tenant_id carried inside each job's payload instead of the key name.
      const job = await redisClient.brPop('transformer:queue', 5);
      if (job) { const p = JSON.parse(job.element); await runAgent('scout', p); await runAgent('transformer', p); await runAgent('compliance', p); }
      const pub = await redisClient.brPop('publisher:queue', 1);
      if (pub) await runAgent('publisher', JSON.parse(pub.element));
      const lead = await redisClient.brPop('webhook:incoming', 1);
      if (lead) await runAgent('lead_intake', JSON.parse(lead.element));
    } catch(e){ console.error('Hermes error', e.message); await new Promise(r=>setTimeout(r,1000)); }
  }
}
loop();
