-- One-time migration for an already-running database: adds the
-- two_fa_secret column used by real TOTP verification
-- (POST /auth/2fa/setup, /auth/2fa/verify, /auth/2fa/disable, and the
-- /auth/login TOTP check). Before this, two_fa_enabled existed but nothing
-- ever stored a secret to actually verify a code against.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-2fa-secret.sql
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS is a no-op if the
-- column already exists.

ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_secret TEXT;
