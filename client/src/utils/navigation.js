/**
 * Navigation & Redirect Security Utilities
 *
 * Prevents Open Redirect vulnerabilities by strictly sanitizing target destination paths.
 * Validates that destinations are internal relative paths starting with a single '/'
 * and rejects external URLs, protocol-relative URLs (e.g. '//evil.com'),
 * backslashes (e.g. '/\\evil.com'), and URI schemes (e.g. 'javascript:', 'data:', 'http:').
 */

/**
 * Sanitizes a post-login or redirection path to guarantee it points to an internal route.
 *
 * @param {string|unknown} path - Candidate redirection path
 * @param {string} [defaultPath='/dashboard'] - Safe internal fallback path
 * @returns {string} Sanitized internal path
 */
export const sanitizeRedirectPath = (path, defaultPath = '/dashboard') => {
  if (typeof path !== 'string' || !path.trim()) {
    return defaultPath;
  }

  const trimmed = path.trim();

  // 1. Must begin with a leading slash
  if (!trimmed.startsWith('/')) {
    return defaultPath;
  }

  // 2. Reject protocol-relative URLs (e.g., '//attacker.com' or '/\attacker.com')
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.startsWith('/#')) {
    return defaultPath;
  }

  // 3. Reject embedded URI schemes (e.g., '/http://...', '/javascript:...')
  if (/^\/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return defaultPath;
  }

  // 4. Reject CR/LF control characters
  if (/[\r\n]/.test(trimmed)) {
    return defaultPath;
  }

  return trimmed;
};

export default {
  sanitizeRedirectPath,
};
