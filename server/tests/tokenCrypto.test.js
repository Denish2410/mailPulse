/**
 * OAuth token encryption at rest (src/utils/tokenCrypto.js). No database and no network.
 *
 * Every key in this file is generated at run time with crypto.randomBytes: disposable, test-only,
 * never written anywhere. The token strings are made-up stand-ins, not real Google tokens.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOKEN_ENVELOPE_VERSION,
  MAX_TOKEN_PLAINTEXT_BYTES,
  TokenEncryptionConfigError,
  TokenEncryptionError,
  createTokenCipher,
  decodeTokenKey,
  getTokenEncryptionConfig,
  isTokenEncryptionRequired,
  validateTokenEncryptionConfig,
  getTokenCipher,
  resetTokenCipher,
  encryptToken,
  decryptToken,
} from '../src/utils/tokenCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

/** A disposable random 32-byte key. */
const newKey = () => crypto.randomBytes(32);
/** A made-up value shaped like a Google refresh token (never a real one). */
const fakeToken = () => `1//test-only-${crypto.randomBytes(24).toString('base64url')}`;
const CONTEXT = 'sender-account:000000000000000000000001:refresh-token';

const cipherWith = (keyId = 'k1', key = newKey()) => createTokenCipher({ keys: { [keyId]: key }, activeKeyId: keyId });

/** Rebuilds an envelope after changing one of its five parts. */
const withPart = (envelope, index, value) => {
  const parts = envelope.split('.');
  parts[index] = value;
  return parts.join('.');
};
/** Flips one bit of a base64url-encoded part. */
const flipBit = (text) => {
  const bytes = Buffer.from(text, 'base64url');
  bytes[0] ^= 0x01;
  return bytes.toString('base64url');
};

/** Asserts a TokenEncryptionError with the given code whose message contains none of `secrets`. */
const rejectsWith = (fn, code, secrets = []) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof TokenEncryptionError, `expected TokenEncryptionError, got ${error?.name}`);
    assert.equal(error.code, code);
    for (const secret of secrets) {
      assert.ok(!String(error.message).includes(secret), 'error message must not contain secrets');
      assert.ok(!String(error.stack).includes(secret), 'error stack must not contain secrets');
    }
    return true;
  });
};

describe('Token encryption: round trip and envelope', () => {
  it('encrypts and decrypts back to the exact token', () => {
    const cipher = cipherWith();
    for (const token of [fakeToken(), 'ya29.short', 'ü-unicode-✓', 'x'.repeat(MAX_TOKEN_PLAINTEXT_BYTES)]) {
      const envelope = cipher.encrypt(token, { context: CONTEXT });
      assert.equal(cipher.decrypt(envelope, { context: CONTEXT }), token);
    }
  });

  it('produces a versioned envelope that names the key and never contains the token', () => {
    const cipher = cipherWith('2026-11');
    const token = fakeToken();
    const envelope = cipher.encrypt(token, { context: CONTEXT });
    const parts = envelope.split('.');
    assert.equal(parts.length, 5);
    assert.equal(parts[0], TOKEN_ENVELOPE_VERSION);
    assert.equal(parts[1], '2026-11');
    assert.equal(Buffer.from(parts[2], 'base64url').length, 12, '96-bit IV');
    assert.equal(Buffer.from(parts[4], 'base64url').length, 16, '128-bit tag');
    assert.ok(!envelope.includes(token));
    assert.match(envelope, /^[A-Za-z0-9_.-]+$/, 'ASCII only, safe to store');
  });

  it('uses a fresh random IV every time, so equal tokens never give equal ciphertexts', () => {
    const cipher = cipherWith();
    const token = fakeToken();
    const envelopes = Array.from({ length: 200 }, () => cipher.encrypt(token, { context: CONTEXT }));
    assert.equal(new Set(envelopes.map((e) => e.split('.')[2])).size, envelopes.length, 'IVs never repeat');
    assert.equal(new Set(envelopes).size, envelopes.length);
    for (const envelope of envelopes.slice(0, 5)) assert.equal(cipher.decrypt(envelope, { context: CONTEXT }), token);
  });
});

