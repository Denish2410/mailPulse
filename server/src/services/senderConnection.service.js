import mongoose from 'mongoose';
import OAuthState from '../models/OAuthState.js';
import SenderAccount from '../models/SenderAccount.js';
import { GrantLockBusyError, grantLockKey, withGrantLock } from './grantLock.service.js';
import { getGoogleOAuthConfig } from '../config/googleOAuth.js';
import { encryptToken, decryptToken } from '../utils/tokenCrypto.js';
import {
  GoogleOAuthError,
  createOAuthState,
  hashOAuthState,
  createPkcePair,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  hasGmailSendScope,
  readIdTokenClaims,
  revokeToken,
} from './googleOAuth.service.js';
import {
  MAX_SENDER_ACCOUNTS_PER_USER,
  sealRefreshToken,
  sealAccessToken,
  openRefreshToken,
  findOwnedSenderAccount,
} from './senderAccount.service.js';

/**
 * Connecting a customer's Gmail mailbox (Google OAuth authorization code flow with PKCE).
 *
 * 1. startGoogleConnection: an authenticated user asks to connect. A random state (only its hash
 *    is stored) and a PKCE verifier (stored encrypted) are saved for 10 minutes, bound to that
 *    user, and the Google consent URL is returned.
 * 2. Google redirects the browser to GOOGLE_OAUTH_REDIRECT_URI (a page of the MailPulse client),
 *    which posts the code and state back to the API with the user's own session; the state must
 *    belong to that user (completeGoogleConnection).
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_CONNECTIONS = 5;

export class SenderConnectionError extends Error {
  constructor(code, statusCode, message) {
    super(message);
    this.name = 'SenderConnectionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const codeVerifierContext = (stateId) => `oauth-state:${String(stateId)}:code-verifier`;

/** Google OAuth settings, or a 503 when Gmail sending is not configured on this server. */
export const requireGoogleOAuthConfig = (env = process.env) => {
  const config = getGoogleOAuthConfig(env);
  if (!config) {
    throw new SenderConnectionError('GMAIL_NOT_CONFIGURED', 503, 'Gmail sending is not configured on this server.');
  }
  return config;
};

const assertSenderLimit = async (userId) => {
  const connected = await SenderAccount.countDocuments({ userId, status: { $ne: 'disconnected' } });
  if (connected >= MAX_SENDER_ACCOUNTS_PER_USER) {
    throw new SenderConnectionError(
      'SENDER_LIMIT_REACHED',
      409,
      `You can connect at most ${MAX_SENDER_ACCOUNTS_PER_USER} sender accounts. Disconnect one first.`
    );
  }
};

/**
 * @param {{ userId: string|import('mongoose').Types.ObjectId, now?: Date, env?: object }} params
 * @returns {Promise<{ authorizationUrl: string, expiresAt: Date }>}
 */
export const startGoogleConnection = async ({ userId, now = new Date(), env = process.env }) => {
  const config = requireGoogleOAuthConfig(env);
  await assertSenderLimit(userId);

  const pending = await OAuthState.countDocuments({ userId, consumedAt: null, expiresAt: { $gt: now } });
  if (pending >= MAX_PENDING_CONNECTIONS) {
    throw new SenderConnectionError(
      'TOO_MANY_PENDING_CONNECTIONS',
      429,
      'Too many connection attempts are in progress. Please finish one or try again in a few minutes.'
    );
  }

  const state = createOAuthState();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const _id = new mongoose.Types.ObjectId();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  await OAuthState.create({
    _id,
    userId,
    provider: 'google',
    stateHash: hashOAuthState(state),
    encryptedCodeVerifier: encryptToken(codeVerifier, { context: codeVerifierContext(_id) }),
    expiresAt,
  });

  return { authorizationUrl: buildAuthorizationUrl(config, { state, codeChallenge }), expiresAt };
};


