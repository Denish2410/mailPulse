import { AppError } from '../middleware/errorHandler.js';

/**
 * Whether sending/scheduling requires a verified account email.
 *
 * Opt in or out explicitly with REQUIRE_VERIFIED_EMAIL=true|false. When unset it is on in
 * production (so unverified sign-ups cannot send mail and damage the sending reputation) and off
 * elsewhere, which keeps local development and tests friction-free.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export const isVerifiedEmailRequired = (env = process.env) => {
  const flag = String(env.REQUIRE_VERIFIED_EMAIL ?? '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV === 'production';
};

/**
 * Whether a sender mailing address is required before sending (CAN-SPAM requires a valid
 * physical postal address in commercial email). REQUIRE_MAILING_ADDRESS=true|false overrides;
 * unset means on in production only.
 *
 * @param {object} [env=process.env]
 * @returns {boolean}
 */
export const isMailingAddressRequired = (env = process.env) => {
  const flag = String(env.REQUIRE_MAILING_ADDRESS ?? '').trim().toLowerCase();
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return env.NODE_ENV === 'production';
};

/**
 * Throws 403 when the account may not send. `action` is "send" or "schedule".
 *
 * @param {{ status?: string, emailVerifiedAt?: Date|null, mailingAddress?: string }} user
 * @param {'send'|'schedule'} action
 * @param {object} [env=process.env]
 */
export const assertAccountMaySend = (user, action, env = process.env) => {
  if (user.status && user.status !== 'active') {
    throw new AppError(`Your account is not permitted to ${action} campaigns.`, 403);
  }
  if (isVerifiedEmailRequired(env) && !user.emailVerifiedAt) {
    throw new AppError(
      `Verify your email address before you ${action} campaigns. Check your inbox or request a new verification email.`,
      403,
      [{ path: 'user.email', message: 'Email address is not verified.' }]
    );
  }
  if (isMailingAddressRequired(env) && !String(user.mailingAddress ?? '').trim()) {
    throw new AppError(
      `Add your mailing address in Account settings before you ${action} campaigns. It is printed in every email footer, as anti-spam law requires.`,
      403,
      [{ path: 'user.mailingAddress', message: 'Mailing address is not set.' }]
    );
  }
};
