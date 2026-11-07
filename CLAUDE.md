# MailPulse — Claude Code Project Context & Memory

## 1. Project Overview & Architecture

MailPulse is a full-stack email campaign management and analytics platform built as an npm monorepo workspace.

- **Backend (`server/`)**: Node.js (ES modules), Express, MongoDB (Mongoose ODM), Argon2id, Zod, Helmet, Morgan.
- **Frontend (`client/`)**: React 19, Vite, Tailwind CSS, React Router v6, Axios, Recharts.
- **Repository**: `https://github.com/Denish2410/mailPulse.git`
- **Current Branch**: `master`
- **Latest Commit**: see `git log`
- **Testing Baseline**: **858 automated tests** (541 server, 317 client), 0 failures, 0 skipped.

---

## 2. Core Architectural Principles & Hard Constraints

1. **Deployment Constraint (Single Instance)**:
   - Run **exactly one application server instance**.
   - Dispatch concurrency tracking (`activeDispatches`), memory rate limiters, and the background scheduler timer live in-process memory.
2. **Tenant Isolation**:
   - Every user-owned document (`Contact`, `Campaign`, `Delivery`, `Suppression`, `Template`, `Segment`; `TrackingEvent` via its owner's campaigns) MUST be scoped strictly to `{ _id: id, userId }`.
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

## 3. Completed Phases Summary (Phases 1 – 12 + gap fixes + product additions)

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

### Phase 11: Contact Segmentation & Tagging
- Contact `tags` (lowercase, de-duplicated, max 20 per contact, 30 chars each; `server/src/utils/tags.js`), `?tag=` list filter, `GET /contacts/tags` counts.
- `segment.service.js`: rules `tagsAny`/`tagsAll`/`tagsNone`, engagement (`opened`/`clicked`/`not_opened` in last N days, owner campaigns only), `createdWithinDays`; combined with AND, unsubscribed always excluded, at least one rule required.
- `Segment` model + `/api/v1/segments` CRUD with `GET /:id/preview` and `POST /preview` (exact count + 10-contact sample).
- `POST /campaigns/:id/audience` (`{ tags | segmentId, mode: 'replace' | 'add' }`) snapshots the audience into a draft's `recipientIds` (409 if not draft, 422 above 5,000).
- Client: tags in the contact form/table/filter, `/segments` page with live preview, audience picker in the campaign form.

### Phase 12: Inbound Bounce & Complaint Processing (Webhooks)
- `POST /api/v1/webhooks/{sendgrid,mailgun,ses}`: mounted before the JSON parser (raw body for signatures). SendGrid = ECDSA, Mailgun = HMAC-SHA256, SES = SNS RSA signature + allow-listed `SES_SNS_TOPIC_ARNS` + trusted `sns.*.amazonaws.com` cert host. A provider without its secret answers 404 (fail closed). See `server/.env.example`.
- `webhookProviders.service.js` authenticates and normalizes events to `hard_bounce` | `soft_bounce` | `complaint`; dispatch tags every message with `mailpulse_delivery_id` via each enabled provider's custom-args header (`X-SMTPAPI`, `X-Mailgun-Variables`, `X-SES-MESSAGE-TAGS`).
- `bounceProcessing.service.js`: events are matched to our own `Delivery` (tag, then message id; address must match) so the owner never comes from the payload; unmatched events are dropped. Hard bounce -> `Suppression` (`source: 'bounce'`); complaint -> suppression + contact unsubscribed; 3 soft bounces in 30 days -> suppression. Idempotent on `{ provider, providerEventId }`.
- Suppressed addresses are excluded from segments/tag audiences. `GET /campaigns/:id/bounces` + Bounces & Complaints panel in the analytics dialog.

### Gap Fixes (post Phase 12)
- Contacts: `POST /contacts/import` (CSV text, email required, name/tags optional, 5,000 rows, skips duplicates, tenant-scoped) and `GET /contacts/export` (formula-injection-safe CSV, optional `?tag=`) via `server/src/utils/csv.js`; Import/Export buttons on the contacts page.
- Suppressions: `GET/POST /suppressions`, `DELETE /suppressions/:id` + `/suppressions` page. Only `admin`, `import` and `bounce` entries are removable; recipient opt-outs (`link`, `one-click-header`) and `complaint` are permanent (409).
- Campaigns: `POST /campaigns/:id/duplicate` (clean owner-scoped draft copy) + duplicate button.
- Auth: `POST /auth/forgot-password` (uniform response, background email) and `POST /auth/reset-password` (hashed, 1h, single-use token); `POST /auth/verify-email` and `POST /auth/resend-verification` (hashed, 24h token); `emailVerified` on the user payload; sending is NOT gated on verification. Client pages `/forgot-password`, `/reset-password`, `/verify-email` and an unverified-email banner.
- The lazily created send/test-email rate limiters pass `validate: { creationStack: false }`.

### Product Additions (post gap fixes)
- Send throttling: `CAMPAIGN_SEND_RATE_PER_MINUTE` (0/unset = unlimited) spaces sends evenly across all dispatch workers (`sendThrottle.service.js`); released on shutdown.
- Custom contact fields: up to 10 `key=value` text fields per contact (`utils/customFields.js`, lowercase snake_case keys, values <= 200 chars), usable as `{{custom.<field>}}` merge tags (with `| "fallback"`), imported/exported as extra CSV columns (`custom:<key>` for names that clash with standard columns), edited in the contact form.
- Public signup forms with double opt-in: owner CRUD at `/api/v1/signup-forms` (max 10, immutable random slug, tags applied to new subscribers); public `GET /api/v1/public/forms/:slug`, `POST /public/forms/:slug/subscribe` (uniform response, honeypot, 5-min per-address cooldown, tight IP rate limit) and `POST /public/subscriptions/confirm` (hashed 48h single-use token). On confirm: bounced/complained/owner-suppressed addresses stay blocked silently; a recipient's own earlier unsubscribe is lifted by fresh verified consent. Client pages `/signup-forms` (owner), `/subscribe/:slug` and `/confirm-subscription` (public).
- A/B subject testing: optional `Campaign.subjectB`; when set, the audience snapshot alternates deliveries between variant `A` (main subject) and `B` (`Delivery.variant`) and the worker sends each arm its subject. `GET /campaigns/:id/analytics` adds `variants` (per-arm sent, unique opens/clicks, rates, `leader` by open rate; null without a test). There is no automatic winner send.
- Timezone-aware scheduling: the schedule inputs take a timezone (remembered in localStorage); `client/src/utils/timezone.js` converts the wall-clock time to a UTC instant before `POST /schedule`, rejecting DST-gap times. No server change: `scheduledAt` stays one UTC instant.
- Test isolation note: test files share one MongoDB and run in parallel, and some suites recover campaigns left in `sending`; keep dispatches in tests short, and do not run the dev server (restart recovery, watchdog and scheduler) against the same database while testing.

---

## 4. Key Data Models (Mongoose)

- **User** (`server/src/models/User.js`):
  - Fields: `name`, `email`, `passwordHash`, `status` (`'active'` | `'suspended'`), `emailVerifiedAt`, plus hashed one-time `passwordResetTokenHash`/`passwordResetExpiresAt` and `emailVerificationTokenHash`/`emailVerificationExpiresAt` (all `select: false`).
- **Contact** (`server/src/models/Contact.js`):
  - Fields: `userId`, `name`, `email`, `tags`, `customFields` (Map of text), `isUnsubscribed`, `unsubscribedAt`.
  - Indexes: `{ userId: 1, email: 1 }` (unique), `{ userId: 1, tags: 1 }`.
- **Campaign** (`server/src/models/Campaign.js`):
  - Fields: `userId`, `name`, `subject`, `subjectB`, `textContent`, `htmlContent`, `recipientIds`, `status` (`'draft'`, `'scheduled'`, `'sending'`, `'sent'`, `'failed'`), `scheduledAt`, `sendStartedAt`, `sendCompletedAt`, `stats` (`total`, `sent`, `failed`).
  - Indexes: `{ userId: 1, createdAt: -1 }`, `{ status: 1, scheduledAt: 1 }`.
- **Delivery** (`server/src/models/Delivery.js`):
  - Fields: `campaignId`, `userId`, `contactId`, `name`, `email`, `variant` (`'A'`, `'B'`), `status` (`'pending'`, `'processing'`, `'sent'`, `'failed'`), `errorCode` (`'INVALID_MESSAGE'`, `'CONFIGURATION_ERROR'`, `'TRANSPORT_ERROR'`, `'INTERRUPTED'`, `'PERSIST_ERROR'`, `'SUPPRESSED'`, `'UNKNOWN_ERROR'`), `attempts`, `sentAt`, `failedAt`.
- **SignupForm** (`server/src/models/SignupForm.js`): `userId`, `name`, `description`, `tags`, `slug` (unique, immutable), `enabled`.
- **PendingSubscription** (`server/src/models/PendingSubscription.js`): `formId`, `userId`, `email`, `name`, `tokenHash` (unique), `expiresAt` (TTL), unique `{ formId, email }`.
- **Template** (`server/src/models/Template.js`):
  - Fields: `userId`, `name`, `subject`, `textContent`, `htmlContent`.
  - Indexes: `{ userId: 1, name: 1 }` (unique), `{ userId: 1, updatedAt: -1 }`.
- **Segment** (`server/src/models/Segment.js`):
  - Fields: `userId`, `name`, `description`, `criteria` (`tagsAny`, `tagsAll`, `tagsNone`, `engagement`, `createdWithinDays`).
  - Indexes: `{ userId: 1, name: 1 }` (unique), `{ userId: 1, updatedAt: -1 }`.
- **BounceEvent** (`server/src/models/BounceEvent.js`):
  - Fields: `userId`, `campaignId`, `deliveryId`, `contactId`, `email`, `provider`, `eventType`, `reason`, `providerEventId`, `occurredAt`.
  - Indexes: `{ provider: 1, providerEventId: 1 }` (unique), `{ userId: 1, email: 1, eventType: 1, occurredAt: -1 }`, `{ campaignId: 1, eventType: 1 }`.
- **Suppression** (`server/src/models/Suppression.js`):
  - Fields: `userId`, `email`, `reason`, `source` (`link`, `one-click-header`, `admin`, `import`, `bounce`, `complaint`), `campaignId`, `createdAt`.
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
| `/api/v1/auth/forgot-password` | POST | Public | Email a reset link (uniform response) |
| `/api/v1/auth/reset-password` | POST | Public | Set a new password with the emailed token |
| `/api/v1/auth/verify-email` | POST | Public | Confirm email with the emailed token |
| `/api/v1/auth/resend-verification` | POST | Protected | Re-send the verification email |
| `/api/v1/contacts` | GET, POST | Protected | List and create contacts |
| `/api/v1/contacts/:id` | PATCH, DELETE | Protected | Update and delete a contact |
| `/api/v1/contacts/import` | POST | Protected | Bulk CSV import |
| `/api/v1/contacts/export` | GET | Protected | CSV download (`?tag=`) |
| `/api/v1/contacts/tags` | GET | Protected | Tags with contact counts |
| `/api/v1/campaigns` | GET, POST | Protected | List and draft campaigns |
| `/api/v1/campaigns/:id` | GET, PATCH, DELETE | Protected | Campaign CRUD (locked if scheduled/sent) |
| `/api/v1/campaigns/:id/readiness` | GET | Protected | Pre-send readiness check |
| `/api/v1/campaigns/:id/test-email` | POST | Protected | Send `[TEST]` email to account email |
| `/api/v1/campaigns/:id/send` | POST | Protected | Dispatch campaign (`{ confirm: true }`) |
| `/api/v1/campaigns/:id/schedule` | POST | Protected | Schedule campaign (`{ scheduledAt }`) |
| `/api/v1/campaigns/:id/cancel-schedule` | POST | Protected | Cancel schedule, revert to draft |
| `/api/v1/campaigns/:id/duplicate` | POST | Protected | Copy into a new draft |
| `/api/v1/campaigns/:id/audience` | POST | Protected | Fill draft recipients by tag or segment |
| `/api/v1/campaigns/:id/deliveries` | GET | Protected | Delivery audit log |
| `/api/v1/campaigns/:id/bounces` | GET | Protected | Bounce/complaint summary + recent events |
| `/api/v1/campaigns/:id/analytics` | GET | Protected | Open/click engagement analytics |
| `/api/v1/templates` | GET, POST | Protected | List and create templates |
| `/api/v1/templates/:id` | GET, PATCH, DELETE | Protected | Template CRUD |
| `/api/v1/segments` | GET, POST | Protected | List and create segments |
| `/api/v1/segments/preview` | POST | Protected | Preview unsaved criteria |
| `/api/v1/segments/:id` | GET, PATCH, DELETE | Protected | Segment CRUD |
| `/api/v1/segments/:id/preview` | GET | Protected | Count + sample for a saved segment |
| `/api/v1/suppressions` | GET, POST | Protected | List and add suppressions |
| `/api/v1/suppressions/:id` | DELETE | Protected | Remove (admin/import/bounce only) |
| `/api/v1/signup-forms` | GET, POST | Protected | List and create public signup forms |
| `/api/v1/signup-forms/:id` | PATCH, DELETE | Protected | Update (enable/disable, tags) and delete a form |
| `/api/v1/public/forms/:slug` | GET | Public | Form name and description |
| `/api/v1/public/forms/:slug/subscribe` | POST | Public | Start double opt-in (uniform response) |
| `/api/v1/public/subscriptions/confirm` | POST | Public | Confirm with the emailed token |
| `/api/v1/analytics/overview` | GET | Protected | Overview metrics (`?days=7\|30\|90`) |
| `/api/v1/webhooks/sendgrid`, `/mailgun`, `/ses` | POST | Signed (ESP) | Bounce & complaint ingestion |
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

- **Phase 13: Distributed Queue & Multi-Instance Scaling (BullMQ / Redis)**:
  - Remove single-instance constraint by replacing memory queues with Redis + BullMQ.
  - Enable multiple server replicas behind load balancers.
- **Phase 14: Automated Drip Campaigns & Sequences**:
  - Time-delayed drip journeys (Welcome series: Day 1 -> Day 3 -> Day 7).
  - Event triggers and visual workflow branching.

