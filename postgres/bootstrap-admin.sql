-- One-time bootstrap: creates the first tenant + a SUPER_ADMIN login.
-- There is no signup route in this app on purpose (RBAC-gated), so this is
-- the only way to create the very first user.
--
-- 1. Edit EMAIL and PASSWORD below to real values.
-- 2. Run it once against the running postgres container, e.g.:
--      docker exec -i <postgres-container-name> \
--        psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/bootstrap-admin.sql
--    (find the container name with `docker ps` — with this compose file it's
--    usually named "<dokploy-app-name>-postgres-1")
-- 3. Delete/rotate the password afterwards if this file ever leaves your
--    machine with real values still in it — don't commit real credentials.

INSERT INTO tenants (name, subdomain, plan, is_premium)
VALUES ('Default Tenant', 'default', 'premium', true)
ON CONFLICT (subdomain) DO NOTHING;

INSERT INTO users (
  tenant_id, email, password_hash, role,
  max_history_days, can_view_revenue, can_view_integrations,
  can_approve_content, two_fa_enabled
)
SELECT
  id,
  'EMAIL',                                   -- <-- change this
  crypt('PASSWORD', gen_salt('bf')),         -- <-- change this
  'SUPER_ADMIN',
  NULL, true, true, true,
  false                                       -- 2FA off so first login isn't blocked
FROM tenants
WHERE subdomain = 'default'
ON CONFLICT (email) DO NOTHING;
