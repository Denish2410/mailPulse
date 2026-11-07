/**
 * Pure helpers for the template library and merge tags (Phase 10).
 */

export const MERGE_TAG_OPTIONS = Object.freeze([
  { tag: 'name', label: 'Full name', example: 'Ada Lovelace' },
  { tag: 'firstName', label: 'First name', example: 'Ada' },
  { tag: 'lastName', label: 'Last name', example: 'Lovelace' },
  { tag: 'email', label: 'Email', example: 'ada@example.com' },
]);

/**
 * Builds the merge tag snippet to insert, e.g. `{{firstName | "there"}}`.
 *
 * @param {string} tag
 * @param {string} [fallback]
 * @returns {string}
 */
export const formatMergeTag = (tag, fallback = '') => {
  const cleanFallback = typeof fallback === 'string' ? fallback.replace(/["{}]/g, '').trim() : '';
  return cleanFallback ? `{{${tag} | "${cleanFallback}"}}` : `{{${tag}}}`;
};

/**
 * Builds `{{custom.<name> | "fallback"}}`-style tags; returns '' for invalid field names.
 */
export const formatCustomMergeTag = (name, fallback = '') => {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9_]{0,29}$/.test(key)) return '';
  return formatMergeTag(`custom.${key}`, fallback);
};

/**
 * Inserts text into a value at the given selection range (clamped to valid bounds).
 *
 * @param {string} value
 * @param {string} insertion
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{ value: string, cursor: number }}
 */
export const insertAtSelection = (value, insertion, start, end) => {
  const base = typeof value === 'string' ? value : '';
  const from = Number.isInteger(start) ? Math.min(Math.max(start, 0), base.length) : base.length;
  const to = Number.isInteger(end) ? Math.min(Math.max(end, from), base.length) : from;
  return {
    value: base.slice(0, from) + insertion + base.slice(to),
    cursor: from + insertion.length,
  };
};

/**
 * Validates the template form. Returns an object of field errors (empty when valid).
 *
 * @param {{ name?: string, subject?: string, textContent?: string, htmlContent?: string }} form
 * @returns {Record<string, string>}
 */
export const validateTemplateForm = (form = {}) => {
  const errors = {};
  const name = typeof form.name === 'string' ? form.name.trim() : '';
  if (name.length < 2) errors.name = 'Template name must be at least 2 characters long.';
  else if (name.length > 120) errors.name = 'Template name cannot exceed 120 characters.';

  if ((form.subject ?? '').trim().length > 200) errors.subject = 'Subject cannot exceed 200 characters.';
  if ((form.textContent ?? '').length > 100000) errors.textContent = 'Plain text cannot exceed 100,000 characters.';
  if ((form.htmlContent ?? '').length > 500000) errors.htmlContent = 'HTML cannot exceed 500,000 characters.';
  return errors;
};

/**
 * Maps a template into campaign-form field values (copy semantics; no live link).
 *
 * @param {object|null} template
 * @returns {{ subject: string, textContent: string, htmlContent: string }}
 */
export const templateToCampaignFields = (template) => ({
  subject: typeof template?.subject === 'string' ? template.subject : '',
  textContent: typeof template?.textContent === 'string' ? template.textContent : '',
  htmlContent: typeof template?.htmlContent === 'string' ? template.htmlContent : '',
});

/**
 * Friendly message for template API failures.
 */
export const getTemplateErrorMessage = (error) => {
  switch (error?.response?.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 404:
      return 'This template no longer exists. Refresh and try again.';
    case 409:
      return error?.response?.data?.message || 'A template with this name already exists.';
    default:
      return 'Something went wrong while saving the template. Please try again.';
  }
};
