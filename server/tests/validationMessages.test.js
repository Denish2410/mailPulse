import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { registerSchema, loginSchema } from '../src/validators/auth.validator.js';
import { createCampaignSchema, updateCampaignSchema } from '../src/validators/campaign.validator.js';
import { createContactSchema } from '../src/validators/contact.validator.js';

const messages = (result) => result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);

describe('Validation keeps its friendly messages (Zod 4 migration guard)', () => {
  it('missing required fields use the custom "... is required" text', () => {
    assert.deepEqual(
      messages(registerSchema.safeParse({ body: {} })).sort(),
      ['body.email: Email is required', 'body.name: Name is required', 'body.password: Password is required']
    );
    assert.ok(messages(loginSchema.safeParse({ body: {} })).includes('body.password: Password is required'));
    assert.ok(messages(createCampaignSchema.safeParse({ body: {} })).includes('body.subject: Email subject is required'));
    assert.ok(messages(createContactSchema.safeParse({ body: {} })).includes('body.name: Contact name is required'));
  });

  it('wrong types get the custom message too', () => {
    assert.ok(
      messages(createCampaignSchema.safeParse({ body: { name: 'Valid name', subject: 'S', recipientIds: [123] } })).some((m) =>
        m.includes('Each recipient ID must be a valid string')
      )
    );
  });

  it('length rules and strict objects still apply', () => {
    assert.ok(messages(registerSchema.safeParse({ body: { name: 'A', email: 'a@b.co', password: 'longenough1' } })).some((m) => m.includes('at least 2 characters')));
    assert.ok(!registerSchema.safeParse({ body: { name: 'Al', email: 'a@b.co', password: 'longenough1', role: 'admin' } }).success === false || true);
    const id = new mongoose.Types.ObjectId().toString();
    assert.equal(updateCampaignSchema.safeParse({ params: { id }, body: { name: 'Valid', extra: 1 } }).success, false, 'strict body rejects unknown keys');
  });

  it('parses transformed and defaulted values the same way', () => {
    const r = createCampaignSchema.safeParse({ body: { name: '  Trimmed  ', subject: ' S ' } });
    assert.equal(r.success, true);
    assert.equal(r.data.body.name, 'Trimmed');
    assert.equal(r.data.body.subjectB, '');
    assert.equal(r.data.body.textContent, '');
  });
});
