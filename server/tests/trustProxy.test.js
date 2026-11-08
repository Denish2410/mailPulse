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

import { resolveTrustProxy } from '../src/config/proxy.js';

describe('TRUST_PROXY resolution', () => {
  it('trusts nothing by default', () => {
    assert.equal(resolveTrustProxy({}), false);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: '' }), false);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: 'false' }), false);
  });

  it('parses hop counts and keeps keywords', () => {
    assert.equal(resolveTrustProxy({ TRUST_PROXY: '1' }), 1);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: ' 2 ' }), 2);
    assert.equal(resolveTrustProxy({ TRUST_PROXY: 'loopback' }), 'loopback');
  });
});

describe('Client IP behind a proxy', () => {
  const ipSeenBy = async (trustProxy, forwardedFor) => {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.get('/ip', (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ip`, {
        headers: { 'X-Forwarded-For': forwardedFor },
      });
      return (await res.json()).ip;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };

  it('uses the forwarded client address only when a hop is trusted', async () => {
    assert.match(await ipSeenBy(resolveTrustProxy({}), '203.0.113.9'), /127\.0\.0\.1/);
    assert.equal(await ipSeenBy(resolveTrustProxy({ TRUST_PROXY: '1' }), '203.0.113.9'), '203.0.113.9');
  });

  it('ignores extra spoofed entries beyond the trusted hops', async () => {
    // Client sent "6.6.6.6"; the single trusted proxy appended the real client "203.0.113.9"
    assert.equal(await ipSeenBy(1, '6.6.6.6, 203.0.113.9'), '203.0.113.9');
  });
});
