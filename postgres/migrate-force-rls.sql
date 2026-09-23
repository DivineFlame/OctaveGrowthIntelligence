-- One-time migration for an already-running MULTI-TENANT database: closes
-- a real gap where Postgres Row-Level Security was defined but never
-- actually enforced (see the full original explanation below - kept for
-- history since it documents a real, previously-shipped bug).
--
-- Postgres exempts a table's OWNER from its own RLS policies by default,
-- and the api container connects as POSTGRES_USER - which owns every
-- table in this database (it's the role docker-entrypoint-initdb.d ran as
-- on first init). So every tenant_isolation_* policy was silently
-- bypassed for the api's own connection from day one. Real isolation
-- rested entirely on the explicit `WHERE tenant_id=$N` clause already
-- present in every query that touched these tables, so this was always a
-- missing second layer, not an active data leak - but it needed closing
-- on any database still running multi-tenant.
--
-- This app has since removed multi-tenancy entirely (see README.md
-- "Hardening notes" and migrate-remove-multitenancy.sql, which runs after
-- this file - see api/src/migrate.js's MIGRATIONS_IN_ORDER) - a fresh
-- single-company install has no tenant_id column on any of these tables
-- at all, so every statement here is guarded to a genuine no-op once
-- that's true, rather than hard-failing with "column tenant_id does not
-- exist".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='content_assets' AND column_name='tenant_id') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_assets ON content_assets';
    EXECUTE 'CREATE POLICY tenant_isolation_assets ON content_assets USING (tenant_id = current_setting(''app.tenant_id'')::UUID)';
    EXECUTE 'ALTER TABLE content_assets FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='content_variants' AND column_name='tenant_id') THEN
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_variants ON content_variants';
    EXECUTE 'CREATE POLICY tenant_isolation_variants ON content_variants USING (tenant_id = current_setting(''app.tenant_id'')::UUID)';
    EXECUTE 'ALTER TABLE content_variants FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='tenant_id') THEN
    EXECUTE 'ALTER TABLE leads FORCE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_runs' AND column_name='tenant_id') THEN
    EXECUTE 'ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY';
  END IF;
END $$;
