-- One-time migration for an already-running MULTI-TENANT database (a
-- fresh install, or one already collapsed to single-company by
-- migrate-remove-multitenancy.sql, has no `tenants` table any more - see
-- README.md "Hardening notes" on removing multi-tenancy). Originally added
-- the webhook_secret column used by the per-tenant webhook URLs and
-- backfilled a real secret for every existing tenant.
--
-- Guarded so it's a safe no-op once `tenants` is gone (either because this
-- is a fresh single-company install, or because
-- migrate-remove-multitenancy.sql already ran and migrated the one
-- surviving webhook_secret onto `company`) - without this guard, this
-- statement would hard-fail with "relation tenants does not exist" on any
-- database created after that architectural change.
DO $$
BEGIN
  IF to_regclass('public.tenants') IS NOT NULL THEN
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
    UPDATE tenants SET webhook_secret = encode(gen_random_bytes(24), 'hex') WHERE webhook_secret IS NULL;
  END IF;
END $$;
