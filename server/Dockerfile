# Build from the repository root: docker build -f server/Dockerfile .
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY server ./server
WORKDIR /app/server
USER node
EXPOSE 5000
# Readiness (not liveness): reports unhealthy while MongoDB is unreachable. Docker only marks the
# container unhealthy, it does NOT restart it, so a short database outage causes no restart loop;
# crashes are handled by the restart policy. The probe talks to the server directly (loopback).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
