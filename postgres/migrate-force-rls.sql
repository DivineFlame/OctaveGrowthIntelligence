-- One-time migration for an already-running database (this deployment
-- included): closes a real gap where Postgres Row-Level Security was
-- defined but never actually enforced.
--
-- Postgres exempts a table's OWNER from its own RLS policies by default,
-- and the api container connects as POSTGRES_USER - which owns every
-- table in this database (it's the role docker-entrypoint-initdb.d ran as
-- on first init). So every tenant_isolation_* policy has been silently
-- bypassed for the api's own connection since day one. Real isolation has
-- been resting entirely on the explicit `WHERE tenant_id=$N` clause
-- already present in every query that touches these tables in
-- api/src/server.js (verified - there are no exceptions), so this was
-- always a missing second layer, not an active data leak - but it should
-- still be closed.
--
-- Also fixes content_assets/content_variants missing a `DROP POLICY IF
-- EXISTS` before their CREATE POLICY (leads and agent_runs already had it)
-- - without it, re-running postgres/init-secure.sql against an existing
-- database fails outright with "policy already exists".
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-force-rls.sql
--
-- Safe to run more than once: DROP POLICY IF EXISTS + CREATE POLICY is
-- idempotent, and FORCE ROW LEVEL SECURITY is a no-op if already forced.

DROP POLICY IF EXISTS tenant_isolation_assets ON content_assets;
CREATE POLICY tenant_isolation_assets ON content_assets USING (tenant_id = current_setting('app.tenant_id')::UUID);

DROP POLICY IF EXISTS tenant_isolation_variants ON content_variants;
CREATE POLICY tenant_isolation_variants ON content_variants USING (tenant_id = current_setting('app.tenant_id')::UUID);

ALTER TABLE leads FORCE ROW LEVEL SECURITY;
ALTER TABLE content_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE content_variants FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;
