import nodemailer from 'nodemailer';

/**
 * MailPulse Email Service Abstraction
 *
 * Implements a decoupled, fail-closed email service abstraction for Phase 4.4.
 *
 * Design Guarantees:
 * 1. Strict Recipient Isolation: Accepts only one explicitly provided destination address (`to`).
 *    Never consults Campaign, Contact, or database collections.
 * 2. Pluggable Transport Layer: Fully supports mock transports for deterministic, offline testing
 *    with zero network access, and opt-in Nodemailer SMTP transports for production/staging.
 * 3. Fail-Closed Security: SMTP is strictly opt-in. Missing configuration results in explicit
 *    sanitized errors; test environments are blocked from instantiating SMTP transports.
 * 4. Header Injection & Payload Protection: Validates recipient email, subject, text, and HTML bounds
 *    and forbids CRLF carriage return/line break characters in headers.
 * 5. Sanitized Error Hierarchy: Categorizes errors into InvalidMessageError, EmailConfigurationError,
 *    and EmailTransportError, preventing credential or provider leakages.
 */

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

/**
 * Base custom operational error class for email service operations.
 */
export class EmailServiceError extends Error {
  /**
   * @param {string} message - Sanitized user-facing error message
   * @param {'INVALID_MESSAGE'|'CONFIGURATION_ERROR'|'TRANSPORT_ERROR'} code - Distinct error code
   * @param {object} [options]
   * @param {Error} [options.cause] - Underlying error (safe for internal debug logging)
   * @param {boolean} [options.isOperational=true]
   */
  constructor(message, code, { cause, isOperational = true } = {}) {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
    this.isOperational = isOperational;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when outbound message parameters fail validation or contain unsafe header content.
 */
export class InvalidMessageError extends EmailServiceError {
  constructor(message, options = {}) {
    super(message, 'INVALID_MESSAGE', options);
    this.name = 'InvalidMessageError';
  }
}

/**
 * Thrown when required transport configuration (e.g. SMTP environment variables) is missing or invalid.
 */
export class EmailConfigurationError extends EmailServiceError {
  constructor(message, options = {}) {
    super(message, 'CONFIGURATION_ERROR', options);
    this.name = 'EmailConfigurationError';
  }
}

/**
 * Thrown when an underlying transport fails to deliver an email.
 */
export class EmailTransportError extends EmailServiceError {
  constructor(message = 'Failed to deliver email through transport.', options = {}) {
    super(message, 'TRANSPORT_ERROR', options);
    this.name = 'EmailTransportError';
  }
}

/**
 * Validates and normalizes outbound message parameters.
 *
 * @param {object} message
 * @param {string} message.to - Explicit single recipient address
 * @param {string} message.subject - Email subject
 * @param {string} [message.text] - Plain text content
 * @param {string} [message.html] - HTML formatted content
 * @returns {{ to: string, subject: string, text: string, html: string }}
 * @throws {InvalidMessageError}
 */
export const validateMessage = (message) => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new InvalidMessageError('Message payload must be an object.');
  }

  const { to, subject, text, html } = message;

  // 1. Destination Address Validation (Strict single recipient)
  if (typeof to !== 'string' || !to.trim()) {
    throw new InvalidMessageError('Recipient email address ("to") is required.');
  }

  const trimmedTo = to.trim();

  // Reject CRLF header injection
  if (/[\r\n]/.test(trimmedTo)) {
    throw new InvalidMessageError('Recipient email address must not contain line breaks or carriage returns.');
  }

  // Reject multi-recipient delimiter attempts
  if (trimmedTo.includes(',') || trimmedTo.includes(';')) {
    throw new InvalidMessageError('Only a single recipient address is permitted.');
  }

  // Max RFC 5321 length
  if (trimmedTo.length > 254) {
    throw new InvalidMessageError('Recipient email address cannot exceed 254 characters.');
  }

  const normalizedTo = trimmedTo.toLowerCase();
  if (!EMAIL_REGEX.test(normalizedTo)) {
    throw new InvalidMessageError('Invalid recipient email address format.');
  }

  // 2. Subject Line Validation
  if (typeof subject !== 'string' || !subject.trim()) {
    throw new InvalidMessageError('Email subject is required and cannot be empty.');
  }

  const trimmedSubject = subject.trim();

  // Reject CRLF header injection in subject
  if (/[\r\n]/.test(trimmedSubject)) {
    throw new InvalidMessageError('Email subject must not contain line breaks or carriage returns.');
  }

