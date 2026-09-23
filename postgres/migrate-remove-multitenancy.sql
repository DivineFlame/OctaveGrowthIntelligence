-- Collapses this database from multi-tenant to a single company -
-- multi-product, multi-user, where a product is assigned to users and any
-- Admin role can see every product. See README.md "Hardening notes" for
-- the full reasoning; this file is the schema half of that change (see
-- api/src/server.js for the corresponding API/JWT changes).
--
-- This is a one-way migration: tenant_id columns and the `tenants` table
-- are dropped, and every existing tenant's data is merged into one
-- `company`. If more than one tenant previously existed, their data is not
-- separated any more (leads/products/users from every former tenant now
-- belong to the one company) - that merge is the intended effect of
-- "collapse to a single company", not a bug.
--
-- Idempotent: every step is guarded (IF EXISTS / a `tenants` table
-- presence check), so running this again after it already applied - on
-- every boot, via api/src/migrate.js - is a no-op.

-- 1) Create `company` (the new singleton, replacing `tenants`) if it
--    doesn't exist yet, and seed it from whatever `tenants` data exists so
--    an already-configured webhook_secret/premium flag survives the
--    migration instead of being silently reset.
CREATE TABLE IF NOT EXISTS company (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200), is_premium BOOLEAN DEFAULT false, webhook_secret TEXT, created_at TIMESTAMPTZ DEFAULT NOW());

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM company) THEN
    -- Pick the oldest tenant as the canonical name/webhook_secret (most
    -- likely the original signup); is_premium is true if ANY former
    -- tenant had it, so this merge never silently takes away a capability
    -- someone already had.
    INSERT INTO company (name, is_premium, webhook_secret, created_at)
    SELECT
      (SELECT name FROM tenants ORDER BY created_at ASC LIMIT 1),
      EXISTS (SELECT 1 FROM tenants WHERE is_premium = true),
      COALESCE((SELECT webhook_secret FROM tenants ORDER BY created_at ASC LIMIT 1), encode(gen_random_bytes(24), 'hex')),
      (SELECT MIN(created_at) FROM tenants)
    WHERE EXISTS (SELECT 1 FROM tenants);
  END IF;
  -- A completely fresh database (no `tenants` table ever existed, e.g. this
  -- migration running right after init-secure.sql on a new install) still
  -- needs exactly one `company` row for POST /auth/signup to update into -
  -- signup itself creates it in that case, so nothing to do here beyond
  -- making sure this DO block doesn't error on a database with no
  -- `tenants` table and no `company` row yet (POST /auth/signup handles
  -- that case by inserting one).
END $$;

-- 2) Drop tenant-isolation RLS entirely - with one company there is nothing
--    left to isolate, and FORCE ROW LEVEL SECURITY on a tenant_id column
--    that's about to be dropped would just break every query.
DROP POLICY IF EXISTS tenant_isolation_leads ON leads;
DROP POLICY IF EXISTS tenant_isolation_assets ON content_assets;
DROP POLICY IF EXISTS tenant_isolation_variants ON content_variants;
DROP POLICY IF EXISTS tenant_isolation_agent_runs ON agent_runs;
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE content_assets DISABLE ROW LEVEL SECURITY;
ALTER TABLE content_variants DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs DISABLE ROW LEVEL SECURITY;

-- 3) Drop tenant_id from every table that had it. DROP COLUMN also drops
--    any index/FK defined on just that column (idx_leads_tenant,
--    idx_content_tenant, idx_content_variants_tenant, idx_products_tenant),
--    so those don't need a separate DROP INDEX.
ALTER TABLE users DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE leads DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE content_assets DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE content_variants DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE approvals DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE csv_uploads DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE audit_logs DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE hermes_agents DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE products DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS tenant_id;

-- 4) The `tenants` table itself is no longer referenced by anything once
--    step 3 has run (every tenant_id FK pointing at it is gone) - drop it.
DROP TABLE IF EXISTS tenants;

-- 5) New columns this same architectural pass adds (product-wise
--    Inbox/Leads/Studio filtering, lead enrichment) - see README and
--    init-secure.sql's comments on these same columns for a fresh install.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_product ON leads(product_id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS detected_language VARCHAR(20);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gstin VARCHAR(15);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gstin_valid BOOLEAN;

CREATE TABLE IF NOT EXISTS lead_messages (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), lead_id UUID REFERENCES leads(id) ON DELETE CASCADE, direction VARCHAR(10) NOT NULL, channel VARCHAR(20), body TEXT NOT NULL, sent_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_lead_messages_lead ON lead_messages(lead_id);
