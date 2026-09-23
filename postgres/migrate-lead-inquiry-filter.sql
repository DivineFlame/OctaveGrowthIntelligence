-- One-time migration for an already-running database: adds
-- leads.is_inquiry, the Sarvam AI message-filtering result (see
-- README.md "Hardening notes" - NULL means unclassified: either
-- SARVAM_API_KEY wasn't set at intake time, or the row predates this
-- column entirely; true/false is an explicit Sarvam classification of the
-- inbound message as a genuine product inquiry or not).
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-lead-inquiry-filter.sql
--
-- Safe to run more than once (IF NOT EXISTS). Also applied automatically on
-- every api container start - see api/src/migrate.js.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_inquiry BOOLEAN;
