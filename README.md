# OrgComms v4 REAL APP KIT - VPS - No Fake ghcr.io - Builds Locally

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-reverse%20proxy-009639?logo=nginx&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

Fixed: docker-compose builds from ./api, ./hermes, ./paperclip locally, no external registry. Real source code included.

> **A pass of dummy/stub cleanup landed together**: the content-transform
> pipeline had two Redis consumers (`hermes-orchestrator` and a
> `transformer-worker` service) racing each other for jobs on the same
> queue key, one of which called a Paperclip endpoint that fabricated a
> file path and never wrote anything; upload also blind-pushed a transform
> job with guessed-at default channels before any transform was requested.
> All replaced with one real, synchronous path: POST
> `/content/:assetId/transform` calls Paperclip directly and Paperclip does
> a real Pillow resize for image assets (honestly reporting "skipped" - not
> a fake success - for video/PDF/spreadsheet sources), persisting the real
> output path onto the variant. The now-dead `transformer-worker` service
> and its `transformer/` directory are gone (same treatment as the earlier
> `csv-handler/` removal); `hermes-orchestrator`'s `scout`/`compliance`
> agent types, which only ever returned hardcoded canned data nothing used,
> are gone too - it now just runs `publisher` and `lead_intake`, both real.
> Separately: content-upload's MIME-type allowlist was defined but never
> enforced (`fileFilter` accepted everything - "Allow all for MVP"); it's
> enforced now. And there was no global Express error handler, so an error
> that didn't hit its own try/catch (a rejected upload, a malformed JSON
> body) fell through to Express's default HTML error page instead of this
> API's usual JSON error shape - added one.
>
> **Migrations now apply automatically.** The `api` container runs
> `postgres/migrate-*.sql` against `DATABASE_URL` on every start, before it
> begins serving traffic (see `api/src/migrate.js` and the `api` service's
> `command:` in `docker-compose.vps.yml`) - a `git pull` + redeploy is
> enough, no manual `docker exec ... psql` step required. The migration
> mentions below predate that and are kept for reference / manual runs
> against a database this container isn't managing.
>
> **Backups now run automatically too**, via the `postgres-backup` sidecar
> container (`postgres/backup/`) - daily `pg_dump`, 7-day local retention by
> default. `scripts/backup-vps.sh` still works for an on-demand backup, and
> `scripts/restore-vps.sh` restores either kind.

> **Channel publishing is now real**, for Email, WhatsApp Business,
> Facebook, Instagram, and LinkedIn (see `api/src/channels.js`) - YouTube
> and Quora remain documented placeholders (YouTube needs a meaningfully
> different upload protocol; Quora has no public posting API at all).
> Configure credentials per-channel from Products > Channels in the
> frontend (fields are channel-specific - WhatsApp needs a phone number ID
> + access token, Email needs SMTP details, etc; secrets are encrypted at
> rest and masked in every API response). Content only publishes through a
> real channel if the asset was uploaded with a `product_id` (`POST
> /content/upload`) - use **Products > (open a product) > Content** in the
> frontend for this: it uploads tied to that product, triggers
> `POST /content/:assetId/transform` for the channels you pick, and lists
> each generated variant with an Approve/Reject action
> (`POST /content/variants/:variantId/approve`) for anyone with the
> `can_approve_content` flag or an approver role. Reading back what's been
> uploaded/generated goes through `GET /products/:id/content`, which didn't
> exist before - there was previously no way to list assets or variants at
> all, only write them. There's a separate, prebuilt/minified widget
> mounted at `#root` in `frontend/index.html` (this repo has no source for
> it) that predates this tab and still only does a bare upload with no
> `product_id` - don't use it for anything that needs to publish; the
> Products > Content tab is the supported path. Instagram specifically
> requires `APP_DOMAIN` or `API_DOMAIN` to be a real public domain, since
> its API has no direct file upload and must fetch the image itself.

## First login

There's no general signup — every user after the first is created by an
admin via the Admin panel (see below) — but `POST /auth/signup`
exists for exactly one purpose: creating the very first Super Admin without
touching the database by hand.

1. Run the migration once if your database predates this feature: `postgres/migrate-signup-flag.sql`
   (same `docker exec ... psql` pattern as the other migrations).
2. Make sure `SIGNUP_ENABLED` isn't set to `false` in Dokploy's Environment
   tab (unset, or `true`, leaves it open).
3. Open the frontend — the login screen shows **"First time here? Create
   the Super Admin account"**. Fill in company name, email, and password.
4. **Set `SIGNUP_ENABLED=false` in Dokploy right after** and redeploy, to
   close the route outright.

Step 4 isn't just tidiness: even if you forget it, the route is still safe
— `POST /auth/signup` atomically claims a one-time-use flag in the database
before creating anything, so at most one account can ever be created
through it regardless of how long `SIGNUP_ENABLED` stays on. But closing it
removes the endpoint from your attack surface entirely, which is worth
doing.

Prefer not to expose a signup endpoint even briefly? `postgres/bootstrap-admin.sql`
still exists as a fully offline alternative — create the company + Super
Admin directly via SQL instead, with `SIGNUP_ENABLED=false` from the start.

The frontend's API base URL is hardcoded in `frontend/index.html` as
`API_BASE` (currently `https://api.octaveaiautomation.com`) — not a visible
field. If the API's domain ever changes, update that one constant and
redeploy the frontend.

## Company and users

This app runs as a single company - multi-product, multi-user (see
"Hardening notes" below for the change that removed multi-tenancy
entirely: there is exactly one `company` row, created once by
`POST /auth/signup`/`bootstrap-admin.sql`, and no `tenant_id` anywhere in
the schema or API any more).

Once signed in, a user with `SUPER_ADMIN`, `IT_ADMIN`, or `DEPT_ADMIN` sees an
**Admin** button (top-right):
- **SUPER_ADMIN / IT_ADMIN / DEPT_ADMIN** create users and assign roles
  under the Users tab (`GET`/`POST /users`). Available roles come from the
  `roles` table (`HR_ADMIN`, `SALES_LEAD`, `CONTENT_CREATOR`, `APPROVER`,
  `DEPT_ADMIN`, `IT_ADMIN`, `SUPER_ADMIN`) — a user's permission flags
  (history window, revenue/integrations visibility, approval rights) are
  derived from that role, not set ad hoc per user.
- Every admin role sees and manages every user and every product company-
  wide (`PRODUCT_ADMIN_ROLES` in the code - renamed from
  `PRODUCT_TENANT_ADMIN_ROLES` when multi-tenancy was removed). A product
  can additionally be assigned to specific non-admin users via
  `product_members` - see "Products/Services" below.

Access tokens expire after 15 minutes; the frontend transparently exchanges
the 7-day refresh token for a new one via `POST /auth/refresh`, so a session
stays usable without re-entering a password until the refresh token itself
expires.

## Products/Services

Run `postgres/migrate-products-agents.sql` once if your database predates
this (same `docker exec ... psql` pattern as the other migrations).

Full hierarchy - company-wide (single company, no tenant scoping):

- **Any Admin role** (`SUPER_ADMIN`/`IT_ADMIN`/`DEPT_ADMIN`, collectively
  `PRODUCT_ADMIN_ROLES` in the code) creates **Products/Services**
  (`POST /products`) and assigns any user as that product's Admin
  (`POST /products/:id/members` with `role: "ADMIN"`).
