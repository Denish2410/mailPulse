import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import rateLimit, { MemoryStore } from 'express-rate-limit';

import { connectDB } from '../src/config/db.js';
import { MongoRateLimitStore, createRateLimitStore } from '../src/middleware/rateLimitStore.js';

const quiet = { warn() {} };

describe('createRateLimitStore selection (no DB)', () => {
  it('uses the default in-memory behaviour unless RATE_LIMIT_STORE=mongo', () => {
    const memory = createRateLimitStore('a', {});
    memory.init({ windowMs: 1000 });
    assert.equal(memory.resolve() instanceof MemoryStore, true);
    assert.equal(memory.localKeys, true);

    const mongo = createRateLimitStore('b', { RATE_LIMIT_STORE: ' Mongo ' });
    mongo.init({ windowMs: 1000 });
    assert.equal(mongo.resolve() instanceof MongoRateLimitStore, true);
    assert.equal(mongo.localKeys, false);
  });

  it('decides on first use, so an env loaded after import still applies', () => {
    const env = {};
    const store = createRateLimitStore('late', env);
    store.init({ windowMs: 1000 });
    env.RATE_LIMIT_STORE = 'mongo'; // e.g. dotenv ran after the route modules were imported
    assert.equal(store.resolve() instanceof MongoRateLimitStore, true);
  });
});

describe('MongoRateLimitStore', () => {
  let isDbConnected = false;
  const ns = `rl-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
    } catch (err) {
      console.warn(`[RateLimit Tests] MongoDB unavailable: ${err.message}`);
    }
  });

  after(async () => {
    if (isDbConnected) {
      await mongoose.connection.collection('ratelimits').deleteMany({ _id: { $regex: `^${ns}` } });
      await mongoose.disconnect();
    }
  });

  const make = (name, windowMs = 60_000, extra = {}) => {
    const store = new MongoRateLimitStore(`${ns}-${name}`, { logger: quiet, ...extra });
    store.init({ windowMs });
    return store;
  };

  it('counts hits within a window and reports the reset time', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const store = make('count');
    const first = await store.increment('ip1');
    const second = await store.increment('ip1');
    assert.equal(first.totalHits, 1);
    assert.equal(second.totalHits, 2);
    assert.ok(second.resetTime > new Date());
    assert.equal((await store.increment('ip2')).totalHits, 1); // other keys are independent
  });

  it('shares counters between instances using the same limiter name', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const instanceA = make('shared');
    const instanceB = make('shared');
    await instanceA.increment('ip');
    await instanceB.increment('ip');
    assert.equal((await instanceA.increment('ip')).totalHits, 3);
  });

  it('does not lose counts under concurrent hits', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const store = make('concurrent');
    const results = await Promise.all(Array.from({ length: 40 }, () => store.increment('burst')));
    const totals = results.map((r) => r.totalHits).sort((a, b) => a - b);
    assert.deepEqual(totals, Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('starts a new window once the previous one expired', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let clock = Date.now();
    const store = make('expiry', 1000, { now: () => clock });
    await store.increment('ip');
    assert.equal((await store.increment('ip')).totalHits, 2);
    clock += 1001;
    assert.equal((await store.increment('ip')).totalHits, 1);
  });

  it('supports decrement and resetKey', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const store = make('dec');
    await store.increment('ip');
    await store.increment('ip');
    await store.decrement('ip');
    assert.equal((await store.increment('ip')).totalHits, 2);
    await store.resetKey('ip');
    assert.equal((await store.increment('ip')).totalHits, 1);
  });

  it('enforces a limit through express-rate-limit with a 429', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const app = express();
    app.use(
      rateLimit({
        windowMs: 60_000,
        limit: 3,
        standardHeaders: true,
        legacyHeaders: false,
        store: make('http'),
      })
    );
    app.get('/', (req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${server.address().port}/`;
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('fails open when the database errors', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const warnings = [];
    const store = make('failopen', 60_000, { logger: { warn: (m) => warnings.push(m) } });
    store.collection = () => ({
      createIndex: async () => {},
      findOneAndUpdate: async () => {
        throw new Error('db down');
      },
    });
    const result = await store.increment('ip');
    assert.equal(result.totalHits, 1);
    await store.increment('ip');
    assert.equal(warnings.length, 1); // warning is throttled
  });
});
