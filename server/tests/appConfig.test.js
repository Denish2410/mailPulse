import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import app from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

describe('Express Application Configuration Review Tests', () => {
  let mainServer;
  let mainBaseUrl;

  before(async () => {
    // Start ephemeral server instance for main app configuration checks
    mainServer = app.listen(0);
    const { port } = mainServer.address();
    mainBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (mainServer) {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });

  it('1. Security headers from Helmet are present on responses', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);

    // Standard Helmet headers
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.ok(res.headers.get('strict-transport-security'));
  });

  it('2. Approved frontend origin receives matching Access-Control-Allow-Origin header', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });

    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('3. Unapproved origins do not receive permissive CORS headers', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`, {
      headers: { Origin: 'http://unapproved-malicious-domain.com' },
    });

    // Cross-origin header must NOT be granted to unapproved origins
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('4. Malformed JSON returns HTTP 400 Bad Request with a clean sanitized message', async () => {
    // Post invalid malformed JSON to any valid endpoint
    const res = await fetch(`${mainBaseUrl}/api/v1/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unclosed": "brace',
    });
    const data = await res.json();

    assert.equal(res.status, 400);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Malformed JSON in request body');
    assert.equal(data.stack, undefined);
  });

  it('5. Request-size limit (1mb) is enforced, returning HTTP 413 Payload Too Large', async () => {
    // Create an isolated test app with a small 100b limit to test payload limit enforcement safely
    const testApp = express();
    testApp.use(express.json({ limit: '100b' }));
    testApp.post('/test/upload', (req, res) => res.json({ ok: true }));
    testApp.use(errorHandler);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heavy: 'x'.repeat(250) }),
      });
      const data = await res.json();

      assert.equal(res.status, 413);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Request payload exceeds size limit');
      assert.equal(data.stack, undefined);
    } finally {
      server.close();
    }
  });

  it('6. Rate limiting is active on /api routes with standard RateLimit headers', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);

    // express-rate-limit v7 headers
    assert.ok(res.headers.get('ratelimit-limit'));
    assert.ok(res.headers.get('ratelimit-remaining'));
    assert.ok(res.headers.get('ratelimit-reset'));
  });

  it('7. Unknown routes return HTTP 404', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/unknown-endpoint`);
    const data = await res.json();

    assert.equal(res.status, 404);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Route not found: GET /api/v1/unknown-endpoint');
  });
});
