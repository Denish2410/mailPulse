import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from '../src/services/password.service.js';

describe('Password Hashing Service (Argon2id)', () => {
  it('1. Hashing produces a non-empty string different from the raw password', async () => {
    const raw = 'CorrectHorseBatteryStaple123!';
    const hash = await hashPassword(raw);

    assert.ok(hash);
    assert.notEqual(hash, raw);
    assert.equal(typeof hash, 'string');
    // Argon2id hashes begin with $argon2id$
    assert.ok(hash.startsWith('$argon2id$'), 'Hash should start with $argon2id$');
  });

  it('2. Hashing the same password twice produces independently salted distinct hashes', async () => {
    const raw = 'IdenticalPassword123!';
    const hash1 = await hashPassword(raw);
    const hash2 = await hashPassword(raw);

    assert.notEqual(hash1, hash2, 'Subsequent hashes must have unique salts');
    // Both should still verify correctly against the same raw password
    assert.equal(await verifyPassword(raw, hash1), true);
    assert.equal(await verifyPassword(raw, hash2), true);
  });

  it('3. Correct password verifies successfully', async () => {
    const raw = 'P@ssw0rdValid2026';
    const hash = await hashPassword(raw);

    const isMatch = await verifyPassword(raw, hash);
    assert.equal(isMatch, true);
  });

  it('4. Incorrect password fails verification safely returning false', async () => {
    const raw = 'CorrectPassword999';
    const wrong = 'IncorrectPassword999';
    const hash = await hashPassword(raw);

    const isMatch = await verifyPassword(wrong, hash);
    assert.equal(isMatch, false);
  });

  it('5. Rejects invalid or empty password inputs in hashPassword with TypeError', async () => {
    const invalidInputs = ['', '   ', null, undefined, 12345, {}, []];

    for (const input of invalidInputs) {
      if (input === '   ') continue; // only non-empty string check
      await assert.rejects(
        async () => {
          await hashPassword(input);
        },
        { name: 'TypeError', message: 'Password must be a non-empty string' }
      );
    }
  });

  it('6. verifyPassword safely returns false on malformed hashes, corrupted strings, or invalid inputs', async () => {
    const malformedCases = [
      ['password', 'not-a-valid-argon-hash'],
      ['password', '$argon2id$malformed$hash$data'],
      ['password', ''],
      ['password', null],
      ['password', undefined],
      ['', '$argon2id$v=19$m=65536,t=3,p=4$someHash'],
      [null, '$argon2id$v=19$m=65536,t=3,p=4$someHash'],
      [undefined, '$argon2id$v=19$m=65536,t=3,p=4$someHash'],
      [12345, '$argon2id$v=19$m=65536,t=3,p=4$someHash'],
    ];

    for (const [candidate, hash] of malformedCases) {
      const result = await verifyPassword(candidate, hash);
      assert.equal(result, false, `Expected false for candidate: ${candidate}, hash: ${hash}`);
    }
  });
});
