import SenderAccount from '../models/SenderAccount.js';
import { getGoogleOAuthConfig } from '../config/googleOAuth.js';
import { GoogleOAuthError, refreshAccessToken, hasGmailSendScope } from './googleOAuth.service.js';
import { openAccessToken, openRefreshToken, sealAccessToken, sealRefreshToken } from './senderAccount.service.js';

/**
 * Access tokens for sending as a customer's Gmail account.
 *
 * - Always scoped by owner: (userId, senderAccountId). Never picks another account.
 * - Returns the cached access token while it is valid for at least 2 more minutes, otherwise
 *   refreshes it with the stored refresh token. Concurrent callers in one process share one
 *   refresh (single flight).
 * - Every write is conditional on the account still being `active` with the same
 *   `tokenGeneration` it had when it was read, so a refresh racing a disconnect or a reconnect can
 *   never restore wiped or outdated tokens; the caller then re-reads the account.
 * - Google refusing the grant (invalid_grant, gmail.send removed) marks the account
 *   `reauth_required`. Temporary failures (network, timeouts, 5xx, rate limits) change nothing and
 *   are reported as retryable.
 * - Errors carry codes and fixed messages; never tokens.
 */

export const ACCESS_TOKEN_MIN_VALIDITY_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/** The account cannot be used to send until the customer acts (or the server is configured). */
export class SenderAccountUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SenderAccountUnavailableError';
    this.code = code;
    this.retryable = false;
    this.reauthRequired = code === 'SENDER_REAUTH_REQUIRED';
  }
}

/** A refresh failed for a reason that may go away (network, Google unavailable, races). */
export class SenderTokenRefreshError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = 'SenderTokenRefreshError';
    this.code = code;
    this.retryable = retryable;
  }
}

const unavailable = {
  SENDER_NOT_FOUND: 'Sender account not found.',
  SENDER_DISCONNECTED: 'This sender account is disconnected. Connect it again to send from it.',
  SENDER_REAUTH_REQUIRED: 'Google no longer accepts this sender account. Reconnect it to send from it.',
  SENDER_TOKEN_UNREADABLE: 'The stored credentials of this sender account cannot be read. Reconnect it, or check the token encryption keys.',
  GMAIL_NOT_CONFIGURED: 'Gmail sending is not configured on this server.',
};
const unavailableError = (code) => new SenderAccountUnavailableError(code, unavailable[code]);

const TOKEN_FIELDS = '+encryptedRefreshToken +encryptedAccessToken +accessTokenExpiresAt';

const assertUsable = (account) => {
  if (!account) throw unavailableError('SENDER_NOT_FOUND');
  if (account.status === 'disconnected') throw unavailableError('SENDER_DISCONNECTED');
  if (account.status !== 'active') throw unavailableError('SENDER_REAUTH_REQUIRED');
  if (!account.encryptedRefreshToken) throw unavailableError('SENDER_REAUTH_REQUIRED');
};

/**
 * Marks an account `reauth_required` and drops its cached access token, but only if it is still
 * active at the given generation (a reconnect in the meantime wins).
 *
 * @returns {Promise<boolean>} whether the account was changed
 */
export const markSenderReauthRequired = async ({ userId, senderAccountId, tokenGeneration, reason, now = new Date() }) => {
  const filter = { _id: senderAccountId, userId, status: 'active' };
  if (Number.isInteger(tokenGeneration)) filter.tokenGeneration = tokenGeneration;
  const result = await SenderAccount.updateOne(filter, {
    $set: {
      status: 'reauth_required',
      statusReason: reason,
      statusChangedAt: now,
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
    },
  });
  return result.modifiedCount === 1;
};

/**
 * Drops the cached access token (for example after Gmail answered 401 with it), so the next call
 * refreshes. Only touches the given generation.
 */
export const invalidateSenderAccessToken = async ({ userId, senderAccountId, tokenGeneration }) => {
  const filter = { _id: senderAccountId, userId };
  if (Number.isInteger(tokenGeneration)) filter.tokenGeneration = tokenGeneration;
  await SenderAccount.updateOne(filter, { $set: { encryptedAccessToken: null, accessTokenExpiresAt: null } });
};

const resultFor = (account, accessToken, expiresAt) => ({
  accessToken,
  expiresAt,
  senderAccountId: String(account._id),
  email: account.email,
  displayName: account.displayName ?? '',
  tokenGeneration: account.tokenGeneration,
});

const inflight = new Map();