/**
 * Revokes a Google grant, but only when no other connected record uses the same Google account.
 *
 * A grant belongs to the pair (Google account, OAuth client), not to a MailPulse record: revoking
 * it would also cut off the same mailbox connected by this user earlier or by another MailPulse
 * user. In that case the token is only dropped here. Never throws; returns whether Google
 * confirmed the revocation.
 */
export const revokeGrantIfUnshared = async ({ providerAccountId, token, excludeAccountId = null, fetchImpl }) => {
  if (!token || !providerAccountId) return false;
  try {
    // The check and the revocation run under the grant's lock, and saving a connection for the
    // same Google account takes the same lock. So a connection saved before the check is seen by
    // it (no revoke), and one saved after the revocation starts from a finished revocation, never
    // from the middle of one. A busy lock means "skip": leaving a grant in place is the safe side.
    return await withGrantLock(grantLockKey(providerAccountId), async () => {
      const filter = { provider: 'google', providerAccountId, status: { $ne: 'disconnected' } };
      if (excludeAccountId) filter._id = { $ne: excludeAccountId };
      if (await SenderAccount.exists(filter)) return false;
      return await revokeToken(token, { fetchImpl });
    });
  } catch {
    return false;
  }
};

const stateError = () =>
  new SenderConnectionError(
    'INVALID_OAUTH_STATE',
    400,
    'This connection request is invalid or has expired. Please start connecting your Gmail account again.'
  );

/** Atomically consumes the pending connection: it must exist, belong to this user, be unused and unexpired. */
const consumePendingConnection = async ({ userId, state, now }) => {
  if (typeof state !== 'string' || !state) throw stateError();
  const pending = await OAuthState.findOneAndUpdate(
    { stateHash: hashOAuthState(state), userId, provider: 'google', consumedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } },
    { new: true }
  ).select('+encryptedCodeVerifier');
  if (!pending) throw stateError();
  try {
    return decryptToken(pending.encryptedCodeVerifier, { context: codeVerifierContext(pending._id) });
  } catch {
    throw stateError();
  } finally {
    await OAuthState.deleteOne({ _id: pending._id });
  }
};

const mapExchangeError = (error) => {
  if (!(error instanceof GoogleOAuthError)) return error;
  if (error.code === 'GOOGLE_INVALID_GRANT' || error.code === 'GOOGLE_REQUEST_REJECTED') {
    return new SenderConnectionError(
      'GOOGLE_AUTHORIZATION_REJECTED',
      400,
      'Google did not accept this authorization. Please start connecting your Gmail account again.'
    );
  }
  if (error.code === 'GOOGLE_INVALID_CLIENT' || error.code === 'GOOGLE_HTTP_DISABLED') {
    return new SenderConnectionError('GOOGLE_CLIENT_MISCONFIGURED', 502, 'Gmail connection is misconfigured on this server.');
  }
  return new SenderConnectionError('GOOGLE_UNAVAILABLE', 502, 'Could not complete the connection with Google. Please try again.');
};

/**
 * Creates the account, or updates this user's existing record for the same Google account
 * (reconnect). The previous refresh token is NOT revoked: it belongs to the same grant, and
 * revoking it would revoke the new one too.
 */
