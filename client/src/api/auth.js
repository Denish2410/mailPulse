import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Authentication API Service
 *
 * Communicates with MailPulse backend authentication endpoints:
 * - POST /auth/register: Create new account and receive initial access token
 * - POST /auth/login: Authenticate credentials and receive access token
 * - GET  /auth/me: Retrieve current authenticated user's safe profile
 */

/**
 * Register a new user account.
 *
 * @param {{ name: string, email: string, password: string }} credentials
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ user: object, token: string, tokenType: string, expiresIn: string }>}
 */
export const registerUser = async ({ name, email, password }, config = {}) => {
  const response = await apiClient.post(
    '/auth/register',
    {
      name: name?.trim(),
      email: email?.trim(),
      password,
    },
    { skipAuth: true, ...config }
  );
  return response.data?.data;
};

/**
 * Authenticate an existing user with email and password.
 *
 * @param {{ email: string, password: string }} credentials
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<{ user: object, token: string, tokenType: string, expiresIn: string }>}
 */
export const loginUser = async ({ email, password }, config = {}) => {
  const response = await apiClient.post(
    '/auth/login',
    {
      email: email?.trim(),
      password,
    },
    { skipAuth: true, ...config }
  );
  return response.data?.data;
};

/**
 * Fetch the profile of the currently authenticated user.
 * Protected endpoint; Bearer token is automatically attached via request interceptor.
 *
 * @param {import('axios').AxiosRequestConfig} [config={}]
 * @returns {Promise<object>} Safe user profile object
 */
export const getCurrentUser = async (config = {}) => {
  const response = await apiClient.get('/auth/me', config);
  return response.data?.data?.user;
};

export { getErrorMessage };

export default {
  registerUser,
  loginUser,
  getCurrentUser,
  getErrorMessage,
};
