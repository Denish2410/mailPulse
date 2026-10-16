import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import app from '../src/app.js';
import { notFound, errorHandler, AppError, asyncHandler } from '../src/middleware/errorHandler.js';

describe('Centralized Error Handling & Routing Tests', () => {
  let mainServer;
  let mainBaseUrl;

  before(async () => {
    // Start ephemeral server instance for main application tests
    mainServer = app.listen(0);
    const { port } = mainServer.address();
    mainBaseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (mainServer) {
      await new Promise((resolve) => mainServer.close(resolve));
    }
  });

  it('1. Valid health-check route returns HTTP 200 with standard JSON format', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.service, 'MailPulse API');
    assert.equal(data.status, 'healthy');
    assert.ok(data.uptime);
    assert.ok(data.database);
  });

  it('2. Unknown route returns HTTP 404 with sanitized message and no internal details', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/invalid-route-xyz`);
    const data = await res.json();

    assert.equal(res.status, 404);
    assert.equal(data.success, false);
    assert.equal(data.message, 'Route not found: GET /api/v1/invalid-route-xyz');
    assert.equal(data.stack, undefined);
  });

  it('3. Deliberately triggered application error returns expected HTTP status and JSON structure', async () => {
    // Isolated test app to safely test custom application errors without polluting public routes
    const testApp = express();
    testApp.get('/test/operational-error', (req, res, next) => {
      next(new AppError('Contact validation failed: Invalid email address', 422, [
        { field: 'email', message: 'Invalid format' }
      ]));
    });
    testApp.use(errorHandler);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test/operational-error`);
      const data = await res.json();

      assert.equal(res.status, 422);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Contact validation failed: Invalid email address');
      assert.deepEqual(data.errors, [{ field: 'email', message: 'Invalid format' }]);
      assert.equal(data.stack, undefined);
    } finally {
      server.close();
    }
  });

  it('4. Unexpected 500 errors do not expose stack traces or sensitive internal error messages', async () => {
    // Isolated test app to verify unexpected exception handling
    const testApp = express();
    testApp.get('/test/unexpected-crash', (req, res, next) => {
      // Throw an error containing sensitive information that must NOT leak to the client
      next(new Error('FATAL: Database authentication failure at mongodb+srv://secret_admin:p@ssword123@cluster.net'));
    });
    testApp.use(errorHandler);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test/unexpected-crash`);
      const data = await res.json();

      assert.equal(res.status, 500);
      assert.equal(data.success, false);
      // Client receives generic sanitized message
      assert.equal(data.message, 'Internal Server Error');
      // Stack trace must NEVER be included in response body
      assert.equal(data.stack, undefined);
      // Secrets must NOT leak into the JSON payload
      assert.equal(JSON.stringify(data).includes('secret_admin'), false);
      assert.equal(JSON.stringify(data).includes('password'), false);
    } finally {
      server.close();
    }
  });

  it('5. Asynchronous route errors reach centralized error handler safely via asyncHandler', async () => {
    // Isolated test app to test async error propagation
    const testApp = express();
    testApp.get(
      '/test/async-error',
      asyncHandler(async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new AppError('Async resource access denied', 403);
      })
    );
    testApp.use(errorHandler);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test/async-error`);
      const data = await res.json();

      assert.equal(res.status, 403);
      assert.equal(data.success, false);
      assert.equal(data.message, 'Async resource access denied');
    } finally {
      server.close();
    }
  });

  it('6. Errors occurring after response headers are sent delegate to Express default handler', () => {
    // Unit test verifying headersSent guard delegation
    const mockReq = { method: 'GET', originalUrl: '/test/stream' };
    const mockRes = {
      headersSent: true,
      status: () => {
        throw new Error('status() should not be called when headersSent is true');
      },
      json: () => {
        throw new Error('json() should not be called when headersSent is true');
      },
    };

    let delegatedError = null;
    const mockNext = (err) => {
      delegatedError = err;
    };

    const testError = new Error('Streaming failed mid-transfer');
    errorHandler(testError, mockReq, mockRes, mockNext);

    assert.equal(delegatedError, testError);
  });
});
