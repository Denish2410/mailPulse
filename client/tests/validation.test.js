import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateName,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
  validateRegisterForm,
  validateLoginForm,
} from '../src/utils/validation.js';

describe('Frontend Validation Utilities', () => {
  describe('validateName', () => {
    it('1. Rejects missing or empty name', () => {
      assert.equal(validateName(''), 'Name is required.');
      assert.equal(validateName('   '), 'Name is required.');
      assert.equal(validateName(null), 'Name is required.');
      assert.equal(validateName(undefined), 'Name is required.');
    });

    it('2. Rejects names shorter than 2 characters', () => {
      assert.equal(validateName('A'), 'Name must be at least 2 characters long.');
      assert.equal(validateName(' J '), 'Name must be at least 2 characters long.');
    });

    it('3. Rejects names longer than 100 characters', () => {
      const longName = 'A'.repeat(101);
      assert.equal(validateName(longName), 'Name cannot exceed 100 characters.');
    });

    it('4. Accepts valid names between 2 and 100 characters', () => {
      assert.equal(validateName('Jane Developer'), null);
      assert.equal(validateName('Jo'), null);
      assert.equal(validateName('A'.repeat(100)), null);
    });
  });

  describe('validateEmail', () => {
    it('5. Rejects missing or empty email', () => {
      assert.equal(validateEmail(''), 'Email address is required.');
      assert.equal(validateEmail('   '), 'Email address is required.');
      assert.equal(validateEmail(null), 'Email address is required.');
    });

    it('6. Rejects malformed email addresses', () => {
      const invalidEmails = [
        'plainaddress',
        '@missingusername.com',
        'username@.com',
        'username@domain',
        'user@domain..com',
        'user space@domain.com',
      ];
      for (const email of invalidEmails) {
        assert.equal(
          validateEmail(email),
          'Please enter a valid email address.',
          `Failed for email: ${email}`
        );
      }
    });

    it('7. Accepts valid standard email addresses', () => {
      assert.equal(validateEmail('user@example.com'), null);
      assert.equal(validateEmail('first.last@sub.domain.org'), null);
      assert.equal(validateEmail('user+tag@domain.co.uk'), null);
    });
  });

  describe('validatePassword', () => {
    it('8. Rejects missing or empty password', () => {
      assert.equal(validatePassword(''), 'Password is required.');
      assert.equal(validatePassword(null), 'Password is required.');
    });

    it('9. Rejects passwords shorter than 8 characters', () => {
      assert.equal(validatePassword('1234567'), 'Password must be at least 8 characters long.');
      assert.equal(validatePassword('short'), 'Password must be at least 8 characters long.');
    });

    it('10. Rejects oversized passwords exceeding 128 characters to prevent DoS', () => {
      const longPassword = 'P'.repeat(129);
      assert.equal(validatePassword(longPassword), 'Password cannot exceed 128 characters.');
    });

    it('11. Accepts valid passwords between 8 and 128 characters', () => {
      assert.equal(validatePassword('ValidPass123!'), null);
      assert.equal(validatePassword('12345678'), null);
      assert.equal(validatePassword('P'.repeat(128)), null);
    });
  });

  describe('validateConfirmPassword', () => {
    it('12. Rejects empty confirmation password', () => {
      assert.equal(
        validateConfirmPassword('Secret123!', ''),
        'Please confirm your password.'
      );
      assert.equal(
        validateConfirmPassword('Secret123!', null),
        'Please confirm your password.'
      );
    });

    it('13. Rejects mismatched confirmation password', () => {
      assert.equal(
        validateConfirmPassword('Secret123!', 'DifferentPass456!'),
        'Passwords do not match.'
      );
    });

    it('14. Accepts matching passwords', () => {
      assert.equal(
        validateConfirmPassword('Secret123!', 'Secret123!'),
        null
      );
    });
  });

  describe('validateRegisterForm', () => {
    it('15. Validates a complete correct registration payload', () => {
      const result = validateRegisterForm({
        name: 'Jane Developer',
        email: 'jane@example.com',
        password: 'SecurePassword123!',
        confirmPassword: 'SecurePassword123!',
      });

      assert.equal(result.isValid, true);
      assert.deepEqual(result.errors, {});
    });

    it('16. Aggregates all invalid field errors across the registration form', () => {
      const result = validateRegisterForm({
        name: '',
        email: 'bad-email',
        password: 'short',
        confirmPassword: 'mismatch',
      });

      assert.equal(result.isValid, false);
      assert.ok(result.errors.name);
      assert.ok(result.errors.email);
      assert.ok(result.errors.password);
      assert.ok(result.errors.confirmPassword);
    });

    it('17. Guarantees that raw passwords are never leaked in error messages', () => {
      const rawPassword = 'MySecretRawPassword123!';
      const result = validateRegisterForm({
        name: 'Jane',
        email: 'jane@example.com',
        password: rawPassword,
        confirmPassword: 'DifferentPassword999!',
      });

      const serialized = JSON.stringify(result.errors);
      assert.equal(serialized.includes(rawPassword), false);
    });
  });

  describe('validateLoginForm', () => {
    it('18. Validates a correct login payload', () => {
      const result = validateLoginForm({
        email: 'user@example.com',
        password: 'ValidPassword123!',
      });

      assert.equal(result.isValid, true);
      assert.deepEqual(result.errors, {});
    });

    it('19. Rejects missing credentials in login payload', () => {
      const result = validateLoginForm({
        email: '',
        password: '',
      });

      assert.equal(result.isValid, false);
      assert.ok(result.errors.email);
      assert.ok(result.errors.password);
    });
  });
});
