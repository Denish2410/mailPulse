import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import User, { userSchema } from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';

describe('User Model — Schema Validation (Unit / Offline)', () => {
  it('1. A valid User document passes schema validation with default status', async () => {
    const validData = {
      name: 'Jane Doe',
      email: 'jane.doe@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv1234567890',
    };

    const user = new User(validData);
    await user.validate();

    assert.equal(user.name, 'Jane Doe');
    assert.equal(user.email, 'jane.doe@example.com');
    assert.equal(user.status, 'active');
    assert.ok(user._id);
  });

  it('2. Missing required fields fail schema validation', async () => {
    // Completely empty document
    const emptyUser = new User({});
    let error;

    try {
      await emptyUser.validate();
    } catch (err) {
      error = err;
    }

    assert.ok(error, 'Validation should fail for empty document');
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors.name, 'name should be required');
    assert.ok(error.errors.email, 'email should be required');
    assert.ok(error.errors.passwordHash, 'passwordHash should be required');
  });

  it('3. Invalid email formats fail validation', async () => {
    const invalidEmails = [
      'plainaddress',
      '#@%^%#$@#$@#.com',
      '@example.com',
      'Joe Smith <email@example.com>',
      'email.example.com',
      'email@example@example.com',
      'email@example',
    ];

    for (const invalidEmail of invalidEmails) {
      const user = new User({
        name: 'Test User',
        email: invalidEmail,
        passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      });

      await assert.rejects(
        async () => {
          await user.validate();
        },
        (err) => {
          assert.equal(err.name, 'ValidationError');
          assert.ok(err.errors.email, `Expected email validation error for: ${invalidEmail}`);
          return true;
        }
      );
    }
  });

  it('4. Name length constraints are enforced', async () => {
    // Too short (1 char < 2)
    const shortUser = new User({
      name: 'A',
      email: 'short@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    });

    await assert.rejects(
      async () => {
        await shortUser.validate();
      },
      (err) => {
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /at least 2 characters/i);
        return true;
      }
    );

    // Too long (101 chars > 100)
    const longUser = new User({
      name: 'A'.repeat(101),
      email: 'long@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    });

    await assert.rejects(
      async () => {
        await longUser.validate();
      },
      (err) => {
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /cannot exceed 100 characters/i);
        return true;
      }
    );
  });

  it('5. Status enum allows only active and suspended', async () => {
    // Valid status: active
    const activeUser = new User({
      name: 'Active User',
      email: 'active@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      status: 'active',
    });
    await activeUser.validate();

    // Valid status: suspended
    const suspendedUser = new User({
      name: 'Suspended User',
      email: 'suspended@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      status: 'suspended',
    });
    await suspendedUser.validate();

    // Invalid status: deleted / pending / admin
    const invalidStatusUser = new User({
      name: 'Invalid Status User',
      email: 'invalid@example.com',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
      status: 'pending',
    });

    await assert.rejects(
      async () => {
        await invalidStatusUser.validate();
      },
      (err) => {
        assert.ok(err.errors.status);
        assert.match(err.errors.status.message, /either active or suspended/i);
        return true;
      }
    );
  });

  it('6. Name and email are trimmed, and email is normalized to lowercase', async () => {
    const user = new User({
      name: '   Sarah Connor   ',
      email: '   Sarah.Connor@EXAMPLE.com   ',
      passwordHash: '$2b$10$abcdefghijklmnopqrstuv',
    });

    await user.validate();

    assert.equal(user.name, 'Sarah Connor');
    assert.equal(user.email, 'sarah.connor@example.com');
  });

  it('7. Schema defines timestamps, select: false on passwordHash, and email unique index', () => {
    // Verify timestamps option is enabled
    assert.equal(userSchema.options.timestamps, true);

    // Verify passwordHash has select: false
    const passwordHashPath = userSchema.path('passwordHash');
    assert.ok(passwordHashPath);
    assert.equal(passwordHashPath.options.select, false);

    // Verify email is configured with unique index
    const emailPath = userSchema.path('email');
    assert.ok(emailPath);
    assert.equal(emailPath.options.unique, true);
  });
});

describe('User Model — Database Integration', () => {
  let isDbConnected = false;
  const testEmailPrefix = `test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      // Ensure indexes (specifically the unique email index) are built
      await User.init();
    } catch (err) {
      console.warn(`[Integration Test] MongoDB connection unavailable. Skipping database integration tests: ${err.message}`);
      isDbConnected = false;
    }
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    // Clean up any test users from prior runs matching this test prefix
    await User.deleteMany({ email: new RegExp(`^${testEmailPrefix}`) });
  });

  after(async () => {
    if (isDbConnected) {
      await User.deleteMany({ email: new RegExp(`^${testEmailPrefix}`) });
      await mongoose.disconnect();
    }
  });

  it('8. Successfully saves a user and populates createdAt and updatedAt timestamps', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const testEmail = `${testEmailPrefix}-save@example.com`;
    const user = await User.create({
      name: 'Database User',
      email: testEmail,
      passwordHash: '$2b$10$hashedPasswordString123456789',
    });

    assert.ok(user._id);
    assert.ok(user.createdAt instanceof Date);
    assert.ok(user.updatedAt instanceof Date);
    assert.equal(user.email, testEmail);
    assert.equal(user.status, 'active');
  });

  it('9. Excludes passwordHash by default on queries, but allows explicit selection', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const testEmail = `${testEmailPrefix}-select@example.com`;
    const rawHash = '$2b$10$secretHashExclusionTest12345';

    const created = await User.create({
      name: 'Security User',
      email: testEmail,
      passwordHash: rawHash,
    });

    // Default findOne query: passwordHash must NOT be returned
    const foundDefault = await User.findById(created._id);
    assert.ok(foundDefault);
    assert.equal(foundDefault.passwordHash, undefined);

    // Explicit selection query: .select('+passwordHash') must return the hash
    const foundWithHash = await User.findById(created._id).select('+passwordHash');
    assert.ok(foundWithHash);
    assert.equal(foundWithHash.passwordHash, rawHash);
  });

  it('10. Enforces real database uniqueness constraint rejecting duplicate emails', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const duplicateEmail = `${testEmailPrefix}-duplicate@example.com`;

    // First insertion should succeed
    const firstUser = await User.create({
      name: 'Original User',
      email: duplicateEmail,
      passwordHash: '$2b$10$hash1',
    });
    assert.ok(firstUser._id);

    // Attempt duplicate insertion with same email (even with different case or whitespace)
    await assert.rejects(
      async () => {
        await User.create({
          name: 'Imposter User',
          email: `  ${duplicateEmail.toUpperCase()}  `,
          passwordHash: '$2b$10$hash2',
        });
      },
      (err) => {
        // Must be a MongoDB E11000 duplicate key error
        assert.equal(err.code, 11000);
        assert.ok(err.message.includes('E11000'));
        return true;
      }
    );
  });
});
