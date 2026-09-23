-- content_variants had no index beyond its primary key (id) - every lookup
-- by asset_id (GET /products/:id/content, the publish route, the transform
-- route's UPDATE after a real Paperclip resize) was a sequential scan.
-- Fine at today's data volume, a real cost once content_variants grows.
-- Safe to run more than once: CREATE INDEX IF NOT EXISTS is a no-op if the
-- index already exists.
CREATE INDEX IF NOT EXISTS idx_content_variants_asset ON content_variants(asset_id);

-- The tenant-scoped index below only applies to a database that still has
-- a tenant_id column on content_variants (a pre-existing multi-tenant
-- database not yet migrated) - a fresh single-company install has no such
-- column (see README.md "Hardening notes" on removing multi-tenancy), and
-- migrate-remove-multitenancy.sql drops both the column and this index
-- together when it upgrades an existing database. Guarded so this
-- statement doesn't hard-fail with "column tenant_id does not exist".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='content_variants' AND column_name='tenant_id') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_content_variants_tenant ON content_variants(tenant_id)';
  END IF;
END $$;
