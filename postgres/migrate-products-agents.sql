-- One-time migration for an already-running database: adds the
-- Products/Services + Agents/LLM-connections tables for the multi-product,
-- multi-user/agent architecture.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-products-agents.sql
--
-- Safe to run more than once: every statement is IF NOT EXISTS. The
-- products.tenant_id index below only applies to a database that still has
-- that column (a pre-existing multi-tenant database not yet migrated) - a
-- fresh single-company install has no tenant_id column on products at all
-- (see README.md "Hardening notes" on removing multi-tenancy), and
-- migrate-remove-multitenancy.sql drops both the column and this index
-- together when it upgrades an existing database.

CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200) NOT NULL, description TEXT, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='products' AND column_name='tenant_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS product_members (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL DEFAULT 'MEMBER', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, user_id));
CREATE INDEX IF NOT EXISTS idx_product_members_product ON product_members(product_id);
CREATE INDEX IF NOT EXISTS idx_product_members_user ON product_members(user_id);

CREATE TABLE IF NOT EXISTS product_channels (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, channel VARCHAR(30) NOT NULL, config JSONB DEFAULT '{}', status VARCHAR(20) DEFAULT 'not_configured', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, channel));

CREATE TABLE IF NOT EXISTS llm_connections (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, provider VARCHAR(30) NOT NULL, api_key_encrypted TEXT NOT NULL, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, llm_connection_id UUID REFERENCES llm_connections(id), model VARCHAR(100), system_prompt TEXT, config JSONB DEFAULT '{}', active BOOLEAN DEFAULT true, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE IF NOT EXISTS product_agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, agent_id));

-- Backfill: POST /products now pre-creates all 7 channel rows for a new
-- product; this catches any product created before that change (or by a
-- version of this script run before it) so every product ends up with the
-- same full channel set. Safe to re-run (ON CONFLICT DO NOTHING).
INSERT INTO product_channels (product_id, channel, status)
SELECT p.id, ch.channel, 'not_configured'
FROM products p
CROSS JOIN (VALUES ('whatsapp'),('facebook'),('instagram'),('linkedin'),('youtube'),('quora'),('email')) AS ch(channel)
ON CONFLICT (product_id, channel) DO NOTHING;