/** Refreshes once. Returns null when the account changed meanwhile (the caller re-reads). */
const refreshFor = async (account, { env, fetchImpl, now }) => {
  const config = getGoogleOAuthConfig(env);
  if (!config) throw unavailableError('GMAIL_NOT_CONFIGURED');

  let refreshToken;
  try {
    refreshToken = openRefreshToken(account._id, account.encryptedRefreshToken);
  } catch {
    // Not marked: a key configuration mistake must not force every customer to reconnect
    throw unavailableError('SENDER_TOKEN_UNREADABLE');
  }

  const markAndThrow = async (reason) => {
    await markSenderReauthRequired({
      userId: account.userId,
      senderAccountId: account._id,
      tokenGeneration: account.tokenGeneration,
      reason,
    });
    throw unavailableError('SENDER_REAUTH_REQUIRED');
  };

  let tokens;
  try {
    tokens = await refreshAccessToken(config, refreshToken, { fetchImpl });
  } catch (error) {
    if (error instanceof GoogleOAuthError && error.code === 'GOOGLE_INVALID_GRANT') return markAndThrow('TOKEN_REVOKED');
    if (error instanceof GoogleOAuthError && (error.code === 'GOOGLE_INVALID_CLIENT' || error.code === 'GOOGLE_HTTP_DISABLED')) {
      throw new SenderTokenRefreshError('GOOGLE_CLIENT_MISCONFIGURED', 'Gmail sending is misconfigured on this server.', {
        retryable: false,
      });
    }
    throw new SenderTokenRefreshError('SENDER_TOKEN_REFRESH_FAILED', 'Could not refresh the Gmail access token. It will be retried.');
  }
  // Google lists the granted scopes; if gmail.send was removed, sending would fail anyway
  if (tokens.scopes.length > 0 && !hasGmailSendScope(tokens.scopes)) return markAndThrow('SCOPE_MISSING');

  const expiresAt = new Date(now() + tokens.expiresIn * 1000);
  const update = {
    $set: {
      encryptedAccessToken: sealAccessToken(account._id, tokens.accessToken),
      accessTokenExpiresAt: expiresAt,
      lastRefreshedAt: new Date(now()),
    },
  };
  let generation = account.tokenGeneration;
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
    // Google rotated the refresh token: store it, and move to a new generation
    update.$set.encryptedRefreshToken = sealRefreshToken(account._id, tokens.refreshToken);
    update.$inc = { tokenGeneration: 1 };
    generation += 1;
  }
  const result = await SenderAccount.updateOne(
    { _id: account._id, userId: account.userId, status: 'active', tokenGeneration: account.tokenGeneration },
    update
  );
  if (result.modifiedCount !== 1) return null;
  return { ...resultFor(account, tokens.accessToken, expiresAt), tokenGeneration: generation };
};

/**
 * @param {{ userId: any, senderAccountId: any, env?: object, fetchImpl?: Function, now?: () => number }} params
 * @returns {Promise<{ accessToken: string, expiresAt: Date, senderAccountId: string, email: string, displayName: string, tokenGeneration: number }>}
 * @throws {SenderAccountUnavailableError|SenderTokenRefreshError}
 */
export const getSenderAccessToken = async ({ userId, senderAccountId, env = process.env, fetchImpl, now = Date.now }) => {
  if (!userId || !senderAccountId) throw unavailableError('SENDER_NOT_FOUND');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let account;
    try {
      account = await SenderAccount.findOne({ _id: senderAccountId, userId }).select(TOKEN_FIELDS);
    } catch (error) {
      if (error?.name === 'CastError') throw unavailableError('SENDER_NOT_FOUND');
      throw error;
    }
    assertUsable(account);

    const expiresAt = account.accessTokenExpiresAt;
    if (account.encryptedAccessToken && expiresAt && expiresAt.getTime() - now() > ACCESS_TOKEN_MIN_VALIDITY_MS) {
      try {
        return resultFor(account, openAccessToken(account._id, account.encryptedAccessToken), expiresAt);
      } catch {
        // Unreadable cached access token: fall through and refresh it
      }
    }

    const key = `${String(account._id)}:${account.tokenGeneration}`;
    let pending = inflight.get(key);
    if (!pending) {
      pending = refreshFor(account, { env, fetchImpl, now }).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const result = await pending;
    if (result) return result;
  }
  throw new SenderTokenRefreshError('SENDER_ACCOUNT_CHANGED', 'The sender account changed while its token was refreshed. It will be retried.');
};

export default {
  ACCESS_TOKEN_MIN_VALIDITY_MS,
  SenderAccountUnavailableError,
  SenderTokenRefreshError,
  getSenderAccessToken,
  invalidateSenderAccessToken,
  markSenderReauthRequired,
};
