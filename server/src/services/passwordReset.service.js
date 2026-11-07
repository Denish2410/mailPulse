import crypto from 'node:crypto';

/**
 * Password reset helpers.
 *
 * The emailed token is 32 random bytes (hex). Only its SHA-256 hash is stored, so a database
 * leak cannot be used to reset accounts. Tokens expire after one hour and are single-use.
 */

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export const hashResetToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export const isWellFormedResetToken = (token) => typeof token === 'string' && TOKEN_PATTERN.test(token);

/**
 * @returns {{ token: string, tokenHash: string, expiresAt: Date }}
 */
export const createResetToken = (now = new Date()) => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashResetToken(token), expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) };
};

/**
 * Builds the reset link on the first configured client origin.
 */
export const buildResetLink = (token, env = process.env) => {
  const origin = (env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
  return `${origin}/reset-password?token=${token}`;
};

export const buildResetEmail = ({ name, link }) => {
  const safeName = String(name || 'there').replace(/[<>&"']/g, '');
  return {
    subject: 'Reset your MailPulse password',
    text:
      `Hi ${safeName},\n\nSomeone asked to reset your MailPulse password. ` +
      `Use this link within 1 hour:\n\n${link}\n\n` +
      'If you did not request this, you can ignore this email; your password will not change.\n',
    html:
      `<p>Hi ${safeName},</p><p>Someone asked to reset your MailPulse password. ` +
      `Use the link below within 1 hour:</p><p><a href="${link}">Reset your password</a></p>` +
      '<p>If you did not request this, you can ignore this email; your password will not change.</p>',
  };
};
