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
import mongoose from 'mongoose';

import {
  findStructureProblem,
  MAX_ARRAY_ITEMS,
  MAX_NESTING_DEPTH,
} from '../src/validators/requestLimits.js';
import { validate } from '../src/validators/validate.js';
import { updateCampaignSchema } from '../src/validators/campaign.validator.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

describe('findStructureProblem', () => {
  it('accepts normal and exactly-at-limit data', () => {
    assert.equal(findStructureProblem({ a: [1, 2, 3], b: { c: ['x'] } }), null);
    assert.equal(findStructureProblem({ ids: new Array(MAX_ARRAY_ITEMS).fill('a') }), null);
    assert.equal(findStructureProblem(null), null);
    assert.equal(findStructureProblem('text'), null);
  });

  it('rejects lists above the limit, including nested ones', () => {
    assert.match(findStructureProblem({ ids: new Array(MAX_ARRAY_ITEMS + 1).fill('a') }), /exceeds/);
    assert.match(findStructureProblem({ a: { b: [{ c: new Array(MAX_ARRAY_ITEMS + 1).fill(0) }] } }), /exceeds/);
    assert.match(findStructureProblem([new Array(MAX_ARRAY_ITEMS + 1).fill(0)]), /exceeds/);
  });

  it('rejects very deep nesting without overflowing the stack', () => {
    let deep = {};
    const root = deep;
    for (let i = 0; i < 50000; i += 1) {
      deep.n = {};
      deep = deep.n;
    }
    assert.match(findStructureProblem(root), /nested too deeply/);
    let fine = { v: 1 };
    for (let i = 0; i < MAX_NESTING_DEPTH - 1; i += 1) fine = { n: fine };
    assert.equal(findStructureProblem(fine), null);
  });
});

describe('validate() refuses oversized lists before Zod runs', () => {
  const start = async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const id = new mongoose.Types.ObjectId().toString();
    app.patch('/c/:id', validate(updateCampaignSchema), (req, res) => res.json({ ok: true }));
    app.use(errorHandler);
    const server = app.listen(0);
    return { server, id, url: `http://127.0.0.1:${server.address().port}` };
  };

  it('answers the 240,000-element attack payload with a fast, cheap 400', async () => {
    const { server, id, url } = await start();
    try {
      const body = `{"recipientIds":[${new Array(240000).fill('"a"').join(',')}]}`;
      assert.ok(body.length < 1024 * 1024, 'payload must fit the 1 MB body limit');
      const rssBefore = process.memoryUsage().rss;
      const t0 = Date.now();
      const res = await fetch(`${url}/c/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      const elapsed = Date.now() - t0;
      const growthMb = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
      assert.equal(res.status, 400);
      assert.match((await res.json()).message, /exceeds 5000 items/);
      assert.ok(elapsed < 1500, `took ${elapsed}ms`);
      assert.ok(growthMb < 150, `grew ${growthMb.toFixed(0)}MB`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still validates normal requests', async () => {
    const { server, id, url } = await start();
    try {
      const ok = await fetch(`${url}/c/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Valid Name' }) });
      assert.equal(ok.status, 200);
      const bad = await fetch(`${url}/c/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientIds: ['not-an-id'] }) });
      assert.equal(bad.status, 400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
