import axios from 'axios';
import { getToken } from '../services/tokenStorage.js';

/**
 * Resolves the backend API base URL from Vite environment variables.
 * In Vite, variables must be prefixed with `VITE_` to be exposed to client-side code.
 */
export const resolveApiBaseUrl = (customEnv) => {
  let url = '';

  if (customEnv && typeof customEnv === 'string') {
    url = customEnv;
  } else if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) {
    url = import.meta.env.VITE_API_BASE_URL;
  } else if (typeof process !== 'undefined' && process.env?.VITE_API_BASE_URL) {
    url = process.env.VITE_API_BASE_URL;
  }

  // Handle missing or empty configuration
  if (!url || typeof url !== 'string' || !url.trim()) {
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') {
      console.warn(
        '[MailPulse API] VITE_API_BASE_URL is not set or empty. Defaulting to http://localhost:5000/api/v1'
      );
    }
    return 'http://localhost:5000/api/v1';
  }

  const trimmed = url.trim();

  // Validate format (must be absolute HTTP/HTTPS URL or root path)
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) {
    if (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test') {
      console.warn(
        `[MailPulse API] Invalid VITE_API_BASE_URL ("${trimmed}"). Expected an absolute HTTP/HTTPS URL or root path. Defaulting to http://localhost:5000/api/v1`
      );
    }
    return 'http://localhost:5000/api/v1';
  }

  return trimmed;
};

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Centralized, reusable Axios client instance configured for MailPulse API.
 */
export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000, // 10 second timeout to prevent stalled requests
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

/**
 * Request Interceptor: Automatically attaches Bearer token to authenticated requests.
 * Explicitly skips token attachment when config.skipAuth is true (e.g. login/register/health).
 * Cleans custom skipAuth property so it does not leak into outgoing request configuration.
 */
apiClient.interceptors.request.use((config) => {
  const shouldSkipAuth = Boolean(config.skipAuth);

  // Consume and remove custom option to prevent leaking into transport headers/adapters
  if ('skipAuth' in config) {
    delete config.skipAuth;
  }

  if (!shouldSkipAuth) {
    const token = getToken();
    if (token && !config.headers.Authorization) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

/**
 * Extracts a safe, user-friendly error message from Axios errors.
 * Never leaks internal database traces, raw request bodies, or credentials.
 *
 * @param {any} error
 * @param {string} [fallback='An unexpected error occurred. Please try again.']
 * @returns {string} Sanitized display message
 */
export const getErrorMessage = (error, fallback = 'An unexpected error occurred. Please try again.') => {
  if (!error) return fallback;

  if (error.response?.data?.message && typeof error.response.data.message === 'string') {
    return error.response.data.message;
  }

  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return 'The request timed out. Please check your connection and try again.';
  }

  if (error.message === 'Network Error' || error.code === 'ERR_NETWORK') {
    return 'Unable to reach the server. Please check your network connection.';
  }

  return fallback;
};

export default apiClient;

