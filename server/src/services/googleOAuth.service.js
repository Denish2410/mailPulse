import crypto from 'node:crypto';
import {
  GOOGLE_ENDPOINTS,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_ID_TOKEN_ISSUERS,
  GMAIL_SEND_SCOPE,
} from '../config/googleOAuth.js';

/**
 * Google OAuth 2.0 client (authorization code flow with PKCE, refresh, revoke).
 *
 * - Uses Node's built-in fetch with a timeout; no SDK dependency.
 * - Outbound requests are refused in NODE_ENV=test unless a fake HTTP client is injected
 *   (setGoogleHttpClient), so tests can never reach Google.
 * - Errors carry a code and a fixed message. They never include tokens, authorization codes,
 *   client secrets or response bodies; only Google's short error keyword (for example
 *   invalid_grant) is kept, and only if it looks like one.
 */

export class GoogleOAuthError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number|null, googleError?: string|null, retryable?: boolean }} [details]
   */
  constructor(code, message, { status = null, googleError = null, retryable = false } = {}) {
    super(message);
    this.name = 'GoogleOAuthError';
    this.code = code;
    this.status = status;
    this.googleError = googleError;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TOKEN_LENGTH = 4096;

let injectedFetch = null;

/** Injects the HTTP client (tests, or a composition root). Pass null to restore the default. */
export const setGoogleHttpClient = (fetchImpl) => {
  if (fetchImpl !== null && typeof fetchImpl !== 'function') {
    throw new TypeError('Google HTTP client must be a fetch-compatible function or null.');
  }
  injectedFetch = fetchImpl;
};

/** The fetch to use for Google requests. Fails closed in tests without an injected client. */
export const resolveGoogleFetch = (env = process.env) => {
  if (injectedFetch) return injectedFetch;
  if (env.NODE_ENV === 'test') {
    throw new GoogleOAuthError('GOOGLE_HTTP_DISABLED', 'Outbound Google requests are disabled in tests.');
  }
  return globalThis.fetch;
};

// --- State and PKCE ---------------------------------------------------------------------------

/** Unguessable OAuth state value (256 bits). Only its hash is stored. */
export const createOAuthState = () => crypto.randomBytes(32).toString('base64url');
export const hashOAuthState = (state) => crypto.createHash('sha256').update(String(state)).digest('hex');

/** PKCE (RFC 7636, S256): a 64-character verifier and its challenge. */
export const createPkcePair = () => {
  const codeVerifier = crypto.randomBytes(48).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
};

/**
 * Google consent-screen URL. `access_type=offline` and `prompt=consent` make Google return a
 * refresh token on every connection; `include_granted_scopes` is off so the grant holds exactly
 * the scopes asked for here.
 */
export const buildAuthorizationUrl = (config, { state, codeChallenge, loginHint } = {}) => {
  if (!state || !codeChallenge) throw new TypeError('state and codeChallenge are required.');
  const url = new URL(GOOGLE_ENDPOINTS.authorization);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'false');
  if (typeof loginHint === 'string' && loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
};

// --- HTTP -------------------------------------------------------------------------------------

const isTimeout = (error) => error?.name === 'TimeoutError' || error?.name === 'AbortError';

const postForm = async (endpoint, params, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  const doFetch = fetchImpl ?? resolveGoogleFetch();
  let response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof GoogleOAuthError) throw error;
    if (isTimeout(error)) {
      throw new GoogleOAuthError('GOOGLE_TIMEOUT', 'Google did not answer in time.', { retryable: true });
    }
    throw new GoogleOAuthError('GOOGLE_NETWORK', 'Could not reach Google.', { retryable: true });
  }
  let body = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = null;
  }
  return { status: response.status, ok: response.ok, body };
};

const googleErrorKeyword = (body) =>
  typeof body?.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : null;

const errorFromResponse = ({ status, body }) => {
  const googleError = googleErrorKeyword(body);
  if (status >= 500) {
    return new GoogleOAuthError('GOOGLE_SERVER', 'Google is temporarily unavailable.', { status, googleError, retryable: true });
  }
  if (status === 429) {
    return new GoogleOAuthError('GOOGLE_RATE_LIMITED', 'Google is rate limiting requests.', { status, googleError, retryable: true });
  }
  if (googleError === 'invalid_grant') {
    return new GoogleOAuthError('GOOGLE_INVALID_GRANT', 'Google refused the authorization grant.', { status, googleError });
  }
  if (googleError === 'invalid_client' || googleError === 'unauthorized_client') {
    return new GoogleOAuthError('GOOGLE_INVALID_CLIENT', 'Google rejected the OAuth client configuration.', { status, googleError });
  }
  return new GoogleOAuthError('GOOGLE_REQUEST_REJECTED', 'Google rejected the request.', { status, googleError });
};

