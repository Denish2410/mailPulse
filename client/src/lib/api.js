import axios from 'axios';

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

export default apiClient;
