import apiClient, { getErrorMessage } from '../lib/api.js';

/**
 * Segments API Service (Phase 11)
 *
 * - GET    /segments            List segments
 * - GET    /segments/:id        Retrieve one
 * - POST   /segments            Create
 * - PATCH  /segments/:id        Update
 * - DELETE /segments/:id        Delete
 * - GET    /segments/:id/preview   Count + sample for a saved segment
 * - POST   /segments/preview       Count + sample for unsaved criteria
 */

export const getSegments = async (params = {}, config = {}) => {
  const queryParams = {};
  const page = Number(params.page);
  if (Number.isInteger(page) && page >= 1) queryParams.page = page;
  const limit = Number(params.limit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 100) queryParams.limit = limit;
  if (typeof params.search === 'string' && params.search.trim()) queryParams.search = params.search.trim();

  const response = await apiClient.get('/segments', { params: queryParams, ...config });
  return response.data?.data;
};

export const getSegmentById = async (id, config = {}) => {
  const response = await apiClient.get(`/segments/${id}`, config);
  return response.data?.data?.segment;
};

export const createSegment = async (payload, config = {}) => {
  const response = await apiClient.post('/segments', payload, config);
  return response.data?.data?.segment;
};

export const updateSegment = async (id, payload, config = {}) => {
  const response = await apiClient.patch(`/segments/${id}`, payload, config);
  return response.data?.data?.segment;
};

export const deleteSegment = async (id, config = {}) => {
  const response = await apiClient.delete(`/segments/${id}`, config);
  return response.data;
};

export const previewSegment = async (id, config = {}) => {
  const response = await apiClient.get(`/segments/${id}/preview`, config);
  return response.data?.data?.preview;
};

export const previewSegmentCriteria = async (criteria, config = {}) => {
  const response = await apiClient.post('/segments/preview', { criteria }, config);
  return response.data?.data?.preview;
};

export { getErrorMessage };

export default {
  getSegments,
  getSegmentById,
  createSegment,
  updateSegment,
  deleteSegment,
  previewSegment,
  previewSegmentCriteria,
  getErrorMessage,
};
