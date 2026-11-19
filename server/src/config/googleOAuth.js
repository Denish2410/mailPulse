/**
 * Google OAuth configuration (customer Gmail sender accounts).
 *
 * Optional as a whole: with none of the three variables set, Gmail sending is simply not
 * available. Setting only some of them, or invalid values, stops startup (the API and the worker
 * validate this before connecting to anything), so a half-configured deployment never runs.
 * When enabled, token encryption is required as well (see src/utils/tokenCrypto.js).
 *
 * Error messages name variables, never their values.
 */

export const GOOGLE_OAUTH_ENV_VARS = Object.freeze([
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
]);

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Least privilege: identify the account (openid, email) and send mail. No read access. */
export const GOOGLE_OAUTH_SCOPES = Object.freeze(['openid', 'email', GMAIL_SEND_SCOPE]);

export const GOOGLE_ENDPOINTS = Object.freeze({
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  gmailSend: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
});

export const GOOGLE_ID_TOKEN_ISSUERS = Object.freeze(['https://accounts.google.com', 'accounts.google.com']);

export class GoogleOAuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleOAuthConfigError';
    this.code = 'GOOGLE_OAUTH_CONFIG';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const read = (env, name) => (typeof env[name] === 'string' ? env[name].trim() : '');

/**
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {null | { clientId: string, clientSecret: string, redirectUri: string }}
 * @throws {GoogleOAuthConfigError}
 */
export const getGoogleOAuthConfig = (env = process.env) => {
  const values = Object.fromEntries(GOOGLE_OAUTH_ENV_VARS.map((name) => [name, read(env, name)]));
  const missing = GOOGLE_OAUTH_ENV_VARS.filter((name) => !values[name]);
  if (missing.length === GOOGLE_OAUTH_ENV_VARS.length) return null;
  if (missing.length > 0) {
    throw new GoogleOAuthConfigError(
      `Google OAuth configuration error: ${missing.join(', ')} must also be set (or none of the GOOGLE_OAUTH_* variables).`
    );
  }

  const clientId = values.GOOGLE_OAUTH_CLIENT_ID;
  if (clientId.length > 255 || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new GoogleOAuthConfigError(
      'Google OAuth configuration error: GOOGLE_OAUTH_CLIENT_ID must be a Google OAuth client ID (ending in .apps.googleusercontent.com).'
    );
  }

  const clientSecret = values.GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientSecret.length < 8 || clientSecret.length > 255 || /\s/.test(clientSecret)) {
    throw new GoogleOAuthConfigError('Google OAuth configuration error: GOOGLE_OAUTH_CLIENT_SECRET is not valid.');
  }

  let url;
  try {
    url = new URL(values.GOOGLE_OAUTH_REDIRECT_URI);
  } catch {
    throw new GoogleOAuthConfigError('Google OAuth configuration error: GOOGLE_OAUTH_REDIRECT_URI must be an absolute URL.');
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new GoogleOAuthConfigError(
      'Google OAuth configuration error: GOOGLE_OAUTH_REDIRECT_URI must use https (http is allowed only for localhost).'
    );
  }
  if (loopback && env.NODE_ENV === 'production') {
    throw new GoogleOAuthConfigError('Google OAuth configuration error: GOOGLE_OAUTH_REDIRECT_URI must use https in production.');
  }
  if (url.username || url.password || url.hash) {
    throw new GoogleOAuthConfigError(
      'Google OAuth configuration error: GOOGLE_OAUTH_REDIRECT_URI must not contain credentials or a fragment.'
    );
  }

  // Kept exactly as configured: Google compares it character for character with the registered URI
  return Object.freeze({ clientId, clientSecret, redirectUri: values.GOOGLE_OAUTH_REDIRECT_URI });
};

/** True when Google OAuth (and therefore Gmail sending) is configured. Throws if misconfigured. */
export const isGoogleOAuthEnabled = (env = process.env) => getGoogleOAuthConfig(env) !== null;

/**
 * Startup check for the API and the worker.
 * @returns {{ enabled: boolean }}
 * @throws {GoogleOAuthConfigError}
 */
export const validateGoogleOAuthConfig = (env = process.env) => ({ enabled: getGoogleOAuthConfig(env) !== null });

export default {
  GOOGLE_OAUTH_ENV_VARS,
  GOOGLE_OAUTH_SCOPES,
  GMAIL_SEND_SCOPE,
  GOOGLE_ENDPOINTS,
  getGoogleOAuthConfig,
  isGoogleOAuthEnabled,
  validateGoogleOAuthConfig,
};
