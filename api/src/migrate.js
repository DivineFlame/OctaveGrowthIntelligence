// Applies postgres/migrate-*.sql against DATABASE_URL, in a fixed dependency
// order, every time the api container starts. Every migration file is
// written to be idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / DROP
// POLICY IF EXISTS before CREATE POLICY), so running all of them on every
// boot - even against a freshly-initialized database that already has
// everything via postgres/init-secure.sql - is a no-op, not a risk.
//
// This exists because applying these by hand (docker exec + psql) was the
// only way to pick up schema changes on an already-running deployment,
// which is easy to forget after a `git pull` + redeploy. Now it happens
// automatically, before the app starts serving traffic.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Order matters: later files reference tables/columns created earlier
// (agent-execution's agent_runs references products/agents from
// products-agents; force-rls's FORCE ROW LEVEL SECURITY on agent_runs
// requires agent-execution to have created it first; remove-multitenancy
// drops tenant_id/RLS/the tenants table entirely, so it has to run after
// every migration that still assumes multi-tenancy exists).
const MIGRATIONS_IN_ORDER = [
  'migrate-signup-flag.sql',
  'migrate-webhook-secret.sql',
  'migrate-user-disabled.sql',
  'migrate-2fa-secret.sql',
  'migrate-products-agents.sql',
  'migrate-agent-execution.sql',
  'migrate-channel-publish.sql',
  'migrate-force-rls.sql',
  'migrate-content-variants-indexes.sql',
  'migrate-gdpr-erasure.sql',
  'migrate-lead-inquiry-filter.sql',
  // Collapses multi-tenancy down to a single company (see README.md
  // "Hardening notes" and this file's own header comment) - runs last
  // since it depends on every table/column every earlier migration
  // created, and is itself idempotent (safe to run again on every boot).
  'migrate-remove-multitenancy.sql'
];

async function main() {
  const dir = process.env.MIGRATIONS_DIR || path.join(__dirname, '..', 'postgres');
  const connectionString = process.env.DATABASE_URL
    || `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@postgres:5432/${process.env.POSTGRES_DB}`;

  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  console.log('[migrate] connected, applying migrations from', dir);

  for (const file of MIGRATIONS_IN_ORDER) {
    const filePath = path.join(dir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`[migrate] SKIP ${file} (not found at ${filePath})`);
      continue;
    }
    const sql = fs.readFileSync(filePath, 'utf-8');
    try {
      await client.query(sql);
      console.log(`[migrate] OK   ${file}`);
    } catch (e) {
      console.error(`[migrate] FAIL ${file}:`, e.message);
      await client.end();
      // Fail closed: don't start the API against a database whose schema
      // migrations didn't apply cleanly - better a visible crash-loop in
      // the deploy logs than the app silently running against a stale or
      // half-migrated schema.
      process.exit(1);
    }
  }

  await client.end();
  console.log('[migrate] done');
}

main().catch((e) => {
  console.error('[migrate] unexpected error:', e);
  process.exit(1);
});
