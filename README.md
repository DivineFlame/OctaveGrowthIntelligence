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

Note: the Studio/Leads/Inbox panels elsewhere in the frontend still show
illustrative example content (sample leads, sample inbox messages) — only
the login and tenant/user administration are wired to the real API so far.

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

Set `CLAMAV_REQUIRED=false` to disable scanning entirely (local dev without
a `clamav` container running) — don't set this in production.
