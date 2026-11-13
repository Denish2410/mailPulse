# Stage 4B.2.1: Deployment validation report

This report records what was actually run to validate the Stage 4B.2 deployment hardening
(commit `1e3454c`, `chore(deploy): harden production container configuration`, merged to `master`
as PR #16). It is a validation record, **not** a production-readiness statement. Several checks are
explicitly NOT VERIFIED or PARTIAL; they are listed in [Outstanding work](#9-outstanding-work).

Status labels used throughout:

- **PASS**: executed and succeeded.
- **PARTIAL**: executed, but the scenario it was meant to prove was not fully exercised.
- **NOT VERIFIED**: not executed, or could not be conclusively established.

## 1. Environment

| Item | Value |
|---|---|
| Docker Engine | 29.9.3 |
| Docker Compose | 5.7.0 |
| Platform | Apple Silicon, ARM64 (`aarch64`) |
| Compose project name | `mailpulse-stage4b2-validation` |
| Code validated | `1e3454c` (Stage 4B.2 feature branch) |

All runs used placeholder secrets supplied through the shell only. No `.env` file was written, no
production credentials or customer data were used, and SMTP settings (`SMTP_HOST`, `SMTP_USER`,
`SMTP_PASS`, `EMAIL_FROM`) were empty, so no email could be sent.

## 2. Compose configuration

| Check | Result |
|---|---|
| `docker-compose.yml` with placeholder `MONGO_ROOT_PASSWORD` and `JWT_SECRET` | PASS |
| `docker-compose.yml` without required variables | Fails as designed (required-variable guards work) |
| `docker-compose.yml` + `docker-compose.prod.yml` combined, with placeholders | PASS |
| `docker-compose.prod.yml` on its own | Fails: it is an **overlay** with no image or build for `server`; always combine it with the base file |

The merged configuration resolved as intended: `unless-stopped` restart policy on every service,
stop grace 40 s (server) and 30 s (mongo), memory limits (mongo 1 GiB, server 768 MiB, client and
caddy 128 MiB), json-file log rotation (10 MB x 3), health-gated start order
(mongo, then server, then client, then caddy in the overlay), and no published database port.
No production endpoints, external databases or email providers are referenced.

## 3. Image builds

Command: `docker compose -p mailpulse-stage4b2-validation -f docker-compose.yml build server client`.

| Image | Result | Architecture | Base | Runtime user |
|---|---|---|---|---|
| server | PASS | arm64/linux | `node:22-slim` | `node` (non-root) |
| client | PASS | arm64/linux | `nginx:1.27-alpine` | image default (nginx master as root, workers as `nginx`) |

Build warnings were pre-existing and unrelated (a deprecated `recharts` notice and the Vite
bundle-size notice).

`.dockerignore` effect, checked by listing the image layers: the server image contains the server
source and scripts and production dependencies only. Tests, documentation, `.env` files and dev tools
are absent. The client image contains the built bundle and `default.conf`, with no source maps, tests
or `.env` files. `server/Dockerfile` and the package files are present in the server image
(harmless; could be excluded later).

## 4. Runtime validation

The base stack (mongo, server, client) was started with a temporary override that publishes the
client on host port 18080 (host port 8080 was already in use). The override lives **outside** the
repository.

| Check | Result |
|---|---|
| mongo, server and client all became healthy, in dependency order, 0 restarts | PASS |
| Docker health checks executed successfully (server readiness, client `/nginx-health`) | PASS |
| `GET /` and a SPA fallback path (`/campaigns/abc`) | PASS (200) |
| `/nginx-health` | PASS (200) |
| `/api/v1/health/ready` through nginx | PASS (200, database connected) |
| `/api/v1/health` (liveness) through nginx | PASS (404, intentionally blocked) |
| API proxy with a query string | PASS (reaches the app, which answers 401 without a token) |
| 3 MB request body | PASS (413) |
| Security headers on `/` (CSP, `X-Frame-Options`, `nosniff`, `Referrer-Policy`) | PASS |
| `nginx -t` inside the built client container (nginx 1.27.5) | PASS |
| Docker embedded DNS: `server` resolves from the client container (resolver `127.0.0.11`) | PASS |
| Server runs as non-root (`uid=1000`) | PASS |
| Fake query tokens redacted in nginx and API request logs (`?[redacted]`) | PASS |
| Placeholder secrets absent from server logs; no error lines in mongo logs | PASS |

Not exercised: tracking, unsubscribe, campaign, dispatch and email endpoints were deliberately not
called. Redaction of tracking-token **paths** (`/tracking/click/<token>`) was therefore not checked in
Docker; it was checked only on a local nginx outside Docker, with automated tests covering the API's
own request log.

## 5. Server restart and nginx recovery

`docker restart` was run on the server container only; the client and mongo containers were not
touched (IDs and start times unchanged).

| Observation | Result |
|---|---|
| Server restarted and became healthy | PASS |
| nginx kept serving the API **without a client restart** | PASS |
| One transient 502, then continuous 200 responses from about 0.5 s onward | PASS |
| Server container IP before and after the restart | `172.18.0.3` both times (unchanged) |
| **Recovery after a backend IP change, in Docker** | **NOT VERIFIED** |

Because Docker reassigned the same IP, this test would also have passed with the old literal
`proxy_pass`, so it does **not** prove the DNS fix. Separately, an earlier test on a local nginx
(1.31.3, outside Docker) with a stub DNS server that moved the answer between two backends showed
nginx switching to the new address without a reload. That is evidence about nginx's variable-based
`proxy_pass` and resolver behaviour only; it does not show how Docker's resolver behaves.

## 6. Graceful shutdown

`docker stop` on the server container only (stop grace period 40 s, `SHUTDOWN_TIMEOUT_MS` 20 s,
`STOP_GRACE_SECONDS` 40).

| Check | Result |
|---|---|
| Stop completed in about 0.13 s, exit code 0, not OOM-killed | PASS |
| No forced-termination marker in the log | PASS |
| Log sequence: SIGTERM received, HTTP server closed cleanly, MongoDB connection closed cleanly, shutdown completed | PASS |
| mongo and client unchanged and healthy afterwards | PASS |
| API readiness through nginx while the backend is stopped | 502 (expected); `/` and `/nginx-health` still 200 |

**Limit:** the server was idle (no campaigns, no deliveries, no dispatch activity). This confirms
SIGTERM handling and the exit code in Docker. It does **not** test shutdown during an in-flight
campaign, lease release, or the 20 s application timeout under load.

Startup validation was also run outside Docker against a throwaway MongoDB: an invalid
`SHUTDOWN_TIMEOUT_MS` and a timeout not at least 5 s shorter than `STOP_GRACE_SECONDS` were both
refused at startup, and valid values were accepted.

## 7. Caddy and HTTPS

NOT VERIFIED. Caddy was not run. The Caddyfile syntax, the `request>uri delete` log filter, the
timeouts, the body limit, certificate issuance, HTTP-to-HTTPS redirection and HTTPS behaviour have
not been tested. The production overlay was never started.

## 8. State of the validation environment

At the time of writing the validation environment has **not** been cleaned up:

- The MongoDB and client containers are running; the server container is intentionally stopped.
- The project volume (`mailpulse-stage4b2-validation_mongo-data`) and network
  (`mailpulse-stage4b2-validation_default`) are intact.
- The temporary Compose override that remaps the client port is outside the repository.
- No repository files were modified by the validation, and no emails were sent.

## 9. Outstanding work

1. **Docker IP-change recovery:** prove nginx recovers after the backend's address changes,
   for example on a disposable network where another container takes the server's IP before the
   restart.
2. **Caddy validation:** run `caddy validate` on the exact Caddyfile and, separately, test the
   overlay (logging filter, timeouts, body limit). Do not use a real domain or issue certificates.
3. **Shutdown under load:** stop the server during an in-flight campaign (using the mock transport,
   never real SMTP) and confirm lease release and recovery.
4. **Tracking-path redaction in Docker:** verify token paths are redacted in container logs.
5. **Final merge review** of the deployment changes, and the later-stage findings that are out of
   scope here (SMTP timeouts and TLS enforcement, backups and restore, data retention, metrics,
   CI Docker jobs).