const saveGoogleSenderAccount = async ({ userId, identity, tokens, now }) => {
  const accessTokenExpiresAt = new Date(now.getTime() + tokens.expiresIn * 1000);
  const fieldsFor = (accountId) => ({
    email: identity.email,
    displayName: identity.name,
    status: 'active',
    statusReason: null,
    statusChangedAt: now,
    scopes: tokens.scopes,
    encryptedRefreshToken: sealRefreshToken(accountId, tokens.refreshToken),
    encryptedAccessToken: sealAccessToken(accountId, tokens.accessToken),
    accessTokenExpiresAt,
    connectedAt: now,
    lastRefreshedAt: now,
    disconnectedAt: null,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await SenderAccount.findOne({ userId, provider: 'google', providerAccountId: identity.sub });
    if (existing) {
      const updated = await SenderAccount.findOneAndUpdate(
        { _id: existing._id, userId },
        { $set: fieldsFor(existing._id), $inc: { tokenGeneration: 1 } },
        { new: true, runValidators: true }
      );
      if (updated) return { account: updated, created: false };
      continue;
    }
    await assertSenderLimit(userId);
    const _id = new mongoose.Types.ObjectId();
    try {
      const account = await SenderAccount.create({
        _id,
        userId,
        provider: 'google',
        providerAccountId: identity.sub,
        ...fieldsFor(_id),
      });
      return { account, created: true };
    } catch (error) {
      // A concurrent callback created the same record first: update it instead
      if (error?.code !== 11000) throw error;
    }
  }
  throw new SenderConnectionError('CONNECTION_CONFLICT', 409, 'The account changed while connecting. Please try again.');
};

/**
 * The last check before a connection is saved, run while holding the Google account's lock.
 *
 * The tokens were minted BEFORE the lock was taken, and a disconnect of the same Google account
 * that holds the lock first (and saw no other connection) revokes the whole grant, including the
 * tokens just minted. Saving them would then show an "active" account whose first send fails.
 * Asking Google for a fresh access token now tells the two cases apart: a revoked grant is
 * refused here, with a clear "connect again", and nothing is saved. From this point the lock
 * keeps any further revocation out until the connection is visible to it. Any OTHER failure
 * (Google unreachable, a bad answer) does not block the connection: the tokens as minted are
 * saved, and a revoked grant is then caught by the first token refresh, which marks the account
 * reconnect-required (fail-safe, never a send with a dead grant).
 */
const confirmGrantStillAlive = async ({ config, tokens, fetchImpl }) => {
  try {
    const fresh = await refreshAccessToken(config, tokens.refreshToken, { fetchImpl });
    const rotated = fresh.refreshToken || tokens.refreshToken;
    return { ...tokens, accessToken: fresh.accessToken, expiresIn: fresh.expiresIn, refreshToken: rotated };
  } catch (error) {
    if (error instanceof GoogleOAuthError && error.code === 'GOOGLE_INVALID_GRANT') {
      throw new SenderConnectionError(
        'GRANT_REVOKED_WHILE_CONNECTING',
        409,
        'Google access for this account was removed while it was being connected. Please connect your Gmail account again.'
      );
    }
    return tokens;
  }
};

/**
 * Completes a connection: consumes the state, exchanges the code (with the PKCE verifier),
 * checks the grant and the identity, and stores the encrypted tokens.
 *
 * @returns {Promise<{ account: import('mongoose').Document, created: boolean }>}
 */
export const completeGoogleConnection = async ({ userId, state, code, now = new Date(), env = process.env, fetchImpl }) => {
  const config = requireGoogleOAuthConfig(env);
  const codeVerifier = await consumePendingConnection({ userId, state, now });

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(config, { code, codeVerifier }, { fetchImpl });
  } catch (error) {
    throw mapExchangeError(error);
  }

  let identity;
  try {
    identity = readIdTokenClaims(tokens.idToken, config, { now: now.getTime() });
  } catch {
    // Without a trustworthy identity there is no safe way to tell whether revoking would cut off
    // another connection of the same mailbox, so the grant is left for the user to remove.
    throw new SenderConnectionError('GOOGLE_IDENTITY_INVALID', 502, 'Google returned an invalid account identity. Please try again.');
  }

  const discard = () =>
    revokeGrantIfUnshared({ providerAccountId: identity.sub, token: tokens.refreshToken || tokens.accessToken, fetchImpl });

  if (!hasGmailSendScope(tokens.scopes)) {
    await discard();
    throw new SenderConnectionError(
      'GMAIL_SCOPE_MISSING',
      400,
      'Permission to send email was not granted. Please connect again and allow MailPulse to send email on your behalf.'
    );
  }
  if (!tokens.refreshToken) {
    await discard();
    throw new SenderConnectionError(
      'GOOGLE_OFFLINE_ACCESS_MISSING',
      400,
      'Google did not grant offline access. Please connect your Gmail account again.'
    );
  }

  try {
    // Under the Google account's lock, so a revocation of the same grant by another connection
    // is either finished before this saves, or sees this connection and does not revoke
    return await withGrantLock(grantLockKey(identity.sub), async () => {
      const confirmed = await confirmGrantStillAlive({ config, tokens, fetchImpl });
      return saveGoogleSenderAccount({ userId, identity, tokens: confirmed, now });
    });
  } catch (error) {
    if (error instanceof GrantLockBusyError) {
      throw new SenderConnectionError('CONNECTION_CONFLICT', 409, 'The account is being updated. Please try again.');
    }
    if (error instanceof SenderConnectionError) await discard();
    throw error;
  }
};

