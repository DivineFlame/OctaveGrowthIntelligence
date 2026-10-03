FROM node:20-alpine AS build
WORKDIR /build
# app/ is the real React source (Vite + Tailwind + React) - see
# app/README.md. overlay.html is the hand-written auth-gate/admin/settings
# app that sits on top of it, preserved byte-for-byte by app/scripts/
# assemble.js rather than being part of the Vite build.
COPY app/package*.json ./app/
RUN cd app && npm ci
COPY app/ ./app/
COPY overlay.html ./overlay.html
# vite build -> app/dist/, then assemble.js splices it with overlay.html
# to produce ./index.html (see app/scripts/assemble.js for exactly how).
RUN cd app && npm run build

FROM nginx:alpine
# index.html still has overlay.html's %%API_BASE%% placeholder in it at
# this point (see overlay.html's API_BASE variable) - kept as a template,
# not the file nginx serves directly, so the real API_BASE can be set per
# deployment at container *start* time (docker-compose.vps.yml's
# frontend.environment.API_BASE) instead of needing a separate image
# build per Dokploy app/domain. See substitute-api-base.sh, which
# generates the real index.html from this template on every start.
COPY --from=build /build/index.html /usr/share/nginx/html/index.html.template
COPY --from=build /build/app/dist/assets /usr/share/nginx/html/assets
COPY octave-icon.png /usr/share/nginx/html/octave-icon.png
COPY octave-logo.png /usr/share/nginx/html/octave-logo.png
# nginx:alpine's official image runs every executable *.sh found in
# /docker-entrypoint.d/ before starting nginx - no ENTRYPOINT/CMD
# override needed to hook into that.
COPY substitute-api-base.sh /docker-entrypoint.d/30-substitute-api-base.sh
RUN chmod +x /docker-entrypoint.d/30-substitute-api-base.sh
# Fallback only - every real deployment should set API_BASE explicitly
# via docker-compose.vps.yml (https://$API_DOMAIN), so this is just what
# a container started without that environment variable falls back to.
ENV API_BASE=https://api.octaveaiautomation.com
