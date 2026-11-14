# Stage 4B.2.1: Deployment validation report

This report records what was actually run to validate the Stage 4B.2 deployment hardening
(commit `1e3454c`, `chore(deploy): harden production container configuration`, merged to `master`
as PR #16). It is a validation record, **not** a production-readiness statement. Several checks are
explicitly NOT VERIFIED or PARTIAL; they are listed in [Outstanding work](#9-outstanding-work).

Sections 1-9 are the original validation record and are kept as written. Sections 10-12 were added
later and record two follow-up tasks: Task H (Caddy configuration validation) and Task I (Docker DNS
recovery validation). Where a later result changes the status of an earlier item, the earlier section
carries a pointer to it.

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
| **Recovery after a backend IP change, in Docker** | **NOT VERIFIED** in this run (addressed later by Task I: [section 11](#11-task-i-docker-dns-recovery-validation)) |

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

*Historical status: at the time of this original run, every Caddy item below was **NOT VERIFIED**.
Task H later checked only the Caddyfile **syntax** and its **adapted configuration** (see
[section 10](#10-task-h-caddy-configuration-validation)); it did not run Caddy, so Caddy runtime
behaviour was not tested and is still NOT VERIFIED.*

NOT VERIFIED. Caddy was not run. The Caddyfile syntax, the `request>uri delete` log filter, the
timeouts, the body limit, certificate issuance, HTTP-to-HTTPS redirection and HTTPS behaviour have
not been tested. The production overlay was never started.

## 8. State of the validation environment

At the time of the original run the validation environment had **not** been cleaned up. Tasks H and I
did not change that; their own state is recorded in sections 10 and 11. At that time:

- The MongoDB and client containers were running; the server container was intentionally stopped.
- The project volume (`mailpulse-stage4b2-validation_mongo-data`) and network
  (`mailpulse-stage4b2-validation_default`) were intact.
- The temporary Compose override that remaps the client port was outside the repository.
- No repository files had been modified by the validation, and no emails had been sent.

## 9. Outstanding work

1. **Docker IP-change recovery:**
   - *Done (Task I, [section 11](#11-task-i-docker-dns-recovery-validation)):* recovery of nginx after
     the backend's IP changed, without an nginx restart or reload, was demonstrated on a disposable
     Docker network (PASS, with one transient 504).
   - *Remaining, NOT VERIFIED:* a controlled experiment that waits out the full 10 s resolver
     validity interval, and an explanation for why the first post-swap request already reached the
     new backend.
2. **Caddy validation:**
   - *Done (Task H, [section 10](#10-task-h-caddy-configuration-validation)):* Caddyfile syntax
     validation and configuration adaptation (PASS).
   - *Remaining, NOT VERIFIED:* actual removal of the URI and Referer from real Caddy log lines,
     certificate issuance, runtime HTTPS and HTTP-to-HTTPS redirect behaviour, runtime timeout and
     body-limit behaviour, and Caddy recovery after the client container's IP changes. These need a
     running Caddy, tested without a real domain or real certificates.
3. **Shutdown under load:** stop the server during an in-flight campaign (using the mock transport,
   never real SMTP) and confirm lease release and recovery.
4. **Tracking-path redaction in Docker:** verify token paths are redacted in container logs.
5. **Final merge review** of the deployment changes, and the later-stage findings that are out of
   scope here (SMTP timeouts and TLS enforcement, backups and restore, data retention, metrics,
   CI Docker jobs).

## 10. Task H: Caddy configuration validation

Task H validated the repository `Caddyfile` with the Caddy image the production overlay references.
No Caddy server was started. Nothing in the repository was changed.

### Environment and preflight

- Docker Engine 29.9.3, `aarch64` (ARM64).
- MongoDB: running and healthy, container ID `106d260ca046` (unchanged).
- Client: running and healthy, container ID `b79af27a7cda` (unchanged).
- Server: stopped, exit code 0, container ID `13370407166d` (unchanged).
- The five unrelated pre-existing containers were unchanged.
- Git was on `docs/stage-4b21-validation-report` at `d585f0a` with a clean working tree.

MongoDB and the client showed new start times because Docker's `unless-stopped` restart policy brought
them back when the Docker daemon restarted. Their container IDs were unchanged and their restart
counts were zero.

### Caddy image

| Item | Value |
|---|---|
| Image | `caddy:2` (the tag used by `docker-compose.prod.yml`) |
| Resolved version | Caddy v2.11.9 |
| Platform | linux/arm64 |
| Image ID and repository digest | `sha256:4e2425f6009577e7c651010f16679c28f7d12df3e7b1914f941a7a3370746b3c` |
| Obtained by | pulled (it was not available locally) |

`caddy:2` is a **floating tag**, not a pinned one: a later pull can resolve to a different release.
The digest above identifies only the image that was validated.

### How validation was run

Each command used a disposable container (`docker run --rm`) with `--network none`, `--read-only`,
temporary in-memory filesystems for writable paths, the repository mounted read-only, no published
ports, and no named volumes. The validation domain was `mailpulse-validation.invalid`.

| Command | Result |
|---|---|
| `caddy validate --config /workspace/Caddyfile --adapter caddyfile` | **PASS** (exit 0, "Valid configuration") |
| `caddy adapt --pretty` (to inspect the generated JSON) | **PASS** (exit 0) |
| `caddy fmt --diff` | exit 0; reports that the file differs from Caddy's canonical formatting (cosmetic only) |

### What the adapted configuration contains

| Item | Adapted value |
|---|---|
| Reverse proxy | single upstream `client:80`, HTTP transport |
| Server timeouts | read header 10 s, read body 30 s, write 120 s, idle 120 s |
| Upstream timeouts | dial 5 s, response header 70 s |
| Request body maximum | 2,000,000 bytes |
| Access log | JSON to stdout |
| Default/error log | JSON to stderr |
| Log filters (both loggers) | `request>uri` delete and `request>headers>Referer` delete |
| Response header | `Strict-Transport-Security` set |
| Compression | gzip |
| TLS | site on port 443 with Caddy's automatic HTTPS; automatic HTTP-to-HTTPS redirect enabled by default |

Two observations:

- **Body-limit difference between layers:** Caddy's limit is 2,000,000 bytes, while nginx's `2m` is
  2 MiB (2,097,152 bytes). Caddy is therefore slightly more restrictive. This is conservative and
  harmless, but the two layers are not identical.
- **Logging trade-off:** deleting the request URI from Caddy's logs removes path-level information
  from them, which reduces debugging detail. The redacted nginx log behind Caddy remains the place
  for request paths.

### Status

| Item | Status |
|---|---|
| Caddyfile syntax | **PASS** |
| Configuration adaptation | **PASS** |
| Log filters present in the adapted configuration | **PASS** (configuration only) |
| Actual removal of URI and Referer from real Caddy log lines | **NOT VERIFIED** |
| Certificate issuance | **NOT VERIFIED** |
| Runtime HTTPS and HTTP-to-HTTPS redirect behaviour | **NOT VERIFIED** |
| Runtime timeout behaviour | **NOT VERIFIED** |
| Runtime body-limit behaviour | **NOT VERIFIED** |
| Caddy recovery after the client container's IP changes | **NOT VERIFIED** |

Syntax validation and the adapted JSON do not prove runtime logging behaviour, so none of the runtime
rows above should be read as verified. The only persistent resource added by Task H is the pulled
`caddy:2` image; no repository files changed.

## 11. Task I: Docker DNS recovery validation

Task I tested whether the repository's nginx configuration recovers when the hostname it proxies to
moves to a different IP address, without nginx being restarted or reloaded. This addresses the item
that section 5 recorded as NOT VERIFIED.

### Test environment

- nginx 1.27.5, from the locally built client image, which carries the repository's
  `client/nginx.conf` (resolver `127.0.0.11`, 10 s validity, variable-based `proxy_pass` to
  `server:5000`).
- A completely separate disposable Docker network (`172.30.77.0/24`, checked for overlap with the
  existing networks beforehand).
- No existing MailPulse container or network was used or modified, no host ports were published, and
  no persistent volumes were created.
- Two tiny disposable backends that answer with `BACKEND_A` or `BACKEND_B`, both registered under the
  Docker network alias `server`, with different static IPs. They ran as small Node.js HTTP servers in
  the already-local `node:20-alpine` image.
- Requests were sent from inside the nginx container with `wget` to `http://127.0.0.1/api/v1/health/ready`.

### Results

| Test | Result |
|---|---|
| **A. Initial backend:** backend A (`172.30.77.10`); three requests through nginx returned `BACKEND_A` | **PASS** |
| **B. Replacement:** backend A removed, backend B (`172.30.77.11`, same alias) started; the first request after the swap returned `BACKEND_B`, and 118 of 118 further requests over 45 s did too | **PASS** (recovery without nginx restart or reload) |
| **C. Process preservation:** nginx container ID and start time unchanged; master PID stayed 1; all ten worker PIDs unchanged; no reload or signal entries in the logs | **PASS** |

### Transient failure

One request, about 3.4 s after the backend swap (a figure derived from the test script's own
timestamps), failed with **HTTP 504**. The 504 and nginx's logged request time of about 5.007 s are
consistent with the configured 5 s connection timeout, for example an attempt against the old address.
The cause was **not conclusively confirmed**: nginx's error log is set to critical entries only (to
keep tokens out of it), so it held no line that confirms what timed out. The transient failure is
recorded here and is **not** a permanent failure: every later request succeeded. Users could see a
brief error while an upstream is replaced.

### DNS cache timing qualification

The test did **not** deliberately wait out the configured 10 s resolver validity interval before the
first post-swap request, and that first request already reached backend B. The reason for the
immediate recovery was **not established**. Per-worker resolver caching was suggested as one possible
explanation but was not proven.

| Item | Status |
|---|---|
| Docker DNS recovery without nginx restart or reload | **PASS** |
| Controlled experiment that waits out the full 10 s cache interval | **NOT VERIFIED** |
| Explanation for the immediate recovery | **NOT VERIFIED** |

### Cleanup and preserved state

The disposable backend containers and the test network were removed; no disposable Task I resources
remain. MongoDB and the client stayed healthy, the server stayed stopped, and the five unrelated
containers were unchanged. Git remained on `docs/stage-4b21-validation-report` at `d585f0a` with a
clean working tree. No repository files were modified.

## 12. Updated status summary

| Area | Status |
|---|---|
| Caddy syntax validation | PASS |
| Caddy configuration adaptation | PASS |
| Caddy runtime log redaction | NOT VERIFIED |
| Caddy runtime HTTPS and certificate behaviour | NOT VERIFIED |
| Docker DNS recovery after a backend IP replacement | PASS |
| Same nginx process, no reload or restart | PASS |
| Transient failure during replacement | one 504 observed |
| Controlled full 10 s cache-expiration experiment | NOT VERIFIED |

These results validate specific deployment configuration and behaviour. They do **not** establish that
the MailPulse production deployment as a whole is ready. Still open from this report and from the
original audit: backup and restore readiness, production secrets management, real external HTTPS and
certificate validation, shutdown under load, tracking-path redaction in Docker, full end-to-end
deployment testing, and the remaining application and operational gaps (SMTP timeouts and TLS
enforcement, data retention, metrics, CI Docker jobs).
