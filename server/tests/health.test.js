import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';

import app from '../src/app.js';
import healthRoutes from '../src/routes/health.routes.js';
import { connectDB } from '../src/config/db.js';

describe('Health & Diagnostic Endpoints (Liveness & Readiness)', () => {
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
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  it('1. Liveness (GET /api/v1/health) returns HTTP 200 with service and uptime details', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);
    const data = await res.json();

    assert.equal(res.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.service, 'MailPulse API');
    assert.equal(data.status, 'healthy');
    assert.ok(data.timestamp);
    assert.ok(typeof data.uptimeSeconds === 'number');
    assert.ok(data.uptime);
    assert.ok(data.database);
    assert.ok(data.diagnostics);
  });

  it('2. Liveness returns HTTP 200 independently of MongoDB availability', async () => {
    // Isolated test app testing liveness route in a disconnected state
    const testApp = express();
    testApp.use('/health', healthRoutes);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      // Ensure mongoose is disconnected for this check
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.status, 'healthy');
      assert.equal(data.database.connected, false);
      assert.equal(data.database.status, 'disconnected');
    } finally {
      server.close();
    }
  });

  it('3. Readiness (GET /api/v1/health/ready) returns HTTP 200 when database is healthy', async () => {
    // Connect to local MongoDB instance
    await connectDB();

    const testApp = express();
    testApp.use('/api/v1/health', healthRoutes);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.success, true);
      assert.equal(data.service, 'MailPulse API');
      assert.equal(data.status, 'ready');
      assert.equal(data.database.status, 'connected');
      assert.equal(data.database.connected, true);
      assert.ok(typeof data.database.responseTimeMs === 'number');
    } finally {
      server.close();
    }
  });

  it('4. Readiness returns HTTP 503 when MongoDB is disconnected', async () => {
    const testApp = express();
    testApp.use('/api/v1/health', healthRoutes);

    const server = testApp.listen(0);
    const { port } = server.address();

    try {
      // Ensure connection is closed
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
      const data = await res.json();

      assert.equal(res.status, 503);
      assert.equal(data.success, false);
      assert.equal(data.status, 'not_ready');
      assert.equal(data.database.connected, false);
      assert.equal(data.database.status, 'disconnected');
    } finally {
      server.close();
    }
  });

  it('5. Readiness returns HTTP 503 when MongoDB ping fails or times out', async () => {
    // Reconnect to test command failure handling
    await connectDB();

    const testApp = express();
    testApp.use('/api/v1/health', healthRoutes);

    const server = testApp.listen(0);
    const { port } = server.address();

    // Mock ping command to simulate network failure
    const origCommand = mongoose.connection.db.command;
    mongoose.connection.db.command = async () => {
      throw new Error('Simulated socket hang up during ping');
    };

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
      const data = await res.json();

      assert.equal(res.status, 503);
      assert.equal(data.success, false);
      assert.equal(data.status, 'not_ready');
      assert.equal(data.database.connected, false);
      assert.equal(data.database.status, 'error');
    } finally {
      mongoose.connection.db.command = origCommand;
      await mongoose.disconnect();
      server.close();
    }
  });

  it('6. Health responses do not expose credentials, environment secrets, or stack traces', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);
    const data = await res.json();
    const raw = JSON.stringify(data);

    // Verify sensitive data is absent
    assert.equal(data.stack, undefined);
    assert.equal(raw.includes('password'), false);
    assert.equal(raw.includes('secret'), false);
    assert.equal(raw.includes('mongodb://'), false);
    assert.equal(raw.includes('mongodb+srv://'), false);
    assert.equal(raw.includes('/Users/'), false);
  });

  it('7. System diagnostics contain safe, non-sensitive operational metrics', async () => {
    const res = await fetch(`${mainBaseUrl}/api/v1/health`);
    const data = await res.json();

    assert.ok(data.diagnostics);
    assert.equal(typeof data.diagnostics.nodeVersion, 'string');
    assert.ok(data.diagnostics.nodeVersion.startsWith('v'));
    assert.ok(typeof data.diagnostics.memoryUsageMB.rss === 'number');
    assert.ok(typeof data.diagnostics.memoryUsageMB.heapUsed === 'number');
  });
});
