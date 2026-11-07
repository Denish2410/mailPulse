import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'deterministic_test_jwt_secret_min_32_characters!';
process.env.JWT_EXPIRES_IN = '15m';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import app from '../src/app.js';
import User from '../src/models/User.js';
import SignupForm, { MAX_SIGNUP_FORMS_PER_USER, generateSlug } from '../src/models/SignupForm.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import { createSignupFormSchema, updateSignupFormSchema } from '../src/validators/signupForm.validator.js';

describe('Signup form validators and slugs (no DB)', () => {
  it('normalizes tags and applies defaults', () => {
    const ok = createSignupFormSchema.safeParse({ body: { name: ' Newsletter ', tags: ['VIP', 'vip', 'Blog'] } });
    assert.equal(ok.success, true);
    assert.equal(ok.data.body.name, 'Newsletter');
    assert.deepEqual(ok.data.body.tags, ['vip', 'blog']);
    assert.equal(ok.data.body.enabled, true);
    assert.equal(ok.data.body.description, '');
  });

  it('rejects bad input and protected fields', () => {
    assert.equal(createSignupFormSchema.safeParse({ body: { name: 'a' } }).success, false);
    assert.equal(createSignupFormSchema.safeParse({ body: { name: 'Valid', tags: ['bad!'] } }).success, false);
    assert.equal(createSignupFormSchema.safeParse({ body: { name: 'Valid', slug: 'mine', userId: 'x' } }).success, false);
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(updateSignupFormSchema.safeParse({ params: { id }, body: {} }).success, false);
    assert.equal(updateSignupFormSchema.safeParse({ params: { id }, body: { enabled: false } }).success, true);
  });

  it('generates unguessable slugs', () => {
    const a = generateSlug();
    assert.match(a, /^[a-f0-9]{24}$/);
    assert.notEqual(a, generateSlug());
  });
});

describe('Signup form API (/api/v1/signup-forms)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `sf-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}/api/v1/signup-forms${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  const ids = () => [userOne._id, userTwo._id];

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await SignupForm.init();
    } catch (err) {
      console.warn(`[Signup Form Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'SF One', email: `${prefix}-1@example.com`, passwordHash });
      userTwo = await User.create({ name: 'SF Two', email: `${prefix}-2@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) await SignupForm.deleteMany({ userId: { $in: ids() } });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await SignupForm.deleteMany({ userId: { $in: ids() } });
      await User.deleteMany({ _id: { $in: ids() } });
      await mongoose.disconnect();
    }
  });

  it('requires authentication', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await request('GET', '', { token: null })).status, 401);
    assert.equal((await request('POST', '', { token: null, body: { name: 'Newsletter' } })).status, 401);
  });

  it('creates, lists, updates (slug stays) and deletes a form', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    let res = await request('POST', '', { body: { name: 'Newsletter', description: 'Monthly news', tags: ['Blog'] } });
    assert.equal(res.status, 201);
    const form = (await res.json()).data.form;
    assert.match(form.slug, /^[a-f0-9]{24}$/);
    assert.deepEqual(form.tags, ['blog']);
    assert.equal(form.enabled, true);
    assert.equal(form.userId, undefined);

    res = await request('PATCH', `/${form.id}`, { body: { enabled: false, tags: ['news'], slug: 'hijack' } });
    assert.equal(res.status, 400);
    res = await request('PATCH', `/${form.id}`, { body: { enabled: false, tags: ['news'] } });
    const updated = (await res.json()).data.form;
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.tags, ['news']);
    assert.equal(updated.slug, form.slug);

    const list = (await (await request('GET', '')).json()).data;
    assert.equal(list.count, 1);

    assert.equal((await request('DELETE', `/${form.id}`)).status, 200);
    assert.equal((await request('DELETE', `/${form.id}`)).status, 404);
  });

  it('enforces the per-user limit and tenant isolation', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    for (let i = 0; i < MAX_SIGNUP_FORMS_PER_USER; i += 1) {
      assert.equal((await request('POST', '', { body: { name: `Form ${i}` } })).status, 201);
    }
    assert.equal((await request('POST', '', { body: { name: 'One too many' } })).status, 409);
    assert.equal((await request('POST', '', { token: tokenTwo, body: { name: 'Other tenant form' } })).status, 201);

    const mine = (await (await request('GET', '')).json()).data.forms;
    assert.equal(mine.length, MAX_SIGNUP_FORMS_PER_USER);
    const foreignId = mine[0].id;
    assert.equal((await request('PATCH', `/${foreignId}`, { token: tokenTwo, body: { enabled: false } })).status, 404);
    assert.equal((await request('DELETE', `/${foreignId}`, { token: tokenTwo })).status, 404);
    assert.equal((await request('DELETE', '/not-an-id')).status, 400);
    assert.ok(await SignupForm.exists({ _id: foreignId }));
  });
});
