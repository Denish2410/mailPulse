import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  buildErrorEvent,
  createErrorReporter,
  getErrorReporter,
  resetErrorReporter,
} from '../src/services/errorReporter.service.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const makeLogger = () => {
  const lines = [];
  return { lines, error: (line) => lines.push(line) };
};
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true };
};

describe('buildErrorEvent', () => {
  it('keeps only safe fields and strips the query string from the path', () => {
    const event = buildErrorEvent(new TypeError('boom'), {
      method: 'GET',
      path: '/api/v1/tracking/click/secret-token?token=abc&email=a@b.co',
      status: 500,
    });
    assert.equal(event.name, 'TypeError');
    assert.equal(event.path, '/api/v1/tracking/click/secret-token');
    assert.equal(event.status, 500);
    assert.ok(!JSON.stringify(event).includes('a@b.co'));
  });

  it('truncates long messages and tolerates non-Error values', () => {
    assert.ok(buildErrorEvent(new Error('x'.repeat(1000))).message.length <= 301);
    assert.equal(buildErrorEvent('just a string').message, 'just a string');
  });
});

describe('createErrorReporter', () => {
  it('always logs one JSON line, with no webhook configured', async () => {
    const logger = makeLogger();
    const reporter = createErrorReporter({ logger });
    assert.equal(reporter.isWebhookEnabled(), false);
    assert.equal(await reporter.reportError(new Error('oops')), false);
    assert.equal(logger.lines.length, 1);
    assert.equal(JSON.parse(logger.lines[0]).message, 'oops');
  });

  it('posts to an https webhook in Slack and Discord shape', async () => {
    const calls = [];
    const reporter = createErrorReporter({
      webhookUrl: 'https://hooks.example.com/abc',
      fetchImpl: okFetch(calls),
      logger: makeLogger(),
    });
    assert.equal(await reporter.reportError(new Error('db down'), { method: 'POST', path: '/api/v1/x' }), true);
    const body = JSON.parse(calls[0].init.body);
    assert.match(body.text, /db down/);
    assert.equal(body.text, body.content);
  });

  it('refuses a non-https webhook URL', () => {
    const reporter = createErrorReporter({ webhookUrl: 'http://insecure.example.com', fetchImpl: okFetch([]), logger: makeLogger() });
    assert.equal(reporter.isWebhookEnabled(), false);
  });

  it('posts the same error once per window, then again after it', async () => {
    const calls = [];
    let clock = 1_000_000;
    const reporter = createErrorReporter({
      webhookUrl: 'https://hooks.example.com/abc',
      fetchImpl: okFetch(calls),
      now: () => clock,
      logger: makeLogger(),
    });
    const fail = () => reporter.reportError(new Error('same'));
    await fail();
    await fail();
    assert.equal(calls.length, 1);
    clock += 5 * 60 * 1000 + 1;
    await fail();
    assert.equal(calls.length, 2);
  });

  it('caps posts per hour so an error loop cannot flood the channel', async () => {
    const calls = [];
    const reporter = createErrorReporter({
      webhookUrl: 'https://hooks.example.com/abc',
      fetchImpl: okFetch(calls),
      logger: makeLogger(),
    });
    for (let i = 0; i < 50; i += 1) await reporter.reportError(new Error(`distinct ${i}`));
    assert.equal(calls.length, 20);
  });

  it('never throws when the webhook fails', async () => {
    const reporter = createErrorReporter({
      webhookUrl: 'https://hooks.example.com/abc',
      fetchImpl: async () => {
        throw new Error('network down');
      },
      logger: makeLogger(),
    });
    assert.equal(await reporter.reportError(new Error('x')), false);
  });
});

describe('errorHandler integration', () => {
  it('reports 5xx errors but not 4xx, and still answers generically', async () => {
    const lines = [];
    const original = console.error;
    console.error = (line) => lines.push(String(line));
    resetErrorReporter();
    const app = express();
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });
    app.get('/bad', (req, res, next) => next(Object.assign(new Error('bad input'), { statusCode: 400 })));
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const boom = await fetch(`${base}/boom?token=zzz`);
      assert.equal(boom.status, 500);
      assert.equal((await boom.json()).message, 'Internal Server Error');
      assert.equal((await fetch(`${base}/bad`)).status, 400);
    } finally {
      console.error = original;
      await new Promise((resolve) => server.close(resolve));
      resetErrorReporter();
    }
    const reported = lines.map((l) => JSON.parse(l));
    assert.equal(reported.length, 1);
    assert.equal(reported[0].path, '/boom');
    assert.equal(reported[0].status, 500);
    assert.ok(getErrorReporter());
  });
});
