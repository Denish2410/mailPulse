import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Contact, { contactSchema } from '../src/models/Contact.js';
import { connectDB } from '../src/config/db.js';

describe('Contact Model — Schema Validation (Unit / Offline)', () => {
  const dummyUserId = new mongoose.Types.ObjectId();

  it('1. A valid Contact document passes schema validation', async () => {
    const validContact = new Contact({
      userId: dummyUserId,
      name: 'Alice Johnson',
      email: 'alice.johnson@example.com',
    });

    await validContact.validate();

    assert.equal(validContact.name, 'Alice Johnson');
    assert.equal(validContact.email, 'alice.johnson@example.com');
    assert.ok(validContact.userId.equals(dummyUserId));
    assert.ok(validContact._id);
  });

  it('2. Missing required fields (userId, name, email) fail validation', async () => {
    const emptyContact = new Contact({});
    let error;

    try {
      await emptyContact.validate();
    } catch (err) {
      error = err;
    }

    assert.ok(error, 'Validation should fail for empty contact document');
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors.userId, 'userId should be required');
    assert.match(error.errors.userId.message, /Owner userId is required/i);
    assert.ok(error.errors.name, 'name should be required');
    assert.match(error.errors.name.message, /Contact name is required/i);
    assert.ok(error.errors.email, 'email should be required');
    assert.match(error.errors.email.message, /Contact email is required/i);
  });

  it('3. Invalid userId reference type fails casting validation', async () => {
    const invalidOwnerContact = new Contact({
      userId: 'not-a-valid-object-id',
      name: 'Bob Smith',
      email: 'bob@example.com',
    });

    await assert.rejects(
      async () => {
        await invalidOwnerContact.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.userId);
        assert.equal(err.errors.userId.name, 'CastError');
        return true;
      }
    );
  });

  it('4. Name length constraints are strictly enforced', async () => {
    // Name too short (1 char < 2)
    const shortContact = new Contact({
      userId: dummyUserId,
      name: 'A',
      email: 'alex@example.com',
    });

    await assert.rejects(
      async () => {
        await shortContact.validate();
      },
      (err) => {
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /at least 2 characters long/i);
        return true;
      }
    );

    // Name too long (101 chars > 100)
    const longContact = new Contact({
      userId: dummyUserId,
      name: 'A'.repeat(101),
      email: 'alex@example.com',
    });

    await assert.rejects(
      async () => {
        await longContact.validate();
      },
      (err) => {
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /cannot exceed 100 characters/i);
        return true;
      }
    );
  });

  it('Email length constraint is strictly enforced (max 254 characters)', async () => {
    // 257 characters with valid email structure
    const longEmail = 'a'.repeat(64) + '@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(60) + '.com';
    assert.ok(longEmail.length > 254);

    const contact = new Contact({
      userId: dummyUserId,
      name: 'Valid Name',
      email: longEmail,
    });

    await assert.rejects(
      async () => {
        await contact.validate();
      },
      (err) => {
        assert.ok(err.errors.email);
        assert.match(err.errors.email.message, /cannot exceed 254 characters/i);
        return true;
      }
    );
  });

  it('5. Name and email are trimmed, and email is normalized to lowercase', async () => {
    const contact = new Contact({
      userId: dummyUserId,
      name: '   Charlie Brown   ',
      email: '   Charlie.BROWN@SubDomain.Example.COM   ',
    });

    await contact.validate();

    assert.equal(contact.name, 'Charlie Brown');
    assert.equal(contact.email, 'charlie.brown@subdomain.example.com');
  });

  it('6. Invalid email formats fail regex validation', async () => {
    const invalidEmails = [
      'plainaddress',
      '#@%^%#$@#$@#.com',
      '@missingusername.com',
      'John Doe <john@example.com>',
      'email.domain.com',
      'email@domain@domain.com',
      'email@domain',
      'email@domain.c', // TLD < 2 chars
    ];

    for (const invalidEmail of invalidEmails) {
      const contact = new Contact({
        userId: dummyUserId,
        name: 'Invalid Email Contact',
        email: invalidEmail,
      });

      await assert.rejects(
        async () => {
          await contact.validate();
        },
        (err) => {
          assert.equal(err.name, 'ValidationError');
          assert.ok(err.errors.email, `Expected email validation error for: ${invalidEmail}`);
          assert.match(err.errors.email.message, /valid email address/i);
          return true;
        }
      );
    }
  });

  it('7. Schema defines timestamps, User reference, and compound indexes', () => {
    // Verify timestamps option is enabled
    assert.equal(contactSchema.options.timestamps, true);

    // Verify userId path references User model
    const userIdPath = contactSchema.path('userId');
    assert.ok(userIdPath);
    assert.equal(userIdPath.options.ref, 'User');
    assert.equal(userIdPath.options.required[0], true);

    // Verify compound indexes are registered on the schema
    const schemaIndexes = contactSchema.indexes();

    // Check for { userId: 1, email: 1 } unique index
    const uniqueOwnerEmailIndex = schemaIndexes.find(([fields, options]) => {
      return fields.userId === 1 && fields.email === 1 && options && options.unique === true;
    });
    assert.ok(uniqueOwnerEmailIndex, 'Schema must define compound unique index { userId: 1, email: 1 }');

    // Check for { userId: 1, createdAt: -1 } query/sort index
    const ownerCreatedAtIndex = schemaIndexes.find(([fields]) => {
      return fields.userId === 1 && fields.createdAt === -1;
    });
    assert.ok(ownerCreatedAtIndex, 'Schema must define query/sort index { userId: 1, createdAt: -1 }');
  });
});