  if (trimmedSubject.length > 200) {
    throw new InvalidMessageError('Email subject cannot exceed 200 characters.');
  }

  // 3. Content Bodies Validation
  if (text !== undefined && typeof text !== 'string') {
    throw new InvalidMessageError('Plain text content must be a string if provided.');
  }
  if (html !== undefined && typeof html !== 'string') {
    throw new InvalidMessageError('HTML content must be a string if provided.');
  }

  const cleanText = typeof text === 'string' ? text : '';
  const cleanHtml = typeof html === 'string' ? html : '';

  if (cleanText.length > 100000) {
    throw new InvalidMessageError('Plain text content cannot exceed 100,000 characters.');
  }
  if (cleanHtml.length > 500000) {
    throw new InvalidMessageError('HTML content cannot exceed 500,000 characters.');
  }

  const hasText = cleanText.trim().length > 0;
  const hasHtml = cleanHtml.trim().length > 0;

  if (!hasText && !hasHtml) {
    throw new InvalidMessageError('Email must contain non-empty text content or HTML content.');
  }

  return {
    to: normalizedTo,
    subject: trimmedSubject,
    text: cleanText,
    html: cleanHtml,
  };
};

/**
 * Checks whether SMTP environment variables are configured.
 *
 * @param {object} [env=process.env]
 * @returns {boolean} True if SMTP_HOST is defined and non-empty
 */
export const isSmtpConfigured = (env = process.env) => {
  return Boolean(env.SMTP_HOST && typeof env.SMTP_HOST === 'string' && env.SMTP_HOST.trim().length > 0);
};

/**
 * Parses and validates SMTP configuration from environment variables.
 *
 * @param {object} [env=process.env]
 * @returns {{ host: string, port: number, secure: boolean, auth?: { user: string, pass: string }, from: string }}
 * @throws {EmailConfigurationError}
 */
export const getSmtpConfig = (env = process.env) => {
  if (!isSmtpConfigured(env)) {
    throw new EmailConfigurationError(
      'SMTP is not configured. Missing required SMTP_HOST environment variable.'
    );
  }

  const host = env.SMTP_HOST.trim();

  // Parse and validate port (defaults to 587 if not explicitly provided)
  const rawPort = env.SMTP_PORT !== undefined ? env.SMTP_PORT : 587;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EmailConfigurationError(
      `Invalid SMTP_PORT: must be an integer between 1 and 65535 (received: ${rawPort}).`
    );
  }

  // Validate EMAIL_FROM
  const rawFrom = env.EMAIL_FROM;
  if (!rawFrom || typeof rawFrom !== 'string' || !rawFrom.trim()) {
    throw new EmailConfigurationError(
      'EMAIL_FROM environment variable is required and must not be empty.'
    );
  }
  const from = rawFrom.trim();

  // Secure: true for 465 or if SMTP_SECURE is explicitly 'true'
  const secure = env.SMTP_SECURE === 'true' || port === 465;

  // Optional Authentication
  let auth;
  const user = env.SMTP_USER && typeof env.SMTP_USER === 'string' ? env.SMTP_USER.trim() : '';
  const pass = env.SMTP_PASS && typeof env.SMTP_PASS === 'string' ? env.SMTP_PASS : '';

  if (user && pass) {
    auth = { user, pass };
  } else if (user || pass) {
    throw new EmailConfigurationError(
      'Incomplete SMTP credentials: both SMTP_USER and SMTP_PASS must be provided if authentication is used.'
    );
  }

  return {
    host,
    port,
    secure,
    auth,
    from,
  };
};

/**
 * Creates a Nodemailer SMTP transport instance based on validated configuration.
 * Fails closed in test environments to guarantee zero accidental network dispatch.
 *
 * @param {object} config - Validated configuration from getSmtpConfig
 * @param {object} [options]
 * @param {object} [options.env=process.env]
 * @returns {import('nodemailer').Transporter}
 * @throws {EmailConfigurationError}
 */
export const createSmtpTransport = (config, { env = process.env } = {}) => {
  if (env.NODE_ENV === 'test') {
    throw new EmailConfigurationError(
      'SMTP transport creation is disabled in the test environment. Automated tests must use the mock transport.'
    );
  }

  if (!config || !config.host) {
    throw new EmailConfigurationError(
      'Cannot create SMTP transport: valid configuration with host is required.'
    );
  }

  const transportOptions = {
    host: config.host,
    port: config.port,
    secure: config.secure,
  };

  if (config.auth) {
    transportOptions.auth = {
      user: config.auth.user,
      pass: config.auth.pass,
    };
  }

  return nodemailer.createTransport(transportOptions);
};

