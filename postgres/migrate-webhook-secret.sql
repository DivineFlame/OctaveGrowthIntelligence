-- One-time migration for an already-running database: adds the
-- webhook_secret column used by the per-tenant webhook URLs
-- (GET /integrations/webhook-urls) and backfills a real secret for every
-- existing tenant so their webhooks work immediately after this runs.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-webhook-secret.sql
-- (find the container name with `docker ps`)
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS is a no-op if the
-- column already exists, and the UPDATE only touches rows still NULL.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

UPDATE tenants
SET webhook_secret = encode(gen_random_bytes(24), 'hex')
WHERE webhook_secret IS NULL;
