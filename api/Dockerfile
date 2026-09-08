FROM node:20-alpine
RUN addgroup -S appgroup && adduser -S -G appgroup appuser
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/recordings /app/logs && chown -R appuser:appgroup /app
USER appuser
EXPOSE 3000 3001
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "src/server.js"]