const badResponse = () => new GoogleOAuthError('GOOGLE_BAD_RESPONSE', 'Google returned an unexpected response.');

const isTokenString = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/\s/.test(value);

/**
 * Validates a token endpoint response.
 * @returns {{ accessToken: string, expiresIn: number, refreshToken: string|null, scopes: string[], idToken: string|null }}
 */
export const parseTokenResponse = (body) => {
  if (!body || typeof body !== 'object') throw badResponse();
  const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope, id_token: idToken, token_type: tokenType } = body;
  if (!isTokenString(accessToken)) throw badResponse();
  if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') throw badResponse();
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 7 * 24 * 3600) throw badResponse();
  if (refreshToken !== undefined && refreshToken !== null && !isTokenString(refreshToken)) throw badResponse();
  if (idToken !== undefined && idToken !== null && (typeof idToken !== 'string' || idToken.length > 8192)) throw badResponse();
  return {
    accessToken,
    expiresIn: seconds,
    refreshToken: refreshToken || null,
    scopes: typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [],
    idToken: idToken || null,
  };
};

export const hasGmailSendScope = (scopes) => Array.isArray(scopes) && scopes.includes(GMAIL_SEND_SCOPE);

/** Exchanges an authorization code (with its PKCE verifier) for tokens. */
export const exchangeAuthorizationCode = async (config, { code, codeVerifier }, options = {}) => {
  const response = await postForm(
    GOOGLE_ENDPOINTS.token,
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    },
    options
  );
  if (!response.ok) throw errorFromResponse(response);
  return parseTokenResponse(response.body);
};

/** Gets a new access token from a refresh token. Google may (rarely) return a new refresh token. */
export const refreshAccessToken = async (config, refreshToken, options = {}) => {
  const response = await postForm(
    GOOGLE_ENDPOINTS.token,
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
    options
  );
  if (!response.ok) throw errorFromResponse(response);
  return parseTokenResponse(response.body);
};

/**
 * Revokes a token (and with it the whole grant). Returns true when Google confirmed it, or said
 * the token was already invalid. Throws GoogleOAuthError otherwise.
 */
export const revokeToken = async (token, options = {}) => {
  const response = await postForm(GOOGLE_ENDPOINTS.revoke, { token }, options);
  if (response.ok) return true;
  if (response.status === 400 && googleErrorKeyword(response.body) === 'invalid_token') return true;
  throw errorFromResponse(response);
};

/**
 * Reads the identity from an ID token received DIRECTLY from Google's token endpoint over TLS.
 * OpenID Connect Core 3.1.3.7 allows relying on the TLS connection instead of the signature in
 * that case; issuer, audience, expiry and the verified-email flag are still checked.
 *
 * @returns {{ sub: string, email: string, name: string }}
 */
export const readIdTokenClaims = (idToken, config, { now = Date.now() } = {}) => {
  const invalid = () => new GoogleOAuthError('GOOGLE_BAD_IDENTITY', 'Google returned an invalid account identity.');
  if (typeof idToken !== 'string') throw invalid();
  const parts = idToken.split('.');
  if (parts.length !== 3) throw invalid();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!claims || typeof claims !== 'object') throw invalid();
  if (!GOOGLE_ID_TOKEN_ISSUERS.includes(claims.iss)) throw invalid();
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.clientId)) throw invalid();
  if (audiences.length > 1 && claims.azp !== config.clientId) throw invalid();
  const skewMs = 5 * 60 * 1000;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now - skewMs) throw invalid();
  if (Number.isFinite(claims.iat) && claims.iat * 1000 > now + skewMs) throw invalid();
  if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw invalid();
  if (typeof claims.email !== 'string' || claims.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) {
    throw invalid();
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw invalid();
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '',
  };
};

export default {
  GoogleOAuthError,
  setGoogleHttpClient,
  resolveGoogleFetch,
  createOAuthState,
  hashOAuthState,
  createPkcePair,
  buildAuthorizationUrl,
  parseTokenResponse,
  hasGmailSendScope,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  readIdTokenClaims,
};
