import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Templates API Service (Phase 10)
 *
 * - GET    /templates: List templates (page, limit, search)
 * - GET    /templates/:id: Retrieve one template
 * - POST   /templates: Create a template
 * - PATCH  /templates/:id: Update a template
 * - DELETE /templates/:id: Delete a template
 */

export const getTemplates = async (params = {}, config = {}) => {
  const queryParams = {};

  const page = Number(params.page);
  if (Number.isInteger(page) && page >= 1) queryParams.page = page;

  const limit = Number(params.limit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) queryParams.limit = limit;

  if (typeof params.search === 'string' && params.search.trim()) {
    queryParams.search = params.search.trim();
  }

  const response = await apiClient.get('/templates', { params: queryParams, ...config });
  return response.data?.data;
};

export const getTemplateById = async (id, config = {}) => {
  const response = await apiClient.get(`/templates/${id}`, config);
  return response.data?.data?.template;
};

export const createTemplate = async (payload, config = {}) => {
  const response = await apiClient.post('/templates', payload, config);
  return response.data?.data?.template;
};

export const updateTemplate = async (id, payload, config = {}) => {
  const response = await apiClient.patch(`/templates/${id}`, payload, config);
  return response.data?.data?.template;
};

export const deleteTemplate = async (id, config = {}) => {
  const response = await apiClient.delete(`/templates/${id}`, config);
  return response.data;
};

export { getErrorMessage };

export default {
  getTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getErrorMessage,
};
