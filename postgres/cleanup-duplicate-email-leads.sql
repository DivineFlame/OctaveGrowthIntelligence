-- One-off cleanup for leads created by the pre-fix IMAP poller: a bug in
-- how it called fetch() meant the same email could be re-ingested as a
-- brand-new lead on every single poll instead of being recognized as
-- already-seen (visible in production as the same "Welcome to Hostinger
-- Email!" message appearing over and over, a few minutes apart, matching
-- the poll interval). Fixed in code - this just cleans up the duplicate
-- rows that bug already created before the fix was deployed.
--
-- Keeps the EARLIEST lead for each (product_id, source_uid) pair and
-- deletes the rest. Only touches source_channel='email' rows that have a
-- source_uid recorded - never affects a lead from any other channel, and
-- never affects an email lead from before this feature existed (no
-- source_uid on those either). lead_messages cascades on delete.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/cleanup-duplicate-email-leads.sql
--
-- Safe to run more than once - a no-op once there's nothing left to
-- dedupe. NOT applied automatically by api/src/migrate.js (this is a
-- one-off data cleanup, not a schema change) - run it by hand after
-- deploying the fix.

DELETE FROM leads a USING leads b
WHERE a.source_channel = 'email'
  AND b.source_channel = 'email'
  AND a.source_uid IS NOT NULL
  AND a.source_uid = b.source_uid
  AND a.product_id = b.product_id
  AND a.created_at > b.created_at;
