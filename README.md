# MailPulse

MailPulse is a full-stack email campaign management and analytics platform built with the MERN stack (MongoDB, Express, React, Node.js).

This repository contains both the frontend client and the backend server applications organized as an npm monorepo workspace.

---

## Folder Structure

```text
MailPulse/
├── client/
│   ├── public/
│   ├── src/
│   │   ├── api/
│   │   │   └── health.js
│   │   ├── assets/
│   │   ├── components/
│   │   │   ├── common/
│   │   │   │   └── ConnectivityCheck.jsx
│   │   │   ├── layout/
│   │   │   ├── contacts/
│   │   │   └── campaigns/
│   │   ├── pages/
│   │   │   ├── auth/
│   │   │   ├── dashboard/
│   │   │   ├── contacts/
│   │   │   ├── campaigns/
│   │   │   └── analytics/
│   │   ├── hooks/
│   │   ├── lib/
│   │   │   └── api.js
│   │   ├── services/
│   │   │   └── api.js
│   │   ├── context/
│   │   ├── utils/
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── tests/
│   │   └── api.test.js
│   ├── .env.example
│   ├── (client/.env - create locally, ignored by git)
│   ├── package.json
│   └── vite.config.js
│
├── server/
│   ├── src/
│   │   ├── config/
│   │   │   └── db.js
│   │   ├── middleware/
│   │   │   └── errorHandler.js
│   │   ├── routes/
│   │   │   └── health.routes.js
│   │   ├── validators/
│   │   │   └── validate.js
│   │   ├── controllers/
│   │   ├── models/
│   │   ├── services/
│   │   ├── jobs/
│   │   ├── utils/
│   │   ├── app.js
│   │   └── server.js
│   ├── tests/
│   │   ├── appConfig.test.js
│   │   ├── errorHandler.test.js
│   │   ├── health.test.js
│   │   ├── shutdown.test.js
│   │   └── validation.test.js
│   ├── package.json
│   ├── .env.example
│   └── (server/.env - create locally, ignored by git)
│
├── docs/
│   ├── architecture.md
│   └── api.md
│
├── .gitignore
├── package.json
└── README.md
```

---

## Technology Stack

### Frontend (`client/`)
- **React.js (v19)** with JSX
- **Vite** build tool and dev server
- **Tailwind CSS** utility-first styling
- **React Router** client-side routing
- **Axios** HTTP client with centralized instance and configuration
- **Recharts** analytics visualization

### Backend (`server/`)
- **Node.js** with ES modules (`"type": "module"`)
- **Express.js** web framework
- **MongoDB** database with **Mongoose** ODM
- **dotenv** environment management
- **cors** cross-origin resource sharing
- **helmet** HTTP security headers
- **morgan** HTTP request logger
- **zod** runtime schema validation
- **express-rate-limit** rate limiting middleware
- **nodemon** development server

---

## Campaign Management & Preview

MailPulse provides a complete campaign drafting, recipient assignment, readiness validation, and review workflow:

