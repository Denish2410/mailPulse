import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Campaign, { campaignSchema } from '../src/models/Campaign.js';
import Contact from '../src/models/Contact.js';
import User from '../src/models/User.js';
import { connectDB } from '../src/config/db.js';

describe('Campaign Model — Schema Validation (Unit / Offline)', () => {
  const dummyUserId = new mongoose.Types.ObjectId();
  const dummyContactId1 = new mongoose.Types.ObjectId();
  const dummyContactId2 = new mongoose.Types.ObjectId();

  it('1. A valid Campaign document passes schema validation', async () => {
    const validCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Spring Launch Announcement',
      subject: 'Announcing our Spring 2026 Collection',
      textContent: 'Welcome to our spring launch! Details inside.',
      htmlContent: '<h1>Welcome</h1><p>Our spring launch details.</p>',
      recipientIds: [dummyContactId1, dummyContactId2],
    });

    await validCampaign.validate();

    assert.equal(validCampaign.name, 'Spring Launch Announcement');
    assert.equal(validCampaign.subject, 'Announcing our Spring 2026 Collection');
    assert.equal(validCampaign.textContent, 'Welcome to our spring launch! Details inside.');
    assert.equal(validCampaign.htmlContent, '<h1>Welcome</h1><p>Our spring launch details.</p>');
    assert.equal(validCampaign.status, 'draft');
    assert.equal(validCampaign.recipientIds.length, 2);
    assert.ok(validCampaign.userId.equals(dummyUserId));
    assert.ok(validCampaign._id);
  });

  it('2. Missing required fields (userId, name, subject) fail validation', async () => {
    const emptyCampaign = new Campaign({});
    let error;

    try {
      await emptyCampaign.validate();
    } catch (err) {
      error = err;
    }

    assert.ok(error, 'Validation should fail for empty campaign document');
    assert.equal(error.name, 'ValidationError');
    assert.ok(error.errors.userId, 'userId should be required');
    assert.match(error.errors.userId.message, /Owner userId is required/i);
    assert.ok(error.errors.name, 'name should be required');
    assert.match(error.errors.name.message, /Campaign name is required/i);
    assert.ok(error.errors.subject, 'subject should be required');
    assert.match(error.errors.subject.message, /Email subject is required/i);
  });

  it('3. Invalid userId reference type fails casting validation', async () => {
    const invalidOwnerCampaign = new Campaign({
      userId: 'not-a-valid-object-id',
      name: 'Q3 Newsletter',
      subject: 'Quarterly Updates',
    });

    await assert.rejects(
      async () => {
        await invalidOwnerCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.userId);
        assert.equal(err.errors.userId.name, 'CastError');
        return true;
      }
    );
  });

  it('4. Campaign name validation enforces trimming, minlength (2), and maxlength (120)', async () => {
    // Name too short (1 char < 2)
    const tooShortCampaign = new Campaign({
      userId: dummyUserId,
      name: 'A',
      subject: 'Valid Subject',
    });
    await assert.rejects(
      async () => {
        await tooShortCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /at least 2 characters/i);
        return true;
      }
    );

    // Name too long (121 chars > 120)
    const tooLongCampaign = new Campaign({
      userId: dummyUserId,
      name: 'A'.repeat(121),
      subject: 'Valid Subject',
    });
    await assert.rejects(
      async () => {
        await tooLongCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.name);
        assert.match(err.errors.name.message, /cannot exceed 120 characters/i);
        return true;
      }
    );

    // Name with leading/trailing whitespace trims correctly
    const trimmedCampaign = new Campaign({
      userId: dummyUserId,
      name: '   Trimmed Campaign Name   ',
      subject: 'Valid Subject',
    });
    await trimmedCampaign.validate();
    assert.equal(trimmedCampaign.name, 'Trimmed Campaign Name');

    // Name containing only whitespace trims to empty string and triggers required validator
    const whitespaceNameCampaign = new Campaign({
      userId: dummyUserId,
      name: '      ',
      subject: 'Valid Subject',
    });
    await assert.rejects(
      async () => {
        await whitespaceNameCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.name);
        return true;
      }
    );
  });

  it('5. Subject validation enforces trimming, minlength (1), and maxlength (200)', async () => {
    // Subject too long (201 chars > 200)
    const tooLongSubjectCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Valid Campaign',
      subject: 'S'.repeat(201),
    });
    await assert.rejects(
      async () => {
        await tooLongSubjectCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.subject);
        assert.match(err.errors.subject.message, /cannot exceed 200 characters/i);
        return true;
      }
    );

    // Subject with leading/trailing whitespace trims properly
    const trimmedSubjectCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Valid Campaign',
      subject: '   Flash Sale 50% Off Today!   ',
    });
    await trimmedSubjectCampaign.validate();
    assert.equal(trimmedSubjectCampaign.subject, 'Flash Sale 50% Off Today!');

    // Whitespace-only subject trims to empty string and triggers required validator
    const whitespaceSubjectCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Valid Campaign',
      subject: '    ',
    });
    await assert.rejects(
      async () => {
        await whitespaceSubjectCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.subject);
        return true;
      }
    );
  });

  it('6. textContent and htmlContent default to empty string and accept valid text and HTML', async () => {
    const minimalCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Minimal Draft',
      subject: 'Draft Subject',
    });

    await minimalCampaign.validate();
    assert.equal(minimalCampaign.textContent, '');
    assert.equal(minimalCampaign.htmlContent, '');

    const populatedCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Populated Content',
      subject: 'Subject',
      textContent: 'Plain text line 1\nPlain text line 2',
      htmlContent: '<div class="email"><h2>Hello</h2><p>Body</p></div>',
    });

    await populatedCampaign.validate();
    assert.equal(populatedCampaign.textContent, 'Plain text line 1\nPlain text line 2');
    assert.equal(populatedCampaign.htmlContent, '<div class="email"><h2>Hello</h2><p>Body</p></div>');

    // Exactly at maximum length limits: textContent (100,000) and htmlContent (500,000)
    const exactMaxCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Exact Max Content',
      subject: 'Subject',
      textContent: 'a'.repeat(100000),
      htmlContent: 'b'.repeat(500000),
    });
    await exactMaxCampaign.validate();
    assert.equal(exactMaxCampaign.textContent.length, 100000);
    assert.equal(exactMaxCampaign.htmlContent.length, 500000);

    // textContent exceeding maximum by 1 character (100,001)
    const tooLongTextCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Too Long Text',
      subject: 'Subject',
      textContent: 'a'.repeat(100001),
    });
    await assert.rejects(
      async () => {
        await tooLongTextCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.textContent);
        assert.match(err.errors.textContent.message, /cannot exceed 100,000 characters/i);
        return true;
      }
    );

    // htmlContent exceeding maximum by 1 character (500,001)
    const tooLongHtmlCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Too Long HTML',
      subject: 'Subject',
      htmlContent: 'b'.repeat(500001),
    });
    await assert.rejects(
      async () => {
        await tooLongHtmlCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.htmlContent);
        assert.match(err.errors.htmlContent.message, /cannot exceed 500,000 characters/i);
        return true;
      }
    );
  });

  it('7. Status defaults to "draft" and rejects unsupported status values', async () => {
    const defaultStatusCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Status Test',
      subject: 'Status Subject',
    });

    assert.equal(defaultStatusCampaign.status, 'draft');

    const invalidStatusCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Invalid Status Test',
      subject: 'Subject',
      status: 'unsupported_status',
    });

    await assert.rejects(
      async () => {
        await invalidStatusCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors.status);
        assert.match(err.errors.status.message, /Status must be draft/i);
        return true;
      }
    );
  });

  it('8. recipientIds defaults to an empty array and accepts valid ObjectId references', async () => {
    const defaultRecipientCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Recipient Default Test',
      subject: 'Subject',
    });

    assert.ok(Array.isArray(defaultRecipientCampaign.recipientIds));
    assert.equal(defaultRecipientCampaign.recipientIds.length, 0);

    const populatedRecipientsCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Populated Recipients Test',
      subject: 'Subject',
      recipientIds: [dummyContactId1, dummyContactId2],
    });

    await populatedRecipientsCampaign.validate();
    assert.equal(populatedRecipientsCampaign.recipientIds.length, 2);
    assert.ok(populatedRecipientsCampaign.recipientIds[0].equals(dummyContactId1));
    assert.ok(populatedRecipientsCampaign.recipientIds[1].equals(dummyContactId2));
  });

  it('9. Invalid ObjectId in recipientIds array fails validation', async () => {
    const invalidRecipientCampaign = new Campaign({
      userId: dummyUserId,
      name: 'Invalid Recipient List',
      subject: 'Subject',
      recipientIds: [dummyContactId1, 'not-a-valid-contact-id'],
    });

    await assert.rejects(
      async () => {
        await invalidRecipientCampaign.validate();
      },
      (err) => {
        assert.equal(err.name, 'ValidationError');
        assert.ok(err.errors['recipientIds.1']);
        assert.equal(err.errors['recipientIds.1'].name, 'CastError');
        return true;
      }
    );
  });

  it('10. Schema defines timestamps, User reference, Contact array reference, and tenant indexes', () => {
    // Timestamps enabled
    assert.equal(campaignSchema.options.timestamps, true);

    // userId path references User
    const userIdPath = campaignSchema.path('userId');
    assert.ok(userIdPath);
    assert.equal(userIdPath.options.ref, 'User');
    assert.equal(userIdPath.options.required[0], true);

    // recipientIds path references Contact
    const recipientIdsPath = campaignSchema.path('recipientIds');
    assert.ok(recipientIdsPath);
    assert.equal(recipientIdsPath.caster.options.ref, 'Contact');

    // Tenant query/sort index { userId: 1, createdAt: -1 } registered
    const schemaIndexes = campaignSchema.indexes();
    const ownerCreatedAtIndex = schemaIndexes.find(([fields]) => {
      return fields.userId === 1 && fields.createdAt === -1;
    });
    assert.ok(ownerCreatedAtIndex, 'Schema must define compound tenant index { userId: 1, createdAt: -1 }');
  });
});

