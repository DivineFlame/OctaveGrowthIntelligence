# OrgComms v4 REAL APP KIT - VPS - No Fake ghcr.io - Builds Locally

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![Python](https://img.shields.io/badge/Python-3-3776AB?logo=python&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![Nginx](https://img.shields.io/badge/Nginx-reverse%20proxy-009639?logo=nginx&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

Fixed: docker-compose builds from ./api, ./hermes, ./paperclip, ./csv-handler, ./transformer locally, no external registry. Real source code included.

## First login

There's no general signup — every user after the first is created by a
tenant admin via the Admin panel (see below) — but `POST /auth/signup`
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
still exists as a fully offline alternative — create the first tenant + Super
Admin directly via SQL instead, with `SIGNUP_ENABLED=false` from the start.

The frontend's API base URL is hardcoded in `frontend/index.html` as
`API_BASE` (currently `https://api.octaveaiautomation.com`) — not a visible
field. If the API's domain ever changes, update that one constant and
redeploy the frontend.

## Tenants and users

Once signed in, a user with `SUPER_ADMIN`, `IT_ADMIN`, or `DEPT_ADMIN` sees an
**Admin** button (top-right):
- **Super Admin** creates new tenants (name, subdomain, plan) under the
  Tenants tab, then picks "Manage users" on a tenant to seed its first user
  (this is the one case a role/tenant admin can create a user outside their
  own tenant — every other tenant admin is restricted to their own tenant).
- **IT_ADMIN / DEPT_ADMIN** (and Super Admin, for their own tenant) create
  users and assign roles under the Users tab. Available roles come from the
  `roles` table (`HR_ADMIN`, `SALES_LEAD`, `CONTENT_CREATOR`, `APPROVER`,
  `DEPT_ADMIN`, `IT_ADMIN`, `SUPER_ADMIN`) — a user's permission flags
  (history window, revenue/integrations visibility, approval rights) are
  derived from that role, not set ad hoc per user.

Access tokens expire after 15 minutes; the frontend transparently exchanges
the 7-day refresh token for a new one via `POST /auth/refresh`, so a session
stays usable without re-entering a password until the refresh token itself
expires.

## Products/Services and Agents

Run `postgres/migrate-products-agents.sql` once if your database predates
this (same `docker exec ... psql` pattern as the other migrations).

Full hierarchy, matching what was asked for:

- **Super Admin** creates Tenants with a Standard or Premium plan (already
  existed - `POST /tenants`, the `plan`/`is_premium` fields). Also the only
  role that can create **LLM connections** (`POST /llm-connections` -
  provider + API key, encrypted at rest with `ENCRYPTION_KEY` via
  `encryptSecret()`/`decryptSecret()`, which had been provisioned since the
  very first deploy but never actually used until now) and **Agents**
  (`POST /agents` - name, which LLM connection, model, system prompt).
- **Tenant Admin** (`SUPER_ADMIN`/`IT_ADMIN`/`DEPT_ADMIN` - the existing
  tenant-management roles, now also called `PRODUCT_TENANT_ADMIN_ROLES` in
  the code) creates **Products/Services** under their tenant
  (`POST /products`) and assigns a tenant user as that product's Admin
  (`POST /products/:id/members` with `role: "ADMIN"`).
- **Product/Service Admin** configures that product's social channels
  (`POST /products/:id/channels` - config storage only right now, see note
  below) and adds `MEMBER` users to run them (`POST /products/:id/members`
  with `role: "MEMBER"`) — a Tenant Admin can do all of this too, for any
  product in their tenant. Every product gets all 7 channels
  (`whatsapp, facebook, instagram, linkedin, youtube, quora, email`)
  pre-created as `not_configured` the moment it's created (`POST /products`
  does this in the same transaction as the product insert) — they're
  independent from every other product's channel rows (`UNIQUE(product_id,
  channel)`), so configuring one product's WhatsApp settings never touches
  another's.
- **Agents on a product**: `POST /products/:id/agents` enables an
  already-defined Agent on a product, gated to Premium tenants only (checks
  `tenants.is_premium`) - a Standard-plan product can only ever be run by
  human `MEMBER` users, matching what was asked for exactly.

Permission model: every product-scoped write (members/channels/agents)
accepts either a Tenant Admin role or that specific product's own `ADMIN`
member (`canAdminProduct()`) - a Product Admin manages their own product
without needing any tenant-wide role.

**What this does NOT do yet, on purpose:**
- **No agent execution.** Creating an Agent stores its LLM connection/model/
  system prompt - nothing calls the LLM or does anything autonomously yet.
  That's a real, separate feature (needs deciding exactly what an agent
  *does* - generate content? Auto-reply to leads? Auto-post on a schedule? -
  plus the actual provider SDK calls) and hasn't been started.
- **No real social-media posting.** `product_channels.config` is just
  storage; there's no OAuth flow or platform API integration behind any
  channel for either Standard (human) or Premium (agent) products. Every
  channel-posting mention elsewhere in this README/app is aspirational until
  specific platforms are integrated one at a time (each needs its own app
  registration/API credentials from you).

### Frontend UI

Deliberately built as new panels in the hand-written login/session-bar/admin
script (the same one behind Sign In, the Security button, and the existing
Admin panel) rather than by editing the compiled React bundle - that bundle
already caused one real syntax-breaking mistake earlier this session, and
this whole feature area has more moving parts than a single safe edit.

- **Products** button (session bar, next to Security - visible to everyone,
  since even a plain Member should see products they belong to) opens a
  list: Tenant Admins see every product in the tenant and can create new
  ones; everyone else sees only products they're a member of. Selecting one
  opens tabs for **Members** (add/remove, with a role picker - Tenant Admins
  get a dropdown of real tenant users via `GET /users`; a Product Admin
  without a tenant-wide role has to type a user's ID directly, since
  `GET /users` is gated to tenant-wide admin roles and a Product Admin
  usually isn't one), **Channels** (per-channel status + a config note - no
  real platform config UI yet, matching the backend), and **Agents** (enable/
  disable already-created agents - shows "Premium plan only" messaging when
  none are enabled rather than pretending it works on Standard).
- **Agents** tab added to the existing Super Admin panel (Admin button):
  create LLM connections (provider + API key, never redisplayed once saved)
  and Agents (name, connection, model, system prompt).

### New-tenant onboarding wizard

Auto-triggers once, right after login, for a Tenant Admin whose tenant has
zero products yet (`GET /products` empty) — a 4-step modal: create the
first Product/Service &rarr; assign its Product Admin (dropdown of real
tenant users) &rarr; optionally configure one channel &rarr; done, with a
button straight into the Products panel. Skippable at every step; once
skipped or once a product exists, it never appears again for that tenant
(tracked in `localStorage`, keyed by tenant ID — clearing site data or
switching browsers will show it again, which is harmless since it no-ops
the moment a product already exists).

## Studio, Leads, and Inbox (real data, not the original mockup)

These three panels were originally a fully client-side simulation — no
network calls, hardcoded sample leads/messages, a fake progress bar, and a
fake "Fetch from Team Drive/Slack" button with invented brand-kit data.
All of that's gone:

- **Leads**: uploading a CSV calls `POST /leads/upload-csv` for real; the
  shown totals (rows/valid/duplicate/invalid) are the actual response, and
  "Recent Leads" is `GET /leads`. The old fake CSV-to-CRM field-mapping
  table and language-distribution chart were removed rather than left
  fake — the real API doesn't return per-field mapping suggestions or a
  language breakdown, so there was no honest way to populate them.
- **Inbox**: there's no dedicated messaging/inbox endpoint in this API, so
  this reuses `GET /leads` (which is what the inbox conceptually
  represented anyway — leads arriving from every channel + CSV).
- **Studio**: uploading calls `POST /content/upload`; "Transform with
  Agent" calls `POST /content/:assetId/transform` with the channels you
  selected and shows the real variants it created (channel, spec, status)
  instead of fabricated thumbnails/sizes/durations — Paperclip doesn't
  generate real preview images accessible to the frontend, so there was no
  honest way to show those either. Approve/Reject/Request Change call
  `POST /content/variants/:variantId/approve` for real, looping over every
  variant from that transform. The "Fetch Client Details" button is
  disabled and labeled accordingly — there's no Slack/Drive/Notion
  integration in this codebase to honestly back it. The tenant switcher
  (previously "Sharma Industries" / "Gupta Tools") now shows your one real
  tenant, non-interactively — a JWT is scoped to exactly one tenant, so
  there was never anything to actually switch between.

The Premium "Multiuser → Multiagent" comparison panel is unchanged — it's
informational/marketing copy describing what the toggle does, not a data
display, so it was never "fake data" in the same sense as the rest.

The bundle's own event handlers reach the real API via
`window.__ORGCOMMS_API__` (path, opts) — exposed by the login/session
script for exactly this purpose — and `window.__ORGCOMMS_SESSION__`,
populated by the same pre-bundle script that seeds the initial tenant
state. Neither existed before this pass; the compiled bundle previously
had zero knowledge of the login gate's session.

## Webhooks (per-tenant, so leads actually persist)

If your database already existed before this feature was added, run
`postgres/migrate-webhook-secret.sql` once (same `docker exec ... psql`
pattern as the bootstrap script) — it adds the `webhook_secret` column and
backfills a real secret for every existing tenant.

Inbound webhooks are URL-shaped as:

```
POST /webhooks/<tenant_id>/<webhook_secret>/<channel>
```

`<channel>` is one of `whatsapp, facebook, instagram, linkedin, youtube,
quora, email`. The secret is embedded in the path rather than a header
because most of these platforms' webhook config UIs only accept a plain
callback URL. A request with a wrong or missing secret gets `401`; an
unknown tenant or channel gets `404`.

A `SUPER_ADMIN` or `IT_ADMIN` gets the exact URLs to paste into each
channel's dashboard from the Admin panel's **Webhooks** tab (backed by
`GET /integrations/webhook-urls`), and can invalidate + reissue all of them
at once from the same tab if a URL ever leaks (`POST
/integrations/webhook-secret/rotate`).

A valid request is deduped (by phone/email against existing leads for that
tenant) and inserted into `leads` directly — persistence no longer depends
on the Hermes queue consumer being up. It also still pushes a
`{lead_id, tenant_id, channel}` notification onto `webhook:incoming` for
`lead_intake` to pick up for downstream enrichment (GSTIN lookup, language
detection, etc.) — that enrichment step is not implemented yet, so
`lead_intake` currently only logs the notification.

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
| `/webhooks/:tenantId/:webhookSecret/:channel` (both the main app and the separate webhook server) | 120 / min |
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

## Dependency note

`multer` was on the vulnerable 1.x line (`npm` flags known CVEs on install);
upgraded to 2.3.0. The upgrade is drop-in for how this app uses it
(`diskStorage`, `.single(fieldname)`, `limits`, `fileFilter`) — no other
code changes were needed.
