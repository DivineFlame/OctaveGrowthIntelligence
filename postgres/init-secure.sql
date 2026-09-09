-- Secure Postgres Multitenant RLS + Audit
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Atomic one-time gate for POST /auth/signup: the first request to insert
-- 'signup_used' wins the race (ON CONFLICT DO NOTHING), so even if
-- SIGNUP_ENABLED is left on by mistake, at most one Super Admin can ever be
-- created through that route.
CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tenants (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200), subdomain VARCHAR(100) UNIQUE, plan VARCHAR(20) DEFAULT 'starter', is_premium BOOLEAN DEFAULT false, webhook_secret TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, email VARCHAR(255) UNIQUE, password_hash TEXT, role VARCHAR(50), max_history_days INT, can_view_revenue BOOLEAN DEFAULT false, can_view_integrations BOOLEAN DEFAULT false, can_approve_content BOOLEAN DEFAULT false, two_fa_enabled BOOLEAN DEFAULT false, two_fa_secret TEXT, disabled BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS roles (name VARCHAR(50) PRIMARY KEY, max_history_days INT, can_view_revenue BOOLEAN, can_view_integrations BOOLEAN, can_approve_content BOOLEAN, can_publish BOOLEAN, can_manage_users BOOLEAN);
INSERT INTO roles VALUES ('HR_ADMIN',7,false,false,false,false,false),('SALES_LEAD',30,true,false,false,false,false),('CONTENT_CREATOR',30,false,false,false,false,false),('APPROVER',90,true,false,true,false,false),('DEPT_ADMIN',90,true,false,true,true,true),('IT_ADMIN',NULL,true,true,true,true,true),('SUPER_ADMIN',NULL,true,true,true,true,true) ON CONFLICT (name) DO NOTHING;
CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, source_channel VARCHAR(20), company_name VARCHAR(200), contact_name VARCHAR(200), phone VARCHAR(50), email VARCHAR(255), language_pref VARCHAR(20), value_inr INT, status VARCHAR(20) DEFAULT 'NEW', is_duplicate BOOLEAN DEFAULT false, csv_upload_id UUID, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_leads ON leads;
CREATE POLICY tenant_isolation_leads ON leads USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE TABLE IF NOT EXISTS content_assets (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, uploaded_by UUID REFERENCES users(id), file_name VARCHAR(500), file_size BIGINT, mime_type VARCHAR(100), s3_key TEXT, virus_scan_status VARCHAR(20) DEFAULT 'PENDING', brand_kit JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE content_assets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_assets ON content_assets USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE TABLE IF NOT EXISTS content_variants (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), asset_id UUID REFERENCES content_assets(id) ON DELETE CASCADE, tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, channel VARCHAR(30), spec VARCHAR(100), s3_key TEXT, title VARCHAR(200), status VARCHAR(20) DEFAULT 'DRAFT', approved_by UUID REFERENCES users(id), published_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE content_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_variants ON content_variants USING (tenant_id = current_setting('app.tenant_id')::UUID);
CREATE TABLE IF NOT EXISTS approvals (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, variant_id UUID REFERENCES content_variants(id) ON DELETE CASCADE, requested_by UUID REFERENCES users(id), approved_by UUID REFERENCES users(id), status VARCHAR(20) DEFAULT 'PENDING', comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS csv_uploads (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, uploaded_by UUID REFERENCES users(id), file_name VARCHAR(500), file_size BIGINT, rows_total INT, rows_valid INT, rows_duplicate INT, rows_invalid INT, virus_scan_status VARCHAR(20) DEFAULT 'PENDING', status VARCHAR(20) DEFAULT 'PROCESSING', created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id), user_id UUID REFERENCES users(id), action VARCHAR(100) NOT NULL, resource_type VARCHAR(100), resource_id UUID, ip_address INET, user_agent TEXT, result VARCHAR(20), details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE OR REPLACE FUNCTION prevent_audit_update_delete() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'Audit logs immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS no_update_audit ON audit_logs;
CREATE TRIGGER no_update_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_audit_update_delete();
CREATE TABLE IF NOT EXISTS hermes_agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, agent_type VARCHAR(50), status VARCHAR(20) DEFAULT 'IDLE', last_run TIMESTAMPTZ, config JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id);
CREATE INDEX IF NOT EXISTS idx_content_tenant ON content_assets(tenant_id);

-- Products/Services: tenant-scoped, created by a Tenant Admin (DEPT_ADMIN/
-- IT_ADMIN/SUPER_ADMIN - the existing tenant-management roles).
CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE, name VARCHAR(200) NOT NULL, description TEXT, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);

-- Which tenant users work on which product, with a role scoped to that
-- product only (separate from the user's tenant-wide role in `users.role`).
-- 'ADMIN' = Product/Service Admin (assigned by a Tenant Admin, can then add
-- MEMBERs themselves); 'MEMBER' = a regular user working the product.
CREATE TABLE IF NOT EXISTS product_members (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL DEFAULT 'MEMBER', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, user_id));
CREATE INDEX IF NOT EXISTS idx_product_members_product ON product_members(product_id);
CREATE INDEX IF NOT EXISTS idx_product_members_user ON product_members(user_id);

-- Per-product social channel configuration, managed by that product's Admin.
CREATE TABLE IF NOT EXISTS product_channels (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, channel VARCHAR(30) NOT NULL, config JSONB DEFAULT '{}', status VARCHAR(20) DEFAULT 'not_configured', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, channel));

-- Platform-level (Super Admin only, not tenant-scoped) LLM provider
-- connections. api_key_encrypted is application-layer AES-256-GCM
-- ciphertext (see encryptSecret()/decryptSecret() in api/src/server.js) -
-- the raw key is never stored, and is only decrypted in memory when an
-- agent actually needs to call the provider.
CREATE TABLE IF NOT EXISTS llm_connections (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, provider VARCHAR(30) NOT NULL, api_key_encrypted TEXT NOT NULL, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

-- Platform-level (Super Admin only) agent definitions - which LLM
-- connection/model/system prompt an agent uses. Assignable to individual
-- (Premium) products via product_agents below.
CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, llm_connection_id UUID REFERENCES llm_connections(id), model VARCHAR(100), system_prompt TEXT, config JSONB DEFAULT '{}', active BOOLEAN DEFAULT true, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

-- Which agents a given product has enabled (Premium tenants only, enforced
-- in the API - a Standard-plan tenant's products run through product_members
-- users instead).
CREATE TABLE IF NOT EXISTS product_agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, agent_id));
