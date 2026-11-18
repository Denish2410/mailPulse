import crypto from 'node:crypto';

/**
 * Authenticated encryption for OAuth tokens at rest (AES-256-GCM).
 *
 * Nothing in MailPulse may store or use a Google OAuth token unless it goes through this module.
 *
 * Envelope (a single ASCII string, safe to store in MongoDB):
 *
 *   mpt1.<keyId>.<iv>.<ciphertext>.<tag>
 *
 *   mpt1        format version; anything else is rejected (never treated as plaintext)
 *   keyId       which key encrypted it, so keys can be rotated without re-encrypting at once
 *   iv          12 random bytes, fresh for every encryption (base64url)
 *   ciphertext  AES-256-GCM output (base64url)
 *   tag         16-byte GCM authentication tag (base64url)
 *
 * Additional authenticated data (AAD) binds every envelope to its format version, its key ID and a
 * caller-supplied context (for example `sender-account:<id>:refresh-token`). A ciphertext copied to
 * another record, or relabelled with another key ID, fails authentication instead of decrypting.
 *
 * Keys come from configuration only (see getTokenEncryptionConfig); there is no built-in, default
 * or test key in this module. Errors never contain token values, key material or ciphertext.
 */

export const TOKEN_ENVELOPE_VERSION = 'mpt1';
export const TOKEN_KEY_BYTES = 32;
export const TOKEN_IV_BYTES = 12;
export const TOKEN_TAG_BYTES = 16;
/** Google tokens are a few hundred bytes; anything far larger is not a token. */
export const MAX_TOKEN_PLAINTEXT_BYTES = 8192;
export const MAX_CONTEXT_LENGTH = 200;

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ENVELOPE_LENGTH = 4 * Math.ceil((MAX_TOKEN_PLAINTEXT_BYTES + TOKEN_IV_BYTES + TOKEN_TAG_BYTES) / 3) + 100;

/**
 * Configuration problem: missing, malformed or unsafe keys. Message is safe to log.
 */
export class TokenEncryptionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenEncryptionConfigError';
    this.code = 'TOKEN_ENCRYPTION_CONFIG';
  }
}

/**
 * Encryption or decryption refused (invalid input, unknown key, failed authentication). The message
 * is generic and safe to log; `code` says which kind.
 */
export class TokenEncryptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TokenEncryptionError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new TokenEncryptionError(code, message);
};

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const validateContext = (context) => {
  if (!isNonEmptyString(context) || context.length > MAX_CONTEXT_LENGTH || /[\u0000-\u001f\u007f]/.test(context)) {
    fail('TOKEN_INVALID_CONTEXT', 'A non-empty encryption context of at most 200 printable characters is required.');
  }
};

const buildAad = (keyId, context) => Buffer.from(`${TOKEN_ENVELOPE_VERSION}|${keyId}|${context}`, 'utf8');

/**
 * Decodes one base64 or base64url key to exactly 32 bytes and rejects obviously unsafe keys.
 *
 * @param {unknown} encoded
 * @returns {Buffer}
 * @throws {TokenEncryptionConfigError}
 */
export const decodeTokenKey = (encoded) => {
  if (typeof encoded !== 'string' || encoded.trim() === '') {
    throw new TokenEncryptionConfigError('Token encryption configuration error: an encryption key is empty.');
  }
  const text = encoded.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    throw new TokenEncryptionConfigError('Token encryption configuration error: encryption keys must be base64 encoded.');
  }
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== TOKEN_KEY_BYTES) {
    throw new TokenEncryptionConfigError(
      `Token encryption configuration error: each encryption key must decode to exactly ${TOKEN_KEY_BYTES} bytes.`
    );
  }
  // Placeholder keys (all bytes equal, such as 32 zero bytes) are never acceptable
  if (key.every((byte) => byte === key[0])) {
    throw new TokenEncryptionConfigError('Token encryption configuration error: an encryption key is not random.');
  }
  return key;
};

/**
 * Builds a cipher from explicit key material. Used by the configuration loader and by tests, which
 * pass disposable random keys; there is no other way to obtain a cipher.
 *
 * @param {object} options
 * @param {Record<string, Buffer>|Map<string, Buffer>} options.keys - Key ID -> 32-byte key
 * @param {string} options.activeKeyId - Key used for new encryptions; must be in `keys`
 * @returns {{
 *   activeKeyId: string,
 *   keyIds: string[],
 *   encrypt: (plaintext: string, options: { context: string }) => string,
 *   decrypt: (envelope: string, options: { context: string }) => string,
 *   needsReencryption: (envelope: string) => boolean,
 * }}
 * @throws {TokenEncryptionConfigError}
 */
