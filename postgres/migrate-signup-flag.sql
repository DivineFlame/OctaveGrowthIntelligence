-- One-time migration for an already-running database: adds the
-- system_flags table used by POST /auth/signup to atomically guarantee
-- at most one account is ever created through that route.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-signup-flag.sql
--
-- Safe to run more than once: CREATE TABLE IF NOT EXISTS is a no-op if the
-- table already exists.
--
-- If you already bootstrapped your Super Admin via postgres/bootstrap-admin.sql,
-- run this too and then claim the flag manually so POST /auth/signup can't
-- create a second Super Admin:
--   INSERT INTO system_flags (key, value) VALUES ('signup_used', 'true')
--   ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, value TEXT);
