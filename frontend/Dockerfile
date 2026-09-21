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
COPY --from=build /build/index.html /usr/share/nginx/html/index.html
COPY --from=build /build/app/dist/assets /usr/share/nginx/html/assets
COPY octave-icon.png /usr/share/nginx/html/octave-icon.png
COPY octave-logo.png /usr/share/nginx/html/octave-logo.png
