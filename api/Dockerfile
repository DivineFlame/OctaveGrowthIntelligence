FROM node:20-alpine
RUN addgroup -S appgroup && adduser -S -G appgroup appuser
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Runs the test suite at build time so a regression in api/src/channels.js
# fails the build instead of reaching production - see api/test/ and
# README.md "Hardening notes". Uses only Node's built-in test runner
# (node:test/node:assert), so this needs no devDependencies beyond what
# `npm ci --omit=dev` already installed.
RUN npm test
RUN mkdir -p /app/recordings /app/logs && chown -R appuser:appgroup /app
USER appuser
EXPOSE 3000 3001
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
