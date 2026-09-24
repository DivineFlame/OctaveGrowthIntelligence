-- POST /leads/:id/reply previously only wrote a row to lead_messages - it
-- never actually sent anything through the lead's channel (see the comment
-- that used to sit above that route: "a real record of what was sent, not
-- an actual send"). The Inbox/Leads UI (MessagesPanel.jsx) renders every
-- outbound row as a sent chat bubble regardless, so replies to real leads
-- (over email, most commonly) were silently never delivered. This adds the
-- columns needed for POST /leads/:id/reply to actually call the configured
-- channel (channels.js's publishToChannel) and record whether that real
-- send succeeded, instead of only ever recording intent.
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS send_status VARCHAR(20) NOT NULL DEFAULT 'not_sent';
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS send_error TEXT;
ALTER TABLE lead_messages ADD COLUMN IF NOT EXISTS external_id TEXT;