- **Campaign CRUD & Recipient Selection**: Create, search, paginate, edit, and delete campaign drafts. Attach recipients selected from the authenticated user's contact list.
- **Backend Readiness Validation**: The `GET /api/v1/campaigns/:id/readiness` endpoint verifies draft status, name and subject constraints, non-empty content (HTML or plain text), and confirms at least one selected recipient resolves to an existing owned contact.
- **Preview & Review UI**: A dedicated modal dialog providing live readiness checks, safe plain-text viewing, and an isolated sandboxed `<iframe>` (`sandbox=""`, `srcDoc`) for email HTML rendering without script execution or DOM injection risks.
- **Recipient Metrics**: Clear metric breakdowns distinguishing total selected recipients, verified eligible recipients, and missing or unavailable contacts.
- **Test Emails**: `POST /api/v1/campaigns/:id/test-email` sends a single `[TEST]` copy of a draft to the signed-in user's own account email only. It never contacts campaign recipients, never modifies the campaign, is rate limited per user, and fails closed (HTTP 503) when SMTP is not configured. The Preview & Review dialog exposes this as a **Send test email** button, disabled until the draft has a subject and content, with duplicate-click protection and clear feedback for rate limits and configuration errors.
- **Campaign Sending**: `POST /api/v1/campaigns/:id/send` (body `{ "confirm": true }`) sends a ready draft to its verified recipients. Readiness and SMTP configuration are re-checked server-side, and the `draft -> sending` transition is atomic so a campaign can never be sent twice. Messages go out in the background with bounded concurrency, one Delivery record per recipient, and the campaign finishes as `sent` or `failed`. Sent campaigns are locked against editing and deletion. In the UI, **Send campaign** in the Preview & Review dialog asks for confirmation, then shows live progress and a per-recipient delivery report.
- **Delivery Log**: `GET /api/v1/campaigns/:id/deliveries` returns per-recipient status (`pending`, `processing`, `sent`, `failed`) with sanitized error codes and a summary. Interrupted sends resume on restart without re-sending to anyone, and a watchdog recovers campaigns whose dispatch stalls while the server is running.
- **Delivery guarantee**: each recipient is emailed **at most once** per campaign. It is not exactly-once: `sent` means "accepted by the SMTP transport", not "delivered", and a crash or database failure right after acceptance is recorded as `failed` (`INTERRUPTED` or `PERSIST_ERROR`) even though the message likely went out. Treat counts as a lower bound.
- **Limits**: a campaign may target at most **5,000 recipients** (enforced on create, update and send).
- **Deployment constraint**: run **exactly one server instance**. Dispatch bookkeeping and the per-user rate limiters live in process memory; with several instances, recovery on one instance can fail deliveries another is still sending, and rate limits multiply by the instance count.
- **Not yet implemented**: scheduled sends, per-recipient personalization, unsubscribe links, and open/click/bounce tracking.

---

## Analytics

`GET /api/v1/analytics/overview?days=7|30|90` returns an owner-scoped summary: contact and campaign counts, delivery totals, a zero-filled daily series of accepted/failed sends (UTC days), failure reasons, and the five most recent sent campaigns with their acceptance rate.

- **Analytics page** (`/analytics`): range switcher, KPI cards, a stacked daily bar chart (Recharts), recent campaigns table and failure-reason breakdown.
- **Dashboard**: the campaign card now shows live 30-day numbers instead of placeholders.
- "Accepted" means the SMTP provider accepted the message; opens, clicks and bounces are not tracked yet.

## Quick-Start Guide

### 1. Prerequisites
- **Node.js**: v20+ or v22+ (LTS recommended)
- **npm**: v10+
- **MongoDB**: Local instance running on `mongodb://localhost:27017` or a MongoDB Atlas URI

### 2. Installation
From the project root directory, install dependencies across both `client` and `server` workspaces:

```bash
npm install
```

### 3. Environment Setup

#### Backend Configuration (`server/.env`)
Copy the backend example template:
```bash
cp server/.env.example server/.env
```
Default configuration values in `server/.env`:
```env
NODE_ENV=development
PORT=5000
CLIENT_URL=http://localhost:5173
MONGODB_URI=mongodb://localhost:27017/mailpulse
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=100
```

#### Frontend Configuration (`client/.env`)
Copy the frontend example template:
```bash
cp client/.env.example client/.env
```
Default configuration values in `client/.env`:
```env
# Backend API Base URL (must use VITE_ prefix to be exposed to Vite browser code)
VITE_API_BASE_URL=http://localhost:5000/api/v1
```

> **Security Note**:
> - Only environment variables prefixed with `VITE_` are exposed to the browser.
> - Never store database credentials, server private keys, or secrets in `client/.env`.
> - All `.env` files are ignored by git in `.gitignore`.

### 4. Starting Frontend and Backend Concurrently
Start both applications simultaneously with colored prefixes and unified process lifecycle management:

```bash
npm run dev
```
- Frontend starts on: `http://localhost:5173`
- Backend API starts on: `http://localhost:5000` (Health check at `http://localhost:5000/api/v1/health`)
- Stopping the process with `Ctrl+C` cleanly terminates both child processes without leaving orphaned background services.

### 5. Starting Applications Separately

```bash
# Start only the Express backend (nodemon with auto-reload)
npm run dev:server

# Start only the Vite frontend dev server
npm run dev:client
```

### 6. Running Automated Tests

MailPulse uses Node.js's native test runner (`node:test`) for lightweight, zero-dependency testing.

