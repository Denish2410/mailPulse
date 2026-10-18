import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient, getErrorMessage } from '../src/lib/api.js';
import {
  getContacts,
  createContact,
  updateContact,
  deleteContact,
} from '../src/api/contacts.js';
import {
  validateContactName,
  validateContactEmail,
  validateContactForm,
} from '../src/utils/validation.js';

describe('Contacts API Client & Contact Validation', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('getContacts', () => {
    it('1. Calls GET /contacts with default query parameters and returns data with pagination metadata', async () => {
      const mockBackendResponse = {
        data: {
          success: true,
          message: 'Contacts retrieved successfully',
          data: {
            contacts: [
              {
                id: 'contact-1',
                name: 'Alice Cooper',
                email: 'alice@example.com',
                createdAt: '2026-10-18T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
              },
            ],
            count: 1,
            pagination: {
              page: 1,
              limit: 20,
              total: 1,
              totalPages: 1,
              hasNextPage: false,
              hasPrevPage: false,
            },
            page: 1,
            limit: 20,
            total: 1,
            totalPages: 1,
            hasNextPage: false,
            hasPrevPage: false,
          },
        },
      };

      let capturedUrl = null;
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedUrl = url;
        capturedConfig = config;
        return mockBackendResponse;
      });

      const result = await getContacts();

      assert.equal(capturedUrl, '/contacts');
      assert.deepEqual(capturedConfig.params, {});
      assert.deepEqual(result.contacts, mockBackendResponse.data.data.contacts);
      assert.deepEqual(result.pagination, mockBackendResponse.data.data.pagination);
      assert.equal(result.count, 1);
    });

    it('2. Serializes valid pagination numbers and trims search & domain filters', async () => {
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return { data: { success: true, data: { contacts: [], pagination: {} } } };
      });

      await getContacts({
        page: 2,
        limit: 50,
        search: '  John Smith  ',
        emailDomain: '  EXAMPLE.COM  ',
      });

      assert.deepEqual(capturedConfig.params, {
        page: 2,
        limit: 50,
        search: 'John Smith',
        emailDomain: 'example.com',
      });
    });

    it('3. Converts valid numeric string pagination values to integers', async () => {
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return { data: { success: true, data: { contacts: [] } } };
      });

      await getContacts({
        page: '3',
        limit: '25',
      });

      assert.equal(capturedConfig.params.page, 3);
      assert.equal(capturedConfig.params.limit, 25);
    });

    it('4. Omits empty, whitespace-only, and invalid optional filters', async () => {
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return { data: { success: true, data: { contacts: [] } } };
      });

      await getContacts({
        search: '   ',
        emailDomain: '   ',
        page: 'invalid-page',
        limit: -5,
      });

      // Blank strings and invalid numbers must be omitted completely
      assert.deepEqual(capturedConfig.params, {});
    });

    it('5. Ignores unexpected array or object values for search and domain filters', async () => {
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return { data: { success: true, data: { contacts: [] } } };
      });

      await getContacts({
        search: ['malicious', 'array'],
        emailDomain: { domain: 'nested.com' },
      });

      assert.deepEqual(capturedConfig.params, {});
    });

    it('6. Propagates API errors from getContacts', async () => {
      const mockNetworkError = new Error('Network Error');
      mockNetworkError.code = 'ERR_NETWORK';

      mock.method(apiClient, 'get', async () => {
        throw mockNetworkError;
      });

      await assert.rejects(
        async () => {
          await getContacts();
        },
        (err) => err.code === 'ERR_NETWORK'
      );
    });
  });

  describe('createContact', () => {
    it('7. Calls POST /contacts sending only supported name and email with whitespace trimmed', async () => {
      const mockCreated = {
        id: 'contact-new-123',
        name: 'Jane Doe',
        email: 'jane@example.com',
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T00:00:00.000Z',
      };

      let capturedUrl = null;
      let capturedBody = null;

      mock.method(apiClient, 'post', async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          data: {
            success: true,
            message: 'Contact created successfully',
            data: { contact: mockCreated },
          },
        };
      });

      const result = await createContact({
        name: '  Jane Doe  ',
        email: '  jane@example.com  ',
        extraField: 'should-be-omitted',
        _id: 'tampered-id',
        userId: 'tampered-user',
      });

      assert.equal(capturedUrl, '/contacts');
      assert.deepEqual(capturedBody, {
        name: 'Jane Doe',
        email: 'jane@example.com',
      });
      assert.deepEqual(result, mockCreated);
    });

    it('8. Propagates HTTP 409 conflict error without hiding duplicate email response', async () => {
      const mock409Error = new Error('Conflict');
      mock409Error.response = {
        status: 409,
        data: {
          success: false,
          message: 'A contact with this email already exists.',
        },
      };

      mock.method(apiClient, 'post', async () => {
        throw mock409Error;
      });

      await assert.rejects(
        async () => {
          await createContact({ name: 'Jane Doe', email: 'duplicate@example.com' });
        },
        (err) => {
          assert.equal(err.response?.status, 409);
          assert.equal(getErrorMessage(err), 'A contact with this email already exists.');
          return true;
        }
      );
    });
  });

  describe('updateContact', () => {
    it('9. Calls PATCH /contacts/:id sending only supported updated fields', async () => {
      const contactId = 'contact-abc-456';
      const mockUpdated = {
        id: contactId,
        name: 'Updated Name',
        email: 'updated@example.com',
        createdAt: '2026-10-18T00:00:00.000Z',
        updatedAt: '2026-10-18T01:00:00.000Z',
      };

      let capturedUrl = null;
      let capturedBody = null;

      mock.method(apiClient, 'patch', async (url, body) => {
        capturedUrl = url;
        capturedBody = body;
        return {
          data: {
            success: true,
            message: 'Contact updated successfully',
            data: { contact: mockUpdated },
          },
        };
      });

      const result = await updateContact(contactId, {
        name: '  Updated Name  ',
        email: '  updated@example.com  ',
        protectedField: 'disallowed',
      });

      assert.equal(capturedUrl, `/contacts/${contactId}`);
      assert.deepEqual(capturedBody, {
        name: 'Updated Name',
        email: 'updated@example.com',
      });
      assert.deepEqual(result, mockUpdated);
    });

    it('10. Allows partial updates with only name or only email', async () => {
      let capturedBody = null;

      mock.method(apiClient, 'patch', async (url, body) => {
        capturedBody = body;
        return { data: { success: true, data: { contact: {} } } };
      });

      await updateContact('contact-1', { name: 'Only Name' });
      assert.deepEqual(capturedBody, { name: 'Only Name' });

      await updateContact('contact-1', { email: 'only@example.com' });
      assert.deepEqual(capturedBody, { email: 'only@example.com' });
    });

    it('11. Propagates HTTP 409 conflict error when updating to an existing email', async () => {
      const mock409Error = new Error('Conflict');
      mock409Error.response = {
        status: 409,
        data: {
          success: false,
          message: 'A contact with this email already exists.',
        },
      };

      mock.method(apiClient, 'patch', async () => {
        throw mock409Error;
      });

      await assert.rejects(
        async () => {
          await updateContact('contact-1', { email: 'already-used@example.com' });
        },
        (err) => {
          assert.equal(err.response?.status, 409);
          assert.equal(getErrorMessage(err), 'A contact with this email already exists.');
          return true;
        }
      );
    });
  });

  describe('deleteContact', () => {
    it('12. Calls DELETE /contacts/:id and returns deletion response', async () => {
      const contactId = 'contact-del-789';
      let capturedUrl = null;

      mock.method(apiClient, 'delete', async (url) => {
        capturedUrl = url;
        return {
          data: {
            success: true,
            message: 'Contact deleted successfully',
          },
        };
      });

      const result = await deleteContact(contactId);

      assert.equal(capturedUrl, `/contacts/${contactId}`);
      assert.equal(result.success, true);
      assert.equal(result.message, 'Contact deleted successfully');
    });

    it('13. Propagates HTTP 404 error when contact does not exist or is not owned', async () => {
      const mock404Error = new Error('Not Found');
      mock404Error.response = {
        status: 404,
        data: {
          success: false,
          message: 'Contact not found.',
        },
      };

      mock.method(apiClient, 'delete', async () => {
        throw mock404Error;
      });

      await assert.rejects(
        async () => {
          await deleteContact('non-existent-id');
        },
        (err) => {
          assert.equal(err.response?.status, 404);
          assert.equal(getErrorMessage(err), 'Contact not found.');
          return true;
        }
      );
    });
  });

  describe('Contact Validation Utilities', () => {
    describe('validateContactName', () => {
      it('14. Rejects missing, empty, or whitespace-only name', () => {
        assert.equal(validateContactName(''), 'Contact name is required.');
        assert.equal(validateContactName('   '), 'Contact name is required.');
        assert.equal(validateContactName(null), 'Contact name is required.');
        assert.equal(validateContactName(undefined), 'Contact name is required.');
      });

      it('15. Rejects name shorter than 2 characters after trimming', () => {
        assert.equal(validateContactName('A'), 'Contact name must be at least 2 characters long.');
        assert.equal(validateContactName('  B  '), 'Contact name must be at least 2 characters long.');
      });

      it('16. Rejects name longer than 100 characters', () => {
        const longName = 'A'.repeat(101);
        assert.equal(validateContactName(longName), 'Contact name cannot exceed 100 characters.');
      });

      it('17. Accepts valid names between 2 and 100 characters', () => {
        assert.equal(validateContactName('Jo'), null);
        assert.equal(validateContactName('  Jane Doe  '), null);
        assert.equal(validateContactName('A'.repeat(100)), null);
      });
    });

    describe('validateContactEmail', () => {
      it('18. Rejects missing, empty, or whitespace-only email', () => {
        assert.equal(validateContactEmail(''), 'Contact email is required.');
        assert.equal(validateContactEmail('   '), 'Contact email is required.');
        assert.equal(validateContactEmail(null), 'Contact email is required.');
        assert.equal(validateContactEmail(undefined), 'Contact email is required.');
      });

      it('19. Rejects malformed email addresses', () => {
        assert.equal(validateContactEmail('plainaddress'), 'Please enter a valid email address.');
        assert.equal(validateContactEmail('@missingusername.com'), 'Please enter a valid email address.');
        assert.equal(validateContactEmail('username@.com'), 'Please enter a valid email address.');
        assert.equal(validateContactEmail('user name@example.com'), 'Please enter a valid email address.');
      });

      it('20. Rejects email exceeding 254 characters', () => {
        // Construct an email with 255 characters
        const localPart = 'a'.repeat(64);
        const domainLabel = 'b'.repeat(60);
        // 64 + 1 (@) + 60 + 1 (.) + 60 + 1 (.) + 65 + 1 (.) + 2 = >254
        const excessiveEmail = `${localPart}@${domainLabel}.${domainLabel}.${'c'.repeat(65)}.com`;
        assert.ok(excessiveEmail.length > 254);
        assert.equal(validateContactEmail(excessiveEmail), 'Contact email cannot exceed 254 characters.');
      });

      it('21. Accepts valid email format within 254 characters', () => {
        assert.equal(validateContactEmail('user@example.com'), null);
        assert.equal(validateContactEmail('  support@sub.domain.co.uk  '), null);

        // Exactly 254 characters valid email
        // local = 64 chars, @ = 1 char, domain = 189 chars (60 + 1 + 60 + 1 + 63 + 1 + 3 = 189)
        const local = 'a'.repeat(64);
        const part1 = 'b'.repeat(60);
        const part2 = 'c'.repeat(60);
        const part3 = 'd'.repeat(63);
        const maxEmail = `${local}@${part1}.${part2}.${part3}.com`;
        assert.equal(maxEmail.length, 254);
        assert.equal(validateContactEmail(maxEmail), null);
      });
    });

    describe('validateContactForm', () => {
      it('22. Validates a correct contact form payload', () => {
        const result = validateContactForm({
          name: 'Sarah Connor',
          email: 'sarah@example.com',
        });
        assert.equal(result.isValid, true);
        assert.deepEqual(result.errors, {});
      });

      it('23. Aggregates errors when both name and email are invalid', () => {
        const result = validateContactForm({
          name: ' ',
          email: 'invalid-email',
        });
        assert.equal(result.isValid, false);
        assert.equal(result.errors.name, 'Contact name is required.');
        assert.equal(result.errors.email, 'Please enter a valid email address.');
      });

      it('24. Handles missing or empty payload gracefully', () => {
        const result = validateContactForm();
        assert.equal(result.isValid, false);
        assert.equal(result.errors.name, 'Contact name is required.');
        assert.equal(result.errors.email, 'Contact email is required.');
      });
    });
  });
});