/**
 * Factory providing an isolated, deterministic mock transport for automated tests.
 * Performs zero network I/O, captures dispatched messages for assertions, and supports
 * simulating transport failures and resetting state.
 *
 * @param {object} [options]
 * @param {boolean} [options.failNext=false] - If true, immediately fails sendMail calls
 * @param {string} [options.errorMessage] - Custom simulated error message
 * @param {string} [options.messageIdPrefix='mock'] - Prefix for generated message ID
 * @returns {object} Mock transport interface
 */
export const createMockTransport = (options = {}) => {
  let shouldFail = Boolean(options.failNext);
  let customError = options.errorMessage ? new Error(options.errorMessage) : null;
  const sentEmails = [];
  const messageIdPrefix = options.messageIdPrefix || 'mock';

  return {
    name: 'mock',
    get sentEmails() {
      return sentEmails.map((item) => ({ ...item }));
    },
    get lastSentEmail() {
      return sentEmails.length > 0 ? { ...sentEmails[sentEmails.length - 1] } : null;
    },
    get count() {
      return sentEmails.length;
    },
    setFail(fail = true, error = null) {
      shouldFail = Boolean(fail);
      customError = error || (fail ? new Error('Simulated mock transport failure') : null);
    },
    clear() {
      sentEmails.length = 0;
      shouldFail = false;
      customError = null;
    },
    async sendMail(mailOptions) {
      if (shouldFail) {
        throw customError || new Error('Simulated mock transport failure');
      }

      const messageId = `<${messageIdPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@mailpulse.test>`;
      const record = {
        to: mailOptions.to,
        from: mailOptions.from,
        subject: mailOptions.subject,
        text: mailOptions.text ?? '',
        html: mailOptions.html ?? '',
        messageId,
        sentAt: new Date().toISOString(),
      };

      sentEmails.push(record);

      return {
        messageId,
        accepted: [mailOptions.to],
        rejected: [],
        response: '250 OK (Mock Transport)',
      };
    },
  };
};

/**
 * Factory creating an EmailService instance with dependency-injected transport and configuration.
 *
 * @param {object} [options]
 * @param {object} [options.transport] - Custom transport (e.g. from createMockTransport())
 * @param {string} [options.from] - Sender address override
 * @param {object} [options.env=process.env] - Environment dictionary for config resolution
 * @returns {{ getTransport: () => object|null, sendEmail: (message: object) => Promise<object> }}
 */
export const createEmailService = ({ transport, from, env = process.env } = {}) => {
  let activeTransport = transport || null;

  return {
    getTransport() {
      return activeTransport;
    },
    async sendEmail(message = {}) {
      // 1. Validate message parameters strictly
      const validated = validateMessage(message);

      // 2. Resolve transport if not injected
      if (!activeTransport) {
        // Enforce fail-closed policy in test environment
        if (env.NODE_ENV === 'test') {
          throw new EmailConfigurationError(
            'Email service in test environment requires an explicitly injected mock transport.'
          );
        }

        // Opt-in SMTP check
        if (!isSmtpConfigured(env)) {
          throw new EmailConfigurationError(
            'Email transport is not configured. Missing required SMTP configuration.'
          );
        }

        const smtpConfig = getSmtpConfig(env);
        activeTransport = createSmtpTransport(smtpConfig, { env });
      }

      // 3. Resolve sender address
      const senderFrom = from || env.EMAIL_FROM || 'MailPulse <no-reply@mailpulse.local>';

      // 4. Assemble mail options strictly using the explicit destination
      const mailOptions = {
        to: validated.to,
        from: senderFrom,
        subject: validated.subject,
        text: validated.text,
        html: validated.html,
      };

      // 5. Send via transport with sanitized error handling
      try {
        const result = await activeTransport.sendMail(mailOptions);
        return {
          success: true,
          destination: validated.to,
          subject: validated.subject,
          messageId: result.messageId || `<${Date.now()}@mailpulse.local>`,
          sentAt: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof EmailServiceError) {
          throw error;
        }

        // Catch underlying transport failure and wrap in sanitized EmailTransportError
        // Never expose raw socket errors, passwords, or credentials
        throw new EmailTransportError('Failed to deliver email through transport.', {
          cause: error,
        });
      }
    },
  };
};

/**
 * Top-level convenience helper to send an email using an ephemeral or configured service.
 *
 * @param {object} message
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export const sendEmail = async (message, options = {}) => {
  const service = createEmailService(options);
  return await service.sendEmail(message);
};

export default {
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
};
