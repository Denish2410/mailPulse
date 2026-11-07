import { parseTagInput } from './segmentHelpers.js';

/**
 * Pure helpers for signup forms.
 */

/**
 * Public URL a visitor opens to subscribe.
 *
 * @param {string} origin - e.g. window.location.origin
 * @param {string} slug
 */
export const buildPublicFormUrl = (origin, slug) =>
  `${String(origin ?? '').replace(/\/+$/, '')}/subscribe/${slug}`;

/**
 * An HTML snippet owners can paste into their site to link to the form.
 */
export const buildEmbedSnippet = (url, label = 'Subscribe to our newsletter') =>
  `<a href="${String(url).replace(/"/g, '&quot;')}">${String(label).replace(/[<>&]/g, '')}</a>`;

/**
 * Validates the owner's form editor. Returns field errors (empty when valid) and the parsed tags.
 */
export const validateSignupFormInput = ({ name, description, tags } = {}) => {
  const errors = {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 2) errors.name = 'Form name must be at least 2 characters long.';
  else if (trimmed.length > 120) errors.name = 'Form name cannot exceed 120 characters.';
  if (typeof description === 'string' && description.trim().length > 300) {
    errors.description = 'Description cannot exceed 300 characters.';
  }
  const parsed = parseTagInput(tags);
  if (parsed.invalid.length > 0) errors.tags = `Invalid tags: ${parsed.invalid.join(', ')}.`;
  else if (parsed.tags.length > 20) errors.tags = 'At most 20 tags.';
  return { errors, tags: parsed.tags };
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validates the public subscribe form.
 */
export const validateSubscribeInput = ({ email, name } = {}) => {
  const errors = {};
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed) errors.email = 'Email is required.';
  else if (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) errors.email = 'Enter a valid email address.';
  if (typeof name === 'string' && name.trim().length > 100) errors.name = 'Name cannot exceed 100 characters.';
  return errors;
};

export const getSubscribeErrorMessage = (error) => {
  switch (error?.response?.status) {
    case 404:
      return 'This signup form is not available.';
    case 429:
      return 'Too many attempts. Please try again later.';
    case 400:
      return 'Please check your email address and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
};
