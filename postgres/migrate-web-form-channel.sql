-- Replaces the permanent "Quora" placeholder channel with "Website Web
-- Form" - a real, useful inbound channel (see api/src/channels.js's
-- CHANNEL_SPECS.web_form) instead of a channel that could never do
-- anything (Quora has no public posting API and never got one).
--
-- Unlike every other channel, Website Web Form is dedicated per product:
-- each product gets its own random, unguessable form_token (used in the
-- public POST /forms/:token route - see server.js) instead of sharing the
-- company-wide webhook_secret + a hidden product_id field the way every
-- other channel's inbound webhook does. That's deliberate - a web form is
-- the one "webhook" meant to be pasted straight into a customer's own
-- public website HTML, so its URL has to identify exactly one product on
-- its own, and copying it out of the page source must never also hand out
-- the credential every other channel's webhook relies on.
--
-- product_channels.channel is a free-text VARCHAR(30) with no CHECK
-- constraint tying it to a fixed list (see init-secure.sql), and .config
-- is a plain JSONB column, so all of this is just data cleanup/backfill,
-- not a schema change:
--   1. Drop every existing 'quora' row - it was always 'not_configured'
--      in practice (nothing could ever configure a channel with zero
--      fields and no publish path), so there is no real configuration to
--      preserve or migrate.
--   2. Backfill a 'web_form' row for every product that predates this
--      change, the same way migrate-products-agents.sql originally
--      backfilled all 7 channels for pre-existing products - already
--      'configured' (not 'not_configured') and with a real form_token,
--      since web_form has no required fields and its URL works the
--      moment a token exists (see POST /products in server.js).
--   3. Also backfill a form_token onto any 'web_form' row that might
--      already exist without one (e.g. from an earlier, in-development
--      version of this migration) - idempotent, never overwrites a
--      token that's already there.
--
-- Historical content_variants rows with channel='quora' are left alone -
-- they're an immutable log of what was actually generated in the past,
-- not a live configuration, so there's nothing to migrate there.
DELETE FROM product_channels WHERE channel = 'quora';

INSERT INTO product_channels (product_id, channel, status, config)
SELECT id, 'web_form', 'configured', jsonb_build_object('form_token', replace(uuid_generate_v4()::text, '-', ''))
FROM products
ON CONFLICT (product_id, channel) DO NOTHING;

UPDATE product_channels
SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{form_token}', to_jsonb(replace(uuid_generate_v4()::text, '-', ''))),
    status = 'configured'
WHERE channel = 'web_form' AND (config->>'form_token') IS NULL;
