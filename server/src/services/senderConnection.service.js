import mongoose from 'mongoose';
import OAuthState from '../models/OAuthState.js';
import SenderAccount from '../models/SenderAccount.js';
import { getGoogleOAuthConfig } from '../config/googleOAuth.js';
import { encryptToken } from '../utils/tokenCrypto.js';
import { createOAuthState, hashOAuthState, createPkcePair, buildAuthorizationUrl } from './googleOAuth.service.js';
import { MAX_SENDER_ACCOUNTS_PER_USER } from './senderAccount.service.js';

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

export default { startGoogleConnection, requireGoogleOAuthConfig, OAUTH_STATE_TTL_MS, MAX_PENDING_CONNECTIONS };
