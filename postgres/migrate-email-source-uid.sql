-- One-time migration for an already-running database: adds
-- leads.source_uid, used only for leads created from the IMAP poller
-- (see api/src/email-poller.js and README.md "Hardening notes"). Records
-- the IMAP UID of the source message so a later poll can tell whether
-- that message still exists in the mailbox - if it was deleted (in the
-- person's own mail client, not through this app), the lead is deleted
-- too rather than sitting around forever referencing an email that's
-- gone. NULL for every lead from any other channel/source.
--
-- Run it once against the running postgres container, e.g.:
--   docker exec -i <postgres-container-name> \
--     psql -U <POSTGRES_USER> -d <POSTGRES_DB> < postgres/migrate-email-source-uid.sql
--
-- Safe to run more than once (IF NOT EXISTS). Also applied automatically
-- on every api container start - see api/src/migrate.js.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_uid BIGINT;