describe('Token encryption: authentication and tampering', () => {
  const cipher = cipherWith();
  const token = fakeToken();
  const envelope = cipher.encrypt(token, { context: CONTEXT });

  it('rejects a tampered ciphertext', () => {
    rejectsWith(() => cipher.decrypt(withPart(envelope, 3, flipBit(envelope.split('.')[3])), { context: CONTEXT }), 'TOKEN_DECRYPT_FAILED', [token]);
  });

  it('rejects a tampered authentication tag', () => {
    rejectsWith(() => cipher.decrypt(withPart(envelope, 4, flipBit(envelope.split('.')[4])), { context: CONTEXT }), 'TOKEN_DECRYPT_FAILED', [token]);
  });

  it('rejects a tampered IV', () => {
    rejectsWith(() => cipher.decrypt(withPart(envelope, 2, flipBit(envelope.split('.')[2])), { context: CONTEXT }), 'TOKEN_DECRYPT_FAILED', [token]);
  });

  it('rejects a truncated tag (no short-tag forgery)', () => {
    const shortTag = Buffer.from(envelope.split('.')[4], 'base64url').subarray(0, 4).toString('base64url');
    rejectsWith(() => cipher.decrypt(withPart(envelope, 4, shortTag), { context: CONTEXT }), 'TOKEN_INVALID_CIPHERTEXT', [token]);
  });

  it('rejects the right envelope under a different context (no copying tokens between records)', () => {
    rejectsWith(
      () => cipher.decrypt(envelope, { context: 'sender-account:000000000000000000000002:refresh-token' }),
      'TOKEN_DECRYPT_FAILED',
      [token]
    );
  });

  it('rejects an envelope relabelled with another configured key ID', () => {
    const keyA = newKey();
    const keyB = newKey();
    const ring = createTokenCipher({ keys: { a: keyA, b: keyB }, activeKeyId: 'a' });
    const sealed = ring.encrypt(token, { context: CONTEXT });
    rejectsWith(() => ring.decrypt(withPart(sealed, 1, 'b'), { context: CONTEXT }), 'TOKEN_DECRYPT_FAILED', [token]);
  });

  it('rejects decryption with the wrong key', () => {
    const other = cipherWith('k1', newKey());
    rejectsWith(() => other.decrypt(envelope, { context: CONTEXT }), 'TOKEN_DECRYPT_FAILED', [token]);
  });

  it('rejects an envelope whose key is not configured', () => {
    const other = cipherWith('k2');
    rejectsWith(() => other.decrypt(envelope, { context: CONTEXT }), 'TOKEN_UNKNOWN_KEY', [token]);
  });
});

describe('Token encryption: never a plaintext fallback', () => {
  const cipher = cipherWith();
  const token = fakeToken();

  it('never returns a plaintext or malformed value unchanged', () => {
    const envelope = cipher.encrypt(token, { context: CONTEXT });
    const parts = envelope.split('.');
    const malformed = [
      token, // a raw token stored by mistake
      '',
      'mpt1',
      'mpt0.' + parts.slice(1).join('.'), // unknown version
      parts.slice(1).join('.'), // version missing
      envelope + '.extra',
      withPart(envelope, 1, 'bad key id!'),
      withPart(envelope, 2, parts[2] + '='), // non-canonical encoding
      withPart(envelope, 2, parts[2] + 'AA'), // wrong IV length
      withPart(envelope, 3, ''), // empty ciphertext
      withPart(envelope, 3, 'not*base64'),
      `${'A'.repeat(20000)}`,
    ];
    for (const value of malformed) {
      assert.throws(
        () => cipher.decrypt(value, { context: CONTEXT }),
        (error) => error instanceof TokenEncryptionError && error.code === 'TOKEN_INVALID_CIPHERTEXT'
      );
    }
  });

  it('rejects non-string and empty inputs on both sides', () => {
    for (const value of [undefined, null, 42, {}, [], Buffer.from('x'), '']) {
      rejectsWith(() => cipher.encrypt(value, { context: CONTEXT }), 'TOKEN_INVALID_PLAINTEXT');
      assert.throws(() => cipher.decrypt(value, { context: CONTEXT }), TokenEncryptionError);
    }
    rejectsWith(() => cipher.encrypt('x'.repeat(MAX_TOKEN_PLAINTEXT_BYTES + 1), { context: CONTEXT }), 'TOKEN_INVALID_PLAINTEXT');
  });

  it('requires a valid context to encrypt and to decrypt', () => {
    const envelope = cipher.encrypt(token, { context: CONTEXT });
    for (const context of [undefined, '', 42, 'x'.repeat(201), 'line\nbreak']) {
      rejectsWith(() => cipher.encrypt(token, { context }), 'TOKEN_INVALID_CONTEXT', [token]);
      rejectsWith(() => cipher.decrypt(envelope, { context }), 'TOKEN_INVALID_CONTEXT', [token]);
    }
    rejectsWith(() => cipher.encrypt(token), 'TOKEN_INVALID_CONTEXT', [token]);
  });
});

