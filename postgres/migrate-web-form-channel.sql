-- Replaces the permanent "Quora" placeholder channel with "Website Web
-- Form" - a real, useful inbound-only channel (see api/src/channels.js's
-- CHANNEL_SPECS.web_form) instead of a channel that could never do
-- anything (Quora has no public posting API and never got one).
--
-- product_channels.channel is a free-text VARCHAR(30) with no CHECK
-- constraint tying it to a fixed list (see init-secure.sql), so this is
-- just data cleanup, not a schema change:
--   1. Drop every existing 'quora' row - it was always 'not_configured'
--      in practice (nothing could ever configure a channel with zero
--      fields and no publish path), so there is no real configuration to
--      preserve or migrate.
--   2. Backfill a 'web_form' row (not_configured) for every product that
--      predates this change, the same way migrate-products-agents.sql
--      originally backfilled all 7 channels for pre-existing products.
--
-- Historical content_variants rows with channel='quora' are left alone -
-- they're an immutable log of what was actually generated in the past,
-- not a live configuration, so there's nothing to migrate there.
DELETE FROM product_channels WHERE channel = 'quora';

INSERT INTO product_channels (product_id, channel, status)
SELECT id, 'web_form', 'not_configured' FROM products
ON CONFLICT (product_id, channel) DO NOTHING;
