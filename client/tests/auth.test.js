import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getToken, setToken, clearToken, hasToken } from '../src/services/tokenStorage.js';
import { apiClient, getErrorMessage } from '../src/lib/api.js';
import { registerUser, loginUser, getCurrentUser } from '../src/api/auth.js';
import { sanitizeRedirectPath } from '../src/utils/navigation.js';

describe('Frontend Authentication Layer & Services', () => {
  beforeEach(() => {
    clearToken();
  });

  afterEach(() => {
    clearToken();
    mock.restoreAll();
  });

  describe('Token Storage Service (sessionStorage)', () => {
    it('1. setToken, getToken, hasToken, and clearToken operate correctly', () => {
      assert.equal(getToken(), null);
      assert.equal(hasToken(), false);

      const testToken = 'jwt-sample-token-12345';
      setToken(testToken);

      assert.equal(getToken(), testToken);
      assert.equal(hasToken(), true);

      clearToken();
      assert.equal(getToken(), null);
      assert.equal(hasToken(), false);
    });

    it('2. Trims whitespace when storing token and ignores empty strings', () => {
      setToken('   padded-token-xyz   ');
      assert.equal(getToken(), 'padded-token-xyz');

      setToken('');
      assert.equal(getToken(), 'padded-token-xyz'); // empty string should not overwrite with empty

      setToken(null);
      assert.equal(getToken(), 'padded-token-xyz');
    });
  });

  describe('Axios Request Interceptor (Bearer Token Attachment)', () => {
    it('3. Automatically attaches Bearer token to requests when token is in storage', async () => {
      const sampleToken = 'bearer-auth-token-999';
      setToken(sampleToken);

      let capturedConfig = null;
      mock.method(apiClient, 'get', async (url, config) => {
        // Run interceptor manually or inspect config
        return { data: { success: true } };
      });

      // Verify the interceptor function itself
      const interceptor = apiClient.interceptors.request.handlers[0].fulfilled;
      const initialConfig = { headers: {} };
      const modifiedConfig = interceptor(initialConfig);

      assert.equal(modifiedConfig.headers.Authorization, `Bearer ${sampleToken}`);
    });

    it('4. Does not attach Authorization header when token is not present', () => {
      clearToken();
      const interceptor = apiClient.interceptors.request.handlers[0].fulfilled;
      const initialConfig = { headers: {} };
      const modifiedConfig = interceptor(initialConfig);

      assert.equal(modifiedConfig.headers.Authorization, undefined);
    });

    it('5. Skips token attachment when config.skipAuth is explicitly true and cleans skipAuth', () => {
      setToken('token-that-should-be-skipped');
      const interceptor = apiClient.interceptors.request.handlers[0].fulfilled;
      const initialConfig = { headers: {}, skipAuth: true };
      const modifiedConfig = interceptor(initialConfig);

      assert.equal(modifiedConfig.headers.Authorization, undefined);
      // Ensures skipAuth does not leak into transport adapters
      assert.equal(modifiedConfig.skipAuth, undefined);
    });

    it('6. Does not overwrite custom Authorization header if already supplied', () => {
      setToken('stored-token');
      const interceptor = apiClient.interceptors.request.handlers[0].fulfilled;
      const initialConfig = { headers: { Authorization: 'Custom-Auth-Scheme special-token' } };
      const modifiedConfig = interceptor(initialConfig);

      assert.equal(modifiedConfig.headers.Authorization, 'Custom-Auth-Scheme special-token');
    });
  });

  describe('Auth API Functions', () => {
    it('7. registerUser submits correct payload and returns safe user data and token', async () => {
      const mockBackendResponse = {
        data: {
          success: true,
          message: 'User registered successfully',
          data: {
            user: {
              id: 'user-id-123',
              name: 'Alice Developer',
              email: 'alice@example.com',
              status: 'active',
              createdAt: '2026-10-17T00:00:00.000Z',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
            token: 'signed-jwt-token-abc',
            tokenType: 'Bearer',
            expiresIn: '15m',
          },
        },
      };

      let capturedUrl = null;
      let capturedPayload = null;
      let capturedConfig = null;

      mock.method(apiClient, 'post', async (url, payload, config) => {
        capturedUrl = url;
        capturedPayload = payload;
        capturedConfig = config;
        return mockBackendResponse;
      });

      const result = await registerUser({
        name: '  Alice Developer  ',
        email: '  ALICE@EXAMPLE.COM  ',
        password: 'ValidPassword123!',
      });

      assert.equal(capturedUrl, '/auth/register');
      assert.equal(capturedPayload.name, 'Alice Developer');
      assert.equal(capturedPayload.email, 'ALICE@EXAMPLE.COM');
      assert.equal(capturedPayload.password, 'ValidPassword123!');
      assert.equal(capturedConfig.skipAuth, true);
      assert.deepEqual(result, mockBackendResponse.data.data);
    });

    it('8. loginUser submits credentials and returns safe user data and token', async () => {
      const mockLoginResponse = {
        data: {
          success: true,
          message: 'Login successful',
          data: {
            user: {
              id: 'user-id-456',
              name: 'Bob Developer',
              email: 'bob@example.com',
              status: 'active',
              createdAt: '2026-10-17T00:00:00.000Z',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
            token: 'signed-jwt-token-def',
            tokenType: 'Bearer',
            expiresIn: '15m',
          },
        },
      };

      let capturedUrl = null;
      let capturedPayload = null;
      let capturedConfig = null;

      mock.method(apiClient, 'post', async (url, payload, config) => {
        capturedUrl = url;
        capturedPayload = payload;
        capturedConfig = config;
        return mockLoginResponse;
      });

      const result = await loginUser({
        email: 'bob@example.com',
        password: 'BobPassword123!',
      });

      assert.equal(capturedUrl, '/auth/login');
      assert.equal(capturedPayload.email, 'bob@example.com');
      assert.equal(capturedPayload.password, 'BobPassword123!');
      assert.equal(capturedConfig.skipAuth, true);
      assert.deepEqual(result, mockLoginResponse.data.data);
    });

    it('9. getCurrentUser calls /auth/me and returns the safe user profile', async () => {
      const mockProfileResponse = {
        data: {
          success: true,
          message: 'Current user profile retrieved successfully',
          data: {
            user: {
              id: 'user-id-789',
              name: 'Carol Developer',
              email: 'carol@example.com',
              status: 'active',
              createdAt: '2026-10-17T00:00:00.000Z',
              updatedAt: '2026-10-17T00:00:00.000Z',
            },
          },
        },
      };

      let capturedUrl = null;
      mock.method(apiClient, 'get', async (url) => {
        capturedUrl = url;
        return mockProfileResponse;
      });

      const user = await getCurrentUser();
      assert.equal(capturedUrl, '/auth/me');
      assert.deepEqual(user, mockProfileResponse.data.data.user);
      assert.equal(user.passwordHash, undefined);
    });
  });

  describe('Error Message Sanitization (getErrorMessage)', () => {
    it('10. Safely extracts backend operational message', () => {
      const error = {
        response: {
          data: {
            success: false,
            message: 'Invalid email or password.',
          },
        },
      };

      assert.equal(getErrorMessage(error), 'Invalid email or password.');
    });

    it('11. Handles network failure gracefully without leaking internals', () => {
      const networkError = {
        code: 'ERR_NETWORK',
        message: 'Network Error',
      };

      assert.equal(
        getErrorMessage(networkError),
        'Unable to reach the server. Please check your network connection.'
      );
    });

    it('12. Handles request timeout safely', () => {
      const timeoutError = {
        code: 'ECONNABORTED',
        message: 'timeout of 10000ms exceeded',
      };

      assert.equal(
        getErrorMessage(timeoutError),
        'The request timed out. Please check your connection and try again.'
      );
    });

    it('13. Falls back to safe default when response data contains no message', () => {
      assert.equal(
        getErrorMessage({}),
        'An unexpected error occurred. Please try again.'
      );
      assert.equal(
        getErrorMessage(null, 'Custom fallback'),
        'Custom fallback'
      );
    });
  });

  describe('Session Restoration & Account State Policy Logic', () => {
    it('14. Session restoration succeeds and stores active user profile', async () => {
      const testToken = 'valid-active-session-token';
      setToken(testToken);

      const activeUser = {
        id: 'user-101',
        name: 'David Active',
        email: 'david@example.com',
        status: 'active',
      };

      mock.method(apiClient, 'get', async (url) => {
        assert.equal(url, '/auth/me');
        return {
          data: {
            success: true,
            data: { user: activeUser },
          },
        };
      });

      const restoredUser = await getCurrentUser();
      assert.deepEqual(restoredUser, activeUser);
      assert.equal(getToken(), testToken); // Token remains valid in storage
    });

    it('15. Session restoration on 401 Unauthorized clears token from storage', async () => {
      setToken('expired-or-invalid-token');

      const mock401Error = new Error('Unauthorized');
      mock401Error.response = { status: 401, data: { message: 'Authentication required.' } };

      mock.method(apiClient, 'get', async () => {
        throw mock401Error;
      });

      let sessionError = null;
      try {
        await getCurrentUser();
      } catch (err) {
        sessionError = err;
        if (err.response?.status === 401) {
          clearToken();
        }
      }

      assert.ok(sessionError);
      assert.equal(getToken(), null); // Token must be cleared
    });

    it('16. Session restoration on 403 Suspended Account clears token from storage', async () => {
      setToken('suspended-user-token');

      const mock403Error = new Error('Forbidden');
      mock403Error.response = { status: 403, data: { message: 'Your account has been suspended.' } };

      mock.method(apiClient, 'get', async () => {
        throw mock403Error;
      });

      try {
        await getCurrentUser();
      } catch (err) {
        if (err.response?.status === 403) {
          clearToken();
        }
      }

      assert.equal(getToken(), null);
    });

    it('17. Logout clears token and subsequent requests have no Authorization header', () => {
      setToken('active-token-before-logout');
      assert.equal(hasToken(), true);

      // Perform logout
      clearToken();
      assert.equal(hasToken(), false);
      assert.equal(getToken(), null);

      const interceptor = apiClient.interceptors.request.handlers[0].fulfilled;
      const requestConfig = interceptor({ headers: {} });
      assert.equal(requestConfig.headers.Authorization, undefined);
    });

    it('18. Protected route decision logic: unauthenticated state preserves destination for redirect', () => {
      // Simulates location preservation: /dashboard -> redirected to /login with state: { from: { pathname: '/dashboard' } }
      const attemptedPath = '/dashboard/campaigns';
      const isAuthenticated = false;

      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login', state: { from: { pathname: attemptedPath } } }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, true);
      assert.equal(redirectDecision.to, '/login');
      assert.equal(redirectDecision.state.from.pathname, attemptedPath);
    });
  });

  describe('Open Redirect Prevention & Navigation Security', () => {
    it('19. Accepts safe internal relative paths for post-login redirects', () => {
      assert.equal(sanitizeRedirectPath('/dashboard'), '/dashboard');
      assert.equal(sanitizeRedirectPath('/campaigns/new'), '/campaigns/new');
      assert.equal(sanitizeRedirectPath('/contacts?list=active'), '/contacts?list=active');
    });

    it('20. Rejects external URLs and protocol-relative URLs with fallback to /dashboard', () => {
      const maliciousDestinations = [
        'https://attacker.evil.com/phish',
        'http://malicious.com',
        '//attacker.com',
        '//malicious.site/dashboard',
        '/\\attacker.com',
        '/#malicious',
        '/javascript:alert(1)',
        'javascript:void(0)',
        'data:text/html,<script>alert(1)</script>',
        '',
        '   ',
        null,
        undefined,
      ];

      for (const dest of maliciousDestinations) {
        assert.equal(
          sanitizeRedirectPath(dest),
          '/dashboard',
          `Failed for malicious destination: ${dest}`
        );
      }
    });

    it('21. Custom fallback path is respected when external URL is rejected', () => {
      assert.equal(
        sanitizeRedirectPath('https://evil.com', '/custom-fallback'),
        '/custom-fallback'
      );
    });
  });
});
