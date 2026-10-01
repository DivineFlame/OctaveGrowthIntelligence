-- Automated lead discovery (see api/src/lead-generation.js, POST
-- /leads/discover in server.js, and MessagesPanel.jsx's "Find leads"
-- panel) - lets a Manager/Admin search for businesses matching a query
-- and location and import the results straight into `leads`. Which
-- third-party service actually runs the search is entirely environment
-- variables (APIFY_* - see README.md and .env.vps.example); this table
-- only ever records what a search actually did - never configuration,
-- and never the provider's name (kept generic on purpose, same as every
-- UI-facing string this feature produces).
CREATE TABLE IF NOT EXISTS lead_discovery_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID,
  requested_by UUID REFERENCES users(id),
  query VARCHAR(200) NOT NULL,
  location VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED',
  leads_found INT DEFAULT 0,
  leads_imported INT DEFAULT 0,
  leads_duplicate INT DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_discovery_runs_requested_by ON lead_discovery_runs(requested_by);
