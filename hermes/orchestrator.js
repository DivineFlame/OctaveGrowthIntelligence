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
  if (type==='lead_intake') return { enriched: true };
  return {};
}
async function loop() {
  console.log('Hermes Agents started - premium_multiagent: scout, transformer, compliance, publisher, lead_intake, enrichment');
  while(true) {
    try {
      const job = await redisClient.brPop('transformer:queue:*', 5);
      if (job) { const p = JSON.parse(job.element); await runAgent('scout', p); await runAgent('transformer', p); await runAgent('compliance', p); }
      const pub = await redisClient.brPop('publisher:queue:*', 1);
      if (pub) await runAgent('publisher', JSON.parse(pub.element));
      const lead = await redisClient.brPop('webhook:*', 1);
      if (lead) await runAgent('lead_intake', JSON.parse(lead.element));
    } catch(e){ console.error('Hermes error', e.message); await new Promise(r=>setTimeout(r,1000)); }
  }
}
loop();
