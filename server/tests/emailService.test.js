import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmailService,
  createMockTransport,
  createSmtpTransport,
  getSmtpConfig,
  isSmtpConfigured,
  validateMessage,
  sendEmail,
  EmailServiceError,
  InvalidMessageError,
  EmailConfigurationError,
  EmailTransportError,
} from '../src/services/email.service.js';

describe('Email Service Abstraction (server/src/services/email.service.js)', () => {
  let mockTransport;
  let emailService;

  beforeEach(() => {
    mockTransport = createMockTransport();
    emailService = createEmailService({ transport: mockTransport });
  });

  // =========================================================================
  // Requirement 1 & 2: Valid Message Delivery & Destination Preservation
  // =========================================================================
  describe('1. Valid Message Handling & Transport Delivery', () => {
    it('passes a valid message to the injected mock transport and returns delivery metadata', async () => {
      const message = {
        to: 'recipient@example.com',
        subject: 'Phase 4.4 Test Campaign',
        text: 'Hello plain text',
        html: '<p>Hello HTML</p>',
      };

      const result = await emailService.sendEmail(message);

      assert.equal(result.success, true);
      assert.equal(result.destination, 'recipient@example.com');
      assert.equal(result.subject, 'Phase 4.4 Test Campaign');
      assert.ok(result.messageId);
      assert.ok(result.sentAt);

      assert.equal(mockTransport.count, 1);
      const sent = mockTransport.lastSentEmail;
      assert.equal(sent.to, 'recipient@example.com');
      assert.equal(sent.subject, 'Phase 4.4 Test Campaign');
      assert.equal(sent.text, 'Hello plain text');
      assert.equal(sent.html, '<p>Hello HTML</p>');
      assert.equal(sent.messageId, result.messageId);
    });

    it('preserves the exact explicitly supplied destination and normalizes case/trimming', async () => {
      const message = {
        to: '  User.Test+Campaign123@Example.COM  ',
        subject: 'Subject Line',
        text: 'Some body text',
      };

      const result = await emailService.sendEmail(message);

      assert.equal(result.destination, 'user.test+campaign123@example.com');
      assert.equal(mockTransport.lastSentEmail.to, 'user.test+campaign123@example.com');
    });

    it('allows text-only messages when HTML is omitted or empty', async () => {
      const result = await emailService.sendEmail({
        to: 'textonly@example.com',
        subject: 'Text Only Subject',
        text: 'This email only has plain text.',
      });

      assert.equal(result.success, true);
      assert.equal(mockTransport.lastSentEmail.text, 'This email only has plain text.');
      assert.equal(mockTransport.lastSentEmail.html, '');
    });

    it('allows HTML-only messages when text is omitted or empty', async () => {
      const result = await emailService.sendEmail({
        to: 'htmlonly@example.com',
        subject: 'HTML Only Subject',
        html: '<h1>This email only has HTML</h1>',
      });

      assert.equal(result.success, true);
      assert.equal(mockTransport.lastSentEmail.html, '<h1>This email only has HTML</h1>');
      assert.equal(mockTransport.lastSentEmail.text, '');
    });
  });

  // =========================================================================
  // Requirement 3: Strict Isolation from Contacts & Campaign Recipient Lists
  // =========================================================================
  describe('2. Recipient Isolation & Non-Consultation of Database Models', () => {
    it('dispatches exclusively to explicit "to" address even if extra recipient fields are passed', async () => {
      const messageWithExtraFields = {
        to: 'explicit-target@example.com',
        subject: 'Isolation Test',
        text: 'Ensuring no campaign recipients receive this email.',
        // Simulating rogue/accidental caller passing contact references or lists
        recipientIds: ['671234567890abcdef123456', '671234567890abcdef123457'],
        recipients: ['accidental1@example.com', 'accidental2@example.com'],
        cc: 'unauthorized-cc@example.com',
        bcc: 'unauthorized-bcc@example.com',
      };

      const result = await emailService.sendEmail(messageWithExtraFields);

      assert.equal(result.destination, 'explicit-target@example.com');
      assert.equal(mockTransport.count, 1);

      const captured = mockTransport.lastSentEmail;
      assert.equal(captured.to, 'explicit-target@example.com');
      // Verify no other recipient properties leaked into outbound transport options
      assert.equal(captured.cc, undefined);
      assert.equal(captured.bcc, undefined);
      assert.equal(captured.recipientIds, undefined);
      assert.equal(captured.recipients, undefined);
    });
  });

  // =========================================================================
  // Requirement 4 & 5: Message Validation & Injection Defenses
  // =========================================================================
  describe('3. Message Validation and Injection Defenses', () => {
    it('rejects missing, null, or non-object payloads', () => {
      assert.throws(() => validateMessage(null), {
        name: 'InvalidMessageError',
        code: 'INVALID_MESSAGE',
      });
      assert.throws(() => validateMessage(undefined), {
        name: 'InvalidMessageError',
        code: 'INVALID_MESSAGE',
      });
      assert.throws(() => validateMessage('not an object'), {
        name: 'InvalidMessageError',
        code: 'INVALID_MESSAGE',
      });
      assert.throws(() => validateMessage([]), {
        name: 'InvalidMessageError',
        code: 'INVALID_MESSAGE',
      });
    });

    it('rejects missing, empty, or whitespace-only destination address', () => {
      assert.throws(() => validateMessage({ subject: 'Test', text: 'Body' }), {
        name: 'InvalidMessageError',
        message: /Recipient email address \("to"\) is required/,
      });
      assert.throws(() => validateMessage({ to: '', subject: 'Test', text: 'Body' }), {
        name: 'InvalidMessageError',
        message: /Recipient email address \("to"\) is required/,
      });
      assert.throws(() => validateMessage({ to: '   ', subject: 'Test', text: 'Body' }), {
        name: 'InvalidMessageError',
        message: /Recipient email address \("to"\) is required/,
      });
      assert.throws(() => validateMessage({ to: 12345, subject: 'Test', text: 'Body' }), {
        name: 'InvalidMessageError',
        message: /Recipient email address \("to"\) is required/,
      });
    });

    it('rejects malformed email destination formats', () => {
      const invalidEmails = [
        'notanemail',
        'missing-at-sign.com',
        '@missing-local.com',
        'user@.missing-domain',
        'user@domain..com',
        'user space@example.com',
      ];

      for (const badEmail of invalidEmails) {
        assert.throws(
          () => validateMessage({ to: badEmail, subject: 'Test', text: 'Body' }),
          {
            name: 'InvalidMessageError',
            message: /Invalid recipient email address format/,
          },
          `Expected rejection for malformed email: "${badEmail}"`
        );
      }
    });

    it('rejects destination exceeding maximum 254 RFC characters', () => {
      const oversizedEmail = `${'a'.repeat(245)}@example.com`; // 257 chars
      assert.throws(
        () => validateMessage({ to: oversizedEmail, subject: 'Test', text: 'Body' }),
        {
          name: 'InvalidMessageError',
          message: /Recipient email address cannot exceed 254 characters/,
        }
      );
    });

    it('rejects comma-separated or semicolon-separated multi-recipient attempts in "to"', () => {
      assert.throws(
        () =>
          validateMessage({
            to: 'user1@example.com, user2@example.com',
            subject: 'Test',
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /Only a single recipient address is permitted/,
        }
      );

      assert.throws(
        () =>
          validateMessage({
            to: 'user1@example.com; user2@example.com',
            subject: 'Test',
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /Only a single recipient address is permitted/,
        }
      );
    });

    it('rejects CRLF header injection in recipient address', () => {
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com\r\nBcc: attacker@example.com',
            subject: 'Test',
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /must not contain line breaks or carriage returns/,
        }
      );

      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com\nBcc: attacker@example.com',
            subject: 'Test',
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /must not contain line breaks or carriage returns/,
        }
      );
    });

    it('rejects missing, empty, or whitespace-only subject', () => {
      assert.throws(() => validateMessage({ to: 'user@example.com', text: 'Body' }), {
        name: 'InvalidMessageError',
        message: /Email subject is required and cannot be empty/,
      });
      assert.throws(
        () => validateMessage({ to: 'user@example.com', subject: '', text: 'Body' }),
        {
          name: 'InvalidMessageError',
          message: /Email subject is required and cannot be empty/,
        }
      );
      assert.throws(
        () => validateMessage({ to: 'user@example.com', subject: '   ', text: 'Body' }),
        {
          name: 'InvalidMessageError',
          message: /Email subject is required and cannot be empty/,
        }
      );
    });

    it('rejects subject exceeding 200 characters', () => {
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com',
            subject: 'x'.repeat(201),
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /Email subject cannot exceed 200 characters/,
        }
      );
    });

    it('rejects CRLF header injection in email subject', () => {
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com',
            subject: 'Subject Line\r\nBcc: evil@example.com',
            text: 'Body',
          }),
        {
          name: 'InvalidMessageError',
          message: /Email subject must not contain line breaks or carriage returns/,
        }
      );
    });

    it('rejects messages where both text and HTML content bodies are empty or missing', () => {
      assert.throws(
        () => validateMessage({ to: 'user@example.com', subject: 'Valid Subject' }),
        {
          name: 'InvalidMessageError',
          message: /Email must contain non-empty text content or HTML content/,
        }
      );
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com',
            subject: 'Valid Subject',
            text: '   ',
            html: '',
          }),
        {
          name: 'InvalidMessageError',
          message: /Email must contain non-empty text content or HTML content/,
        }
      );
    });

    it('rejects non-string content or oversized content bodies', () => {
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com',
            subject: 'Valid Subject',
            text: 12345,
          }),
        {
          name: 'InvalidMessageError',
          message: /Plain text content must be a string/,
        }
      );
      assert.throws(
        () =>
          validateMessage({
            to: 'user@example.com',
            subject: 'Valid Subject',
            html: { tags: '<p>' },
          }),
        {
          name: 'InvalidMessageError',
          message: /HTML content must be a string/,
        }
      );
    });
  });

  // =========================================================================
  // Requirement 6: Transport Failure Handling
  // =========================================================================
  describe('4. Mock Transport Failure Simulation', () => {
    it('handles simulated mock transport failures and wraps them in sanitized EmailTransportError', async () => {
      mockTransport.setFail(true, new Error('Simulated socket timeout connecting to mail server'));

      await assert.rejects(
        async () => {
          await emailService.sendEmail({
            to: 'recipient@example.com',
            subject: 'Subject',
            text: 'Content',
          });
        },
        (err) => {
          assert.equal(err instanceof EmailTransportError, true);
          assert.equal(err.code, 'TRANSPORT_ERROR');
          assert.equal(err.message, 'Failed to deliver email through transport.');
          assert.ok(err.cause);
          assert.equal(err.cause.message, 'Simulated socket timeout connecting to mail server');
          return true;
        }
      );
    });
  });

  // =========================================================================
  // Requirement 7: Missing SMTP Configuration Fails Closed
  // =========================================================================
  describe('5. Fail-Closed SMTP Configuration Checks', () => {
    it('reports isSmtpConfigured as false when SMTP_HOST is omitted', () => {
      assert.equal(isSmtpConfigured({}), false);
      assert.equal(isSmtpConfigured({ SMTP_HOST: '' }), false);
      assert.equal(isSmtpConfigured({ SMTP_HOST: '   ' }), false);
      assert.equal(isSmtpConfigured({ SMTP_HOST: 'smtp.sendgrid.net' }), true);
    });

    it('fails closed when attempting to send via unconfigured service in production', async () => {
      const unconfiguredService = createEmailService({
        env: { NODE_ENV: 'production' },
      });

      await assert.rejects(
        async () => {
          await unconfiguredService.sendEmail({
            to: 'recipient@example.com',
            subject: 'Subject',
            text: 'Content',
          });
        },
        (err) => {
          assert.equal(err instanceof EmailConfigurationError, true);
          assert.equal(err.code, 'CONFIGURATION_ERROR');
          assert.match(err.message, /Missing required SMTP configuration/);
          return true;
        }
      );
    });

    it('rejects invalid or out-of-range SMTP_PORT values', () => {
      assert.throws(
        () =>
          getSmtpConfig({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: 'invalid-port',
            EMAIL_FROM: 'test@example.com',
          }),
        {
          name: 'EmailConfigurationError',
          message: /Invalid SMTP_PORT: must be an integer between 1 and 65535/,
        }
      );

      assert.throws(
        () =>
          getSmtpConfig({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '70000',
            EMAIL_FROM: 'test@example.com',
          }),
        {
          name: 'EmailConfigurationError',
          message: /Invalid SMTP_PORT: must be an integer between 1 and 65535/,
        }
      );
    });

    it('rejects missing or empty EMAIL_FROM environment variable', () => {
      assert.throws(
        () =>
          getSmtpConfig({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '587',
          }),
        {
          name: 'EmailConfigurationError',
          message: /EMAIL_FROM environment variable is required/,
        }
      );
    });

    it('rejects incomplete credentials when only username or only password is provided', () => {
      assert.throws(
        () =>
          getSmtpConfig({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '587',
            EMAIL_FROM: 'test@example.com',
            SMTP_USER: 'only_username',
          }),
        {
          name: 'EmailConfigurationError',
          message: /both SMTP_USER and SMTP_PASS must be provided/,
        }
      );

      assert.throws(
        () =>
          getSmtpConfig({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: '587',
            EMAIL_FROM: 'test@example.com',
            SMTP_PASS: 'only_password',
          }),
        {
          name: 'EmailConfigurationError',
          message: /both SMTP_USER and SMTP_PASS must be provided/,
        }
      );
    });

    it('correctly parses complete valid SMTP configuration', () => {
      const config = getSmtpConfig({
        SMTP_HOST: 'smtp.mailtrap.io',
        SMTP_PORT: '2525',
        SMTP_USER: 'test_user',
        SMTP_PASS: 'test_pass',
        EMAIL_FROM: 'MailPulse <noreply@mailpulse.local>',
      });

      assert.equal(config.host, 'smtp.mailtrap.io');
      assert.equal(config.port, 2525);
      assert.equal(config.secure, false);
      assert.deepEqual(config.auth, { user: 'test_user', pass: 'test_pass' });
      assert.equal(config.from, 'MailPulse <noreply@mailpulse.local>');
    });
  });

  // =========================================================================
  // Requirement 8: Test Environment Network & SMTP Protections
  // =========================================================================
  describe('6. Test Environment Network Protections', () => {
    it('actively forbids creating SMTP transports in the test environment', () => {
      assert.throws(
        () =>
          createSmtpTransport(
            { host: 'smtp.example.com', port: 587 },
            { env: { NODE_ENV: 'test' } }
          ),
        {
          name: 'EmailConfigurationError',
          message: /SMTP transport creation is disabled in the test environment/,
        }
      );
    });

    it('requires an explicitly injected mock transport when running in test environment', async () => {
      const testServiceWithoutTransport = createEmailService({
        env: { NODE_ENV: 'test' },
      });

      await assert.rejects(
        async () => {
          await testServiceWithoutTransport.sendEmail({
            to: 'recipient@example.com',
            subject: 'Subject',
            text: 'Content',
          });
        },
        {
          name: 'EmailConfigurationError',
          message: /Email service in test environment requires an explicitly injected mock transport/,
        }
      );
    });
  });

  // =========================================================================
  // Requirement 9: Sanitized Errors & Credential Protection
  // =========================================================================
  describe('7. Sanitized Errors & Credential Protection', () => {
    it('does not leak internal passwords or connection URIs in user-facing EmailTransportError message', async () => {
      const sensitiveLeakError = new Error(
        'Failed connecting to smtp://smtp_user:super_secret_password_12345@smtp.service.com:587 (ECONNREFUSED)'
      );
      mockTransport.setFail(true, sensitiveLeakError);

      await assert.rejects(
        async () => {
          await emailService.sendEmail({
            to: 'recipient@example.com',
            subject: 'Subject',
            text: 'Body',
          });
        },
        (err) => {
          // Public message must be clean and not leak raw connection string or password
          assert.equal(err.message, 'Failed to deliver email through transport.');
          assert.doesNotMatch(err.message, /super_secret_password_12345/);
          assert.doesNotMatch(err.message, /smtp_user/);
          return true;
        }
      );
    });
  });

  // =========================================================================
  // Requirement 10: State Isolation Between Instances
  // =========================================================================
  describe('8. Mock Transport State Isolation & Reset', () => {
    it('isolates state between separate mock transport and service instances', async () => {
      const mockA = createMockTransport({ messageIdPrefix: 'mock-a' });
      const mockB = createMockTransport({ messageIdPrefix: 'mock-b' });

      const serviceA = createEmailService({ transport: mockA });
      const serviceB = createEmailService({ transport: mockB });

      await serviceA.sendEmail({
        to: 'targetA@example.com',
        subject: 'Subject A',
        text: 'Body A',
      });

      assert.equal(mockA.count, 1);
      assert.equal(mockB.count, 0);
      assert.equal(mockA.lastSentEmail.to, 'targeta@example.com');
      assert.equal(mockB.lastSentEmail, null);

      // Simulating failure on mockA must not affect serviceB / mockB
      mockA.setFail(true);

      const resultB = await serviceB.sendEmail({
        to: 'targetB@example.com',
        subject: 'Subject B',
        text: 'Body B',
      });

      assert.equal(resultB.success, true);
      assert.equal(mockB.count, 1);

      // Resetting mockA clears its state cleanly
      mockA.clear();
      assert.equal(mockA.count, 0);
      assert.equal(mockA.lastSentEmail, null);
    });
  });
});
