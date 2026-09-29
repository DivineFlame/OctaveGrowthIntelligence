-- Company branding: lets the Admin set this company's own logo, shown in
-- place of Octave's default branding in the top bar, the sign-in/sign-up
-- screen, and the Admin panel header (see PATCH /company and
-- POST/DELETE /company/logo in api/src/server.js). This app is single-
-- tenant (one company row), so there's exactly one logo to manage, no
-- per-tenant scoping needed. Octave's own "Powered by OctaveAIAutomation"
-- floating badge is unrelated and always shows Octave's own logo
-- regardless of what a company uploads here.
--
-- logo_path mirrors content_assets.s3_key's existing pattern (despite the
-- name, that column - and this one - just holds a local disk path; see
-- README "Hardening notes"/POST /content/upload). logo_mime is stored
-- alongside so GET /company/logo can set the right Content-Type without
-- re-sniffing the file on every request. logo_updated_at doubles as a
-- cache-busting value for the frontend's <img> src.
ALTER TABLE company ADD COLUMN IF NOT EXISTS logo_path TEXT;
ALTER TABLE company ADD COLUMN IF NOT EXISTS logo_mime TEXT;
ALTER TABLE company ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;
