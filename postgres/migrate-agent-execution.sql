-- Adds real agent execution to existing databases (fresh deploys already
-- get this via init-secure.sql). Idempotent - safe to re-run.
--
-- The RLS/tenant_isolation part below only applies to a database that
-- still has a `tenant_id` column on agent_runs (a pre-existing
-- multi-tenant database not yet migrated) - a fresh single-company install
-- creates agent_runs with no tenant_id at all (see init-secure.sql and
-- README.md "Hardening notes" on removing multi-tenancy), and
-- migrate-remove-multitenancy.sql (which runs after this file - see
-- api/src/migrate.js's MIGRATIONS_IN_ORDER) is what actually drops that
-- column and its RLS policy on a database being upgraded. Guarded so this
-- statement doesn't hard-fail with "column tenant_id does not exist" on
-- either of those.

ALTER TABLE llm_connections ADD COLUMN IF NOT EXISTS base_url TEXT;

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id),
  lead_id UUID REFERENCES leads(id),
  triggered_by UUID REFERENCES users(id),
  trigger_type VARCHAR(20) NOT NULL DEFAULT 'manual',
  input_text TEXT,
  output_text TEXT,
  status VARCHAR(20) NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_product ON agent_runs(product_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_runs' AND column_name='tenant_id') THEN
    EXECUTE 'ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_agent_runs ON agent_runs';
    EXECUTE 'CREATE POLICY tenant_isolation_agent_runs ON agent_runs USING (tenant_id = current_setting(''app.tenant_id'')::UUID)';
  END IF;
END $$;
