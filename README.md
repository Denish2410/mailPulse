<div align="center">

# 📬 MailPulse

### Write it. Check it. Send it. Measure it.

**A friendly, full-stack email campaign platform — from first draft to delivery report.**

![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-API-000000?style=for-the-badge&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-Build-646CFF?style=for-the-badge&logo=vite&logoColor=white)

[🚀 Quick Start](#-up-and-running-in-4-steps) •
[✨ Features](#-what-mailpulse-does) •
[🧰 Commands](#-handy-commands) •
[🩺 Help](#-something-not-working) •
[📚 Docs](#-learn-more)

</div>

---

## 💡 What is MailPulse?

Think of MailPulse as your **mission control for email campaigns**:

```
  📇 Contacts  ──►  ✍️ Draft  ──►  🔍 Preview  ──►  🧪 Test  ──►  🚀 Send  ──►  📊 Analytics
```

Add your contacts, write a campaign, preview it safely, send yourself a test, launch it to everyone — then watch the numbers roll in. No guesswork, no double-sends.

---

## 🚀 Up and running in 4 steps

> **You'll need:** [Node.js 20+](https://nodejs.org) · npm 10+ · [MongoDB](https://www.mongodb.com/try/download/community) (local, or a free [Atlas](https://www.mongodb.com/atlas) URI)

### 1️⃣ Get the code

```bash
git clone https://github.com/Denish2410/mailPulse.git
cd mailPulse
```

### 2️⃣ Install everything (one command, both apps)

```bash
npm install
```

### 3️⃣ Create your settings files

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

✅ The defaults work out of the box for local development. Using MongoDB Atlas? Just paste your URI into `MONGODB_URI` in `server/.env`.

### 4️⃣ Launch 🎉

```bash
npm run dev
```

| What | Where |
|---|---|
| 🖥️ App | **http://localhost:5173** |
| ⚙️ API | http://localhost:5000 |
| ❤️ Health check | http://localhost:5000/api/v1/health |

Press `Ctrl + C` to stop both — nothing is left running in the background.

> 💌 **Want to actually send emails?** Fill in the SMTP settings in `server/.env` (see `server/.env.example`). Without them, sending is safely disabled and you'll get a clear message instead of a crash.

---

## ✨ What MailPulse does

<table>
<tr>
<td width="50%" valign="top">

### ✍️ Campaigns
Create, search, edit and delete drafts. Pick recipients straight from your contact list.

</td>
<td width="50%" valign="top">

### 🔍 Safe Preview
See your email exactly as it'll look, in a locked-down sandbox — no scripts, no surprises.

</td>
</tr>
<tr>
<td valign="top">

### ✅ Readiness Check
Before sending, MailPulse confirms your subject, content and recipients are all good to go.

</td>
<td valign="top">

### 🧪 Test Emails
Send a `[TEST]` copy to **only yourself** with one click. Real recipients are never touched.

</td>
</tr>
<tr>
<td valign="top">

### 🚀 One-Time Sending
Confirm and launch. Live progress, a per-recipient report, and a guarantee nobody gets it twice.

</td>
<td valign="top">

### 📊 Analytics
KPI cards, daily charts, failure reasons and recent campaigns — for the last 7, 30 or 90 days.

</td>
</tr>
</table>

<details>
<summary><b>🔎 Under the hood — how sending works (click to expand)</b></summary>

<br>

- **Atomic launch:** a campaign moves `draft → sending` in a single step, so it can never be sent twice.
- **Background delivery** with bounded concurrency and one delivery record per recipient.
- **Crash-safe:** interrupted sends resume on restart without re-sending, and a watchdog recovers stalled campaigns.
- **Locked after sending:** sent campaigns can't be edited or deleted.
- **At most once per recipient.** "Sent" means *accepted by your SMTP provider*, not opened or delivered — so treat counts as a lower bound.
- **Limits:** up to **5,000 recipients** per campaign. Test emails are rate-limited per user.
- ⚠️ **Run a single server instance.** Delivery bookkeeping and rate limits live in memory.

**Key endpoints**

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1/campaigns/:id/readiness` | Is this draft ready to send? |
| `POST` | `/api/v1/campaigns/:id/test-email` | Send a test copy to yourself |
| `POST` | `/api/v1/campaigns/:id/send` | Send it (body: `{ "confirm": true }`) |
| `GET` | `/api/v1/campaigns/:id/deliveries` | Per-recipient delivery log |
| `GET` | `/api/v1/analytics/overview?days=7\|30\|90` | Analytics summary |

</details>

### 🛣️ Coming soon

`⏰ Scheduled sends` · `👤 Personalization` · `🔕 Unsubscribe links` · `👀 Open / click / bounce tracking`

---

## 🧰 Handy commands

Run these from the project root.

| Command | What it does |
|---|---|
| `npm run dev` | 🚀 Start frontend + backend together |
| `npm run dev:server` | ⚙️ Start only the backend (auto-reload) |
| `npm run dev:client` | 🖥️ Start only the frontend |
| `npm test` | 🧪 Run all tests |
| `npm run test:server` | 🧪 Backend tests only |
| `npm run test:client` | 🧪 Frontend tests only |
| `npm run build` | 📦 Build the frontend for production (`client/dist/`) |
| `npm run start:server` | 🏁 Run the backend in production mode |

---

## 🩺 Something not working?

<details>
<summary><b>🍃 "Connection refused" / can't reach MongoDB</b></summary>

<br>

MongoDB isn't running, or the URI is wrong.

```bash
brew services start mongodb-community   # macOS
sudo systemctl start mongod             # Linux
mongosh --eval "db.adminCommand('ping')" # check it's alive
```

Then double-check `MONGODB_URI` in `server/.env`.
</details>

<details>
<summary><b>🔌 "EADDRINUSE: address already in use :::5000"</b></summary>

<br>

Something else is using port 5000. **On a Mac it's usually AirPlay Receiver.**

- **Easy fix:** System Settings → General → AirDrop & AirPlay → turn off **AirPlay Receiver**.
- **Or change the port:** set `PORT=5005` in `server/.env` and `VITE_API_BASE_URL=http://localhost:5005/api/v1` in `client/.env`.
- **Find the culprit:** `lsof -i :5000`
</details>

<details>
<summary><b>⚙️ "VITE_API_BASE_URL is not set" / missing config</b></summary>

<br>

You probably skipped step 3. Make sure both files exist:

- `server/.env` → has `PORT`, `CLIENT_URL`, `MONGODB_URI`
- `client/.env` → has `VITE_API_BASE_URL=http://localhost:5000/api/v1` (the `VITE_` prefix matters!)
</details>

<details>
<summary><b>🚫 "Backend server not detected" / CORS errors</b></summary>

<br>

- Is the backend running? → `npm run dev:server`
- `CLIENT_URL` in `server/.env` should be `http://localhost:5173`
- `VITE_API_BASE_URL` in `client/.env` should point to the backend's host and port
- Hit **Re-check** in the app's connectivity banner once fixed ✅
</details>

> 🔐 **Security tip:** only `VITE_`-prefixed variables reach the browser. Never put secrets in `client/.env`. All `.env` files are git-ignored.

---

## 🗂️ Project layout

```
mailPulse/
├── 🖥️ client/     React 19 + Vite + Tailwind + Recharts
├── ⚙️ server/     Express + MongoDB (Mongoose) + Zod
├── 📚 docs/       Architecture & API docs
└── 📦 package.json  npm workspaces — one install, one command
```

<details>
<summary><b>🧱 Full tech stack</b></summary>

<br>

**Frontend:** React 19 · Vite · Tailwind CSS · React Router · Axios · Recharts
**Backend:** Node.js (ES modules) · Express · MongoDB + Mongoose · Zod · Helmet · CORS · Morgan · express-rate-limit · dotenv · nodemon
**Testing:** Node's built-in `node:test` runner — zero extra dependencies

</details>

---

## 📚 Learn more

- 🏗️ [Architecture overview](docs/architecture.md)
- 🔌 [API reference](docs/api.md)

---

<div align="center">

**Made with ☕ and 💌 by [Denish](https://github.com/Denish2410)**

If MailPulse helped you, drop a ⭐ — it really makes a difference!

</div>