const openQuietly = (account) => {
  if (!account?.encryptedRefreshToken) return null;
  try {
    return openRefreshToken(account._id, account.encryptedRefreshToken);
  } catch {
    return null;
  }
};

/**
 * Disconnects a sender account: tokens are wiped and the status set to `disconnected` in one
 * atomic update (generation bumped, so no in-flight refresh can restore them), THEN the grant is
 * revoked at Google when no other connected record uses it. A failed revocation does not undo the
 * disconnect; the response says whether Google confirmed it.
 *
 * @returns {Promise<null | { account: import('mongoose').Document, revoked: boolean, alreadyDisconnected: boolean }>}
 *          null when the account does not exist for this user
 */
export const disconnectSenderAccount = async ({ userId, accountId, now = new Date(), fetchImpl }) => {
  const current = await findOwnedSenderAccount(userId, accountId);
  if (!current) return null;
  const before = await SenderAccount.findOneAndUpdate(
    { _id: current._id, userId, status: { $ne: 'disconnected' } },
    {
      $set: {
        status: 'disconnected',
        statusReason: 'USER_DISCONNECTED',
        statusChangedAt: now,
        disconnectedAt: now,
        encryptedRefreshToken: null,
        encryptedAccessToken: null,
        accessTokenExpiresAt: null,
      },
      $inc: { tokenGeneration: 1 },
    },
    { new: false }
  ).select('+encryptedRefreshToken');
  if (!before) return { account: current, revoked: false, alreadyDisconnected: true };

  const revoked = await revokeGrantIfUnshared({
    providerAccountId: before.providerAccountId,
    token: openQuietly(before),
    excludeAccountId: before._id,
    fetchImpl,
  });
  return { account: await SenderAccount.findById(before._id), revoked, alreadyDisconnected: false };
};

/**
 * Account deletion: revokes the user's Google grants that no other connected record uses.
 * Best effort and in parallel (each request has its own timeout); never throws.
 *
 * @returns {Promise<number>} how many grants Google confirmed as revoked
 */
export const revokeAllSenderGrants = async (userId, { fetchImpl } = {}) => {
  const accounts = await SenderAccount.find({ userId, status: { $ne: 'disconnected' } }).select('+encryptedRefreshToken');
  const results = await Promise.allSettled(
    accounts.map((account) =>
      revokeGrantIfUnshared({
        providerAccountId: account.providerAccountId,
        token: openQuietly(account),
        excludeAccountId: account._id,
        fetchImpl,
      })
    )
  );
  return results.filter((r) => r.status === 'fulfilled' && r.value === true).length;
};

export default {
  startGoogleConnection,
  completeGoogleConnection,
  disconnectSenderAccount,
  revokeAllSenderGrants,
  revokeGrantIfUnshared,
  requireGoogleOAuthConfig,
  OAUTH_STATE_TTL_MS,
  MAX_PENDING_CONNECTIONS,
};
