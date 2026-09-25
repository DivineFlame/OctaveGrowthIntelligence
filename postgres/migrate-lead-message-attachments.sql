-- Lets a lead reply carry image/PDF attachments (see reply-formatting.js
-- and POST /leads/:id/reply). The actual files are only ever transient -
-- staged to disk long enough for nodemailer to attach and send them, then
-- deleted - so this is just enough metadata (name/type/size) for the
-- Inbox thread to show "this message had 2 attachments" honestly, not a
-- reference to a file that still exists anywhere.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
