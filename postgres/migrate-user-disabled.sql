-- Adds account-disable support to existing databases (fresh deploys already
-- get this column via init-secure.sql). Idempotent - safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT false;
