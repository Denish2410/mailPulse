import argon2 from 'argon2';

/**
 * Password Hashing Service using Argon2id.
 *
 * Implements the RFC 9106 recommended password hashing algorithm:
 * - Argon2id: Hybrid variant offering resistance against both side-channel and GPU/ASIC attacks.
 * - Generates a unique, cryptographically secure random salt automatically for every hash.
 * - Strict input type validation prevents accidental type coercion or unhandled exceptions.
 * - Safely returns false on wrong passwords or malformed hashes without disclosing implementation details.
 * - Strictly avoids logging raw passwords, password hashes, or credentials.
 */

/**
 * Hashes a plaintext password using Argon2id with secure defaults.
 *
 * @param {string} password - Raw password to hash
 * @returns {Promise<string>} Encoded Argon2id hash string ($argon2id$v=19$...)
 * @throws {TypeError} If password is not a valid non-empty string
 */
export const hashPassword = async (password) => {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string');
  }

  // Use argon2id with standard OWASP-recommended memory and time cost parameters
  return await argon2.hash(password, {
    type: argon2.argon2id,
  });
};

/**
 * Verifies a plaintext password against an Argon2id hash.
 * Safely handles invalid inputs, malformed hashes, and verification errors,
 * always returning false on failure without throwing or disclosing details.
 *
 * @param {string} password - Plaintext password candidate
 * @param {string} passwordHash - Stored Argon2 hash
 * @returns {Promise<boolean>} True if password matches hash, false otherwise
 */
export const verifyPassword = async (password, passwordHash) => {
  if (
    typeof password !== 'string' ||
    password.length === 0 ||
    typeof passwordHash !== 'string' ||
    passwordHash.length === 0
  ) {
    return false;
  }

  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    // Return false on malformed hashes or internal errors to avoid disclosing implementation details
    return false;
  }
};

export default {
  hashPassword,
  verifyPassword,
};