describe('Token encryption: key validation', () => {
  it('accepts a 32-byte key in base64 or base64url', () => {
    const key = newKey();
    assert.deepEqual(decodeTokenKey(key.toString('base64')), key);
    assert.deepEqual(decodeTokenKey(key.toString('base64url')), key);
  });

  it('rejects keys of the wrong length, encoding or randomness', () => {
    const bad = [
      undefined,
      '',
      '   ',
      crypto.randomBytes(16).toString('base64'), // 128-bit
      crypto.randomBytes(31).toString('base64'),
      crypto.randomBytes(33).toString('base64'),
      crypto.randomBytes(64).toString('base64'),
      'not base64 at all!',
      Buffer.alloc(32).toString('base64'), // all zero bytes
      Buffer.alloc(32, 7).toString('base64'), // one repeated byte
    ];
    for (const value of bad) {
      assert.throws(() => decodeTokenKey(value), TokenEncryptionConfigError);
    }
  });

  it('rejects an invalid keyring', () => {
    const key = newKey();
    const cases = [
      {},
      { keys: {}, activeKeyId: 'k1' },
      { keys: { k1: key }, activeKeyId: 'k2' }, // active key missing
      { keys: { k1: crypto.randomBytes(16) }, activeKeyId: 'k1' },
      { keys: { k1: Buffer.alloc(32) }, activeKeyId: 'k1' },
      { keys: { k1: 'a string, not bytes' }, activeKeyId: 'k1' },
      { keys: { 'bad id!': key }, activeKeyId: 'bad id!' },
      { keys: { k1: key, k2: Buffer.from(key) }, activeKeyId: 'k1' }, // same key under two IDs
    ];
    for (const options of cases) {
      assert.throws(() => createTokenCipher(options), TokenEncryptionConfigError);
    }
  });

  it('keeps its own copy of the key (later changes to the caller buffer have no effect)', () => {
    const key = newKey();
    const cipher = createTokenCipher({ keys: { k1: key }, activeKeyId: 'k1' });
    const envelope = cipher.encrypt('ya29.example', { context: CONTEXT });
    key.fill(0);
    assert.equal(cipher.decrypt(envelope, { context: CONTEXT }), 'ya29.example');
  });

  it('rotation: decrypts with retired keys, encrypts with the active one, flags old envelopes', () => {
    const oldKey = newKey();
    const newerKey = newKey();
    const before = createTokenCipher({ keys: { old: oldKey }, activeKeyId: 'old' });
    const sealedOld = before.encrypt('ya29.rotate', { context: CONTEXT });

    const after = createTokenCipher({ keys: { old: oldKey, new: newerKey }, activeKeyId: 'new' });
    assert.equal(after.decrypt(sealedOld, { context: CONTEXT }), 'ya29.rotate');
    assert.equal(after.needsReencryption(sealedOld), true);
    const sealedNew = after.encrypt('ya29.rotate', { context: CONTEXT });
    assert.equal(sealedNew.split('.')[1], 'new');
    assert.equal(after.needsReencryption(sealedNew), false);
  });
});

