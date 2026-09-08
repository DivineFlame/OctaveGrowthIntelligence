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

There is no signup route and no seeded user — run `postgres/bootstrap-admin.sql`
once against the running Postgres container to create the first tenant and a
SUPER_ADMIN login (edit the EMAIL/PASSWORD placeholders in that file first).
See the comments in that file for the exact `docker exec` command.

Then open the frontend and sign in. The login screen asks for:
- **API Base URL** — the public URL of the `api` service (e.g.
  `https://api.yourdomain.com`), cached in the browser after first entry
- **Email** / **Password** — the credentials from the bootstrap step above

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
