-- Secure Postgres schema - single company, multi-product, multi-user.
-- (Formerly multi-tenant; see postgres/migrate-remove-multitenancy.sql for
-- the migration that collapsed an existing multi-tenant database down to
-- this shape. This file is the fresh-install schema going forward.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- Atomic one-time gate for POST /auth/signup: the first request to insert
-- 'signup_used' wins the race (ON CONFLICT DO NOTHING), so even if
-- SIGNUP_ENABLED is left on by mistake, at most one Super Admin (and one
-- `company` row) can ever be created through that route.
CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, value TEXT);
-- Singleton: exactly one row, created once by POST /auth/signup (guarded by
-- the same system_flags.signup_used race-gate above, so nothing else ever
-- inserts a second row). Replaces the old per-tenant `tenants` table now
-- that this app runs as a single company rather than many isolated ones -
-- every route reads it with `SELECT * FROM company LIMIT 1` instead of
-- joining/filtering by an id.
CREATE TABLE IF NOT EXISTS company (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200), is_premium BOOLEAN DEFAULT false, webhook_secret TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), email VARCHAR(255) UNIQUE, password_hash TEXT, role VARCHAR(50), max_history_days INT, can_view_revenue BOOLEAN DEFAULT false, can_view_integrations BOOLEAN DEFAULT false, can_approve_content BOOLEAN DEFAULT false, two_fa_enabled BOOLEAN DEFAULT false, two_fa_secret TEXT, disabled BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS roles (name VARCHAR(50) PRIMARY KEY, max_history_days INT, can_view_revenue BOOLEAN, can_view_integrations BOOLEAN, can_approve_content BOOLEAN, can_publish BOOLEAN, can_manage_users BOOLEAN);
INSERT INTO roles VALUES ('HR_ADMIN',7,false,false,false,false,false),('SALES_LEAD',30,true,false,false,false,false),('CONTENT_CREATOR',30,false,false,false,false,false),('APPROVER',90,true,false,true,false,false),('DEPT_ADMIN',90,true,false,true,true,true),('IT_ADMIN',NULL,true,true,true,true,true),('SUPER_ADMIN',NULL,true,true,true,true,true) ON CONFLICT (name) DO NOTHING;
CREATE TABLE IF NOT EXISTS leads (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), source_channel VARCHAR(20), company_name VARCHAR(200), contact_name VARCHAR(200), phone VARCHAR(50), email VARCHAR(255), language_pref VARCHAR(20), value_inr INT, status VARCHAR(20) DEFAULT 'NEW', is_duplicate BOOLEAN DEFAULT false, csv_upload_id UUID, created_at TIMESTAMPTZ DEFAULT NOW(), pii_erased_at TIMESTAMPTZ, product_id UUID, detected_language VARCHAR(20), gstin VARCHAR(15), gstin_valid BOOLEAN);
CREATE TABLE IF NOT EXISTS content_assets (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), uploaded_by UUID REFERENCES users(id), file_name VARCHAR(500), file_size BIGINT, mime_type VARCHAR(100), s3_key TEXT, virus_scan_status VARCHAR(20) DEFAULT 'PENDING', brand_kit JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS content_variants (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), asset_id UUID REFERENCES content_assets(id) ON DELETE CASCADE, channel VARCHAR(30), spec VARCHAR(100), s3_key TEXT, title VARCHAR(200), status VARCHAR(20) DEFAULT 'DRAFT', approved_by UUID REFERENCES users(id), published_url TEXT, published_at TIMESTAMPTZ, publish_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS approvals (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), variant_id UUID REFERENCES content_variants(id) ON DELETE CASCADE, requested_by UUID REFERENCES users(id), approved_by UUID REFERENCES users(id), status VARCHAR(20) DEFAULT 'PENDING', comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS csv_uploads (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), uploaded_by UUID REFERENCES users(id), file_name VARCHAR(500), file_size BIGINT, rows_total INT, rows_valid INT, rows_duplicate INT, rows_invalid INT, virus_scan_status VARCHAR(20) DEFAULT 'PENDING', status VARCHAR(20) DEFAULT 'PROCESSING', created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS audit_logs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID REFERENCES users(id), action VARCHAR(100) NOT NULL, resource_type VARCHAR(100), resource_id UUID, ip_address INET, user_agent TEXT, result VARCHAR(20), details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE OR REPLACE FUNCTION prevent_audit_update_delete() RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'Audit logs immutable'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS no_update_audit ON audit_logs;
CREATE TRIGGER no_update_audit BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION prevent_audit_update_delete();
CREATE TABLE IF NOT EXISTS hermes_agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), agent_type VARCHAR(50), status VARCHAR(20) DEFAULT 'IDLE', last_run TIMESTAMPTZ, config JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_content_variants_asset ON content_variants(asset_id);