describe('Contact Model — Database Integration', () => {
  let isDbConnected = false;
  const testPrefix = `contacttest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      // Ensure indexes (specifically the compound unique index) are created in MongoDB
      await Contact.init();
    } catch (err) {
      console.warn(`[Integration Test] MongoDB connection unavailable. Skipping database integration tests: ${err.message}`);
      isDbConnected = false;
    }
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    // Clean up only test records matching this test run's unique prefix
    await Contact.deleteMany({ email: new RegExp(`^${testPrefix}`) });
  });

  after(async () => {
    if (isDbConnected) {
      await Contact.deleteMany({ email: new RegExp(`^${testPrefix}`) });
      await mongoose.disconnect();
    }
  });

  it('8. Successfully saves a contact and auto-populates createdAt and updatedAt timestamps', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const ownerId = new mongoose.Types.ObjectId();
    const testEmail = `${testPrefix}-save@example.com`;

    const contact = await Contact.create({
      userId: ownerId,
      name: 'Persistent Contact',
      email: testEmail,
    });

    assert.ok(contact._id);
    assert.ok(contact.userId.equals(ownerId));
    assert.equal(contact.name, 'Persistent Contact');
    assert.equal(contact.email, testEmail);
    assert.ok(contact.createdAt instanceof Date, 'createdAt should be a valid Date');
    assert.ok(contact.updatedAt instanceof Date, 'updatedAt should be a valid Date');
  });

  it('9. Enforces per-user email uniqueness: same user cannot add duplicate contact email', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const ownerId = new mongoose.Types.ObjectId();
    const testEmail = `${testPrefix}-duplicate@example.com`;

    // First contact insertion for this user
    const firstContact = await Contact.create({
      userId: ownerId,
      name: 'Primary Contact',
      email: testEmail,
    });
    assert.ok(firstContact._id);

    // Attempt second contact insertion for the SAME user with identical normalized email
    await assert.rejects(
      async () => {
        await Contact.create({
          userId: ownerId,
          name: 'Duplicate Contact Attempt',
          email: `  ${testEmail.toUpperCase()}  `,
        });
      },
      (err) => {
        // Must fail with MongoDB duplicate key error code 11000
        assert.equal(err.code, 11000);
        assert.ok(err.message.includes('E11000') || err.message.includes('duplicate key'));
        return true;
      }
    );
  });

  it('10. Multi-tenancy isolation: different users CAN add the same contact email', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const userOneId = new mongoose.Types.ObjectId();
    const userTwoId = new mongoose.Types.ObjectId();
    const sharedEmail = `${testPrefix}-shared@example.com`;

    // User One creates contact with sharedEmail
    const userOneContact = await Contact.create({
      userId: userOneId,
      name: 'User One Shared Contact',
      email: sharedEmail,
    });
    assert.ok(userOneContact._id);

    // User Two creates contact with identical sharedEmail — must succeed without collision
    const userTwoContact = await Contact.create({
      userId: userTwoId,
      name: 'User Two Shared Contact',
      email: sharedEmail,
    });
    assert.ok(userTwoContact._id);
    assert.notEqual(userOneContact._id.toString(), userTwoContact._id.toString());
    assert.equal(userOneContact.email, userTwoContact.email);
    assert.notEqual(userOneContact.userId.toString(), userTwoContact.userId.toString());
  });

  it('11. Supports querying and sorting contacts scoped to owner userId', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const ownerId = new mongoose.Types.ObjectId();
    const otherOwnerId = new mongoose.Types.ObjectId();

    // Create 2 contacts for ownerId and 1 contact for otherOwnerId
    const c1 = await Contact.create({
      userId: ownerId,
      name: 'Contact First',
      email: `${testPrefix}-c1@example.com`,
    });

    const c2 = await Contact.create({
      userId: ownerId,
      name: 'Contact Second',
      email: `${testPrefix}-c2@example.com`,
    });

    await Contact.create({
      userId: otherOwnerId,
      name: 'Other Owner Contact',
      email: `${testPrefix}-other@example.com`,
    });

    // Query scoped to ownerId, sorted by createdAt descending
    const ownerContacts = await Contact.find({ userId: ownerId }).sort({ createdAt: -1 });

    assert.equal(ownerContacts.length, 2);
    // Verified that other owner's contact is not returned
    assert.ok(ownerContacts.every((c) => c.userId.equals(ownerId)));
    // Verified descending sort order
    assert.ok(ownerContacts[0].createdAt >= ownerContacts[1].createdAt);
  });
});
