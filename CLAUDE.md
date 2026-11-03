# MailPulse — Claude Code Project Context & Memory

## 1. Project Overview & Architecture

MailPulse is a full-stack email campaign management and analytics platform built as an npm monorepo workspace.

- **Backend (`server/`)**: Node.js (ES modules), Express, MongoDB (Mongoose ODM), Argon2id, Zod, Helmet, Morgan.
- **Frontend (`client/`)**: React 19, Vite, Tailwind CSS, React Router v6, Axios, Recharts.
- **Repository**: `https://github.com/Denish2410/mailPulse.git`
- **Current Branch**: `master`
- **Latest Commit**: see `git log` (Phase 10 work lives on branch `phase10/personalization`)
- **Testing Baseline**: **673 automated tests** (403 server, 270 client), 0 failures, 0 skipped.

---

## 2. Core Architectural Principles & Hard Constraints

1. **Deployment Constraint (Single Instance)**:
   - Run **exactly one application server instance**.
   - Dispatch concurrency tracking (`activeDispatches`), memory rate limiters, and the background scheduler timer live in-process memory.
2. **Tenant Isolation**:
   - Every user-owned document (`Contact`, `Campaign`, `Delivery`, `Suppression`, `TrackingEvent`) MUST be scoped strictly to `{ _id: id, userId }`.
   - Never expose raw database IDs or sensitive internal fields in safe formatting functions.
3. **Fail-Closed Security**:
   - Verify SMTP configuration before locking drafts (`503 Service Unavailable` if unconfigured).
   - Rate limit `/test-email` per user (in-memory sliding window).
   - Prevent open-redirect vulnerabilities on click-tracking by enforcing `http:` or `https:`.
4. **Atomic State Machine for Campaigns**:
   - Lifecycle: `draft` ➔ `scheduled` ➔ `sending` ➔ `sent` | `failed`.
   - Transition to `sending` requires atomic MongoDB `findOneAndUpdate` conditioned on status and `updatedAt`.
   - While `scheduled`, `sending`, `sent`, or `failed`, mutations via `PATCH` and `DELETE` MUST return `409 Conflict`.
5. **Delivery Guarantee (At-Most-Once)**:
   - Maximum recipient cap: **5,000 recipients per campaign**.
   - Each recipient receives **at most one email** per campaign.
   - If a crash occurs after transport acceptance, record as `failed` (`INTERRUPTED` or `PERSIST_ERROR`) to prevent duplicate sends.
6. **Zero Real Email Safety in Tests**:
   - Automated tests MUST always use the mock transport (`createMockTransport()`).
   - Never configure real SMTP credentials during test executions.

---

## 3. Completed Phases Summary (Phases 1 – 10)

### Phase 1: Core Infrastructure & Security
- Monorepo setup, centralized Express error handling, Helmet, CORS, morgan logging.
- Database connection lifecycle with health probes (`GET /api/v1/health`, `GET /api/v1/health/ready`).
- Graceful shutdown handlers for `SIGINT` and `SIGTERM`.

