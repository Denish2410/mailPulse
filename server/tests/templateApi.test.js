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
import Template from '../src/models/Template.js';
import { connectDB } from '../src/config/db.js';
import { signAccessToken } from '../src/utils/token.js';
import { hashPassword } from '../src/services/password.service.js';
import {
  createTemplateSchema,
  updateTemplateSchema,
} from '../src/validators/template.validator.js';

describe('Template validators (no DB)', () => {
  it('requires a name and rejects unknown or protected fields', () => {
    assert.equal(createTemplateSchema.safeParse({ body: { subject: 'x' } }).success, false);
    assert.equal(createTemplateSchema.safeParse({ body: { name: 'a' } }).success, false);
    assert.equal(createTemplateSchema.safeParse({ body: { name: 'Welcome', userId: 'x' } }).success, false);
    const ok = createTemplateSchema.safeParse({ body: { name: ' Welcome ' } });
    assert.equal(ok.success, true);
    assert.equal(ok.data.body.name, 'Welcome');
    assert.equal(ok.data.body.htmlContent, '');
  });

  it('requires at least one field on update', () => {
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(updateTemplateSchema.safeParse({ params: { id }, body: {} }).success, false);
    assert.equal(updateTemplateSchema.safeParse({ params: { id }, body: { subject: 'Hi' } }).success, true);
  });
});

describe('Template API (/api/v1/templates)', () => {
  let server;
  let baseUrl;
  let isDbConnected = false;
  const prefix = `tpl-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  let userOne;
  let userTwo;
  let tokenOne;
  let tokenTwo;

  const request = (method, urlPath, { token = tokenOne, body } = {}) =>
    fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await Template.init();
    } catch (err) {
      console.warn(`[Template API Tests] MongoDB unavailable: ${err.message}`);
    }
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    if (isDbConnected) {
      const passwordHash = await hashPassword('StrongPassword123!');
      userOne = await User.create({ name: 'Tpl One', email: `${prefix}-one@example.com`, passwordHash });
      userTwo = await User.create({ name: 'Tpl Two', email: `${prefix}-two@example.com`, passwordHash });
      tokenOne = signAccessToken(userOne);
      tokenTwo = signAccessToken(userTwo);
    }
  });

  beforeEach(async () => {
    if (isDbConnected) await Template.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (isDbConnected) {
      await Template.deleteMany({ userId: { $in: [userOne._id, userTwo._id] } });
      await User.deleteMany({ _id: { $in: [userOne._id, userTwo._id] } });
      await mongoose.disconnect();
    }
  });

  it('requires authentication', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const res = await request('GET', '/api/v1/templates', { token: null });
    assert.equal(res.status, 401);
  });

  it('creates, reads, updates and deletes a template', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');

    let res = await request('POST', '/api/v1/templates', {
      body: {
        name: 'Welcome',
        subject: 'Hi {{firstName | "there"}}',
        htmlContent: '<p>Hello {{name}}</p>',
        textContent: 'Hello {{email}}',
      },
    });
    assert.equal(res.status, 201);
    const created = (await res.json()).data.template;
    assert.deepEqual(created.mergeTags.sort(), ['email', 'firstName', 'name']);
    assert.equal(created.userId, undefined);

    res = await request('GET', `/api/v1/templates/${created.id}`);
    assert.equal(res.status, 200);

    res = await request('PATCH', `/api/v1/templates/${created.id}`, { body: { subject: 'Updated' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.template.subject, 'Updated');

    res = await request('GET', '/api/v1/templates?search=welc');
    const list = (await res.json()).data;
    assert.equal(list.count, 1);
    assert.ok(list.availableMergeTags.includes('firstName'));

    res = await request('DELETE', `/api/v1/templates/${created.id}`);
    assert.equal(res.status, 200);
    res = await request('GET', `/api/v1/templates/${created.id}`);
    assert.equal(res.status, 404);
  });

  it('rejects duplicate names per user with 409 but allows them across users', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const body = { name: 'Newsletter' };
    assert.equal((await request('POST', '/api/v1/templates', { body })).status, 201);
    assert.equal((await request('POST', '/api/v1/templates', { body })).status, 409);
    assert.equal((await request('POST', '/api/v1/templates', { body, token: tokenTwo })).status, 201);

    const other = await request('POST', '/api/v1/templates', { body: { name: 'Other' } });
    const otherId = (await other.json()).data.template.id;
    const res = await request('PATCH', `/api/v1/templates/${otherId}`, { body: { name: 'Newsletter' } });
    assert.equal(res.status, 409);
  });

  it('isolates tenants: foreign templates return 404', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    const created = await request('POST', '/api/v1/templates', { body: { name: 'Private' } });
    const id = (await created.json()).data.template.id;

    assert.equal((await request('GET', `/api/v1/templates/${id}`, { token: tokenTwo })).status, 404);
    assert.equal(
      (await request('PATCH', `/api/v1/templates/${id}`, { token: tokenTwo, body: { subject: 'x' } })).status,
      404
    );
    assert.equal((await request('DELETE', `/api/v1/templates/${id}`, { token: tokenTwo })).status, 404);

    const list = await (await request('GET', '/api/v1/templates', { token: tokenTwo })).json();
    assert.equal(list.data.count, 0);
    assert.ok(await Template.exists({ _id: id }));
  });

  it('rejects invalid ids and bodies with 400', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB required');
    assert.equal((await request('GET', '/api/v1/templates/not-an-id')).status, 400);
    assert.equal((await request('POST', '/api/v1/templates', { body: { name: 'a' } })).status, 400);
    assert.equal(
      (await request('POST', '/api/v1/templates', { body: { name: 'Valid', userId: String(userTwo._id) } })).status,
      400
    );
  });
});
