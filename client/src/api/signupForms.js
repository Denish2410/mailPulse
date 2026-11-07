import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Signup forms API (owner management) and public subscribe API (no auth).
 */

export const getSignupForms = async (config = {}) => {
  const response = await apiClient.get('/signup-forms', config);
  return response.data?.data?.forms ?? [];
};

export const createSignupForm = async (payload, config = {}) => {
  const response = await apiClient.post('/signup-forms', payload, config);
  return response.data?.data?.form;
};

export const updateSignupForm = async (id, payload, config = {}) => {
  const response = await apiClient.patch(`/signup-forms/${id}`, payload, config);
  return response.data?.data?.form;
};

export const deleteSignupForm = async (id, config = {}) => {
  const response = await apiClient.delete(`/signup-forms/${id}`, config);
  return response.data;
};

/** Public: fetch a form's name and description. */
export const getPublicForm = async (slug, config = {}) => {
  const response = await apiClient.get(`/public/forms/${slug}`, { skipAuth: true, ...config });
  return response.data?.data?.form;
};

/** Public: request a subscription (the server always answers the same way). */
export const subscribeToPublicForm = async (slug, { email, name, website } = {}, config = {}) => {
  const body = { email: typeof email === 'string' ? email.trim() : email };
  if (typeof name === 'string' && name.trim()) body.name = name.trim();
  if (website) body.website = website;
  const response = await apiClient.post(`/public/forms/${slug}/subscribe`, body, { skipAuth: true, ...config });
  return response.data;
};

/** Public: confirm a subscription from the emailed token. */
export const confirmSubscription = async (token, config = {}) => {
  const response = await apiClient.post('/public/subscriptions/confirm', { token }, { skipAuth: true, ...config });
  return response.data?.data;
};

export { getErrorMessage };

export default {
  getSignupForms,
  createSignupForm,
  updateSignupForm,
  deleteSignupForm,
  getPublicForm,
  subscribeToPublicForm,
  confirmSubscription,
  getErrorMessage,
};