- **Product/Service Admin** configures that product's social channels
  (`POST /products/:id/channels` - config storage only right now, see note
  below) and adds `MEMBER` users to run them (`POST /products/:id/members`
  with `role: "MEMBER"`) — any Admin role can do all of this too, for any
  product company-wide. Every product gets all 7 channels
  (`whatsapp, facebook, instagram, linkedin, youtube, quora, email`)
  pre-created as `not_configured` the moment it's created (`POST /products`
  does this in the same transaction as the product insert) — they're
  independent from every other product's channel rows (`UNIQUE(product_id,
  channel)`), so configuring one product's WhatsApp settings never touches
  another's.

Permission model: every product-scoped write (members/channels) accepts
either a company-wide Admin role or that specific product's own `ADMIN`
member (`canAdminProduct()`) - a Product Admin manages their own product
without needing a company-wide role.

**What this does NOT do yet, on purpose:**
- **No real social-media posting.** `product_channels.config` is just
  storage; there's no OAuth flow or platform API integration behind any
  channel. Every channel-posting mention elsewhere in this README/app is
  aspirational until specific platforms are integrated one at a time (each
  needs its own app registration/API credentials from you).
- **No Agents feature right now.** LLM-connection-backed Agents (create a
  connection, create an Agent, enable it on a Premium product, run it
  manually or automatically on lead intake) existed briefly and were
  removed from the UI/API for this version - deferred to a future one (see
  "Hardening notes" below). The `agents`/`llm_connections`/
  `product_agents`/`agent_runs` tables are untouched in the schema, so
  bringing this back is a routes/UI change, not a new migration. What
  Sarvam AI is used for today is smaller and different: classifying
  inbound lead messages as genuine inquiries (env-var configured, no admin
  UI) - see "Hardening notes" below and "Webhooks" above.

### Frontend UI

Deliberately built as new panels in the hand-written login/session-bar/admin
script (the same one behind Sign In, the Security button, and the existing
Admin panel) rather than by editing the compiled React bundle - that bundle
already caused one real syntax-breaking mistake earlier this session, and
this whole feature area has more moving parts than a single safe edit.

- **Products** button (session bar, next to Security - visible to everyone,
  since even a plain Member should see products they belong to) opens a
  list: any Admin role sees every product company-wide and can create new
  ones; everyone else sees only products they're a member of. Selecting one
  opens tabs for **Members** (add/remove, with a role picker - an Admin
  gets a dropdown of real company users via `GET /users`; a Product Admin
  without a company-wide role has to type a user's ID directly, since
  `GET /users` is gated to company-wide admin roles and a Product Admin
  usually isn't one) and **Channels** (per-channel status + a config note -
  no real platform config UI yet, matching the backend).

### Onboarding wizard

Auto-triggers once, right after login, for an admin whose company has
zero products yet (`GET /products` empty) — a 4-step modal: create the
first Product/Service &rarr; assign its Product Admin (dropdown of real
company users) &rarr; optionally configure one channel &rarr; done, with a
button straight into the Products panel. Skippable at every step; once
skipped or once a product exists, it never appears again (tracked in
`localStorage` — clearing site data or switching browsers will show it
again, which is harmless since it no-ops the moment a product already
exists).

## Navigation: Home / Inbox / Studio / Leads (real data, not the original mockup)

The React app (`frontend/app/src/App.jsx`) is a real top-nav-bar,
tab-based layout, not the original single-page mockup with one hardcoded
dashboard:

- **Home** (`Home.jsx`): the company-wide dashboard — your one company's
  name/plan badge (see "Hardening notes" below on the single-company
  model), total product and lead counts, and a card per product. Clicking
  a product card jumps straight to that product's Inbox.
- **Inbox** and **Leads** (both `MessagesPanel.jsx`, one component, two
  props): a three-column view — a left-hand channel filter for the
  selected product (from `GET /products/:id/channels`, merged with
  `GET /channels/spec` so every channel shows even if not yet
  configured), a middle list of leads/messages (`GET /leads`, scoped by
  `product_id` and optionally `channel`), and a right-hand thread view
  (`GET /leads/:id/messages`, reply via `POST /leads/:id/reply`). Leads
  differs from Inbox only by passing `inquiry_only=true`, which the API
  filters server-side using the Sarvam AI classification described below
  (`is_inquiry` — see "Hardening notes"); Inbox shows every message
  regardless of classification, and each lead row shows its
  Inquiry/Noise/unclassified badge either way.
- **Studio** (a `Studio` component defined inline in `App.jsx`, wrapping the existing
  `ContentPipeline` component): uploading calls `POST /content/upload`
  for the product selected in the nav bar; "Transform" calls
  `POST /content/:assetId/transform` with the channels you selected and
  shows the real variants it created (channel, spec, status) instead of
  fabricated thumbnails/sizes/durations — Paperclip doesn't generate real
  preview images accessible to the frontend, so there was no honest way
  to show those either. Approve/Reject/Request Change call
  `POST /content/variants/:variantId/approve` for real, looping over
  every variant from that transform.

All four tabs share one product selector in the nav bar (Home has none —
it's company-wide); switching products re-fetches that product's
channels/content/leads. The former tenant switcher (previously "Sharma
Industries" / "Gupta Tools") is gone — this app is a single company now,
so there is nothing to switch between; the header just shows your one
company's name.

The Premium "Multiuser → Multiagent" comparison panel referenced
elsewhere in the overlay is unchanged — it's informational/marketing copy
describing what the toggle does, not a data display.

The bundle's own event handlers reach the real API via
`window.__ORGCOMMS_API__` (path, opts) — exposed by the login/session
script for exactly this purpose — and `window.__ORGCOMMS_SESSION__`,
populated by the same pre-bundle script that seeds the initial company
state.

## Webhooks (company-wide, channel-scoped, so leads actually persist)

If your database already existed before this feature was added, run
`postgres/migrate-webhook-secret.sql` once (same `docker exec ... psql`
pattern as the bootstrap script) — it adds the `webhook_secret` column and
backfills a real secret (now on the singleton `company` row rather than
per-tenant - see "Hardening notes" below on removing multi-tenancy).

Inbound webhooks are URL-shaped as:

```
POST /webhooks/<webhook_secret>/<channel>
```

`<channel>` is one of `whatsapp, facebook, instagram, linkedin, youtube,
quora, email`. The secret is embedded in the path rather than a header
because most of these platforms' webhook config UIs only accept a plain
callback URL. A request with a wrong or missing secret gets `401`; an
unknown channel gets `404`.

A `SUPER_ADMIN` or `IT_ADMIN` gets the exact URLs to paste into each
channel's dashboard from the Admin panel's **Webhooks** tab (backed by
`GET /integrations/webhook-urls`), and can invalidate + reissue all of them
at once from the same tab if a URL ever leaks (`POST
/integrations/webhook-secret/rotate`).

A valid request is deduped (by phone/email against existing leads) and
inserted into `leads` directly — persistence no longer depends on the
Hermes queue consumer being up. It also runs real lead enrichment
(`api/src/lead-enrichment.js`) on any inbound message/note/text field -
script-level language detection and GSTIN extraction/checksum validation,
plus Sarvam AI inquiry classification if `SARVAM_API_KEY` is set (see
"Hardening notes" below) - and writes an inbound `lead_messages` row, all
synchronously in the request itself (nothing is queued to Hermes for this
any more - see "Hardening notes" on why the old `webhook:incoming`/
`lead_intake` auto-run-agent path was removed).

## Virus scanning (ClamAV)

`POST /leads/upload-csv` and `POST /content/upload` scan every uploaded file
against the `clamav` container before touching it — via `clamscan`'s
network mode, no local ClamAV binary needed in the `api` container, just
TCP to `CLAMAV_HOST:CLAMAV_PORT` (defaults to `clamav:3310`, already set in
`docker-compose.dokploy.yml`).

This fails **closed** by default: if ClamAV can't be reached or returns an
inconclusive result, the upload is rejected with `503` rather than treated
as clean. Check the `api` container's logs on startup — it logs `ClamAV
connected: <version>` if the connection works, or a clear warning if not.
An infected file is rejected with `400` and the matched signature name(s),
and is deleted rather than kept around.

Set `CLAMAV_REQUIRED=false` to disable scanning entirely (local dev without
a `clamav` container running) — don't set this in production.

## CORS (locked to your real frontend domain)

**You must set `APP_DOMAIN` in Dokploy's Environment tab now** (e.g.
`app.yourdomain.com`, no scheme) — this was already listed in
`.env.vps.example` but, until this fix, was never actually forwarded into
the `api` container, so it silently did nothing. It's now load-bearing: the
API only answers browser cross-origin requests from `https://<APP_DOMAIN>`
by default and rejects everything else. With `APP_DOMAIN` unset, **every**
browser request to the API — including from your own frontend — is
rejected, and the `api` container logs a warning saying so on startup.

Need more than one allowed frontend origin (staging, local dev)? Set
`CORS_ALLOWED_ORIGINS` to a comma-separated list of full origins (scheme +
host, e.g. `https://staging.yourdomain.com,http://localhost:5173`) — it
adds to `APP_DOMAIN` rather than replacing it.

Note: this only affects requests carrying a browser `Origin` header.
Server-to-server calls (`curl`, the webhook endpoints, `docker exec`,
health checks) aren't browser requests and are unaffected either way.

`API_DOMAIN` has the same "listed but never forwarded" bug fixed in the
same commit — it feeds the webhook URLs (`GET /integrations/webhook-urls`)
and `POST /integrations/reveal`'s webhook URL, both of which were silently
building relative URLs with no domain in front of them until now. Set it
too.

This deployment's actual values:
```
APP_DOMAIN=app.octaveaiautomation.com
API_DOMAIN=api.octaveaiautomation.com
```

## Branding

`frontend/octave-logo.png` (full lockup) and `frontend/octave-icon.png`
(icon mark only, cropped from the same source since the full lockup's text
isn't legible at favicon/badge sizes) are both copied into the nginx image
by `frontend/Dockerfile` — served at `/octave-logo.png` and
`/octave-icon.png`. Used for: the browser tab favicon, the header badge and
wordmark inside the main app bundle, and the login screen/session
bar/admin panel (the parts of the frontend outside that bundle). Replace
either file and redeploy to update the brand everywhere at once — nothing
else references the old placeholder "O" badge or "OrgComms" text anymore.

## Rate limiting

Nothing enforced this before — the original security docs assumed an nginx
layer that doesn't exist under Dokploy. Per-route limits (`express-rate-limit`,
keyed by client IP):

| Routes | Limit |
| --- | --- |
| `/auth/login`, `/auth/signup`, `/auth/refresh`, `/auth/2fa/verify`, `/auth/2fa/disable` | 10 / 15 min |
| `/leads/upload-csv`, `/content/upload` | 10 / min |
| `/webhooks/:webhookSecret/:channel` (both the main app and the separate webhook server) | 120 / min |
| everything else | 300 / min (global baseline) |

This requires `app.set('trust proxy', 1)`, also added — without it, every
request looks like it comes from Dokploy's Traefik (one shared IP for all
clients), which would make per-IP limiting useless and also make
`audit_logs.ip_address` record the proxy instead of the real client.
Already set on both the main app and the separate webhook server.

## Two-factor authentication (real TOTP, not a presence check)

Previously `/auth/login` only checked that a `totp` field was non-empty —
any value at all "passed". Now it's verified against a real per-user secret
(`otplib`, standard 30-second/6-digit TOTP, compatible with Google
Authenticator, Authy, 1Password, etc.).

2FA is opt-in for every role (not just Super Admin) — anyone can turn it on
for their own account from the **Security** button next to Logout:
1. **Enable 2FA** generates a secret and shows a QR code.
2. Scan it, then enter the 6-digit code to confirm — `two_fa_enabled` only
   flips on here, after the code checks out, so a QR that never got
   scanned (or was scanned wrong) can't lock you out on your next login.
3. Disabling requires your current password, so a hijacked but
   still-valid access token (15 min TTL) can't silently strip 2FA off the
   account.

If your database predates this feature, run `postgres/migrate-2fa-secret.sql`
once first (same pattern as the other migrations).

## User lifecycle: disable and admin-driven password reset

Two gaps that any real deployment with actual employees needs day one:
there was no way to lock a departed/compromised user out, and no way to
recover a forgotten password.

- **Disable/enable**: `PATCH /users/:userId/status { disabled: true|false }`
  (Admin roles only). A disabled user is rejected at
  `POST /auth/login` with a 403, even with the correct password and 2FA
  code — no partial session is ever issued. A manager can't disable their
  own account (prevents locking the whole company out with no recovery
  path). Wired up in the Admin panel's **Users** tab as a per-row
  Disable/Enable button with a `disabled` badge next to the email.
- **Password reset**: `POST /users/:userId/reset-password { new_password }`
  (Admin roles only). There's no email/SMS
  infrastructure in this system for a self-service "forgot password" link,
  so an admin sets a new password directly; tell the user to change it
  again after they log in. Wired up as a **Reset Password** button per row
  (prompts for the new password client-side, never displays or stores it
  anywhere but the one request).

If your database predates this feature, run
`postgres/migrate-user-disabled.sql` once first (same pattern as the other
migrations — adds `users.disabled BOOLEAN DEFAULT false`).

A third, user-initiated lifecycle action also exists: **self-service data
export and account erasure**, `GET /me/export` and `POST /me/erase`
(any logged-in user, own account only — no admin role needed), reachable
from the Security modal's "My Data" section. See "Hardening notes" below
for what erasure actually does (anonymize in place, not a hard delete)
and why.

## Testing

Two tiers, run differently, for a reason:

- **Unit tests** (`api/test/*.test.js`, 80 as of this writing): pure
  functions and routes tested against fake/mocked pg and Redis clients -
  no external dependency, run anywhere, always run by plain `npm test`.
  See "Added a real test suite, starting from zero" below for why most of
  `server.js` isn't in this tier.
