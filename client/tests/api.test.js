import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveApiBaseUrl, apiClient, API_BASE_URL } from '../src/lib/api.js';
import { getLiveness, getReadiness, checkHealth } from '../src/api/health.js';

describe('Frontend API Client & Configuration', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('resolveApiBaseUrl', () => {
    it('should return default localhost URL when no environment variable is provided', () => {
      const url = resolveApiBaseUrl('');
      assert.equal(url, 'http://localhost:5000/api/v1');
    });

    it('should resolve and trim a valid custom HTTP/HTTPS URL', () => {
      const customUrl = '  https://api.mailpulse.test/api/v1  ';
      const resolved = resolveApiBaseUrl(customUrl);
      assert.equal(resolved, 'https://api.mailpulse.test/api/v1');
    });

    it('should allow relative root path configuration', () => {
      const rootPath = '/api/v1';
      const resolved = resolveApiBaseUrl(rootPath);
      assert.equal(resolved, '/api/v1');
    });

    it('should fall back to default when input is whitespace only', () => {
      const resolved = resolveApiBaseUrl('   ');
      assert.equal(resolved, 'http://localhost:5000/api/v1');
    });

    it('should warn and fall back to default when an invalid URL scheme is passed', () => {
      const invalidUrl = 'ftp://invalid-server/api';
      const resolved = resolveApiBaseUrl(invalidUrl);
      assert.equal(resolved, 'http://localhost:5000/api/v1');
    });
  });

  describe('apiClient instance configuration', () => {
    it('should have a valid baseURL configured', () => {
      assert.ok(apiClient.defaults.baseURL);
      assert.equal(apiClient.defaults.baseURL, API_BASE_URL);
    });

    it('should set request timeout to 10000ms', () => {
      assert.equal(apiClient.defaults.timeout, 10000);
    });

    it('should set expected JSON request headers', () => {
      assert.equal(apiClient.defaults.headers['Content-Type'], 'application/json');
      assert.equal(apiClient.defaults.headers['Accept'], 'application/json');
    });
  });

  describe('Health API functions', () => {
    it('getLiveness should call GET /health and return data', async () => {
      const mockResponse = {
        data: {
          success: true,
          service: 'MailPulse API',
          status: 'healthy',
          uptime: '120s',
          database: { status: 'connected', connected: true },
        },
      };

      const getMock = mock.method(apiClient, 'get', async (url) => {
        assert.equal(url, '/health');
        return mockResponse;
      });

      const result = await getLiveness();
      assert.equal(getMock.mock.callCount(), 1);
      assert.deepEqual(result, mockResponse.data);
    });

    it('getLiveness should forward request configuration (like AbortSignal)', async () => {
      const controller = new AbortController();
      let capturedConfig = null;

      mock.method(apiClient, 'get', async (url, config) => {
        capturedConfig = config;
        return { data: { success: true } };
      });

      await getLiveness({ signal: controller.signal });
      assert.equal(capturedConfig?.signal, controller.signal);
    });

    it('getLiveness should propagate network errors', async () => {
      mock.method(apiClient, 'get', async () => {
        const error = new Error('Network Error');
        error.code = 'ERR_NETWORK';
        throw error;
      });

      await assert.rejects(
        async () => {
          await getLiveness();
        },
        { code: 'ERR_NETWORK', message: 'Network Error' }
      );
    });

    it('getReadiness should call GET /health/ready and return readiness data', async () => {
      const mockReadyResponse = {
        data: {
          success: true,
          service: 'MailPulse API',
          status: 'ready',
          database: { status: 'connected', connected: true, responseTimeMs: 2 },
        },
      };

      const getMock = mock.method(apiClient, 'get', async (url, config) => {
        assert.equal(url, '/health/ready');
        // Verify custom validateStatus allows status 503
        assert.equal(typeof config.validateStatus, 'function');
        assert.equal(config.validateStatus(200), true);
        assert.equal(config.validateStatus(503), true);
        assert.equal(config.validateStatus(500), false);
        return mockReadyResponse;
      });

      const result = await getReadiness();
      assert.equal(getMock.mock.callCount(), 1);
      assert.deepEqual(result, mockReadyResponse.data);
    });

    it('getReadiness should return database not-ready payload when backend responds with 503', async () => {
      const mock503Response = {
        data: {
          success: false,
          service: 'MailPulse API',
          status: 'not_ready',
          database: { status: 'disconnected', connected: false },
        },
      };

      mock.method(apiClient, 'get', async (url) => {
        assert.equal(url, '/health/ready');
        return mock503Response;
      });

      const result = await getReadiness();
      assert.deepEqual(result, mock503Response.data);
      assert.equal(result.status, 'not_ready');
    });

    it('checkHealth should aggregate liveness and readiness results', async () => {
      const livenessData = { success: true, status: 'healthy', uptime: '45s' };
      const readinessData = { success: true, status: 'ready', database: { connected: true } };

      mock.method(apiClient, 'get', async (url) => {
        if (url === '/health') return { data: livenessData };
        if (url === '/health/ready') return { data: readinessData };
        throw new Error(`Unexpected URL: ${url}`);
      });

      const result = await checkHealth();
      assert.deepEqual(result.liveness, livenessData);
      assert.deepEqual(result.readiness, readinessData);
      assert.equal(result.error, null);
    });

    it('checkHealth should capture error when endpoint fails', async () => {
      mock.method(apiClient, 'get', async (url) => {
        if (url === '/health') {
          const err = new Error('Connection refused');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return { data: { success: false } };
      });

      const result = await checkHealth();
      assert.equal(result.liveness, null);
      assert.ok(result.error);
      assert.equal(result.error.code, 'ECONNREFUSED');
    });
  });
});
