FROM node:20-alpine
# UID/GID pinned to 1001 to exactly match docker-compose.vps.yml's
# `user: "1001:1001"` override for this service. Without this, `adduser
# -S` picks whatever system UID happens to be free (not 1001), so the
# chown below lands on a different UID than the container actually runs
# as at runtime - the named `recordings` volume then gets initialized
# owned by that other UID, and every write to it from this container
# (e.g. POST /content/upload) fails with EACCES: permission denied.
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S -G appgroup appuser
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Runs the test suite at build time so a regression in api/src/channels.js,
# validators.js or schemas.js fails the build instead of reaching
# production - see api/test/ and README.md "Hardening notes". Uses only
# Node's built-in test runner (node:test/node:assert) plus zod, already a
# production dependency installed by `npm ci --omit=dev` above - no
# devDependencies needed.
RUN npm test
RUN mkdir -p /app/recordings /app/logs && chown -R appuser:appgroup /app
USER appuser
EXPOSE 3000 3001
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