- **Integration tests** (`api/test/integration/routes.integration.js`):
  the same app's real routes, but driven against a **real** Postgres and
  Redis - the things a mock genuinely cannot verify: that an admin sees
  every product while an unassigned `MEMBER` sees none, that the
  `audit_logs` `no_update_audit` trigger actually rejects an `UPDATE`,
  that the Redis-backed rate limiter actually blocks a client after 10
  requests (not just that it fails open when Redis is unreachable - the
  mocked-client tests in `rate-limiters.test.js` could only ever prove
  that half), that the full migration chain applies cleanly against a
  freshly-`init-secure.sql`'d database, and that `POST /me/erase`/`DELETE
  /leads/:id` genuinely mutate rows rather than just returning `{ erased:
  true }`.

  This file spawns the real `api/src/server.js` as a child process
  against whatever `DATABASE_URL`/`REDIS_URL` you give it, then drives it
  with real HTTP requests. It's **not** run by plain `npm test` - it
  self-skips with a clear reason if `DATABASE_URL`/`REDIS_URL` aren't
  set, so a laptop without a spare Postgres+Redis sees one skipped test,
  not a failure. To actually run it:

  ```sh
  # once, against a disposable database - never a real one, some of
  # these tests are destructive by design:
  psql -U orgcomms_test -d orgcomms_test -f postgres/init-secure.sql
  cd api && MIGRATIONS_DIR=../postgres node src/migrate.js

  DATABASE_URL=postgres://orgcomms_test:<password>@localhost:5432/orgcomms_test \
  REDIS_URL=redis://localhost:6379 \
  npm run test:integration
  ```

  `.github/workflows/api-tests.yml` runs both tiers on every push/PR now
  - the `integration-test` job spins up real `postgres:15-alpine` and
  `redis:7-alpine` service containers (matching
  `docker-compose.vps.yml`'s actual versions), applies the schema exactly
  the way a real deploy does (`init-secure.sql` then `migrate.js`), and
  runs this suite against them. This was previously a real gap - no
  Docker/Postgres/Redis was available in the environment these hardening
  passes were done in, so every fix up to this one could only be verified
  against mocks; this closes that gap for good, in CI, on every future
  change, not just as a one-off.

## Dependency note

`multer` was on the vulnerable 1.x line (`npm` flags known CVEs on install);
upgraded to 2.3.0. The upgrade is drop-in for how this app uses it
(`diskStorage`, `.single(fieldname)`, `limits`, `fileFilter`) — no other
code changes were needed.

## Hardening notes from a completeness audit

- **`/integrations/reveal` now actually verifies 2FA.** It previously only
  checked that a `totp` field was present (any value passed) — the same
  class of bug `/auth/login` had before real TOTP was added, just missed
  on this sibling route. It now requires the *caller's own* 2FA to be
  enabled (403 if not — reveal a raw integration API key without 2FA at
  all isn't acceptable) and verifies the code for real, logging
  `REVEAL_KEY_2FA_FAILED` on a bad attempt.
- **Removed a duplicate `/audit-logs` route.** Two near-identical handlers
  existed; Express only ever ran the first (Super-Admin-only, no `user_id`
  column), silently shadowing the second (which also allowed `IT_ADMIN`).
  Consolidated into one route that allows both roles and returns
  `user_id`.
- **Added `.dockerignore` to every service that does `COPY . .`** (`api`,
  `hermes`, `transformer`, `paperclip`) — without one, local
  `node_modules`/`.venv`/`.env` files could get baked into an image if
  someone builds from an unclean working tree. `frontend`'s Dockerfile
  copies only three named files, so it doesn't need one.
- **Deleted the orphaned `csv-handler/` service directory.** It was
  already removed from both compose files earlier (it never started a
  server or consumer loop, so it crash-looped in production — the CSV
  logic it duplicated already lives inline in `POST /leads/upload-csv`),
  but the unused source directory itself was left behind. Removed to stop
  it from being audited/patched as if it were live code.
- **Real dependency vulnerabilities fixed, not just flagged:**
  - `csv-parse` bumped 5.x → 7.0.2 in `api` — the 5.x line has a known
    prototype-pollution issue reachable through the `columns` option
    (GHSA-8cw4-87c7-c6xx), and `POST /leads/upload-csv` parses
    user-uploaded CSVs with exactly that option (`columns: true`) to turn
    header rows into object keys. Verified the sync API and `columns: true`
    behavior are unchanged in 7.0.2 (including that a header literally
    named `__proto__` parses to a plain data key, not a prototype write).
  - `qs` (pulled in transitively by `express`) pinned to `^6.16.0` via a
    `package.json` `overrides` entry — `npm audit fix` alone can't move it
    because `express` itself declares a narrower `~6.15.1` range.
  - `uuid` bumped 9 → 11 (only the `v4()` export is used here, which is
    unaffected by the underlying advisory, but the upgrade was a drop-in
    no-op so there was no reason not to take it).
  - `npm audit` is clean (0 vulnerabilities) across `api`, `hermes`, and
    `transformer` as of this pass.
- **Removed the orphaned `csv-handler/` directory outright** (see above)
  rather than just patching its `csv-parse` too, since it was already dead
  weight not built by either compose file.
- **Checked in `package-lock.json` for `api`, `hermes`, and `transformer`.**
  None of the three had one — every deploy was resolving each dependency's
  latest matching version fresh at build time, so a build today could pull
  different transitive versions than a build tomorrow with zero code
  changes (or a build that worked yesterday could break tomorrow). Also
  switched their Dockerfiles from `npm install --omit=dev` to
  `npm ci --omit=dev`, which fails loudly if `package.json` and the
  lockfile ever drift apart instead of silently resolving around it.
- **Pinned `paperclip/requirements.txt`** — `fastapi`, `uvicorn`, `Pillow`,
  and `python-multipart` had no version constraints at all, so every image
  build re-resolved to whatever was current on PyPI that day. Pinned to
  the versions actually verified against this build (`fastapi==0.141.1`,
  `uvicorn==0.52.4`, `Pillow==12.3.0`, `python-multipart==0.0.32`).
- **Fixed a real double-tmpfs-mount bug in `docker-compose.vps.yml`.**
  `paperclip-transformer` mounted `/app/cache` as both a `tmpfs` entry and
  the persistent `paperclip_cache` volume — Docker Compose rejects that
  outright (`target already mounted`). This exact bug had already been
  found and fixed in `docker-compose.dokploy.yml` earlier, but the fix was
  never carried over to this file; anyone deploying straight from
  `docker-compose.vps.yml` (bypassing Dokploy) would have hit it. Verified
  both compose files now parse cleanly with `docker compose config`.
- **Added healthchecks so `depends_on` means something.** Neither
  `postgres` nor `redis`'s official images ship a built-in `HEALTHCHECK`,
  so `depends_on: [postgres, redis, clamav]` was only ever waiting for
  those containers to *start*, not for Postgres/Redis to actually be
  accepting connections — `api` could come up and start serving requests
  during that gap. Added real healthchecks (`pg_isready`, `redis-cli
  ping`, plus one for `frontend` and `paperclip-transformer`, which had
  none) and switched every `depends_on` to
  `condition: service_healthy` where a healthcheck now backs it. `clamav`
  already ships its own healthcheck (`clamdcheck.sh`, confirmed by
  inspecting the actual image config) so it needed no override, just the
  `condition: service_healthy` wiring on the services that depend on it.
  Applied identically to both compose files.
- **Added the missing `content_variants` indexes.** It had nothing beyond
  its primary key, so every lookup by `asset_id` (`GET
  /products/:id/content`, the publish route, the transform route's
  post-resize `UPDATE`) and every RLS/tenant-scoped query was a sequential
  scan — fine today, a real cost as it grows. Added
  `postgres/migrate-content-variants-indexes.sql` (registered in
  `api/src/migrate.js`) and the same two indexes directly in
  `init-secure.sql` for fresh installs.
- **`hermes-orchestrator` had no healthcheck at all.** It's a background
  worker with no HTTP server, so `restart: unless-stopped` only caught an
  actual process crash, not a hang (stuck on something that never resolves
  or rejects, with no error to log). It now writes a heartbeat file once
  per loop iteration (every ~2s in the healthy case — two sequential
  `brPop` calls with 1s timeouts each), and `hermes/Dockerfile`'s
  `HEALTHCHECK` fails once that file goes stale.
- **Added `scripts/smoke-test.sh`.** There's no test suite in this repo at
  all yet — this isn't one either, but it's a fast, dependency-free check
  you can run right after a deploy (`./scripts/smoke-test.sh
  https://api.yourdomain.com`) to confirm `/health` reports Postgres and
  Redis are actually reachable, and that the auth/RBAC boundaries on a
  handful of representative routes (`/leads`, `/users`, `/auth/login`, the
  internal publish route) still reject the way they're supposed to.
- **Fixed stored/reflected XSS across the hand-written frontend.** Nothing
  in `frontend/index.html`'s vanilla-JS chrome (login, top bar, Admin,
  Products, the Content tab, the Agents/LLM-connections panels) escaped
  dynamic values before splicing them into `innerHTML` — a product name, an
  uploaded file's original filename, a tenant/company name from signup, a
  member's email, an LLM connection name, or even a server error message
  that echoes back raw request input (e.g. `` `Unknown channel: ${channel}` ``)
  would all execute as markup if they contained HTML. Added a shared
  `esc()` helper and applied it at every such site. (The separate,
  minified React bundle mounted at `#root` is out of scope, as always — no
  source is available for it in this repo.)
- **Finished the light/dark theme conversion.** A handful of inline
  `style="color:..."` values in JS-generated markup (the 2FA panel, agent
  run cards, empty-state table rows, the Content tab's Agents/LLM
  Connections headings) were still hardcoded dark-theme colors left over
  from before the theme system existed — invisible-on-white in light mode.
  Switched to the same `var(--oc-*)` custom properties the rest of the UI
  uses.
- **`JWT_SECRET` and `ENCRYPTION_KEY` used to fail silently, not loudly.**
  Every call site did `process.env.JWT_SECRET || 'dev-secret-change-me'`
  (and the same shape for `ENCRYPTION_KEY`) — if the VPS's `.env` was ever
  missing that line, or the value came through empty (a blank env var is
  falsy in Node), the API would boot without complaint and run on a
  hardcoded default that's sitting in this public source file. That means
  forgeable JWTs for any tenant/role, or a decryptable key for everything
  `ENCRYPTION_KEY_BUF` protects (stored LLM API keys, webhook secrets),
  with no error anywhere pointing at the cause. Added a
  `requireSecretOrExit()` startup guard: with `NODE_ENV=production` (which
  `docker-compose.vps.yml` always sets), a missing/empty value now exits
  the process with a clear message instead of starting; outside production
  it still falls back for local dev, but logs a loud warning. All 7 former
  inline fallbacks now go through the same resolved `JWT_SECRET_VALUE` /
  `ENCRYPTION_KEY_VALUE` constants.
- **The frontend's HTML page had no CSP, and no HSTS/X-Frame-Options/
  X-Content-Type-Options either.** Those headers existed on the
  `api.yourdomain.com` nginx server block, but the separate
  `app.yourdomain.com` block that actually serves `frontend/index.html` —
  where the XSS fixes above apply — had none of them. Added the same
  three headers there, plus `Referrer-Policy`, plus a real
  `Content-Security-Policy`. `frontend/index.html`'s 4 inline `<script>`
  blocks are static (no per-request templating — nginx just serves the
  file), so `script-src` uses exact `sha256-...` hashes of each block
  instead of `'unsafe-inline'`: an injected inline `<script>` (exactly the
  class of bug just fixed at the application layer) now fails to execute
  even if it somehow got past escaping, giving CSP its intended job as a
  second line of defense rather than a header that quietly allows
  anything. `style-src` keeps `'unsafe-inline'` (~50 inline `style="..."`
  attributes across dynamically-built rows make per-attribute hashing
  impractical, and it's a materially lower-severity primitive than inline
  script). Added `scripts/gen-csp-hashes.sh` to regenerate the four hashes
  whenever an inline `<script>` block's content changes — the deploy
  checklist in this README should run it before any frontend release that
  touches the hand-written `<script>` code, and paste the output into
  `nginx/orgcomms-vps.conf`'s `app.yourdomain.com` block.
- **Disabling a user didn't actually stop them if they already had a
  refresh token.** `POST /auth/login` already refused a `disabled` user,
  but `POST /auth/refresh` didn't check the flag at all — it just verified
  the refresh token's signature and looked the user up. A disabled user's
  still-valid 7-day refresh token could keep minting fresh 15-minute access
  tokens indefinitely, making "disable this account" a no-op against
  anyone who was already logged in. `/auth/refresh` now checks `disabled`
  too, so a disabled user's access dies within at most 15 minutes (the
  bound already accepted for a stolen/expiring access token) instead of
  up to 7 days.
