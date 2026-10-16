import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { z } from 'zod';

import app from '../src/app.js';
import { validate } from '../src/validators/validate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

describe('Reusable Zod Request Validation Middleware', () => {
  let mainServer;
  let mainBaseUrl;

  before(async () => {
    // Start ephemeral server for application-level tests
    mainServer = app.listen(0);
    const { port } = mainServer.address();
    mainBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (mainServer) {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });

  // Helper factory to create an isolated test express application
  const createTestApp = (routePath, method, schema, handler) => {
    const testApp = express();
    testApp.use(express.json());
    testApp[method.toLowerCase()](routePath, validate(schema), handler);
    testApp.use(errorHandler);
    return testApp;
  };

  it('1. Valid request data passes validation', async () => {
    const contactSchema = z.object({
      body: z.object({
        email: z.string().email(),
        name: z.string().min(2),
      }),
    });

    const testApp = createTestApp('/contacts', 'post', contactSchema, (req, res) => {
      res.status(201).json({ success: true, data: req.body });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alex@example.com', name: 'Alex Hunter' }),
      });
      const data = await res.json();

      assert.equal(res.status, 201);
      assert.equal(data.success, true);
      assert.equal(data.data.email, 'alex@example.com');
      assert.equal(data.data.name, 'Alex Hunter');
    } finally {
      server.close();
    }
  });

  it('2. Invalid request body returns HTTP 400 with structured errors', async () => {
    const contactSchema = z.object({
      body: z.object({
        email: z.string().email('Invalid email address format'),
        name: z.string().min(2, 'Name must be at least 2 characters'),
      }),
    });

    const testApp = createTestApp('/contacts', 'post', contactSchema, (req, res) => {
      res.status(200).json({ success: true });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', name: 'A' }),
      });
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Validation failed');
      assert.ok(Array.isArray(data.errors));
      assert.equal(data.errors.length, 2);

      const emailError = data.errors.find((e) => e.path === 'body.email');
      const nameError = data.errors.find((e) => e.path === 'body.name');

      assert.ok(emailError);
      assert.equal(emailError.message, 'Invalid email address format');
      assert.ok(nameError);
      assert.equal(nameError.message, 'Name must be at least 2 characters');
    } finally {
      server.close();
    }
  });

  it('3. Invalid query parameters are rejected with HTTP 400', async () => {
    const listSchema = z.object({
      query: z.object({
        page: z.coerce.number().min(1, 'Page must be 1 or greater'),
        limit: z.coerce.number().max(50, 'Limit cannot exceed 50'),
      }),
    });

    const testApp = createTestApp('/items', 'get', listSchema, (req, res) => {
      res.status(200).json({ success: true, query: req.query });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/items?page=0&limit=100`);
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Validation failed');

      const pageError = data.errors.find((e) => e.path === 'query.page');
      const limitError = data.errors.find((e) => e.path === 'query.limit');

      assert.ok(pageError);
      assert.equal(pageError.message, 'Page must be 1 or greater');
      assert.ok(limitError);
      assert.equal(limitError.message, 'Limit cannot exceed 50');
    } finally {
      server.close();
    }
  });

  it('4. Invalid route parameters are rejected with HTTP 400', async () => {
    const paramSchema = z.object({
      params: z.object({
        id: z.string().uuid('Contact ID must be a valid UUID'),
      }),
    });

    const testApp = createTestApp('/contacts/:id', 'get', paramSchema, (req, res) => {
      res.status(200).json({ success: true, id: req.params.id });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/contacts/invalid-id-123`);
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Validation failed');

      const idError = data.errors.find((e) => e.path === 'params.id');
      assert.ok(idError);
      assert.equal(idError.message, 'Contact ID must be a valid UUID');
    } finally {
      server.close();
    }
  });

  it('5. Multiple validation issues across body, query, and params return structured errors', async () => {
    const combinedSchema = z.object({
      params: z.object({
        userId: z.string().uuid('Invalid user UUID'),
      }),
      query: z.object({
        mode: z.enum(['full', 'compact'], { message: 'Mode must be full or compact' }),
      }),
      body: z.object({
        status: z.enum(['active', 'archived'], { message: 'Status must be active or archived' }),
      }),
    });

    const testApp = createTestApp('/users/:userId/status', 'put', combinedSchema, (req, res) => {
      res.status(200).json({ success: true });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/users/bad-id/status?mode=invalid_mode`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unknown_status' }),
      });
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Validation failed');
      assert.equal(data.errors.length, 3);

      const paths = data.errors.map((e) => e.path).sort();
      assert.deepEqual(paths, ['body.status', 'params.userId', 'query.mode'].sort());
    } finally {
      server.close();
    }
  });

  it('6. Unexpected middleware errors during validation are forwarded to next(error)', async () => {
    // Custom refinement that throws an unexpected internal error (not a ZodError)
    const buggySchema = z.object({
      body: z.object({
        data: z.string().refine(() => {
          throw new Error('Unexpected runtime fault in custom validator logic');
        }),
      }),
    });

    const testApp = createTestApp('/buggy', 'post', buggySchema, (req, res) => {
      res.status(200).json({ success: true });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/buggy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'hello' }),
      });
      const data = await res.json();

      assert.equal(res.status, 500);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Internal Server Error');
      assert.equal(data.stack, undefined);
    } finally {
      server.close();
    }
  });

  it('7. Validated and transformed/coerced values are available downstream on req and req.validated', async () => {
    const transformSchema = z.object({
      query: z.object({
        page: z.coerce.number(),
      }),
      body: z.object({
        email: z.string().trim().toLowerCase(),
        count: z.coerce.number(),
      }),
    });

    let capturedReq = null;

    const testApp = createTestApp('/transform', 'post', transformSchema, (req, res) => {
      capturedReq = {
        body: req.body,
        query: req.query,
        validated: req.validated,
      };
      res.status(200).json({ success: true });
    });

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/transform?page=5`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: '  ALEX@Example.COM  ', count: '42' }),
      });

      assert.equal(res.status, 200);
      assert.ok(capturedReq);

      // Verify trimmed and lowercased string transformation on req.body
      assert.equal(capturedReq.body.email, 'alex@example.com');
      // Verify coerced number transformation on req.body
      assert.equal(capturedReq.body.count, 42);
      assert.equal(typeof capturedReq.body.count, 'number');

      // Verify coerced number on req.query
      assert.equal(capturedReq.query.page, 5);
      assert.equal(typeof capturedReq.query.page, 'number');

      // Verify req.validated object matches
      assert.equal(capturedReq.validated.body.email, 'alex@example.com');
      assert.equal(capturedReq.validated.query.page, 5);
    } finally {
      server.close();
    }
  });

  it('8. Existing health-check and 404 behavior remains unchanged on the main app', async () => {
    // Health check returns 200
    const healthRes = await fetch(`${mainBaseUrl}/api/v1/health`);
    const healthData = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(healthData.success, true);
    assert.equal(healthData.status, 'healthy');

    // Unknown route returns 404
    const notFoundRes = await fetch(`${mainBaseUrl}/api/v1/unmatched-route`);
    const notFoundData = await notFoundRes.json();
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundData.success, false);
    assert.equal(notFoundData.message, 'Route not found: GET /api/v1/unmatched-route');
  });
});
