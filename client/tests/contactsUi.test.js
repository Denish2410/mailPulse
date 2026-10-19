import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatContactDate,
  normalizeEmailDomain,
  computePageAfterDeletion,
} from '../src/utils/contactHelpers.js';
import {
  validateContactName,
  validateContactEmail,
  validateContactForm,
} from '../src/utils/validation.js';
import {
  getContacts,
  createContact,
  updateContact,
  deleteContact,
  getErrorMessage,
} from '../src/api/contacts.js';
import { apiClient } from '../src/lib/api.js';

describe('Contacts Management UI Logic & Helpers', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('formatContactDate', () => {
    it('1. Formats valid ISO date string into locale date', () => {
      const formatted = formatContactDate('2026-10-18T10:00:00.000Z');
      assert.equal(formatted, 'Oct 18, 2026');
    });

    it('2. Returns "—" fallback for null, undefined, or empty date values', () => {
      assert.equal(formatContactDate(null), '—');
      assert.equal(formatContactDate(undefined), '—');
      assert.equal(formatContactDate(''), '—');
    });

    it('3. Returns "—" fallback for unparseable invalid dates', () => {
      assert.equal(formatContactDate('invalid-date-string'), '—');
      assert.equal(formatContactDate('not a date'), '—');
    });
  });

  describe('normalizeEmailDomain', () => {
    it('4. Trims whitespace and normalizes domain to lowercase', () => {
      assert.equal(normalizeEmailDomain('  EXAMPLE.COM  '), 'example.com');
      assert.equal(normalizeEmailDomain('GMAIL.com'), 'gmail.com');
    });

    it('5. Strips accidental leading "@" characters', () => {
      assert.equal(normalizeEmailDomain('@company.org'), 'company.org');
      assert.equal(normalizeEmailDomain('  @sub.domain.co  '), 'sub.domain.co');
    });

    it('6. Handles empty, non-string, or null inputs safely', () => {
      assert.equal(normalizeEmailDomain(''), '');
      assert.equal(normalizeEmailDomain('   '), '');
      assert.equal(normalizeEmailDomain(null), '');
      assert.equal(normalizeEmailDomain(undefined), '');
    });
  });

  describe('computePageAfterDeletion', () => {
    it('7. Decrements page from N to N-1 when deleting the sole contact on page N (N > 1)', () => {
      // 21 items total, limit 20 -> page 1 had 20, page 2 had 1.
      // Deleting 1 item leaves 20 total -> only 1 page remains.
      const newPage = computePageAfterDeletion({
        currentPage: 2,
        totalCount: 21,
        limit: 20,
      });
      assert.equal(newPage, 1);
    });

    it('8. Keeps current page when other contacts remain on the current page', () => {
      // 25 items total, limit 20 -> page 2 has 5 items.
      // Deleting 1 item leaves 24 total -> page 2 still has 4 items.
      const newPage = computePageAfterDeletion({
        currentPage: 2,
        totalCount: 25,
        limit: 20,
      });
      assert.equal(newPage, 2);
    });

    it('9. Never decrements below page 1 when deleting on page 1', () => {
      // 1 item total -> deleting leaves 0 total.
      const newPage = computePageAfterDeletion({
        currentPage: 1,
        totalCount: 1,
        limit: 20,
      });
      assert.equal(newPage, 1);
    });

    it('10. Clamps page to max available pages when total drops significantly', () => {
      const newPage = computePageAfterDeletion({
        currentPage: 5,
        totalCount: 20, // 20 items / limit 10 = 2 pages max
        limit: 10,
      });
      assert.equal(newPage, 2);
    });
  });

  describe('Contacts Form Validation & Error Mapping', () => {
    it('11. Rejects empty contact form and returns field errors', () => {
      const result = validateContactForm({ name: '', email: '' });
      assert.equal(result.isValid, false);
      assert.equal(result.errors.name, 'Contact name is required.');
      assert.equal(result.errors.email, 'Contact email is required.');
    });

    it('12. Rejects contact names with invalid lengths (<2 or >100)', () => {
      assert.equal(validateContactName('A'), 'Contact name must be at least 2 characters long.');
      assert.equal(validateContactName('A'.repeat(101)), 'Contact name cannot exceed 100 characters.');
    });

    it('13. Rejects email addresses exceeding 254 characters or with invalid syntax', () => {
      assert.equal(validateContactEmail('notanemail'), 'Please enter a valid email address.');
      const hugeEmail = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(65)}.com`;
      assert.ok(hugeEmail.length > 254);
      assert.equal(validateContactEmail(hugeEmail), 'Contact email cannot exceed 254 characters.');
    });

    it('14. Accepts valid contact form payloads', () => {
      const result = validateContactForm({
        name: 'Sarah Connor',
        email: 'sarah@resistance.org',
      });
      assert.equal(result.isValid, true);
      assert.deepEqual(result.errors, {});
    });
  });

  describe('Asynchronous CRUD Flow & Error Handling', () => {
    it('15. Fetches contacts forwarding search, domain, and AbortSignal', async () => {
      const controller = new AbortController();
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return {
          data: {
            success: true,
            data: {
              contacts: [{ id: '1', name: 'John Doe', email: 'john@gmail.com' }],
              count: 1,
              pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
            },
          },
        };
      });

      const result = await getContacts(
        { page: 1, limit: 10, search: 'John', emailDomain: 'gmail.com' },
        { signal: controller.signal }
      );

      assert.equal(capturedConfig.signal, controller.signal);
      assert.equal(capturedConfig.params.search, 'John');
      assert.equal(capturedConfig.params.emailDomain, 'gmail.com');
      assert.equal(result.contacts.length, 1);
    });

    it('16. Handles 409 duplicate email conflict gracefully and formats safe error', async () => {
      const conflictError = new Error('Conflict');
      conflictError.response = {
        status: 409,
        data: { message: 'A contact with this email already exists.' },
      };

      mock.method(apiClient, 'post', async () => {
        throw conflictError;
      });

      try {
        await createContact({ name: 'John Doe', email: 'duplicate@test.com' });
        assert.fail('Expected createContact to throw on 409');
      } catch (err) {
        assert.equal(err.response?.status, 409);
        assert.equal(getErrorMessage(err), 'A contact with this email already exists.');
      }
    });

    it('17. Handles successful updateContact flow', async () => {
      const updatedContact = {
        id: 'contact-1',
        name: 'Updated Name',
        email: 'updated@test.com',
      };

      mock.method(apiClient, 'patch', async (url, body) => {
        assert.equal(url, '/contacts/contact-1');
        assert.deepEqual(body, { name: 'Updated Name', email: 'updated@test.com' });
        return {
          data: {
            success: true,
            data: { contact: updatedContact },
          },
        };
      });

      const result = await updateContact('contact-1', {
        name: 'Updated Name',
        email: 'updated@test.com',
      });

      assert.deepEqual(result, updatedContact);
    });

    it('18. Handles successful deleteContact flow', async () => {
      mock.method(apiClient, 'delete', async (url) => {
        assert.equal(url, '/contacts/contact-123');
        return {
          data: {
            success: true,
            message: 'Contact deleted successfully',
          },
        };
      });

      const result = await deleteContact('contact-123');
      assert.equal(result.success, true);
    });
  });
});