### Phase 2: Authentication & Account Lifecycle
- Argon2id password hashing with timing-attack resistant comparisons.
- JWT Access tokens with configurable expiration and verification middleware.
- `User` model with account status (`active`, `suspended`).
- Auth routes: `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `GET /api/v1/auth/me`.
- Client Auth context, protected routes, and login/registration views.

### Phase 3: Contact & Audience Management
- Multi-tenant `Contact` model with compound index `{ userId: 1, email: 1 }`.
- Contact CRUD with search, pagination, and domain filtering.
- Bulk CSV contact import endpoint and modal UI.

### Phase 4: Campaign Drafting & Readiness Engine
- `Campaign` model with lifecycle states (`draft`, `scheduled`, `sending`, `sent`, `failed`).
- Server-side readiness validation (`GET /api/v1/campaigns/:id/readiness`).
- Sandboxed XSS-safe `<iframe>` (`sandbox=""`, `srcDoc`) for email HTML preview.

### Phase 5: Email Service & Safe Batch Dispatch
- Email service abstraction with mock & Nodemailer transports.
- Test email dispatch (`POST /:id/test-email`) exclusively to user's account address.
- Batch dispatch (`POST /:id/send`, `{ confirm: true }`) with atomic version locks.
- Concurrency worker pool, `Delivery` audit log, stall watchdog, and restart recovery.

### Phase 6: High-Level Analytics & Dashboard
- Aggregated metrics endpoint (`GET /api/v1/analytics/overview?days=7|30|90`).
- Recharts daily time-series chart, delivery acceptance rates, and failure distributions.
- Frontend `/analytics` page and live dashboard KPI cards.

### Phase 7: Open & Click Tracking Engine
- Cryptographic HMAC-SHA256 tracking tokens.
- Transparent 1x1 GIF tracking pixel (`GET /api/v1/tracking/open/:token`) with anti-cache headers.
- Click redirect (`GET /api/v1/tracking/click/:token`) with open-redirect protection.
- Automated link rewriting and pixel injection in HTML emails.
- Engagement metrics: total/unique opens, CTR, CTD, per-link analytics.

### Phase 8: Unsubscribe & Suppression Management (RFC 8058)
- Cryptographic HMAC-SHA256 unsubscribe tokens and `{{unsubscribeUrl}}` injection.
- RFC 8058 one-click native headers (`List-Unsubscribe`, `List-Unsubscribe-Post`).
- Web confirmation page (`GET /api/v1/tracking/unsubscribe/:token`) and one-click submission (`POST`).
- Tenant-scoped permanent `Suppression` collection (`{ userId: 1, email: 1 }`).
- Dual-layer suppression enforcement in Campaign Readiness and Dispatch worker (`SUPPRESSED` error code).

### Phase 9: Scheduled Campaign Dispatch
- In-process background scheduler worker (`campaignScheduler.service.js`) with interval polling.
- Overlapping-poll prevention and atomic claim (`scheduledAt <= now` ➔ `sending`).
- Endpoints: `POST /:id/schedule` and `POST /:id/cancel-schedule`.
- Edit/delete locks (`409 Conflict`) while scheduled.
- Frontend datetime picker, "Scheduled" badges, and preview reschedule/cancel controls.

### Phase 10: Template Engine & Personalization
- `personalization.service.js`: `{{name}}`, `{{firstName}}`, `{{lastName}}`, `{{email}}` with `{{tag | "fallback"}}`; single-pass, HTML-escaped in HTML, control chars stripped in subjects; unknown and `{{unsubscribeUrl}}` tags untouched.
- Merge tags render per recipient in dispatch (before tracking/unsubscribe injection) and in test emails (account holder's details).
- `Template` model + `/api/v1/templates` CRUD (tenant-scoped, unique name per user, 200 per user).
- Client: `/templates` library page, "Start from template" in the campaign form (copy, not link), merge tag toolbar.

---

## 4. Key Data Models (Mongoose)

- **User** (`server/src/models/User.js`):
  - Fields: `name`, `email`, `passwordHash`, `status` (`'active'` | `'suspended'`).
- **Contact** (`server/src/models/Contact.js`):
  - Fields: `userId`, `name`, `email`, `isUnsubscribed`, `unsubscribedAt`.
  - Indexes: `{ userId: 1, email: 1 }` (unique).
- **Campaign** (`server/src/models/Campaign.js`):
  - Fields: `userId`, `name`, `subject`, `textContent`, `htmlContent`, `recipientIds`, `status` (`'draft'`, `'scheduled'`, `'sending'`, `'sent'`, `'failed'`), `scheduledAt`, `sendStartedAt`, `sendCompletedAt`, `stats` (`total`, `sent`, `failed`).
  - Indexes: `{ userId: 1, createdAt: -1 }`, `{ status: 1, scheduledAt: 1 }`.
- **Delivery** (`server/src/models/Delivery.js`):
  - Fields: `campaignId`, `userId`, `contactId`, `name`, `email`, `status` (`'pending'`, `'processing'`, `'sent'`, `'failed'`), `errorCode` (`'INVALID_MESSAGE'`, `'CONFIGURATION_ERROR'`, `'TRANSPORT_ERROR'`, `'INTERRUPTED'`, `'PERSIST_ERROR'`, `'SUPPRESSED'`, `'UNKNOWN_ERROR'`), `attempts`, `sentAt`, `failedAt`.
- **Template** (`server/src/models/Template.js`):
  - Fields: `userId`, `name`, `subject`, `textContent`, `htmlContent`.
  - Indexes: `{ userId: 1, name: 1 }` (unique), `{ userId: 1, updatedAt: -1 }`.
- **Suppression** (`server/src/models/Suppression.js`):
  - Fields: `userId`, `email`, `reason`, `source`, `createdAt`.
  - Indexes: `{ userId: 1, email: 1 }` (unique).
- **TrackingEvent** (`server/src/models/TrackingEvent.js`):
  - Fields: `campaignId`, `userId`, `contactId`, `eventType` (`'open'`, `'click'`, `'unsubscribe'`), `targetUrl`, `userAgent`, `ipHash`, `createdAt`.

---

## 5. API Endpoints Quick Reference

| Route | Method | Access | Description |
|---|---|---|---|
| `/api/v1/health` | GET | Public | Liveness check |
| `/api/v1/health/ready` | GET | Public | Readiness check (MongoDB ping) |
| `/api/v1/auth/register` | POST | Public | Register new user |
| `/api/v1/auth/login` | POST | Public | Authenticate user & return JWT |
| `/api/v1/auth/me` | GET | Protected | Get authenticated profile |
| `/api/v1/contacts` | GET, POST | Protected | List and create contacts |
| `/api/v1/contacts/:id` | GET, PUT, DELETE | Protected | Contact CRUD |
| `/api/v1/contacts/import` | POST | Protected | Bulk CSV import |
| `/api/v1/campaigns` | GET, POST | Protected | List and draft campaigns |
| `/api/v1/campaigns/:id` | GET, PATCH, DELETE | Protected | Campaign CRUD (locked if scheduled/sent) |
| `/api/v1/campaigns/:id/readiness` | GET | Protected | Pre-send readiness check |
| `/api/v1/campaigns/:id/test-email` | POST | Protected | Send `[TEST]` email to account email |
| `/api/v1/campaigns/:id/send` | POST | Protected | Dispatch campaign (`{ confirm: true }`) |
| `/api/v1/campaigns/:id/schedule` | POST | Protected | Schedule campaign (`{ scheduledAt }`) |
| `/api/v1/campaigns/:id/cancel-schedule` | POST | Protected | Cancel schedule, revert to draft |
| `/api/v1/campaigns/:id/deliveries` | GET | Protected | Delivery audit log |
| `/api/v1/campaigns/:id/analytics` | GET | Protected | Open/click engagement analytics |
| `/api/v1/templates` | GET, POST | Protected | List and create templates |
| `/api/v1/templates/:id` | GET, PATCH, DELETE | Protected | Template CRUD |
| `/api/v1/analytics/overview` | GET | Protected | Overview metrics (`?days=7\|30\|90`) |
| `/api/v1/tracking/open/:token` | GET | Public | Transparent 1x1 GIF tracking pixel |
| `/api/v1/tracking/click/:token` | GET | Public | Click tracking redirect |
| `/api/v1/tracking/unsubscribe/:token` | GET, POST | Public | Web landing page & RFC 8058 1-click |

---

## 6. Development & Verification Workflow

```bash
# 1. Run server tests (requires local MongoDB daemon on localhost:27017)
npm run test:server

# 2. Run client tests
npm run test:client

# 3. Run all tests
npm test

# 4. Build frontend client for production
npm run build:client

# 5. Check formatting and trailing whitespace before committing
git diff --check
```

---

## 7. Future Phases Roadmap

- **Phase 11: Contact Segmentation & Tagging**:
  - Tags (`VIP`, `Lead`) and smart dynamic filters (e.g., opened in last 30 days).
  - Target campaigns directly by tag or segment criteria.
- **Phase 12: Inbound Bounce & Complaint Processing (Webhooks)**:
  - ESP webhook ingress (SES, SendGrid, Mailgun) for hard/soft bounces and spam complaints.
  - Automatic suppression of hard bounces.
- **Phase 13: Distributed Queue & Multi-Instance Scaling (BullMQ / Redis)**:
  - Remove single-instance constraint by replacing memory queues with Redis + BullMQ.
  - Enable multiple server replicas behind load balancers.
- **Phase 14: Automated Drip Campaigns & Sequences**:
  - Time-delayed drip journeys (Welcome series: Day 1 -> Day 3 -> Day 7).
  - Event triggers and visual workflow branching.

