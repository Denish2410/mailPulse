/**
 * Token Storage Service
 *
 * Centralizes access to the authentication access token.
 * Uses browser `sessionStorage` so that the token is scoped strictly to the current
 * browser tab/session and automatically clears when the tab/window is closed.
 *
 * Security Notice:
 * Tokens stored in sessionStorage are accessible via JavaScript and therefore vulnerable
 * to extraction if a Cross-Site Scripting (XSS) vulnerability is present.
 * An HttpOnly-cookie based authentication architecture may be considered in later security phases.
 * Sensitive data such as raw passwords or hashes are NEVER stored in browser storage.
 */

const TOKEN_KEY = 'mailpulse_access_token';

// In-memory fallback for non-browser environments (e.g. Node.js test runner)
let memoryToken = null;

const isStorageAvailable = () => {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
};

/**
 * Retrieve the current access token.
 * @returns {string|null} The token string or null if not stored.
 */
export const getToken = () => {
  try {
    if (isStorageAvailable()) {
      return window.sessionStorage.getItem(TOKEN_KEY);
    }
  } catch {
    // Fallback if sessionStorage access is blocked by browser security sandbox
  }
  return memoryToken;
};

/**
 * Store the access token.
 * @param {string} token - JWT access token
 */
export const setToken = (token) => {
  if (!token || typeof token !== 'string') return;
  const trimmed = token.trim();
  try {
    if (isStorageAvailable()) {
      window.sessionStorage.setItem(TOKEN_KEY, trimmed);
      return;
    }
  } catch {
    // Fallback to memory
  }
  memoryToken = trimmed;
};

/**
 * Remove the stored access token.
 */
export const clearToken = () => {
  try {
    if (isStorageAvailable()) {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Fallback
  }
  memoryToken = null;
};

/**
 * Check whether a token is present in storage.
 * Note: Does not verify token validity or signature.
 * @returns {boolean}
 */
export const hasToken = () => {
  return Boolean(getToken());
};

export default {
  getToken,
  setToken,
  clearToken,
  hasToken,
};
