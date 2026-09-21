# OrgComms Studio - frontend app

This is the real, buildable source for the React app that used to ship as
an untracked, pre-built, minified bundle pasted directly into
`frontend/index.html` (Tailwind CSS + React, ~200KB of minified JS, no
source anywhere in the repository). That bundle is gone; this is what
replaces it.

## Why this exists

Two problems, one rewrite:

1. **No source.** `frontend/index.html` contained a fully-built React
   bundle with nothing to rebuild it from - any change meant hand-editing
   compiled output, and the file couldn't be audited, linted, or tested.
2. **Theme toggle didn't work.** The site has a real dark/light theme
   system (`data-theme` attribute + CSS custom properties, see
   `../overlay.html`), but the old bundle never referenced `data-theme`
   anywhere, never added Tailwind's `dark` class to anything, and its
   built CSS had exactly 2 `dark:` utility rules in a 200KB+ file -
   toggling the theme visibly changed the auth/admin overlay and did
   nothing to the actual app screens underneath.

This app fixes both: it's real, readable, buildable source, and every
component uses paired light/dark Tailwind classes wired to the site's
actual theme system via `src/lib/theme.js`.

## Architecture: two apps, one page

`frontend/index.html` is **generated**, not hand-edited. It's assembled
from two pieces at build time:

- **This app** (`frontend/app/`) - a Vite + React + Tailwind SPA that
  renders into `<div id="root">`. This is where the actual product
  screens live: the content pipeline (upload → transform → approve →
  publish), stat tiles, and integrations status. It talks to the real
  API (`src/lib/api.js`) using the session the overlay app manages.
- **The overlay app** (`frontend/overlay.html`) - hand-written vanilla JS,
  unchanged by this rewrite. Owns the auth gate, top bar, admin panel,
  products/channels/onboarding/security UI. Preserved byte-for-byte by
  the build (`scripts/assemble.js` reads it and never modifies it).

Both apps share one session (`localStorage['orgcomms_session']`) and one
theme (`data-theme` on `<html>`, `octave_theme` in `localStorage`).

## Building

```sh
npm ci
npm run build
```

This runs `vite build` (→ `dist/`, hashed JS/CSS asset files, no
inlining - see `vite.config.js` for why that matters for CSP), then
`scripts/assemble.js` splices those built asset tags into
`../overlay.html` and writes the result to `../index.html` - the file
`frontend/Dockerfile` actually copies into the nginx image. Nothing here
runs at container runtime; this is a build-time step in the multi-stage
`frontend/Dockerfile`.

**If you change an inline `<script>` block** (either of the two small
ones in `scripts/assemble.js`, or anything in `overlay.html`), the CSP
`script-src` hashes in `nginx/orgcomms-vps.conf` need regenerating -
build first, then run `../../scripts/gen-csp-hashes.sh` against the
freshly-built `frontend/index.html` and paste the printed hashes in.

## Editing

- Product screens, the content pipeline, stat tiles → edit files under
  `src/`, same as any Vite React app.
- Auth gate, admin panel, products/channels/onboarding/security modals →
  edit `../overlay.html` directly (it's plain HTML/CSS/JS, not part of
  this build).
- API contract (routes, request/response shapes) → `src/lib/api.js`
  mirrors `api/src/server.js` route-for-route; keep them in sync if the
  API changes.

## What's real vs. what's still a stub

Every screen in this app calls the real API (`GET /products`,
`GET /channels/spec`, `POST /content/upload`, `POST /content/:id/transform`,
`POST /content/variants/:id/approve`, `GET /leads`, `GET /integrations`) -
there is no mock/demo data. The per-channel spec chips are driven by
whatever `GET /channels/spec` actually returns (including `implemented:
false` for channels that don't publish yet, e.g. YouTube/Quora - see the
root README's "Hardening notes"), not hardcoded flavor text.