```bash
# Run all project test suites sequentially (fails if either suite fails)
npm test

# Run backend tests only (36 tests across 5 suites)
npm run test:server

# Run frontend tests only (15 tests covering API client & health probes)
npm run test:client
```

### 7. Building the Frontend for Production

```bash
# Build the production bundle into client/dist/
npm run build

# Direct workspace alias
npm run build:client
```

---

## Root Script Reference

| Command | Action | Implementation Details |
| :--- | :--- | :--- |
| `npm run dev` | Starts server & client concurrently | Uses `concurrently -k` with colored prefixes (`[server]`, `[client]`). Automatically terminates child processes on exit. |
| `npm run dev:server` | Starts Express backend | Runs `nodemon src/server.js` in `server/`. |
| `npm run dev:client` | Starts Vite frontend | Runs `vite` in `client/` on port `5173`. |
| `npm test` | Runs all test suites | Executes `npm run test:server && npm run test:client`. Exits non-zero if either suite fails. |
| `npm run test:server` | Runs backend test suite | Runs `node --test tests/**/*.test.js` in `server/`. |
| `npm run test:client` | Runs frontend test suite | Runs `node --test tests/**/*.test.js` in `client/`. |
| `npm run build` | Builds frontend production bundle | Calls `npm run build:client` -> `vite build` in `client/`. |
| `npm run build:client` | Explicit build script alias | Runs `npm --prefix client run build`. |
| `npm run start:server` | Starts backend in production mode | Runs `node src/server.js` in `server/`. |

---

## Troubleshooting Guide

### 1. MongoDB Connection Errors
- **Symptom**: `[Server Error] Startup failed: Connection refused to MongoDB host` or Readiness returns `503 Not Ready`.
- **Cause**: The MongoDB daemon is not running locally or the connection URI is wrong.
- **Solution**:
  - macOS (Homebrew): `brew services start mongodb-community`
  - Linux: `sudo systemctl start mongod`
  - Verify MongoDB status: `mongosh --eval "db.adminCommand('ping')"`
  - Check `MONGODB_URI` in `server/.env`.

### 2. Occupied Ports (`EADDRINUSE`)
- **Symptom**: `Startup failed: listen EADDRINUSE: address already in use :::5000`.
- **Causes**:
  - **macOS AirPlay Receiver**: On macOS Monterey, Ventura, Sonoma, and Sequoia, macOS ControlCenter listens on port 5000 by default for AirPlay Receiver (`commplex-main`).
    - *Fix A*: Turn off AirPlay Receiver in **System Settings > General > AirDrop & AirPlay > AirPlay Receiver (Toggle Off)**.
    - *Fix B*: Change `PORT=5005` in `server/.env` and update `VITE_API_BASE_URL=http://localhost:5005/api/v1` in `client/.env`.
  - **Stray process**: Check which process is occupying the port with `lsof -i :5000` and stop the conflicting process.

### 3. Missing or Misconfigured Environment Variables
- **Symptom**: Warning in browser console: `[MailPulse API] VITE_API_BASE_URL is not set...` or backend fails with missing config.
- **Cause**: `.env` file was not created or lacks required keys.
- **Solution**:
  - Verify `server/.env` exists and has `PORT`, `CLIENT_URL`, `MONGODB_URI`.
  - Verify `client/.env` exists and contains `VITE_API_BASE_URL=http://localhost:5000/api/v1` (ensure the `VITE_` prefix is present).

### 4. Frontend API Connectivity & CORS Failures
- **Symptom**: In-app connectivity check turns red with `Backend server not detected` or browser console reports `Blocked by CORS policy`.
- **Cause**: Backend is stopped, port numbers do not match, or CORS origin differs from the Vite dev server origin.
- **Solution**:
  - Ensure the backend is running (`npm run dev:server`).
  - Verify `CLIENT_URL` in `server/.env` matches the frontend URL (`http://localhost:5173`).
  - Verify `VITE_API_BASE_URL` in `client/.env` matches the backend host and port (`http://localhost:5000/api/v1`).
  - Use the in-app **"Re-check"** button in `ConnectivityCheck` to verify once resolved

---

## Documentation

- [Architecture Overview](file:///Users/denishahalpara/Desktop/MailPulse/docs/architecture.md)
- [API Specifications](file:///Users/denishahalpara/Desktop/MailPulse/docs/api.md)
