-- Octave Voice Agent (Sarvam AI outbound calling) - lets a team member
-- place a call to a lead's phone number straight from the Inbox/Leads UI
-- (see MessagesPanel.jsx's Thread header, api/src/voice-agent.js,
-- POST /leads/:id/call in server.js). Configuration is entirely
-- environment variables (SARVAM_VOICE_* - see README.md "Octave Voice
-- Agent" and .env.vps.example), the same pattern SARVAM_API_KEY's inquiry
-- classifier already uses: no DB row, no admin UI for settings. This
-- table only ever records what actually happened - the call attempts
-- Octave made and whatever Sarvam reported back - never configuration.
--
-- raw_last_webhook keeps the full last status-webhook body verbatim
-- (see voice-agent.js's parseStatusWebhookPayload comment on why: Sarvam's
-- public docs don't spell out the exact webhook field names, so nothing
-- Sarvam actually sends is ever silently discarded even where this app's
-- best-effort field extraction guesses wrong).
CREATE TABLE IF NOT EXISTS voice_calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  initiated_by UUID REFERENCES users(id),
  to_number VARCHAR(32) NOT NULL,
  from_number VARCHAR(32),
  provider VARCHAR(20) NOT NULL DEFAULT 'sarvam',
  attempt_id TEXT,
  status VARCHAR(30) NOT NULL DEFAULT 'initiating',
  duration_seconds INT,
  recording_url TEXT,
  transcript_url TEXT,
  error TEXT,
  raw_last_webhook JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_lead ON voice_calls(lead_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_attempt ON voice_calls(attempt_id);