export const createTokenCipher = ({ keys, activeKeyId } = {}) => {
  const entries = keys instanceof Map ? [...keys.entries()] : Object.entries(keys || {});
  if (entries.length === 0) {
    throw new TokenEncryptionConfigError('Token encryption configuration error: at least one encryption key is required.');
  }
  const keyring = new Map();
  for (const [keyId, key] of entries) {
    if (!KEY_ID_PATTERN.test(String(keyId))) {
      throw new TokenEncryptionConfigError(
        'Token encryption configuration error: key IDs must be 1-32 characters of letters, digits, "-" or "_".'
      );
    }
    if (!Buffer.isBuffer(key) || key.length !== TOKEN_KEY_BYTES) {
      throw new TokenEncryptionConfigError(
        `Token encryption configuration error: each encryption key must be exactly ${TOKEN_KEY_BYTES} bytes.`
      );
    }
    if (key.every((byte) => byte === key[0])) {
      throw new TokenEncryptionConfigError('Token encryption configuration error: an encryption key is not random.');
    }
    keyring.set(String(keyId), Buffer.from(key)); // private copy
  }
  const distinct = new Set([...keyring.values()].map((key) => key.toString('hex')));
  if (distinct.size !== keyring.size) {
    throw new TokenEncryptionConfigError('Token encryption configuration error: two key IDs share the same key.');
  }
  if (!keyring.has(String(activeKeyId))) {
    throw new TokenEncryptionConfigError(
      'Token encryption configuration error: the active key ID must be one of the configured keys.'
    );
  }
  const active = String(activeKeyId);

  const encrypt = (plaintext, { context } = {}) => {
    if (!isNonEmptyString(plaintext)) {
      fail('TOKEN_INVALID_PLAINTEXT', 'Only a non-empty string can be encrypted.');
    }
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_TOKEN_PLAINTEXT_BYTES) {
      fail('TOKEN_INVALID_PLAINTEXT', 'The value is too large to be a token.');
    }
    validateContext(context);
    const iv = crypto.randomBytes(TOKEN_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyring.get(active), iv, { authTagLength: TOKEN_TAG_BYTES });
    cipher.setAAD(buildAad(active, context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [TOKEN_ENVELOPE_VERSION, active, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
  };

  /** Strictly parses an envelope; never returns anything for input that is not one. */
  const parse = (envelope) => {
    if (typeof envelope !== 'string' || envelope.length === 0 || envelope.length > MAX_ENVELOPE_LENGTH) {
      fail('TOKEN_INVALID_CIPHERTEXT', 'The stored token is not a valid encrypted value.');
    }
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== TOKEN_ENVELOPE_VERSION) {
      fail('TOKEN_INVALID_CIPHERTEXT', 'The stored token is not a valid encrypted value.');
    }
    const [, keyId, ivText, ciphertextText, tagText] = parts;
    if (!KEY_ID_PATTERN.test(keyId) || ![ivText, ciphertextText, tagText].every((part) => BASE64URL_PATTERN.test(part))) {
      fail('TOKEN_INVALID_CIPHERTEXT', 'The stored token is not a valid encrypted value.');
    }
    const iv = Buffer.from(ivText, 'base64url');
    const ciphertext = Buffer.from(ciphertextText, 'base64url');
    const tag = Buffer.from(tagText, 'base64url');
    // Canonical encoding only: re-encoding must give back exactly what was stored
    if (
      iv.length !== TOKEN_IV_BYTES ||
      tag.length !== TOKEN_TAG_BYTES ||
      ciphertext.length === 0 ||
      iv.toString('base64url') !== ivText ||
      ciphertext.toString('base64url') !== ciphertextText ||
      tag.toString('base64url') !== tagText
    ) {
      fail('TOKEN_INVALID_CIPHERTEXT', 'The stored token is not a valid encrypted value.');
    }
    return { keyId, iv, ciphertext, tag };
  };

  const decrypt = (envelope, { context } = {}) => {
    validateContext(context);
    const { keyId, iv, ciphertext, tag } = parse(envelope);
    const key = keyring.get(keyId);
    if (!key) {
      fail('TOKEN_UNKNOWN_KEY', 'The stored token was encrypted with a key that is not configured.');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TOKEN_TAG_BYTES });
      decipher.setAAD(buildAad(keyId, context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong context, or any tampering: one generic answer, nothing echoed
      return fail('TOKEN_DECRYPT_FAILED', 'The stored token could not be authenticated.');
    }
  };

  /** True when the envelope is valid but was encrypted with a key other than the active one. */
  const needsReencryption = (envelope) => parse(envelope).keyId !== active;

  return Object.freeze({
    activeKeyId: active,
    keyIds: Object.freeze([...keyring.keys()]),
    encrypt,
    decrypt,
    needsReencryption,
  });
};

/**
 * Reads token encryption configuration from the environment.
 *
 *   TOKEN_ENCRYPTION_KEYS           comma-separated `keyId:base64Key` pairs, each key 32 random bytes
 *   TOKEN_ENCRYPTION_ACTIVE_KEY_ID  key ID used for new encryptions (optional when only one key)
 *
 * Returns null when neither variable is set: token encryption is simply not enabled, so nothing that
 * needs it (Google OAuth) can work, and nothing else is affected. Anything set but invalid throws,
 * so a typo never quietly disables encryption.
 *
 * @param {object} [env=process.env]
 * @returns {{ keys: Map<string, Buffer>, activeKeyId: string } | null}
 * @throws {TokenEncryptionConfigError}
 */
export const getTokenEncryptionConfig = (env = process.env) => {
  const rawKeys = typeof env.TOKEN_ENCRYPTION_KEYS === 'string' ? env.TOKEN_ENCRYPTION_KEYS.trim() : '';
  const rawActive = typeof env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID === 'string' ? env.TOKEN_ENCRYPTION_ACTIVE_KEY_ID.trim() : '';
  if (rawKeys === '' && rawActive === '') {
    return null;
  }
  if (rawKeys === '') {
    throw new TokenEncryptionConfigError(
      'Token encryption configuration error: TOKEN_ENCRYPTION_ACTIVE_KEY_ID is set but TOKEN_ENCRYPTION_KEYS is not.'
    );
  }
  const keys = new Map();
  for (const entry of rawKeys.split(',')) {
    const item = entry.trim();
    const separator = item.indexOf(':');
    if (separator <= 0) {
      throw new TokenEncryptionConfigError(
        'Token encryption configuration error: TOKEN_ENCRYPTION_KEYS entries must look like keyId:base64Key.'
      );
    }
    const keyId = item.slice(0, separator).trim();
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new TokenEncryptionConfigError(
        'Token encryption configuration error: key IDs must be 1-32 characters of letters, digits, "-" or "_".'
      );
    }
    if (keys.has(keyId)) {
      throw new TokenEncryptionConfigError('Token encryption configuration error: a key ID is listed twice.');
    }
    keys.set(keyId, decodeTokenKey(item.slice(separator + 1)));
  }
  let activeKeyId = rawActive;
  if (activeKeyId === '') {
    if (keys.size !== 1) {
      throw new TokenEncryptionConfigError(
        'Token encryption configuration error: TOKEN_ENCRYPTION_ACTIVE_KEY_ID is required when several keys are configured.'
      );
    }
    [activeKeyId] = keys.keys();
  }
  // Validates the whole keyring (active key present, no duplicate keys)
  createTokenCipher({ keys, activeKeyId });
  return { keys, activeKeyId };
};

