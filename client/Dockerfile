# Build from the repository root: docker build -f client/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspace=client --include-workspace-root=false
COPY client ./client
# The API is served from the same origin through the nginx proxy below.
ENV VITE_API_BASE_URL=/api/v1
RUN npm --prefix client run build

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
# nginx answers /nginx-health itself (no API call), so this only proves the web server is up.
# busybox wget ships with the alpine image; 127.0.0.1 avoids IPv6 "localhost" resolution.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/nginx-health || exit 1
