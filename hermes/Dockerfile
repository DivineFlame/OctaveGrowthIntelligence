FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
USER 1001
# The loop's two brPop calls (1s timeout each) mean a healthy loop touches
# the heartbeat file at least every ~2s; a hang (stuck on something that
# never resolves or rejects) goes stale and this starts failing within
# ~20s. -mmin -1 = modified in the last 1 minute, generous slack over the
# ~2s expected cadence.
HEALTHCHECK --interval=20s --timeout=5s --retries=3 --start-period=10s \
  CMD find /tmp/heartbeat -mmin -1 2>/dev/null | grep -q heartbeat || exit 1
CMD ["node","orchestrator.js"]
