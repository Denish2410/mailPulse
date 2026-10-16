import apiClient from '../lib/api.js';

/**
 * Health API module for MailPulse.
 * Communicates with backend health probe endpoints:
 * - GET /health (Liveness)
 * - GET /health/ready (Readiness)
 */

/**
 * Fetches the backend liveness status.
 * Verifies that the Express server process is running and accepting traffic.
 *
 * @param {import('axios').AxiosRequestConfig} [config={}] - Optional Axios request configuration (e.g. AbortSignal)
 * @returns {Promise<object>} The liveness health response data
 */
export const getLiveness = async (config = {}) => {
  const response = await apiClient.get('/health', config);
  return response.data;
};

/**
 * Fetches the backend readiness status.
 * Verifies that the API can successfully query MongoDB.
 * Note: Status 503 is treated as an informative response (not ready) rather than a transport error.
 *
 * @param {import('axios').AxiosRequestConfig} [config={}] - Optional Axios request configuration (e.g. AbortSignal)
 * @returns {Promise<object>} The readiness health response data
 */
export const getReadiness = async (config = {}) => {
  const response = await apiClient.get('/health/ready', {
    validateStatus: (status) => (status >= 200 && status < 300) || status === 503,
    ...config,
  });
  return response.data;
};

/**
 * Checks both liveness and readiness concurrently.
 *
 * @param {import('axios').AxiosRequestConfig} [config={}] - Optional Axios request configuration
 * @returns {Promise<{ liveness: object|null, readiness: object|null, error: Error|null }>} Combined health status
 */
export const checkHealth = async (config = {}) => {
  const [livenessResult, readinessResult] = await Promise.allSettled([
    getLiveness(config),
    getReadiness(config),
  ]);

  return {
    liveness: livenessResult.status === 'fulfilled' ? livenessResult.value : null,
    readiness: readinessResult.status === 'fulfilled' ? readinessResult.value : null,
    error:
      livenessResult.status === 'rejected'
        ? livenessResult.reason
        : readinessResult.status === 'rejected'
        ? readinessResult.reason
        : null,
  };
};

export default {
  getLiveness,
  getReadiness,
  checkHealth,
};