-- Products/Services: company-wide, created by an Admin (DEPT_ADMIN/
-- IT_ADMIN/SUPER_ADMIN). A product is assigned to users via product_members
-- below; an Admin role can see and manage every product, a regular user
-- only the ones they're assigned to.
CREATE TABLE IF NOT EXISTS products (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(200) NOT NULL, description TEXT, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

-- Which users work on which product, with a role scoped to that product
-- only (separate from the user's company-wide role in `users.role`).
-- 'ADMIN' = Product/Service Admin (assigned by an Admin, can then add
-- MEMBERs themselves); 'MEMBER' = a regular user working the product.
CREATE TABLE IF NOT EXISTS product_members (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, user_id UUID REFERENCES users(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL DEFAULT 'MEMBER', created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, user_id));
CREATE INDEX IF NOT EXISTS idx_product_members_product ON product_members(product_id);
CREATE INDEX IF NOT EXISTS idx_product_members_user ON product_members(user_id);

-- Per-product social channel configuration, managed by that product's Admin.
CREATE TABLE IF NOT EXISTS product_channels (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, channel VARCHAR(30) NOT NULL, config JSONB DEFAULT '{}', status VARCHAR(20) DEFAULT 'not_configured', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, channel));

-- Ties an uploaded asset to the Product it belongs to, so publishing one of
-- its variants can look up that product's product_channels config
-- (credentials) for the variant's channel, and so Studio/Inbox/Leads can
-- filter product-wise. Added here (not at content_assets' own CREATE TABLE
-- above) because `products` doesn't exist yet at that point in this file -
-- same reasoning applies to leads.product_id above.
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_assets_product ON content_assets(product_id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leads_product ON leads(product_id);

-- Platform-level (Super Admin only) LLM provider connections.
-- api_key_encrypted is application-layer AES-256-GCM ciphertext (see
-- encryptSecret()/decryptSecret() in api/src/server.js) - the raw key is
-- never stored, and is only decrypted in memory when an agent actually
-- needs to call the provider.
-- provider is one of 'anthropic' | 'sarvam' | 'openai_compatible' (enforced
-- in the API, not here). base_url is only used/required for
-- openai_compatible (a full .../v1 base, e.g. https://api.groq.com/openai/v1
-- - '/chat/completions' is appended) - anthropic and sarvam use hardcoded
-- real endpoints since their exact auth header/response shape is
-- provider-specific, not something a generic base_url can express.
CREATE TABLE IF NOT EXISTS llm_connections (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, provider VARCHAR(30) NOT NULL, base_url TEXT, api_key_encrypted TEXT NOT NULL, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

-- Platform-level (Super Admin only) agent definitions - which LLM
-- connection/model/system prompt an agent uses. Assignable to individual
-- (Premium) products via product_agents below.
CREATE TABLE IF NOT EXISTS agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name VARCHAR(100) NOT NULL, llm_connection_id UUID REFERENCES llm_connections(id), model VARCHAR(100), system_prompt TEXT, config JSONB DEFAULT '{}', active BOOLEAN DEFAULT true, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());

-- Which agents a given product has enabled (Premium companies only,
-- enforced in the API via company.is_premium - a Standard-plan company's
-- products run through product_members users instead).
CREATE TABLE IF NOT EXISTS product_agents (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(product_id, agent_id));

-- Real record of every agent invocation (manual "Run Agent" clicks, and
-- automatic runs off lead intake for Premium products) - the actual LLM
-- call's input/output, not a fabricated status. trigger_type is 'manual' or
-- 'auto_lead_intake'; triggered_by is NULL for automatic runs.
CREATE TABLE IF NOT EXISTS agent_runs (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), product_id UUID REFERENCES products(id) ON DELETE CASCADE, agent_id UUID REFERENCES agents(id), lead_id UUID REFERENCES leads(id), triggered_by UUID REFERENCES users(id), trigger_type VARCHAR(20) NOT NULL DEFAULT 'manual', input_text TEXT, output_text TEXT, status VARCHAR(20) NOT NULL, error TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_agent_runs_product ON agent_runs(product_id);

-- Short-lived, single-purpose public file tokens: lets one specific asset
-- be fetched at a public URL for a few minutes, for the one real use case
-- that needs it (Instagram's Graph API requires a publicly-reachable
-- image_url - it has no direct-upload option, unlike Facebook). A
-- deliberately narrow, ungrantable-by-default token containing only what a
-- public GET needs to serve one file. Created by POST
-- /internal/content-variants/:variantId/publish right before it needs one,
-- expires quickly, and is deleted after being served once.
CREATE TABLE IF NOT EXISTS public_file_tokens (token UUID PRIMARY KEY DEFAULT uuid_generate_v4(), file_path TEXT NOT NULL, mime_type TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_public_file_tokens_expires ON public_file_tokens(expires_at);

-- Inbox/reply thread on a lead - a lead can arrive with one inbound message
-- (the webhook payload/CSV row) and then be replied to and followed up on
-- from the Inbox/Leads screens. Kept separate from `leads` itself (which
-- stays the canonical contact + inquiry record) so a lead can carry many
-- messages over time without repeatedly mutating that row.
CREATE TABLE IF NOT EXISTS lead_messages (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), lead_id UUID REFERENCES leads(id) ON DELETE CASCADE, direction VARCHAR(10) NOT NULL, channel VARCHAR(20), body TEXT NOT NULL, sent_by UUID REFERENCES users(id), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_lead_messages_lead ON lead_messages(lead_id);
