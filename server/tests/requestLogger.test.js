import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Writable } from 'node:stream';
import express from 'express';

import { createRequestLogger, redactUrl } from '../src/middleware/requestLogger.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const TOKEN = 'SUPERSECRETTOKEN0123456789abcdef';

const startApp = async (production) => {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const app = express();
  app.use(createRequestLogger({ production, stream }));
  app.use((req, res) => res.status(200).send('ok'));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: server.address().port, path, headers }, (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { lines, get, stop };
};

describe('Request log redaction', () => {
  it('redactUrl replaces tracking tokens and drops every query string', () => {
    assert.equal(redactUrl(`/api/v1/tracking/click/${TOKEN}`), '/api/v1/tracking/click/[redacted]');
    assert.equal(redactUrl(`/api/v1/tracking/open/${TOKEN}?x=1`), '/api/v1/tracking/open/[redacted]?[redacted]');
    assert.equal(redactUrl(`/api/v1/tracking/unsubscribe/${TOKEN}`), '/api/v1/tracking/unsubscribe/[redacted]');
    assert.equal(redactUrl(`/reset-password?token=${TOKEN}`), '/reset-password?[redacted]');
    assert.equal(redactUrl('/api/v1/contacts?search=bob&page=2'), '/api/v1/contacts?[redacted]');
    assert.equal(redactUrl('/api/v1/contacts'), '/api/v1/contacts');
    assert.equal(redactUrl(undefined), '-');
  });

  for (const production of [true, false]) {
    it(`captured ${production ? 'production (combined)' : 'development'} log lines contain no token`, async () => {
      const { lines, get, stop } = await startApp(production);
      try {
        await get(`/api/v1/tracking/click/${TOKEN}?url=https://x.test`, { Referer: `https://app.test/reset-password?token=${TOKEN}` });
        await get(`/api/v1/tracking/open/${TOKEN}`);
        await get(`/api/v1/tracking/unsubscribe/${TOKEN}`);
        await get(`/verify-email?token=${TOKEN}`);
        await get(`/api/v1/auth/reset-password?token=${TOKEN}`);
        await get('/api/v1/contacts?page=2');
      } finally {
        await stop();
      }
      const output = lines.join('');
      assert.equal(lines.length, 6, 'one line per request');
      assert.ok(!output.includes(TOKEN), 'no token appears in the captured log');
      assert.ok(!output.includes('token='), 'no query string appears in the captured log');
      assert.ok(output.includes('/api/v1/tracking/click/[redacted]'));
      assert.ok(output.includes('/api/v1/contacts?[redacted]'));
      assert.ok(output.includes(' 200 '), 'status is still logged');
      if (production) {
        assert.ok(output.includes('GET'), 'method is still logged');
        assert.ok(!output.includes('app.test'), 'Referer is not logged');
      }
    });
  }

  it('the error reporter receives a redacted path for a failing token URL', async () => {
    const reported = [];
    const { getErrorReporter } = await import('../src/services/errorReporter.service.js');
    const reporter = getErrorReporter();
    const original = reporter.reportError;
    reporter.reportError = (err, ctx) => {
      reported.push(ctx);
      return Promise.resolve();
    };
    try {
      const res = { headersSent: false, status() { return this; }, json() { return this; } };
      errorHandler(new Error('boom'), { method: 'GET', originalUrl: `/api/v1/tracking/click/${TOKEN}?a=b` }, res, () => {});
    } finally {
      reporter.reportError = original;
    }
    assert.equal(reported.length, 1);
    assert.ok(!JSON.stringify(reported).includes(TOKEN));
  });
});
