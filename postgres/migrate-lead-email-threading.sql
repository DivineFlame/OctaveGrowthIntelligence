-- An email reply sent from POST /leads/:id/reply used to always go out
-- with a made-up subject ("Re: message from <company>") and no
-- In-Reply-To/References headers at all - so instead of landing in the
-- same email thread as the message the lead actually sent, it showed up
-- in their inbox as a brand-new, unrelated conversation. Fixes that by
-- remembering the original inbound email's real Subject and Message-ID
-- when it's ingested (email-poller.js), so a reply can build a correct
-- "Re: <original subject>" and a real In-Reply-To/References chain (see
-- publishEmail() in channels.js and POST /leads/:id/reply in server.js).
-- NULL for every lead not sourced from IMAP polling (webhook-based
-- channels, CSV upload, etc.) - there's no email thread to rejoin there.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_message_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_subject TEXT;
