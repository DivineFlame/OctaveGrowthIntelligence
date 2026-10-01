# Demo deployment

A fully working copy of the app, seeded with realistic sample data, for
demoing or evaluating the product without needing real customer data or
real third-party credentials (WhatsApp, email, Sarvam voice, Apify lead
discovery, etc). It is the same codebase as a real deployment - nothing
is mocked at the UI layer - pointed at its own disposable database and
populated by one script, `api/scripts/seed-demo.js`.

## Standing it up

Uses the same `docker-compose.vps.yml` as a real deployment.

1. Copy the demo env file and fill in the `GENERATE_*` secrets:
   ```
   cp .env.demo.example .env.demo
   openssl rand -hex 24   # POSTGRES_PASSWORD
   openssl rand -hex 24   # REDIS_PASSWORD
   openssl rand -hex 32   # JWT_SECRET
   openssl rand -hex 32   # ENCRYPTION_KEY
   openssl rand -hex 32   # INTERNAL_API_SECRET
   ```
   Leave the `SARVAM_*`/`APIFY_API_TOKEN` lines commented out - see
   "What's real vs. simulated" below for why that's intentional.

   If this VPS already runs a production deployment of this same repo (or
   another demo), keep `.env.demo`'s `POSTGRES_HOST_PORT`/`API_HOST_PORT`/
   `API_METRICS_HOST_PORT`/`FRONTEND_HOST_PORT` lines uncommented - they
   give this stack its own host ports so `docker compose up` doesn't fail
   with "port is already allocated" against the ports the other stack is
   already using. If this is the only deployment on the box, you can
   comment them back out and it'll fall back to the production defaults.

2. Bring the stack up on the `demo` branch, pointed at `.env.demo`:
   ```
   git checkout demo
   docker compose -f docker-compose.vps.yml --env-file .env.demo up -d
   ```
   The `api` container's own startup command (`node src/migrate.js &&
   node src/server.js`) applies the schema migrations automatically -
   same as any deployment, nothing demo-specific there.

3. Seed the sample data (one-off, run once against a fresh database):
   ```
   docker compose -f docker-compose.vps.yml --env-file .env.demo exec api npm run seed:demo
   ```
   This is idempotent and safety-guarded: it checks whether the demo
   admin (`admin@demo.octave.invalid`) already exists and exits quietly
   if so, and it refuses to run at all against a database that already
   has other real users in it unless you pass `--force` - this is a
   deliberate guard against accidentally pointing the seed script at a
   production database. It needs `ENCRYPTION_KEY` set (step 1) to
   encrypt the sample channel credentials it writes, the same way the
   app encrypts real ones.

4. Log in at `https://$APP_DOMAIN` (or `http://localhost:5173` for a
   local run) with any of the accounts below.

## Logging in

| Email | Role | Password |
|---|---|---|
| `admin@demo.octave.invalid` | Super Admin | `OctaveDemo#2026` |
| `manager@demo.octave.invalid` | Department Admin | `OctaveDemo#2026` |
| `sales@demo.octave.invalid` | Sales Lead | `OctaveDemo#2026` |
| `creator@demo.octave.invalid` | Content Creator | `OctaveDemo#2026` |

(Override the shared password at seed time with `DEMO_PASSWORD=...` in
the environment before running `npm run seed:demo`.) Signup is closed
(`SIGNUP_ENABLED=false`) - these four accounts are the only way in, by
design, matching how a real deployment closes signup after its first
Super Admin exists.

## What's seeded

Two sample products (**Aarav Home Furnishings**, **Nimbus Cloud
Kitchen**), each with:
- all 7 channels pre-created, each "configured" with syntactically
  valid (but fake) credentials, exactly as `POST /products/:id/channels`
  would leave them for a real integration
- 10 leads (20 total) with realistic company/contact/phone/email data,
  a mix of sources (CSV upload, WhatsApp, Instagram, Facebook, website
  web form, manual entry), some flagged as genuine inquiries, some with
  a GSTIN embedded in their notes so the GSTIN-detection pipeline has
  something to show, and roughly a third assigned to the Sales Lead
  account
- a short reply thread on the first couple of leads per product, so
  Inbox/Thread views aren't empty
- discovery history: two completed automated "Find leads" runs and one
  failed one (with a realistic timeout error), so the Leads screen's
  discovery history has entries without needing a live Apify call
- voice call history: a completed call, a failed (no-answer) call, and
  one still shown as ringing, so the Voice Agent call log isn't empty
- Content Studio: one content asset per product (a real small PNG on
  disk, not a fabricated file size) with three variants each, spanning
  the full real lifecycle - published, approved, rejected,
  publish-failed, and (one per product) genuinely still
  `PENDING_APPROVAL` - see below
- a handful of audit log entries, visible to the two admin roles

## What's real vs. simulated

- **Historical records are real rows, not UI-only mockups.** Every
  lead, message, discovery run, call, content asset/variant and audit
  log entry seeded above is a genuine row in the same tables the real
  app reads from - the screens that display them are running their
  normal code, unmodified.
- **The one `PENDING_APPROVAL` content variant per product is live and
  clickable.** Its Approve/Reject buttons in Content Studio hit the
  real `POST /content/variants/:id/approve` route and write a real
  `approvals` row - there is nothing simulated about this action.
- **Channel credentials are syntactically valid but fake.** Each
  channel is marked "configured" so the UI shows it as set up, but the
  values (API keys, tokens, phone IDs) are not real. Any *new* outbound
  action through a channel - sending a fresh WhatsApp/email message,
  publishing a newly-approved variant out to a real channel - will fail
  the same way it would on any deployment with invalid credentials: the
  attempt is made, the provider rejects it, and the UI shows that
  failure honestly. This is intentional, not a bug: the demo doesn't
  pretend to actually reach WhatsApp, Instagram, email, etc.
- **Voice Agent calling and automated lead discovery are left
  unconfigured on purpose** (`SARVAM_*`/`APIFY_API_TOKEN` unset in
  `.env.demo.example`). Their *history* is seeded and viewable, but
  starting a *new* call or a *new* discovery search shows the same
  "not configured yet" state any deployment shows before those
  optional integrations are set up - never a fake success.

If you want to demo a genuinely live outbound action (a real call, a
real discovery search, a real publish), set the corresponding real
credentials in `.env.demo` and restart the stack - at that point it's
functioning exactly as a production deployment would, just with the
sample data already in place underneath it.