/**
 * Whether anything that requires token encryption is enabled. Google OAuth configuration (added in a
 * later milestone) will make it required; until then nothing in MailPulse needs it.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export const isTokenEncryptionRequired = (env = process.env) =>
  ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI'].some(
    (name) => typeof env[name] === 'string' && env[name].trim() !== ''
  );

/**
 * Startup check for the API and the worker. Invalid configuration always stops startup. Missing
 * configuration stops startup only when something that needs it is enabled; otherwise MailPulse
 * runs as before with token encryption (and therefore Google OAuth) unavailable.
 *
 * @param {object} [env=process.env]
 * @returns {{ enabled: boolean }}
 * @throws {TokenEncryptionConfigError}
 */
export const validateTokenEncryptionConfig = (env = process.env) => {
  const config = getTokenEncryptionConfig(env);
  if (!config && isTokenEncryptionRequired(env)) {
    throw new TokenEncryptionConfigError(
      'Token encryption configuration error: Google OAuth is configured but TOKEN_ENCRYPTION_KEYS is not. OAuth tokens are never stored unencrypted.'
    );
  }
  return { enabled: Boolean(config) };
};

let defaultCipher = null;

/**
 * The process-wide cipher, built from the environment on first use. Throws (fail closed) when token
 * encryption is not configured or the configuration is invalid; there is no plaintext mode.
 *
 * @param {object} [env=process.env]
 * @returns {ReturnType<typeof createTokenCipher>}
 * @throws {TokenEncryptionConfigError}
 */
export const getTokenCipher = (env = process.env) => {
  if (defaultCipher) return defaultCipher;
  const config = getTokenEncryptionConfig(env);
  if (!config) {
    throw new TokenEncryptionConfigError(
      'Token encryption is not configured: set TOKEN_ENCRYPTION_KEYS. OAuth tokens cannot be stored or used without it.'
    );
  }
  defaultCipher = createTokenCipher(config);
  return defaultCipher;
};

/** Forgets the cached process-wide cipher (tests, and after configuration changes). */
export const resetTokenCipher = () => {
  defaultCipher = null;
};

/**
 * Encrypts a token with the process-wide cipher. Fails closed when encryption is unavailable.
 *
 * @param {string} plaintext
 * @param {{ context: string }} options
 * @returns {string}
 */
export const encryptToken = (plaintext, options) => getTokenCipher().encrypt(plaintext, options);

/**
 * Decrypts a token with the process-wide cipher. Fails closed when encryption is unavailable or the
 * value does not authenticate; never returns its input unchanged.
 *
 * @param {string} envelope
 * @param {{ context: string }} options
 * @returns {string}
 */
export const decryptToken = (envelope, options) => getTokenCipher().decrypt(envelope, options);

export default {
  createTokenCipher,
  decodeTokenKey,
  getTokenEncryptionConfig,
  isTokenEncryptionRequired,
  validateTokenEncryptionConfig,
  getTokenCipher,
  resetTokenCipher,
  encryptToken,
  decryptToken,
};
