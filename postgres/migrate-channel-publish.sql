-- One-time migration for an already-running database: adds real
-- channel-publishing support.
--
--   - content_assets.product_id ties an uploaded asset to the Product it
--     belongs to, so publishing a variant can look up that product's
--     product_channels config (credentials) for the variant's channel.
--     Nullable - existing rows predate the Products hierarchy and simply
--     can't be published through a real channel until re-associated
--     (there is no reliable way to infer which product an old asset
--     belonged to, so this does not attempt to backfill it).
--   - content_variants.published_at / publish_error record the outcome of
--     an actual publish attempt (content_variants.published_url already
--     existed but was never populated by anything real).
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-channel-publish.sql
--
-- Safe to run more than once: every statement is IF NOT EXISTS.
-- (Also applied automatically on every api container start - see
-- api/src/migrate.js - so you likely never need to run this by hand.)

ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_content_assets_product ON content_assets(product_id);

ALTER TABLE content_variants ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE content_variants ADD COLUMN IF NOT EXISTS publish_error TEXT;


-- Short-lived, single-purpose public file tokens: lets one specific asset
-- be fetched at a public URL for a few minutes, for the one real use case
-- that needs it (Instagram's Graph API requires a publicly-reachable
-- image_url - it has no direct-upload option, unlike Facebook). Not the
-- content_assets table itself (which is FORCE ROW LEVEL SECURITY'd and
-- tenant-scoped) - a deliberately narrow, ungrantable-by-default token
-- containing only what a public GET needs to serve one file: no tenant
-- data, no RLS bypass required. Created by POST
-- /internal/content-variants/:variantId/publish right before it needs one,
-- expires quickly, and is deleted after being served once.
CREATE TABLE IF NOT EXISTS public_file_tokens (token UUID PRIMARY KEY DEFAULT uuid_generate_v4(), file_path TEXT NOT NULL, mime_type TEXT, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_public_file_tokens_expires ON public_file_tokens(expires_at);
