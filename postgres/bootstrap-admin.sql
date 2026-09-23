-- One-time bootstrap: creates the singleton `company` row + a SUPER_ADMIN
-- login, entirely offline (no signup route needed). This app runs as a
-- single company - multi-product, multi-user (see README.md "Hardening
-- notes" on removing multi-tenancy) - so `company` has exactly one row,
-- same as if POST /auth/signup had created it.
--
-- 1. Edit EMAIL and PASSWORD below to real values.
-- 2. Run it once against the running postgres container, e.g.:
--      docker exec -i <postgres-container-name> \
--        psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/bootstrap-admin.sql
--    (find the container name with `docker ps` — with this compose file it's
--    usually named "<dokploy-app-name>-postgres-1")
-- 3. Delete/rotate the password afterwards if this file ever leaves your
--    machine with real values still in it — don't commit real credentials.
-- 4. Also marks system_flags.signup_used, so POST /auth/signup correctly
--    refuses to create a second Super Admin/company later even if
--    SIGNUP_ENABLED is left on by mistake.

INSERT INTO company (name)
SELECT 'Default Company'
WHERE NOT EXISTS (SELECT 1 FROM company);

INSERT INTO users (
  email, password_hash, role,
  max_history_days, can_view_revenue, can_view_integrations,
  can_approve_content, two_fa_enabled
)
VALUES (
  'EMAIL',                                   -- <-- change this
  crypt('PASSWORD', gen_salt('bf')),         -- <-- change this
  'SUPER_ADMIN',
  NULL, true, true, true,
  false                                       -- 2FA off so first login isn't blocked
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO system_flags (key, value) VALUES ('signup_used', 'bootstrap-admin.sql')
ON CONFLICT (key) DO NOTHING;