describe('Campaign Model — Database Integration', () => {
  let isDbConnected = false;
  const testPrefix = `campaigntest-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  let testUser;

  before(async () => {
    try {
      await connectDB();
      isDbConnected = true;
      await User.init();
      await Contact.init();
      await Campaign.init();

      testUser = await User.create({
        name: 'Campaign Tester',
        email: `${testPrefix}-tester@example.com`,
        passwordHash: 'dummy-hash-password-for-model-test',
      });
    } catch (err) {
      console.warn(`[Campaign Model Integration] MongoDB unavailable: ${err.message}`);
      isDbConnected = false;
    }
  });

  beforeEach(async () => {
    if (!isDbConnected) return;
    await Campaign.deleteMany({ userId: testUser._id });
    await Contact.deleteMany({ userId: testUser._id });
  });

  after(async () => {
    if (isDbConnected) {
      await Campaign.deleteMany({ userId: testUser._id });
      await Contact.deleteMany({ userId: testUser._id });
      await User.deleteMany({ _id: testUser._id });
      await mongoose.disconnect();
    }
  });

  it('11. Successfully saves a campaign and auto-populates createdAt and updatedAt timestamps', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const campaign = await Campaign.create({
      userId: testUser._id,
      name: `${testPrefix} Summer Newsletter`,
      subject: 'Exclusive Summer Deals',
      textContent: 'Check out deals',
      htmlContent: '<p>Check out deals</p>',
    });

    assert.ok(campaign._id);
    assert.ok(campaign.userId.equals(testUser._id));
    assert.ok(campaign.createdAt instanceof Date);
    assert.ok(campaign.updatedAt instanceof Date);
    assert.equal(campaign.status, 'draft');
    assert.deepEqual(campaign.recipientIds, []);
  });

  it('12. Supports querying campaigns scoped to owner userId sorted newest-first', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    const otherUser = await User.create({
      name: 'Other User',
      email: `${testPrefix}-other@example.com`,
      passwordHash: 'dummy-hash',
    });

    try {
      // Create 2 campaigns for testUser with distinct timestamps
      const camp1 = await Campaign.create({
        userId: testUser._id,
        name: `${testPrefix} Older Campaign`,
        subject: 'Older Subject',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const camp2 = await Campaign.create({
        userId: testUser._id,
        name: `${testPrefix} Newer Campaign`,
        subject: 'Newer Subject',
      });

      // Create 1 campaign for otherUser
      await Campaign.create({
        userId: otherUser._id,
        name: `${testPrefix} Other Campaign`,
        subject: 'Other Subject',
      });

      // Query scoped strictly to testUser._id sorted by createdAt descending
      const results = await Campaign.find({ userId: testUser._id }).sort({ createdAt: -1 });

      assert.equal(results.length, 2);
      assert.ok(results.every((c) => c.userId.equals(testUser._id)));
      assert.equal(results[0]._id.toString(), camp2._id.toString());
      assert.equal(results[1]._id.toString(), camp1._id.toString());
      assert.ok(results[0].createdAt >= results[1].createdAt);
    } finally {
      await Campaign.deleteMany({ userId: otherUser._id });
      await User.deleteOne({ _id: otherUser._id });
    }
  });

  it('13. Deleting a Contact does not automatically cascade or remove recipient IDs from draft campaign', async (t) => {
    if (!isDbConnected) return t.skip('MongoDB connection unavailable');

    // Create a contact owned by testUser
    const contact = await Contact.create({
      userId: testUser._id,
      name: 'Transient Contact',
      email: `${testPrefix}-transient@example.com`,
    });

    // Create a draft campaign referencing this contact ID
    const campaign = await Campaign.create({
      userId: testUser._id,
      name: `${testPrefix} Draft Retaining Deleted Contact`,
      subject: 'Draft Subject',
      recipientIds: [contact._id],
    });

    assert.equal(campaign.recipientIds.length, 1);
    assert.equal(campaign.recipientIds[0].toString(), contact._id.toString());

    // Delete the contact from database
    await Contact.deleteOne({ _id: contact._id });

    // Verify contact no longer exists in DB
    const fetchedContact = await Contact.findById(contact._id);
    assert.equal(fetchedContact, null);

    // Fetch the campaign from DB: the referenced contact ID remains retained in recipientIds
    const fetchedCampaign = await Campaign.findById(campaign._id);
    assert.ok(fetchedCampaign);
    assert.equal(fetchedCampaign.recipientIds.length, 1);
    assert.equal(fetchedCampaign.recipientIds[0].toString(), contact._id.toString());
  });
});
