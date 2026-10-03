#!/bin/sh
# Runs automatically on every container start (copied to
# /docker-entrypoint.d/ - nginx:alpine's official image runs every
# executable *.sh there before starting nginx, no CMD/ENTRYPOINT
# override needed here).
#
# index.html.template (baked into the image at build time) still has the
# literal %%API_BASE%% placeholder that used to be a hardcoded
# 'https://api.octaveaiautomation.com' in overlay.html's API_BASE
# variable - see frontend/Dockerfile for why. This regenerates the real
# index.html nginx serves from that template on every start, substituting
# in whatever API_BASE this container's environment has right now (set by
# docker-compose.vps.yml's frontend.environment.API_BASE, normally
# https://$API_DOMAIN - see .env.vps.example).
#
# Deliberately regenerates from the untouched template every time rather
# than editing index.html in place: editing in place would consume the
# placeholder on the first start, leaving no way to pick up a changed
# API_BASE on a later restart without rebuilding the image.
set -eu
sed "s|%%API_BASE%%|${API_BASE}|g" /usr/share/nginx/html/index.html.template > /usr/share/nginx/html/index.html