describe('Token encryption: configuration from the environment', () => {
  afterEach(() => resetTokenCipher());

  const envWith = (keys, active) => ({
    ...(keys !== undefined && { TOKEN_ENCRYPTION_KEYS: keys }),
    ...(active !== undefined && { TOKEN_ENCRYPTION_ACTIVE_KEY_ID: active }),
  });

  it('not configured: returns null, and the cipher fails closed (no plaintext mode)', () => {
    assert.equal(getTokenEncryptionConfig({}), null);
    assert.equal(getTokenEncryptionConfig(envWith('  ', '')), null);
    assert.throws(() => getTokenCipher({}), TokenEncryptionConfigError);
    assert.throws(() => encryptToken('ya29.example', { context: CONTEXT }), TokenEncryptionConfigError);
    assert.throws(() => decryptToken('ya29.example', { context: CONTEXT }), TokenEncryptionConfigError);
  });

  it('parses one key, several keys and the active key ID', () => {
    const k1 = newKey();
    const k2 = newKey();
    const single = getTokenEncryptionConfig(envWith(`k1:${k1.toString('base64')}`));
    assert.equal(single.activeKeyId, 'k1');
    assert.deepEqual(single.keys.get('k1'), k1);

    const several = getTokenEncryptionConfig(envWith(` k1:${k1.toString('base64')} , k2:${k2.toString('base64url')} `, 'k2'));
    assert.equal(several.activeKeyId, 'k2');
    assert.deepEqual([...several.keys.keys()], ['k1', 'k2']);
  });

  it('anything set but invalid throws instead of quietly disabling encryption', () => {
    const k1 = newKey().toString('base64');
    const k2 = newKey().toString('base64');
    const cases = [
      envWith(undefined, 'k1'), // active ID without keys
      envWith(k1), // no key ID
      envWith(':' + k1),
      envWith(`k1:${k1},k1:${k2}`), // duplicate key ID
      envWith(`k1:${k1},k2:${k2}`), // several keys, no active ID
      envWith(`k1:${k1}`, 'k9'), // unknown active ID
      envWith(`k1:${crypto.randomBytes(16).toString('base64')}`),
      envWith(`k1:${Buffer.alloc(32).toString('base64')}`),
      envWith('k1:'),
    ];
    for (const env of cases) {
      assert.throws(() => getTokenEncryptionConfig(env), TokenEncryptionConfigError);
      assert.throws(() => validateTokenEncryptionConfig(env), TokenEncryptionConfigError);
    }
  });

  it('the process-wide cipher encrypts and decrypts with the configured key', () => {
    const env = envWith(`prod-1:${newKey().toString('base64')}`);
    const cipher = getTokenCipher(env);
    assert.equal(cipher.activeKeyId, 'prod-1');
    assert.equal(getTokenCipher(env), cipher, 'cached');
    const envelope = cipher.encrypt('ya29.example', { context: CONTEXT });
    assert.equal(encryptToken('ya29.example', { context: CONTEXT }).split('.')[1], 'prod-1');
    assert.equal(decryptToken(envelope, { context: CONTEXT }), 'ya29.example');
  });

  it('startup: optional until Google OAuth is configured, then required', () => {
    assert.deepEqual(validateTokenEncryptionConfig({}), { enabled: false }, 'existing workflows are unaffected');
    assert.deepEqual(validateTokenEncryptionConfig(envWith(`k1:${newKey().toString('base64')}`)), { enabled: true });

    for (const name of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI']) {
      assert.equal(isTokenEncryptionRequired({ [name]: 'set' }), true);
      assert.throws(() => validateTokenEncryptionConfig({ [name]: 'set' }), TokenEncryptionConfigError);
      assert.deepEqual(
        validateTokenEncryptionConfig({ [name]: 'set', TOKEN_ENCRYPTION_KEYS: `k1:${newKey().toString('base64')}` }),
        { enabled: true }
      );
    }
    assert.equal(isTokenEncryptionRequired({ GOOGLE_OAUTH_CLIENT_ID: '   ' }), false);
  });
});

describe('Token encryption: no secrets in errors', () => {
  it('configuration errors never contain key material', () => {
    const almost = crypto.randomBytes(31).toString('base64');
    const secrets = [almost, almost.slice(0, 12)];
    for (const env of [{ TOKEN_ENCRYPTION_KEYS: `k1:${almost}` }, { TOKEN_ENCRYPTION_KEYS: almost }]) {
      assert.throws(
        () => getTokenEncryptionConfig(env),
        (error) => {
          assert.ok(error instanceof TokenEncryptionConfigError);
          for (const secret of secrets) {
            assert.ok(!error.message.includes(secret));
            assert.ok(!String(error.stack).includes(secret));
          }
          return true;
        }
      );
    }
  });

  it('decryption errors never contain the token, the key, the envelope or the context', () => {
    const key = newKey();
    const cipher = cipherWith('k1', key);
    const token = fakeToken();
    const envelope = cipher.encrypt(token, { context: CONTEXT });
    const tampered = withPart(envelope, 3, flipBit(envelope.split('.')[3]));
    assert.throws(
      () => cipherWith('k1').decrypt(tampered, { context: CONTEXT }),
      (error) => {
        const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
        for (const secret of [token, key.toString('base64'), key.toString('hex'), envelope, tampered, envelope.split('.')[3], CONTEXT]) {
          assert.ok(!text.includes(secret), 'nothing sensitive in the error');
        }
        assert.equal(error.cause, undefined, 'no underlying crypto error attached');
        return true;
      }
    );
  });

  it('the API and the worker refuse to start on an invalid key, without printing it', () => {
    const badKey = crypto.randomBytes(20).toString('base64');
    for (const script of ['src/server.js', 'src/worker.js']) {
      const result = spawnSync(process.execPath, [script], {
        cwd: SERVER_DIR,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          // Never reached: startup stops at configuration validation, before any connection
          MONGODB_URI: 'mongodb://127.0.0.1:1/never_connected',
          JWT_SECRET: 'test_only_jwt_secret_for_startup_validation_0123456789',
          SMTP_HOST: '',
          TOKEN_ENCRYPTION_KEYS: `k1:${badKey}`,
        },
        encoding: 'utf8',
        timeout: 20000,
      });
      assert.equal(result.status, 1, `${script} must exit 1 (${result.stdout}${result.stderr})`);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /Token encryption configuration error/);
      assert.ok(!output.includes(badKey), `${script} must not print the key`);
    }
  });
});
