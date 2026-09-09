-- Adds real agent execution to existing databases (fresh deploys already
-- get this via init-secure.sql). Idempotent - safe to re-run.

ALTER TABLE llm_connections ADD COLUMN IF NOT EXISTS base_url TEXT;

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
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
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_agent_runs ON agent_runs;
CREATE POLICY tenant_isolation_agent_runs ON agent_runs USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE INDEX IF NOT EXISTS idx_agent_runs_product ON agent_runs(product_id);
