-- content_variants had no index beyond its primary key (id) - every lookup
-- by asset_id (GET /products/:id/content, the publish route, the transform
-- route's UPDATE after a real Paperclip resize) and every tenant-scoped
-- query (RLS policy check, withTenantClient reads) was a sequential scan.
-- Fine at today's data volume, a real cost once content_variants grows.
-- Safe to run more than once: CREATE INDEX IF NOT EXISTS is a no-op if the
-- index already exists.
CREATE INDEX IF NOT EXISTS idx_content_variants_asset ON content_variants(asset_id);
CREATE INDEX IF NOT EXISTS idx_content_variants_tenant ON content_variants(tenant_id);