- **Unexpected-error responses were leaking raw Postgres/driver messages to
  the client.** ~50 routes shared the same `catch(e){
  res.status(500).json({ error: e.message }); }` shape — the generic
  "something unexpected happened" fallback path, as opposed to the
  deliberately-thrown, already-friendly errors those same routes surface
  through their own explicit 400/403/409 checks. A raw driver error's
  `.message` can include column/constraint/table names or other schema
  internals (e.g. `duplicate key value violates unique constraint
  "users_email_key"`) that shouldn't reach an API response. Added a shared
  `serverError(res, e)` helper — always logs the full error server-side,
  but in production (`NODE_ENV=production`, which `docker-compose.vps.yml`
  always sets) responds with a generic `Internal server error` instead of
  `e.message`; outside production it still returns the real message, since
  that's more useful for local debugging than the disclosure risk. Routes
  that deliberately craft a user-facing error message (validation
  failures, "email already exists", channel-publish failures, etc.) were
  left untouched — only the generic catch-all path changed. `/health`'s
  own `error: e.message` was also left as-is; it's meant to report *why*
  a dependency is unreachable for anyone watching uptime, not app data.
- **Neither `api` nor `hermes-orchestrator` handled `SIGTERM`.** Every
  redeploy sends it, then SIGKILLs after Docker's default 10s grace period
  — with no handler, that meant in-flight HTTP requests got cut off
  mid-response on every single deploy (not just a crash), and
  `hermes-orchestrator`'s loop (including whatever `runAgent()` call was
  mid-flight — a real HTTP call to `api`, or the gap between a destructive,
  non-acked `BRPOP` and finishing the job it just popped) could be killed
  at any point in its cycle, routinely. Added graceful shutdown to both:
  `api` now stops accepting new connections on `SIGTERM`/`SIGINT`, lets
  in-flight requests on both its HTTP servers finish, then closes the
  shared pg pool and Redis client (with a 9s internal force-exit timer so
  a stuck connection can't hang it past that); `hermes-orchestrator` checks
  a shutdown flag at the top of each loop iteration and exits cleanly once
  the current iteration finishes. `docker-compose.vps.yml`'s
  `stop_grace_period` bumped to `15s` for both so Docker's SIGKILL isn't
  racing the graceful path under normal conditions. This doesn't make the
  underlying Redis queues reliable — `BRPOP` still has no ack, so a crash
  (as opposed to a normal SIGTERM'd redeploy) mid-processing still loses
  that one job; that would need a bigger change (`BRPOPLPUSH` + an explicit
  ack/re-queue step) that's out of scope here.
- **Container logs had no size cap.** Docker's default `json-file` driver
  keeps every line forever unless told otherwise, and `api` alone logs
  every request via `morgan('combined')` — on a long-running VPS that
  grows without bound and can eventually fill the disk, which takes down
  every service on the box at once (including Postgres), not just the
  noisy one. Added a shared `x-logging` anchor in `docker-compose.vps.yml`
  (`json-file`, `max-size: 10m`, `max-file: 5` — 50MB of history per
  container) applied to all 8 services.
- **Backups had no off-host copy.** `postgres-backup`'s daily `pg_dump`
  writes into the `pgbackups` Docker volume, which lives on the same VPS
  disk as the database it's backing up — real protection against a bad
  migration or a fat-fingered `DELETE`, but none at all against disk
  failure, the VPS provider having an outage, or an accidental `docker
  volume rm`. `postgres/backup/backup.sh` now supports optional off-host
  shipping via `rclone` (any of its ~70 supported storage backends - S3,
  Backblaze B2, a second VPS over SFTP, etc.) right after each local
  backup succeeds; a shipping failure is logged as a warning and never
  deletes or skips the local copy, so it degrades to exactly today's
  behavior rather than breaking the backup job. It's opt-in, not wired up
  automatically, since it needs your own object-storage credentials. To
  turn it on:
  1. Add `rclone` to `postgres/backup/Dockerfile` (`RUN apk add --no-cache
     dcron rclone`, alongside the existing `dcron` install).
  2. Create an `rclone.conf` for your remote (see
     [rclone's docs](https://rclone.org/docs/#configure)) and mount it
     read-only into the container, e.g. add
     `- ./rclone.conf:/root/.config/rclone/rclone.conf:ro` under
     `postgres-backup`'s `volumes:` in `docker-compose.vps.yml`.
  3. Set `RCLONE_REMOTE` in your `.env` (e.g. `RCLONE_REMOTE=s3:my-bucket/orgcomms-backups`)
     — already passed through to the container, so this step alone is what
     turns shipping on once the first two are done.
  Leave `RCLONE_REMOTE` unset (the default) and nothing changes: backups
  stay exactly as local-only as they are today.
- **Cross-tenant privilege escalation via role assignment (the most
  serious finding of this pass).** `USER_MANAGER_ROLES` (`SUPER_ADMIN`,
  `IT_ADMIN`, `DEPT_ADMIN`) can all call `POST /users` and `PATCH
  /users/:userId/role` — but `IT_ADMIN` and `DEPT_ADMIN` are meant to be
  *tenant-scoped* admins, while `SUPER_ADMIN` reaches across every tenant
  on the platform (`POST`/`GET /tenants`, platform-wide LLM connections
  and agent definitions — see the `SUPER_ADMIN`-only routes). Neither
  route checked what role the *caller* was allowed to grant: any tenant's
  `IT_ADMIN` (or `DEPT_ADMIN`) could create a brand-new user with `role:
  "SUPER_ADMIN"`, or promote an existing one, and that account would then
  have full platform-wide reach — every other tenant's data, the ability
  to create new tenants, and control of every LLM connection and agent
  definition on the install. This wasn't a misconfiguration or an edge
  case; it was reachable by design in the default deployment, by the
  lowest-privileged role that can manage users at all. Both routes now
  reject (`403`, audit-logged as `RBAC_BLOCKED`) an attempt to grant the
  `SUPER_ADMIN` role from any caller who isn't already a `SUPER_ADMIN`
  themselves. `IT_ADMIN`/`DEPT_ADMIN` granting each other's roles is left
  alone — the `roles` table gives `IT_ADMIN` the same tenant-level
  permission flags as `SUPER_ADMIN` already, so that doesn't cross a
  privilege boundary the way reaching into another tenant does.
- **`POST /content/upload` could leak an orphaned file on disk.** Multer
  writes the uploaded file to `/app/recordings` before the route handler
  even runs, so any failure between that point and the `content_assets`
  INSERT succeeding left a file on disk with no DB row pointing at it —
  and nothing else in this codebase ever cleans up a file like that. Two
  paths could hit this: an invalid `product_id` (checked but didn't clean
  up before returning 400) and the generic catch-all (any thrown error
  after a successful virus scan, e.g. the INSERT itself failing, left the
  file behind silently). Uploads here can be up to 100MB each, so repeated
  failures — a bad `product_id`, a transient DB hiccup — could grow this
  the same unbounded way the container-logs issue above could. Both paths
  now unlink the file before returning/re-throwing.
- **Added a real test suite, starting from zero.** This repo had no
  automated tests at all - `scripts/smoke-test.sh` is a post-deploy curl
  check, not a test suite, and every fix in this "Hardening notes" section
  up to now was verified by hand (`node --check`, a manual repro, reading
  the diff) rather than by a test that keeps checking it. Most of
  `api/src/server.js` isn't safely unit-testable as-is - it's a monolithic
  file that connects to Postgres/Redis and calls `app.listen()` as a side
  effect of being required, so testing it would mean either spinning up
  real infrastructure or a larger refactor, neither of which fits this
  pass. `api/src/channels.js` is different: it's already a clean,
  side-effect-free module (no DB/network connection on require, secrets
  passed in as injected encrypt/decrypt functions rather than reaching for
  real crypto), so it's where a real suite could start without touching
  anything else. Added `api/test/channels.test.js` (13 tests, using
  Node's built-in `node:test` - no new dependency to add or keep patched)
  covering config validation (missing/blank required fields, the
  unknown-channel and unimplemented-channel cases), the
  encrypt/mask/decrypt round-trip (including that masking never fakes a
  value for an empty secret), and `publishToChannel` refusing an
  unimplemented channel with a clear error rather than a silent fake
  success - the exact bug class this same audit found and fixed in
  Paperclip's old `/transform` endpoint earlier. One test
  (`CHANNEL_SPECS keys match the channel vocabulary...`) directly pins the
  channel-vocabulary bug fixed earlier in this file's history
  (`content_variants.channel` vs `product_channels.channel` using two
  different vocabularies) so it can't silently regress. Run with `npm
  test` from `api/`; `api/Dockerfile` now also runs it during the image
  build (`RUN npm test`, right after `COPY . .`), so a regression here
  fails the build instead of reaching production.
- **Extracted two more pure pieces of `server.js` into their own,
  testable modules.** `normalizeDomain`/`sanitizeCSVValue` (small string
  helpers) and the zod `schemas` object (request-body validation for 10
  routes) had no dependency on anything stateful - they just weren't
  reachable from a test without requiring `server.js` itself, which isn't
  safe (it opens DB/Redis connections and calls `app.listen()` as a side
  effect of being loaded). Moved them to `api/src/validators.js` and
  `api/src/schemas.js` respectively, `require()`d back into `server.js`
  with identical behavior (verified with `node --check` and a full
  `npm test` run before and after) - nothing about how any route validates
  or behaves changed, only where the code lives. Added
  `api/test/validators.test.js` (CSV-formula-injection prefixing, HTML
  stripping, domain normalization) and `api/test/schemas.test.js`
  (password length, email/UUID/enum validation per schema, and - mirroring
  the `CHANNEL_SPECS` test in `channels.test.js` from the other side - a
  test pinning `transformContent`'s channel enum against the old,
  disconnected channel vocabulary so the two copies of that list can't
  silently drift apart again). The suite is now 31 tests across 3 files,
  still all built-in `node:test` with zero new dependencies.
- **Extracted and tested the AES-256-GCM secret-encryption helpers.**
  `encryptSecret`/`decryptSecret` in `server.js` are what every stored
  secret in this app goes through - LLM provider API keys, channel access
  tokens, SMTP passwords - but they closed over a module-level
  `ENCRYPTION_KEY_BUF` derived from `requireSecretOrExit()`, so testing
  them meant either requiring the real `ENCRYPTION_KEY` env var or
  requiring `server.js` itself (unsafe - see above). Moved the actual
  AES-256-GCM logic to `api/src/crypto-secrets.js` as pure functions that
  take the key buffer as a parameter (the same dependency-injection
  pattern `channels.js` already used for these two functions), and
  rebound `encryptSecret`/`decryptSecret` in `server.js` to call it with
  the real key - every call site keeps its original single-argument
  signature, nothing about how secrets are stored changed. Added
  `api/test/crypto-secrets.test.js` (7 tests, throwaway test key) that
  goes beyond "it round-trips" to pin the actual security properties an
  authenticated cipher is supposed to give: decrypting with the wrong key
  throws, a single flipped byte anywhere in the ciphertext or the auth tag
  fails to decrypt rather than silently returning corrupted output, and
  encrypting the same plaintext twice never produces the same ciphertext
  (the random IV, without which two channels sharing one access token
  would leak that they're equal just by comparing stored ciphertext).
  Suite is now 38 tests across 4 files.
- **Extracted and tested the CSV lead-import sanitize/validate/dedup
  logic.** `POST /leads/upload-csv` ran column-name normalization,
  per-value sanitization, email validation, and phone+email
  deduplication inline in the route handler - real logic worth testing on
  its own, but only reachable before now by actually uploading a CSV to a
  running server. Moved it to `api/src/csv-leads.js`
  (`sanitizeCsvRecord`/`processLeadCsvRecords`, pure functions - no DB or
  file-system access) and wired the route to call it, same behavior,
  verified with `node --check` and a full `npm test` run. Added
  `api/test/csv-leads.test.js` (9 tests): column-name normalization across
  inconsistent header styles, a malformed email correctly counted invalid
  rather than inserted, case-insensitive phone+email deduplication (and
  the inverse - that sharing only *one* of phone or email across two rows
  is correctly NOT treated as a duplicate), the recognized phone-column
  aliases (`phone`/`mobile`/`phone_number`), and an empty file. One test
  also pins that a phone number starting with `+` still goes through the
  same CSV-formula-injection guard as every other field, since `+` is one
  of the characters that guard exists for. Suite is now 48 tests across 5
  files.
- **Wired the test suite into actual CI.** All 48 tests were already a
  hard gate at Docker build time (`api/Dockerfile`'s `RUN npm test`), but
  that only catches a regression at deploy time - after it's merged, not
  before. Added `.github/workflows/api-tests.yml`: runs `npm test` on
  every push to `main` and every pull request that touches `api/**`, using
  `actions/setup-node` with the same Node 20 the Dockerfile builds on. No
  Postgres/Redis service containers needed - every test in this suite is a
  pure-function unit test by design (see the extraction work above), so
  there's nothing stateful for CI to provision. A broken PR now fails
  visibly before merge instead of only being caught at the next deploy.
- **Extracted and tested the RBAC decision logic itself, including a
  direct regression test for the cross-tenant privilege-escalation fix
  above.** `userClaims` (JWT claims shaping), the `roleOrFlag()`
  middleware's core role-or-flag check, and the `canGrantRole` check added
  earlier in this pass (only a Super Admin can grant the Super Admin
  role) were all inline in `server.js` - correct, but only verified by
  hand when they were written. Moved the pure decision logic to
  `api/src/rbac.js` (`userClaims`, `hasRoleOrFlag`, `canGrantRole`) and
  rebound the three call sites in `server.js` to it, identical behavior,
  verified with `node --check` and a full `npm test` run (57/57 passing)
  before and after. Added `api/test/rbac.test.js` (9 tests) - most
  importantly, `canGrantRole` now has a fast, direct test pinning the
  exact privilege-escalation scenario the earlier fix closed (`IT_ADMIN`/
  `DEPT_ADMIN`/any other role attempting to grant `SUPER_ADMIN` must
  return `false`), so that fix can never silently regress without a test
  failing immediately, rather than relying on someone noticing in
  production again. Suite is now 57 tests across 6 files.
- **Added observability: request/latency/error metrics and optional error
  tracking.** Before this, the only way to know the API was unhealthy was a
  Docker healthcheck failing (`/health`, DB+Redis only) or someone noticing
  a problem in production and grepping container logs after the fact -
  nothing recorded request volume, latency, or error rate over time, and
  no unhandled exception was captured anywhere beyond `console.error`.
  Added two pieces:
  - `api/src/metrics.js`: a small, dependency-free Prometheus-format
    metrics module (counters + one latency histogram), deliberately
    hand-rolled instead of adding `prom-client` - the app's needs here are
    a handful of series, and this keeps it fully unit-testable as pure
    functions with no new dependency to trust. Wired into `server.js` as
    a request-timing middleware (records method/route/status/duration on
    every response's `finish` event, using the matched Express route
    pattern so `/users/:userId` doesn't fragment into one series per user
    id) and exposed at `GET /metrics`. `serverError()` now also increments
    an `orgcomms_errors_total` counter, so every 500 it handles is
    reflected there. **Not publicly reachable** - `nginx/orgcomms-vps.conf`
    explicitly denies `/metrics` on the public `api.*` server block, since
    request-volume/route fingerprints are a minor leak with no upside if
    left open; it's meant to be scraped from inside the Docker network
    (a Prometheus container joined to the same compose network, or
    `docker exec <api container> wget -qO- http://localhost:3000/metrics`).
  - `api/src/error-tracking.js`: optional Sentry integration, following
    the same pattern as the off-host backup shipping in
    `postgres/backup/backup.sh` - entirely inert unless `SENTRY_DSN` is
    set (see `.env.vps.example`), and any failure to initialize or report
    (bad DSN, Sentry unreachable) is caught and logged, never thrown -
    error tracking losing an error is bad, but nowhere near as bad as the
    API refusing to boot or a request failing because the error *reporter*
    broke. `serverError()` now calls `captureError(e)` on every 500 it
    handles, so with a DSN configured, unhandled errors show up in Sentry
    with a stack trace instead of only ever existing in a log line that
    scrolls away. Added `@sentry/node` as a real dependency (used only
    when `SENTRY_DSN` is set) and `SENTRY_DSN` as an optional pass-through
    env var in `docker-compose.vps.yml`. Both modules verified with
    `node --check`, a full `npm test` run, and 13 new tests
    (`api/test/metrics.test.js`, `api/test/error-tracking.test.js`) -
    including that a malformed `SENTRY_DSN` is caught rather than crashing
    startup, and that `captureError` never throws when tracking is
    disabled. Suite is now 70 tests across 8 files.
- **Rebuilt the frontend's React app from real, buildable source - and
  fixed the dark/light theme not applying to it.** `frontend/index.html`
  used to contain a fully-built, minified React + Tailwind bundle
  (~200KB of compiled JS) with no source anywhere in the repository -
  any change meant hand-editing compiled output, and it couldn't be
  audited or rebuilt. Investigating a report that the site's dark/light
  theme toggle didn't affect this app's screens confirmed why: the
  toggle sets a `data-theme` attribute on `<html>` (see
  `frontend/overlay.html`), but the old bundle never referenced
  `data-theme` anywhere, never added Tailwind's `dark` class to
  anything (Tailwind here uses the `.dark *` class-strategy selector,
  not a media query), and its compiled CSS had exactly 2 `dark:`
  utility rules in the whole 200KB+ file. Toggling the theme visibly
  re-themed the auth gate and admin panel and did nothing to the actual
  product screens underneath.
  - Added `frontend/app/`: a real Vite + React + Tailwind project (see
    `frontend/app/README.md` for the full architecture). Every
    component uses paired light/dark Tailwind classes, and
    `frontend/app/src/lib/theme.js` bridges the site's `data-theme`
    attribute onto Tailwind's `dark` class via a `MutationObserver`,
    which is the piece that was simply never wired up before.
  - The old bundle also made zero real API calls (no `fetch`, no
    `axios`, no `XMLHttpRequest` anywhere in it) - it was a static,
    unwired mockup sitting on top of a fully functional backend.
    `frontend/app/src/lib/api.js` wires it to the real API (products,
    content upload/transform/approve, channel specs, leads,
    integrations), sharing the same `localStorage` session and 401 ->
    refresh -> retry logic as `frontend/overlay.html`'s own `api()`
    helper, so both halves of the page share one session lifecycle.
  - `frontend/index.html` is now **generated**, not hand-edited:
    `frontend/app/scripts/assemble.js` runs after `vite build` and
    splices the built (external, hashed) `<script>`/`<link>` tags into
    `frontend/overlay.html` - which is preserved byte-for-byte, still
    the hand-written source of truth for the auth gate, admin panel,
    products/channels/onboarding/security UI. `frontend/index.html` is
    now gitignored (Docker builds it fresh every time - see below) so
    it can't go stale relative to its real source the way a committed
    copy eventually would have.
  - `frontend/Dockerfile` is now a real multi-stage build (`node:20-alpine`
    build stage running `npm ci && npm run build`, then the built output
    copied into the `nginx:alpine` stage) instead of just copying a
    pre-built file into the image.
  - Because the built React bundle is now an external same-origin
    `<script src>` instead of inline, it needs no CSP hash at all
    (`script-src 'self'` already covers it) - `nginx/orgcomms-vps.conf`'s
    CSP dropped from 4 sha256 hashes to 3 (the two small bootstrap
    scripts plus `overlay.html`'s own script, all still inline and still
    exact-hash-pinned, same reasoning as before).
  - Verified with a clean `npm ci && npm run build` (both directly and
    simulated through the exact multi-stage Docker layout) producing a
    valid, byte-checked assembled `index.html` before this was written
    back to the repo.
- **Made rate limiting Redis-backed, for real horizontal-scaling
  readiness.** All four `express-rate-limit` limiters (`authLimiter`,
  `uploadLimiter`, `webhookLimiter`, `generalLimiter`) used the package's
  default in-memory store - fine with exactly one `api` replica (which is
  all `docker-compose.vps.yml` runs today), but a silent trap the moment
  it's ever scaled beyond that: each replica keeps its own separate
  count, so N replicas means the *effective* limit becomes N times what's
  configured, with nothing anywhere to warn about it. Added
  `api/src/rate-limiters.js` (`createLimiters(redisClient)`), backing all
  four with `rate-limit-redis` against the same Redis client `server.js`
  already holds open - the limit is now real regardless of replica count.
  `passOnStoreError: true` keeps the same fallback the in-memory store
  implicitly had: if Redis is unreachable, requests fail *open* (allowed
  through, un-limited) rather than every request 500ing - losing rate
  limiting during a Redis outage is the same risk this app already had
  before Redis was in the loop here at all; turning a Redis blip into a
  full API outage would be strictly worse.
  Writing the real test for this (`api/test/rate-limiters.test.js`,
  spinning up a real Express server per test and driving it with `fetch`,
  since a full real-Redis integration harness isn't available in this
  environment at the time - see "Testing" above, now fixed) caught
  a genuine bug before it shipped: `rate-limit-redis`'s `RedisStore`
  constructor eagerly fires an *unawaited* `SCRIPT LOAD` promise, which
  becomes an unhandled promise rejection (able to crash the whole process
  under Node's default policy) if Redis isn't reachable at that exact
  instant - including at server boot, before `redisClient.connect()` has
  necessarily resolved. `rate-limiters.js` now explicitly marks those
  promises handled (without consuming them - `rate-limit-redis`'s own
  later `await` inside `retryableIncrement` still sees the same
  rejection, which is what `passOnStoreError` actually catches) so a
  slow-to-connect or briefly-down Redis at startup can no longer take the
  API down with it. Suite is now 74 tests across 9 files.
- **Made the Postgres connection pool's size an explicit, documented
  setting instead of an invisible library default.** `new Pool({...})` in
  `api/src/server.js` never set `max`, so it silently used
  node-postgres's own built-in default of 10 connections - fine as a
  number, but nobody deploying this would know it exists or how to
  change it, and getting it wrong in either direction is a real failure
  mode: too low and requests queue or time out waiting for a free client
  under load; too high and this one service can exhaust Postgres's own
  `max_connections` (default 100) once it isn't the only thing
  connecting (`migrate.js`, `psql`/backup tooling, etc. all count against
  the same limit). Added `DB_POOL_MAX` (default 10, unchanged behavior),
  `DB_POOL_IDLE_TIMEOUT_MS` (default 30000) and
  `DB_POOL_CONNECTION_TIMEOUT_MS` (default 5000) as optional env vars,
  documented in `.env.vps.example` and wired through
  `docker-compose.vps.yml`. Defaults are unchanged from what node-postgres
  already did, so this is purely making an existing default visible and
  tunable, not a behavior change on its own.
- **Added a disaster recovery runbook (`docs/disaster-recovery.md`).**
  This repo already had real backup/restore tooling
  (`postgres-backup` sidecar, `scripts/backup-vps.sh`/`restore-vps.sh`)
  but no single document tying it together into "the VPS is gone, now
  what" steps, and no accounting of what *isn't* covered. Written from
  what's actually in the compose file and scripts, not an idealized
  setup - it flags two real gaps found while writing it: `.env.production`
  (and therefore `ENCRYPTION_KEY` - unrecoverable if lost, since it's
  what integration secrets in Postgres are encrypted with) has no backup
  anywhere outside the VPS itself, and Redis (`redisdata`) holds real
  in-flight job queues (`sarvam:queue:*`, `publisher:queue`,
  `webhook:incoming` - see `api/src/server.js`'s `redisClient.lPush`
  calls), not just cache, with no backup and no scripted recovery for
  jobs stranded mid-queue if it's lost.
- **Basic accessibility pass on the overlay UI
  (`frontend/overlay.html`).** This is the hand-written vanilla-JS app
  (auth gate, top bar, admin panel, products/channels/onboarding/security
  modals) that owns most of the interactive surface - it had almost no
  ARIA beyond a handful of `alt` attributes on images. Fixed, all
  additive (no markup restructuring, no behavior change - every existing
  `id`/`class` a JS `getElementById`/`querySelector` or CSS selector
  depends on is untouched):
  - The five `&times;` icon-only close buttons and the emoji-only theme
    toggle had no accessible name at all - a screen reader announced
    them as "button" with no indication of what they do. Added
    `aria-label="Close"` / `aria-label="Switch theme"`.
  - The 2FA setup QR code `<img>` had no `alt` text - added one
    describing what it is, not just that it's an image.
  - The six modal overlays (security/2FA, onboarding, products, channel
    wizard, admin) are created via `document.createElement('div')` and
    never marked as dialogs - added `role="dialog"` +
    `aria-modal="true"` via `setAttribute` right after each one's `id`
    is set.
  - The ~20 inline status/error message containers (`.oc-err`,
    `.oc-msg`/`.oc-msg.oc-full`) update via `.textContent`/`.innerHTML`
    with nothing telling assistive tech that content changed - added
    `role="alert" aria-live="assertive"` to the error containers and
    `aria-live="polite"` to the general status ones, so a screen reader
    announces a validation error or a completed action without the user
    needing to go find it.

  Changing `overlay.html`'s inline `<script>` content changes its CSP
  sha256 hash (see `nginx/orgcomms-vps.conf`'s `script-src`) -
  regenerated via `scripts/gen-csp-hashes.sh` and updated; the two
  bootstrap-script hashes were unaffected since only `overlay.html`
  changed, not `frontend/app/scripts/assemble.js`. Verified with a clean
  `npm run build` producing valid HTML (`html.parser` round-trip) and
  syntactically valid JS (`node --check` on the extracted inline
  script), and by diffing the built asset hashes to confirm the React
  app itself (`frontend/app/src/`) was untouched.

  This is a first pass, not a full audit - form `<input>`s still rely on
  `placeholder` text rather than associated `<label>` elements in most
  of this file, which is a larger, riskier rewrite of markup structure
  better done as its own follow-up.
- **Implemented real YouTube publishing; left Quora as a documented,
  permanent gap.** `api/src/channels.js` previously marked both
  `youtube` and `quora` `implemented: false`. They're not the same kind
  of gap: Quora has no public API for posting content at all - nothing
  to build, ever, so it stays a manual/placeholder channel by design.
  YouTube does have a real API, so it's now real: `publishYouTube()`
  speaks the YouTube Data API v3's resumable upload protocol
  (initiate a session, then `PUT` the video bytes to the URL it hands
  back), authenticating via a stored OAuth `refresh_token` that's
  redeemed for a fresh access token on every publish (access tokens
  expire in about an hour; this app never stores one directly, the same
  reasoning applied everywhere else credentials are handled here).
  New required config fields: `client_id`, `client_secret`,
  `refresh_token` (from a one-time Google OAuth consent flow for the
  channel-owning account, done outside this app), plus optional
  `privacy_status` (defaults to `unlisted`, not `public` - publishing
  shouldn't go live by surprise) and `category_id`. Rejects a non-video
  asset with a clear error before making any API call, rather than
  letting Google's API reject it after the fact. Both the React app's
  channel picker and the overlay's channel wizard already drive their
  "implemented"/"soon" UI off `GET /channels/spec` dynamically, so
  YouTube lights up automatically - no frontend change needed.
  Verified with new tests mocking `global.fetch` to check the actual
  three-call HTTP sequence (token refresh -> session init -> byte
  upload) end to end, not just that some function gets called - the
  same real-protocol-testing-without-a-live-account approach used for
  Redis-backed rate limiting earlier in this list. Suite is now 79
  tests across 9 files.
- **Added GDPR-style self-service data export and erasure.** This app
  holds two different kinds of personal data with two different feasible
  ways to satisfy an access/erasure request, so it's two features, not
  one:
  - **Staff accounts (`users`).** `GET /me/export` lets any logged-in
    user download everything this app holds tied to their own account -
    profile, company, product memberships, content they've uploaded or
    approved, agent runs they triggered, and their own audit log entries
    - as JSON (Art. 15, right of access). `POST /me/erase` (password-
    confirmed, rate-limited like every other auth-adjacent route) is
    self-service erasure (Art. 17) - but it anonymizes in place rather
    than hard-deleting the row: `content_assets.uploaded_by`,
    `content_variants.approved_by`, `approvals.requested_by`/
    `approved_by`, `agent_runs.triggered_by`, and `audit_logs.user_id`
    all reference `users(id)` with no `ON DELETE` clause (default `NO
    ACTION`), so any user who has ever uploaded, approved, or triggered
    anything logged can't be hard-deleted without breaking those foreign
    keys - and `audit_logs` is deliberately append-only (see its
    `no_update_audit` trigger), so rewriting history to remove them
    isn't the right move either. Erasure scrubs the email to an
    unguessable `erased-<id>@erased.invalid`, replaces the password hash
    with an unusable random one, clears 2FA, and disables login -
    refused only if the caller is the company's last active account
    (same reasoning `PATCH /users/:userId/status` already applies to
    disabling yourself, applied here to a stricter, self-service
    action). Both routes shipped with a UI, not just an API: a "My Data"
    section in the overlay's existing Security modal
    (`frontend/overlay.html`) - "Export my data" downloads the JSON
    directly in the browser; "Erase my account" requires typing your
    password to confirm, then signs you out.
  - **Leads.** External individuals (prospects/contacts collected via
    webhook or CSV upload) have no login of their own, so if one emails
    the company asking to see or delete their data, an admin
    (`USER_MANAGER_ROLES`) now has `GET /leads/:id/export` and `DELETE
    /leads/:id` to act on their behalf. Deletion also anonymizes rather
    than removes the row, for the same foreign-key reason
    (`agent_runs.lead_id` references `leads(id)` with no `ON DELETE`
    clause) plus a second one: the row's non-personal aggregate fields
    (`source_channel`/`status`/`value_inr`) are legitimate business
    records once the personal identifiers are gone, not something an
    erasure request should also destroy. Added
    `leads.pii_erased_at` (`postgres/migrate-gdpr-erasure.sql`) as the
    durable record that erasure actually happened and when - a `NULL`
    `contact_name`/`phone`/`email` alone doesn't prove a request was
    ever made versus the field just never being filled in. Deliberately
    API-only, no new UI: this codebase has no leads *list* screen at
    all yet (leads only ever feed a count into a stat tile - see
    `frontend/app/src/App.jsx`), so building one from scratch was out of
    scope for this change; an admin runs these via `curl`/
    Postman today, same as this app's other admin-only, UI-less routes.

  `server.js` isn't safely unit-testable as a whole (see "Added a real
  test suite, starting from zero" above) - these routes were verified by
  hand (`node --check`, a full HTML-parse and JS-syntax check on the
  rebuilt frontend, tracing every query against the actual schema) rather
  than by a new automated test, consistent with how every other `server.js`
  route addition in this list has been verified.
- **Added real Postgres/Redis integration testing - the "no Docker in
  this environment" gap that every entry above this one had to work
  around.** Every hardening pass before this one that touched
  RLS/triggers/Redis-backed behavior (Redis-backed rate limiting, the
  GDPR routes just above) could only be verified against a mocked
  pg/Redis client, because no real instance of either existed in the
  environment doing the work - documented honestly each time, but a real
  gap. Root access in this particular session's environment made it
  possible to actually install and run real Postgres 16 + Redis directly
  (`apt-get install postgresql redis-server`) and use them for real -
  see "Testing" above for what `api/test/integration/routes.integration.js`
  actually verifies and how to run it, and `.github/workflows/api-tests.yml`
  for the service-container CI job that keeps it running on every future
  push, so this doesn't stay a one-off. A genuinely new bug was
  worth calling out from writing these: seeding test data directly
  against the RLS-protected `leads` table via a raw `pg` client needed an
  explicit `SET app.tenant_id` before every query on that connection,
  same as `withTenantClient()` already has to do in `server.js` itself -
  a stale `app.tenant_id` left over from a previous query on the same
  long-lived connection silently filtered out the very row a later test
  was looking for (RLS returned zero rows, not an error), which is a
  precise, real illustration of exactly the connection-affinity bug
  `withTenantClient()`'s own comment in `server.js` warns about. All 22
  integration tests pass against real services; the existing 80 unit
  tests are unaffected and still run without them.
- **Fixed a keyboard accessibility gap in the React app's upload
  dropzone.** `ContentPipeline.jsx`'s "drop a file here" control was a
  plain `<div onClick={...}>` with a `className="hidden"` (so
  `display:none`, removed from both the tab order and the accessibility
  tree) `<input type="file">` inside it - a mouse click worked, but there
  was no way to open the file picker with a keyboard at all, and a
  screen reader had no indication this region was interactive. This is
  the same class of gap the overlay UI's accessibility pass (above) found
  and fixed, just in the other frontend. Added `role="button"`,
  `tabIndex={0}`, a descriptive `aria-label`, an `onKeyDown` handler for
  Enter/Space (a `div` isn't natively keyboard-activatable the way a real
  `<button>` is - `role="button"` alone only changes what a screen reader
  announces, not what actually responds to a key press), and a visible
  focus ring. Verified with a clean `npm run build` (confirmed the new
  `aria-label`/keyboard-handler text made it into the built bundle, not
  just the source) and an HTML-parse check on the assembled output; the
  CSP hash was unaffected since only the React app's own source changed,
  not any inline `<script>` block.
- **Linked every form field in `frontend/overlay.html` to a real,
  programmatically-associated label.** The earlier accessibility pass on
  this file (see above) covered ARIA roles, live regions, and keyboard
  handling, but left one gap flagged rather than done blind: most of the
  overlay's ~12 forms relied on placeholder text or a bare adjacent
  `<label>` with no `for`/`id` link, which means a screen reader
  announcing focus on the field reads nothing describing what it's for.
  Fixed across every form (login/signup gate, security/2FA/data-erasure
  modals, onboarding wizard, products modal, add-member form, the
  channel-wizard's dynamic per-channel fields, admin panel's tenant/user/
  webhook/LLM-connection/agent forms): fields that already had a real
  adjacent `<label>` and an `id` got `for="<id>"` added to link them
  (safe, purely additive); fields with only a `name` attribute (no `id`)
  either got a new `id` + `for`-linked label, or - where a persistent
  visible label didn't fit the layout (compact inline fields, a
  read-only webhook URL cell, the bare user-ID picker) - an `aria-label`
  directly on the input, the same pattern already used for icon-only
  buttons. Verified first that every form-submit handler in this file
  reads fields via `new FormData(ev.target)` (by `name`, never by `id`),
  so adding `id` attributes to previously `name`-only inputs cannot
  break any existing JS. Deliberately left untouched: the `<label
  class="oc-full">Section Heading</label>` pattern used as a styled form
  title (e.g. "Create Tenant", "Add LLM Connection") rather than a
  per-field label - retagging those risked a CSS regression via the
  shared `.oc-full` class for no accessibility benefit, since they don't
  describe one specific following field. Verified with a clean
  `npm run build` (confirmed all 42 new `for=`/`aria-label` attributes
  made it into the assembled, minified output, not just the source),
  `node --check` on the extracted inline script, and regenerated the CSP
  sha256 hash in `nginx/orgcomms-vps.conf` (only the overlay's inline
  script hash changed; the app-shell script hashes were unaffected).
- **Removed multi-tenancy entirely - this app is now a single company,
  multi-product, multi-user.** The original design isolated many unrelated
  companies ("tenants") behind Postgres RLS on one shared deployment; that
  was never how this app is actually run (one deployment, one company), so
  the whole `tenant_id`/`tenants`/RLS-isolation layer was dead weight and a
  real attack surface (every `tenant_id`-scoped query, RLS policy, and JWT
  claim was one more thing that had to be gotten right on every route,
  every time - see the cross-tenant privilege-escalation entry above for
  what happens when one of them wasn't).
  - **Schema**: `tenants` is gone. A new singleton `company` table (exactly
    one row, guaranteed by the same `system_flags.signup_used` atomic
    race-gate that already guarded first-signup - see "First login" above)
    replaces it; every route reads it with `getCompany()` (a 5-second
    in-process cache) instead of the old `withTenantClient()`/RLS pattern.
    `tenant_id` is dropped from every table that had it (`users`, `leads`,
    `content_assets`, `content_variants`, `approvals`, `csv_uploads`,
    `audit_logs`, `hermes_agents`, `products`, `agent_runs`), along with
    every `tenant_isolation_*` RLS policy. `postgres/init-secure.sql` is
    the fresh-install schema going forward;
    `postgres/migrate-remove-multitenancy.sql` is the one-time upgrade
    path for an existing multi-tenant database - it creates `company` and
    seeds it from the existing `tenants` data (the oldest tenant's
    name/webhook_secret becomes canonical; `is_premium` is `true` if *any*
    existing tenant was premium, so no capability is silently lost in the
    merge), drops every `tenant_id` column and RLS policy, and drops
    `tenants` itself. **This is a one-way, data-merging migration** - if
    your database currently has more than one tenant, their users/leads/
    content all end up under one company with no way to split them back
    apart afterwards. It runs automatically on every `api` container start
    (last in `api/src/migrate.js`'s `MIGRATIONS_IN_ORDER`, since it depends
    on every table every earlier migration creates) and is idempotent, but
    back up your database first if you have real multi-tenant data today.
    Every legacy migration file that references `tenant_id` (`migrate-
    products-agents.sql`, `migrate-webhook-secret.sql`, `migrate-agent-
    execution.sql`, `migrate-force-rls.sql`, `migrate-content-variants-
    indexes.sql`) was updated to guard that reference behind an
    `information_schema.columns` existence check, so they're safe no-ops
    against a fresh single-company database instead of hard-failing with
    "column tenant_id does not exist".
  - **"Admin sees all, product can be assigned to a user"**: preserved
    exactly via the existing `product_members` table (`ADMIN`/`MEMBER`
    roles) and `PRODUCT_ADMIN_ROLES` (renamed from
    `PRODUCT_TENANT_ADMIN_ROLES`) - `SUPER_ADMIN`/`IT_ADMIN`/`DEPT_ADMIN`
    see and manage every product company-wide; a plain `MEMBER` only sees
    products they're explicitly assigned to.
  - **API**: `POST`/`GET /tenants` and `GET /tenants/me` are gone; a new
    `GET /company` route returns `{id, name, is_premium, created_at}`
    (never `webhook_secret`). Webhook URLs dropped their tenant segment:
    `/webhooks/<tenant_id>/<webhook_secret>/<channel>` became
    `/webhooks/<webhook_secret>/<channel>` (both the main app and the
    separate webhook server). `auditLog()` no longer takes a `tenant_id`
    parameter (~40 call sites updated). `userClaims()` no longer puts
    `tenant_id` in the JWT.
  - **Frontend**: the Admin panel's entire "Tenants" tab (tenant list,
    "Create Tenant" form, tenant picker for the Users tab) is removed -
    there is nothing left to administer at that level. `session.tenant`
    became `session.company` throughout `frontend/overlay.html` and the
    React app (`App.jsx`, `Header.jsx`, `lib/api.js`'s `currentTenant()` ->
    `currentCompany()`), including the pre-mount script that seeds
    `window.__ORGCOMMS_TENANT__` -> `window.__ORGCOMMS_COMPANY__` before
    either app renders (`frontend/app/scripts/assemble.js`). The onboarding-
    dismissal `localStorage` key dropped its per-tenant-ID suffix (there's
    only one company, so nothing to key it by). `npm run build` was rerun
    to regenerate `frontend/index.html` and its hashed asset bundle from
    the updated source, and the CSP `sha256-` hashes in
    `nginx/orgcomms-vps.conf` were regenerated with
    `scripts/gen-csp-hashes.sh` for the two inline `<script>` blocks whose
    content changed (the pre-mount script and the overlay script).
  - **Hermes**: `hermes/orchestrator.js` no longer forwards a `tenant_id`
    it never actually needs - `runAgent()`'s internal API calls to `api`
    now send an empty body, matching `server.js` no longer pushing
    `tenant_id` onto either `publisher:queue` or `webhook:incoming`.
  - **Lead enrichment** (see also the entry below): built as part of this
    same pass, wired into both `POST /leads/upload-csv` and the inbound
    webhook handler.
  - **Quora**: evaluated for real outbound-publishing support (no public
    API, no MCP server as of this writing) and is a final, permanent
    decision, not an open gap - `product_channels` still lists it as a
    configurable channel (for consistency with the other 6, and in case
    Quora ships a public API later), but `api/src/channels.js` marks it
    `implemented: false` and it is not expected to ever publish for real
    without Quora shipping one.
  - **Verified**: a clean fresh-install migration chain (11/11 files OK
    against a brand-new database), a simulated upgrade path (seeded an old
    multi-tenant database with a tenant/user/lead via raw SQL, ran the new
    migration chain against it, and confirmed by direct query that
    `company` correctly inherited the tenant's name/premium-flag/webhook-
    secret, that the user and lead rows survived intact, that `tenants` is
    fully gone, and that `leads` has the new columns with no `tenant_id`),
    and the full test suites (unit + `api/test/integration/
    routes.integration.js` against real Postgres/Redis, including a new
    products/membership-visibility test proving an Admin sees every
    product while an unassigned `MEMBER` sees none).
- **Real lead enrichment: script-level language detection + GSTIN
  extraction/validation.** New `api/src/lead-enrichment.js`, wired into
  both `POST /leads/upload-csv` and the inbound webhook handler (any
  message/note/text field on an inbound lead). `detectLanguage()` is
  Unicode-range script matching (Devanagari, Bengali, Gurmukhi, Gujarati,
  Odia, Tamil, Telugu, Kannada, Malayalam, Arabic script, else Latin ->
  `en`, else `null`) - a real signal, but honestly documented as
  script-level detection, not true NLP language identification (it can't
  tell Hindi from Marathi, both Devanagari). `extractGstin()`/
  `gstinChecksum()` implement the real 15-character GSTIN structural
  format (2-digit state code + 10-char PAN + entity digit + fixed `Z` +
  checksum) and its mod-36 checksum algorithm - this validates that a
  GSTIN is *structurally well-formed*, not that it's actually registered
  with the government (no paid registry API access available); `leads`
  gained `detected_language`/`gstin`/`gstin_valid` columns and a new
  `lead_messages` table records the inbound message itself, laying the
  groundwork for the Leads panel's reply-thread UI.
- **Removed the Agents feature from the UI/API - deferred to a future
  version - and replaced it with a much smaller, real Sarvam AI
  integration: server-side inbound-message filtering.** The Agents feature
  (LLM connections managed in the app, per-product enable/run/history UI,
  automatic agent runs on lead intake) had only just been built in the
  previous pass and was removed again just as deliberately: it added a lot
  of surface (routes, an Admin tab, a per-product tab, a Redis
  `webhook:incoming` queue and a Hermes consumer for it) for a capability
  not needed yet.
  - **What's gone**: `POST`/`GET`/`DELETE /llm-connections`,
    `POST`/`GET`/`PATCH /agents`, `GET`/`POST`/`DELETE
    /products/:id/agents(/:agentId)`, `POST
    /products/:id/agents/:agentId/run`, `GET
    /products/:id/agents/:agentId/runs`, and `POST
    /internal/leads/:leadId/auto-run-agent` are all removed from
    `api/src/server.js`, along with `callLLM()`/`runAgentForProduct()` and
    the `createLlmConnection`/`createAgent`/`updateAgent` zod schemas. The
    Admin panel's "Agents" tab (LLM connections + Agents management) and
    each product's own "Agents" tab (enable/run/history) are both removed
    from `frontend/overlay.html`. Hermes (`hermes/orchestrator.js`) no
    longer has a `lead_intake` job type or a second `BRPOP` on
    `webhook:incoming` - `handleInboundWebhook` in `server.js` no longer
    pushes anything onto that queue, since nothing consumes it any more.
  - **What's kept, on purpose**: the `agents`, `llm_connections`,
    `product_agents`, and `agent_runs` tables are untouched in the schema
    (no migration dropped them) - re-adding this feature next version is a
    routes/UI change against an already-correct schema, not a new
    migration. `GET /me/export` and `GET /leads/:id/export` still safely
    query `agent_runs` (always empty going forward until the feature
    returns) for GDPR export completeness.
  - **What replaced it**: real-time Sarvam AI message filtering, wired
    directly into `handleInboundWebhook` - classifies an inbound lead
    message as a genuine product inquiry (`true`), not one (`false`), or
    leaves it unclassified (`null`) if `SARVAM_API_KEY` isn't set, the
    message is empty, or the API call fails/returns something
    unrecognized. Deliberately env-var configured
    (`SARVAM_API_KEY`/`SARVAM_MODEL`, optional, in `.env.vps.example` and
    `docker-compose.vps.yml`) - no database row, no admin UI, no "LLM
    connection" abstraction; this is a single fixed integration, not a
    general provider system. `leads` gained an `is_inquiry` column
    (`postgres/migrate-lead-inquiry-filter.sql`) and `GET /leads` gained
    `?inquiry_only=true`, which hides only rows explicitly classified
    `false` - an unclassified (`null`) row always stays visible, so a
    filter that never ran on a given row (no API key set, or a bulk CSV
    import - see below) never silently hides it. Deliberately **not**
    run on `POST /leads/upload-csv` - a bulk import can be up to 5000
    rows, and calling an external API synchronously per row inside that
    request would be slow and costly; bulk-imported leads get
    `detected_language`/`gstin` (local, script-level, no external call)
    but `is_inquiry` stays `NULL`.
  - **Verified**: unit tests updated (removed the `createLlmConnection`
    schema test; 81 of 82 pass - the one failure is a pre-existing,
    unrelated missing `rate-limit-redis` dev dependency on this machine,
    not something this change touched), `node --check` on every changed
    file, a clean `npm run build` (confirms the removed Agents markup
    compiles out of `frontend/index.html` cleanly), and the CSP
    `sha256-` hash in `nginx/orgcomms-vps.conf` was regenerated for the
    overlay's inline script.

- **Rebuilt real top-nav navigation: Home / Inbox / Studio / Leads.** The
  React app was a single always-on dashboard (one product's content
  pipeline + integrations panel, no way to see another product or a
  leads-only view without scrolling through everything). Replaced with:
  - `Nav.jsx` - a top tab bar (Home/Inbox/Studio/Leads) plus, for the
    three product-scoped tabs, a product `<select>` so switching products
    re-scopes whichever tab is open.
  - `Home.jsx` - the company dashboard: company name/plan, total
    products/leads, and a clickable card per product (jumps straight to
    that product's Inbox).
  - `MessagesPanel.jsx` - one component backing both Inbox and Leads
    (they differ only by an `inquiryOnly` prop and copy): left-hand
    channel filter, middle lead list, right-hand thread with reply.
    Leads passes `inquiryOnly` so `GET /leads?inquiry_only=true` hides
    Sarvam-classified noise (see the Agents/Sarvam entry above);
    unclassified messages always stay visible either way.
  - `Studio` - a small component defined inline in `App.jsx` that wraps
    the existing `ContentPipeline`/`IntegrationsPanel` pair, scoped to
    whichever product is selected in the nav.
  - `api.js` gained `company()`, `leads(params)`, `leadMessages(leadId)`,
    and `replyToLead(leadId, body, channel)` to back all of the above -
    the leads/messages/reply routes themselves already existed
    server-side from earlier work; only the frontend didn't use them yet.
  - Also fixed a stale "Transforming with Agent…" button label in
    `ContentPipeline.jsx`, left over from before Agents was removed.
  - **Verified**: `npm run build` succeeds (1569 modules, clean output),
    the CSP `sha256-` hashes in `nginx/orgcomms-vps.conf` were
    regenerated and confirmed unchanged (this change is entirely inside
    the Vite bundle, not the overlay's inline scripts), and the full API
    test suite still shows 81/82 (same pre-existing, unrelated
    `rate-limit-redis` failure noted above) since this was a
    frontend-only change.

- **Disaster-recovery gaps closed: secrets, Redis, recordings, and
  stuck-queue recovery.** The daily `postgres-backup` sidecar only ever
  backed up Postgres - the `.env` secrets, the `redisdata` volume, and the
  `recordings` volume (every uploaded content asset and its transformed
  per-channel variants) had no backup at all, and a Redis crash/restart
  mid-job could silently strand an approved piece of content forever.
  - **Secrets**: `scripts/backup-secrets.sh` (new, manual/on-demand, not
    automated) GPG-encrypts `.env` before it ever touches disk as a
    backup file - `GPG_RECIPIENT=you@example.com
    ./scripts/backup-secrets.sh`, or no recipient set falls back to a
    passphrase-prompted symmetric encryption. Deliberately kept manual and
    always-encrypted rather than folded into the daily automated sidecar:
    writing decrypted secrets into a daily, less-guarded backup volume is
    its own risk. `ENCRYPTION_KEY` is the one genuinely irreplaceable
    value in there - lose it with no backup and every already-stored
    channel credential (WhatsApp/Facebook/Instagram/LinkedIn/YouTube/email
    tokens) becomes permanently undecryptable, not just hard to recover.
  - **Redis and recordings**: `postgres/backup/backup.sh` (the same daily
    sidecar) now also takes a `redis-cli --rdb` snapshot of Redis and tars
    the `recordings` volume (mounted read-only into the sidecar), gzips
    both, applies the same `BACKUP_RETENTION_DAYS` retention, and ships
    both through the same optional `RCLONE_REMOTE` as the Postgres dump -
    one schedule, one shipping config, three things backed up. Each of the
    three is independent: a Redis or recordings failure is logged and
    skipped, never fails or blocks the Postgres backup that already
    succeeded in the same run.
  - **Stuck-queue recovery**: `publisher:queue` (Redis, popped via `BRPOP`
    with no ack) can silently lose an approved `content_variant` forever -
    Redis restarting before AOF fsyncs the push, `hermes-orchestrator`
    dying mid-`BRPOP`-to-publish, or the job being pushed while
    `hermes-orchestrator` wasn't running at all - leaving
    `content_variants.status` stuck at `'APPROVED'` with nothing left to
    revisit it. `scripts/recover-stuck-publishes.sh` (new) finds every
    variant still `'APPROVED'` whose most recent `approvals` row is older
    than `STALE_MINUTES` (default 10 - long enough that it never re-queues
    a job that's simply still in flight) and re-pushes it onto
    `publisher:queue`. Safe to run repeatedly: a variant that published or
    failed in the meantime is no longer `'APPROVED'`, so it's skipped on
    the next run. Manual/on-demand, not scheduled - this handles a Redis
    incident, not routine operation.
  - **Verified**: `docker-compose.vps.yml` validated as parseable YAML
    after the `postgres-backup` service changes (added the `recordings`
    read-only mount and `REDIS_HOST`/`REDIS_PASSWORD` env vars, plus a
    `redis: { condition: service_healthy }` dependency); all three new/
    changed shell scripts pass `bash -n`/`sh -n` syntax checks; the SQL in
    `recover-stuck-publishes.sh` was checked by hand against the exact
    columns `content_variants`/`approvals` actually have (no `updated_at`
    on `content_variants` - staleness is measured from `approvals.created_at`
    instead, which is written in the same request that pushes to
    `publisher:queue`).

- **Removed the Premium/Standard plan distinction.** `company.is_premium`
  drove a "Premium" badge in the header and on Home, and used to gate
  Agents (already removed - see the Agents/Sarvam entry above). With
  Agents gone, `is_premium` had nothing left to actually gate - it was
  purely cosmetic, showing a "V4 Premium" or "Standard plan" badge that no
  longer corresponded to a real feature difference. Removed from every
  user-facing surface: the Header and Home badges are gone, `GET /company`
  and `GET /me/export` no longer return `is_premium`, and
  `postgres/bootstrap-admin.sql` / the signup route no longer set it.
  `company.is_premium` itself is left in the schema, defaulting `false`
  and unused - same "keep the column, remove the feature" treatment as
  `agents`/`llm_connections`/`product_agents`/`agent_runs`, in case a real
  plan tier comes back in a future version.
- **Studio now says which product an upload lands in.** Uploading was
  scoped by whichever product was selected in the nav bar's picker, but
  nothing on the Studio screen itself named that product - easy to lose
  track of after switching tabs or scrolling. Added a banner above the
  upload area ("Uploading to **\<Product Name\>**") so it's unambiguous
  without having to look back up at the nav bar.

- **Real inbound email: IMAP polling, not just outbound SMTP.** Configuring
  the Email channel previously only set up SMTP fields (for sending) -
  there was no code anywhere that turned a reply into a lead, so
  "configure email, then see inbound messages" silently did nothing. Added
  six optional fields to the Email channel spec (`imap_host`, `imap_port`,
  `imap_secure`, `imap_user`, `imap_pass`, `imap_mailbox` - see
  `api/src/channels.js`; the channel-config UI is fully spec-driven, so
  these show up in Studio's existing "Configure a Channel" wizard with no
  frontend changes needed) and a real poller
  (`api/src/email-poller.js`, using `imapflow`/`mailparser`) that the API
  process runs on an interval (`EMAIL_POLL_INTERVAL_MINUTES`, default 5,
  `0` to disable - see `.env.vps.example`).
  - Extracted the lead-creation logic that used to live entirely inside
    `handleInboundWebhook` into a shared `ingestInboundLead()` - same
    dedup, GSTIN/language detection, Sarvam inquiry classification, and
    audit log for every inbound source, so an emailed lead behaves
    identically to a WhatsApp/Facebook one rather than a second-class
    path built separately.
  - A message is only marked `\Seen` *after* it's successfully turned
    into a lead - a transient failure (a DB blip, say) leaves it unread
    so the next poll retries it rather than silently dropping it. A
    connection failure for one product's mailbox (bad credentials, host
    unreachable) is logged and skipped, never allowed to block polling
    every other product's mailbox.
  - Real limitation worth knowing, documented in the channel's own help
    text: IMAP's "unread" flag is shared mailbox state, not something
    this app owns - if a person reads a message in their own mail client
    before the next poll runs, it becomes invisible to the poller from
    then on. Use a dedicated mailbox for lead intake if you can, not a
    personal inbox someone else also reads.
  - **Verified**: `node --check` on every changed/new file,
    `require('./email-poller.js')` resolves both new dependencies
    (`imapflow`, `mailparser`) cleanly, `docker-compose.vps.yml`
    validated as parseable YAML, and the full unit test suite passes
    clean (85/85 non-skipped - the pre-existing missing-`rate-limit-redis`
    gap noted earlier turned out to be fixed by this session's
    `npm install` too, not something this change did on purpose but a
    welcome side effect) including two new tests pinning the Email
    channel's required-vs-optional field split and that `imap_pass`
    round-trips through encrypt/mask/decrypt exactly like every other
    secret field.

- **Three real bugs fixed in the IMAP poller after live testing against a
  real mailbox.**
  - **Garbled message content.** A real welcome email (Hostinger's) showed
    the lead message full of visible junk characters - the template pads
    its inbox preview snippet with runs of invisible zero-width
    space/combining-mark characters, and mailparser's plain-text
    extraction faithfully includes them since they're real text content,
    just visually hidden via the email itself, not something a text
    parser can know to skip. Added `cleanEmailText()` (strips
    `​-‍`, `﻿`, `­`, and `̀-ͯ`, then
    collapses the whitespace left behind) applied to every message body
    before it's stored.
  - **A deleted email stayed a lead forever.** Nothing reconciled a lead
    against its source message still existing - delete the email in your
    own mail client and the lead just sat there. `leads` gained a
    `source_uid` column (`migrate-email-source-uid.sql`) recording the
    IMAP UID a lead came from; every poll now also runs
    `reconcileDeletedLeads()` (`IMAP UID SEARCH ALL`, cheap even against a
    large mailbox - just the UID numbers, not full messages) and deletes
    any lead whose source UID is no longer present. `lead_messages`
    cascades on delete; `audit_logs` keeps the historical record
    regardless (no FK to `leads`).
  - **Long email content overflowed its message bubble.** The Inbox/Leads
    thread view had `whitespace-pre-wrap` but no `overflow-wrap`, so an
    unbroken run of characters (a tracking URL, template artifacts) could
    push past the bubble's `max-width` instead of wrapping. Added
    `break-words` to the message text and `overflow-hidden`/`min-w-0` to
    the bubble and its scroll container as a second line of defense.
  - **Verified**: 7 new unit tests for `cleanEmailText()` and
    `reconcileDeletedLeads()` (the latter via an injected fake
    pool/IMAP-client, same pattern `channels.test.js` uses for
    encrypt/decrypt - no real mailbox needed), full suite passes clean
    (94/94 non-skipped), `node --check` on every changed file, clean
    `npm run build` with CSP hashes confirmed unchanged.
