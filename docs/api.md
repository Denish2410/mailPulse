# MailPulse API Documentation

## 1. Overview & Conventions

The MailPulse API is a RESTful API communicating over HTTP using standard JSON payloads.

- **Base URL**: `http://localhost:5000/api/v1`
- **Default Content-Type**: `application/json`
- **Rate Limit**: 100 requests per 15-minute window by default (configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`)

---

## 2. Standard Response Format

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional descriptive message"
}
```

### Error Response
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "path": "body.email",
      "message": "Invalid email address format"
    }
  ]
}
```

---

## 3. HTTP Status Codes

| Code | Description | Usage |
| :--- | :--- | :--- |
| `200 OK` | Success | Standard response for successful GET, PUT, PATCH requests, and healthy checks |
| `201 Created` | Created | Resource successfully created via POST |
| `400 Bad Request` | Validation Error | Request body, query, or parameters failed Zod schema validation |
| `401 Unauthorized` | Authentication Required | Missing or invalid authentication token |
| `403 Forbidden` | Access Denied | Authenticated user lacks permission |
| `404 Not Found` | Resource Not Found | Unmatched route or entity ID does not exist |
| `429 Too Many Requests`| Rate Limited | Exceeded rate limit quota |
| `500 Server Error` | Internal Error | Unhandled server exception (sanitized, no stack traces leaked) |
| `503 Service Unavailable` | Dependency Unhealthy | Database is disconnected or readiness ping failed/timed out |

---

## 4. Health & Diagnostic Endpoints

MailPulse separates process health into **Liveness** and **Readiness** probes, suitable for container orchestrators (e.g. Kubernetes, Docker) and uptime monitors.

### A. Liveness Check (`GET /api/v1/health`)

Determines whether the API process is alive and able to accept incoming HTTP traffic. It does **not** execute any database queries, ensuring the API is never marked dead due to transient database latency.

- **Endpoint**: `GET /api/v1/health`
- **Access**: Public
- **Authentication**: None

#### Example Request
```bash
curl -X GET http://localhost:5000/api/v1/health
```

#### Example Response (200 OK)
```json
{
  "success": true,
  "service": "MailPulse API",
  "status": "healthy",
  "timestamp": "2026-10-16T04:20:00.000Z",
  "uptime": "120s",
  "uptimeSeconds": 120,
  "database": {
    "status": "connected",
    "connected": true
  },
  "diagnostics": {
    "nodeVersion": "v22.22.3",
    "memoryUsageMB": {
      "rss": 45,
      "heapUsed": 20
    }
  },
  "version": "1.0.0"
}
```

---

### B. Readiness Check (`GET /api/v1/health/ready`)

Determines whether the API is ready to serve database-backed requests by actively pinging MongoDB with a 2-second timeout guard.

- **Endpoint**: `GET /api/v1/health/ready`
- **Access**: Public
- **Authentication**: None

#### Status Code Semantics
- **`200 OK`**: MongoDB is connected and the ping command responded successfully.
- **`503 Service Unavailable`**: MongoDB is disconnected, connecting, or the ping command failed/timed out.

#### Example Response: Database Ready (200 OK)
```json
{
  "success": true,
  "service": "MailPulse API",
  "status": "ready",
  "timestamp": "2026-10-16T04:20:00.000Z",
  "database": {
    "status": "connected",
    "connected": true,
    "responseTimeMs": 4
  }
}
```

#### Example Response: Database Not Ready (503 Service Unavailable)
```json
{
  "success": false,
  "service": "MailPulse API",
  "status": "not_ready",
  "timestamp": "2026-10-16T04:20:00.000Z",
  "database": {
    "status": "disconnected",
    "connected": false
  }
}
```

---

### C. Diagnostic Data Policy

To prevent sensitive information leakage, health responses strictly control diagnostic data:

- **Included**: Process uptime, ISO timestamp, service identifier, Node runtime major version, memory footprint summary (`rss` and `heapUsed` in MB), and database ping response latency.
- **Intentionally Excluded**: Environment variables, connection strings, credentials/passwords, internal server file paths, exception stack traces, and low-level driver error objects.

---

## 5. Request Validation (Zod)

All incoming requests with payloads, URL queries, or route parameters are validated using reusable Zod schemas via the `validate()` middleware.

### Defining a Request Schema
```javascript
import { z } from 'zod';

export const createContactSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address format'),
    name: z.string().min(2, 'Name must be at least 2 characters'),
  }),
  query: z.object({
    source: z.string().optional(),
  }).optional(),
  params: z.object({}).optional(),
});
```

### Applying to an Express Route
```javascript
import { Router } from 'express';
import { validate } from '../validators/validate.js';
import { createContactSchema } from '../validators/contact.validator.js';

const router = Router();

router.post('/', validate(createContactSchema), (req, res) => {
  // Downstream handlers access validated & coerced data on req.body or req.validated:
  const { email, name } = req.body; // or req.validated.body
  res.status(201).json({ success: true, data: { email, name } });
});
```

### Validation Error Response (HTTP 400)
When validation fails, an HTTP `400 Bad Request` response is returned with structured field errors:
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "path": "body.email",
      "message": "Invalid email address format"
    }
  ]
}
```

---

## 6. Planned Endpoints (Future Phases)

The following endpoints will be introduced in subsequent phases:

### Authentication (`/api/v1/auth`)
- `POST /register`: Register new user account
- `POST /login`: Authenticate and receive JWT
- `GET /me`: Fetch authenticated user profile

### Contacts (`/api/v1/contacts`)
- `GET /`: List contacts with pagination and filters
- `POST /`: Create contact
- `GET /:id`: Retrieve contact details
- `PUT /:id`: Update contact
- `DELETE /:id`: Delete contact
- `POST /import`: Bulk import contacts via CSV

### Campaigns (`/api/v1/campaigns`)
- `POST /`: Create new campaign draft
- `GET /`: List email campaign drafts with pagination and search
- `GET /:id`: Retrieve single campaign details
- `GET /:id/readiness`: Evaluate send-readiness, blocking issues, and resolved recipients
- `PATCH /:id`: Update campaign draft
- `DELETE /:id`: Delete campaign draft
- `POST /:id/send`: Dispatch or queue campaign (Future Phase)

#### Campaign Readiness Contract (`GET /api/v1/campaigns/:id/readiness`)
- **Access**: Protected (Bearer JWT)
- **Rules**:
  - `name`: Must be between 2 and 120 characters long.
  - `subject`: Must be between 1 and 200 characters long.
  - `content`: At least one of `textContent` or `htmlContent` must have non-whitespace content.
  - `status`: Must be `'draft'`.
  - `recipients`: At least 1 recipient must resolve to an existing, verified contact owned by the authenticated user.
- **Response Shape (HTTP 200)**:
```json
{
  "success": true,
  "message": "Campaign is ready for sending",
  "data": {
    "isReady": true,
    "issues": [],
    "summary": {
      "totalRecipients": 2,
      "eligibleRecipients": [
        { "id": "671234567890abcdef123456", "name": "Alice Smith", "email": "alice@example.com" }
      ],
      "eligibleRecipientsCount": 1,
      "missingRecipientsCount": 1,
      "hasTextContent": true,
      "hasHtmlContent": false,
      "status": "draft"
    }
  }
}
```

### Analytics (`/api/v1/analytics`)
- `GET /overview`: High-level open, click, and bounce metrics
- `GET /campaigns/:id`: Per-campaign delivery performance metrics
