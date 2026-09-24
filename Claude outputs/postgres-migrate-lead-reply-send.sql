-- POST /leads/:id/reply previously only wrote a row to lead_messages - it
-- never actually sent anything through the lead's channel (see the comment
-- that used to sit above that route, which explained this was intentional:
-- "a real record of what was sent, not an actual send"). That reads fine in
-- isolation, but the Inbox UI renders every outbound row as a sent chat
-- bubble with no indication it never left the building, so replies to real
-- leads (e.g. over email) were silently never delivered. This adds the
-- columns needed to make POST /leads/:id/reply actually call the
-- configured channel (channels.js's publishToChannel) and record whether
-- that real send succeeded, instead of only ever recording intent.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS send_status VARCHAR(20) NOT NULL DEFAULT 'not_sent';
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS send_error TEXT;
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS external_id TEXT;
