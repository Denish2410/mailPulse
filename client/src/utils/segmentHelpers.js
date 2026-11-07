/**
 * Pure helpers for contact tags and segments (Phase 11).
 */

export const MAX_TAGS_PER_CONTACT = 20;
export const MAX_TAG_LENGTH = 30;
const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]*$/;

/**
 * Normalizes one tag the same way the server does; returns null when invalid.
 */
export const normalizeTag = (value) => {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!tag || tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) return null;
  return tag;
};

/**
 * Parses a comma/newline separated tag string into valid unique tags plus the rejected entries.
 *
 * @param {string} input
 * @returns {{ tags: string[], invalid: string[] }}
 */
export const parseTagInput = (input) => {
  const tags = [];
  const invalid = [];
  if (typeof input !== 'string') return { tags, invalid };
  for (const part of input.split(/[,\n]/)) {
    const raw = part.trim();
    if (!raw) continue;
    const tag = normalizeTag(raw);
    if (!tag) invalid.push(raw);
    else if (!tags.includes(tag)) tags.push(tag);
  }
  return { tags, invalid };
};

/**
 * Validates a contact's tag list for the form. Returns an error message or null.
 */
export const validateContactTags = (tags) => {
  if (tags.length > MAX_TAGS_PER_CONTACT) return `A contact can have at most ${MAX_TAGS_PER_CONTACT} tags.`;
  return null;
};

export const ENGAGEMENT_OPTIONS = Object.freeze([
  { value: '', label: 'Any engagement' },
  { value: 'opened', label: 'Opened an email' },
  { value: 'clicked', label: 'Clicked a link' },
  { value: 'not_opened', label: 'Did not open any email' },
]);

/**
 * Builds the API criteria object from the segment form fields. Empty rules are omitted.
 *
 * @param {{ tagsAny?: string, tagsAll?: string, tagsNone?: string, engagementType?: string,
 *   engagementDays?: string|number, createdWithinDays?: string|number }} form
 * @returns {{ criteria: object, invalidTags: string[] }}
 */
export const buildCriteriaFromForm = (form = {}) => {
  const criteria = {};
  const invalidTags = [];

  for (const key of ['tagsAny', 'tagsAll', 'tagsNone']) {
    const { tags, invalid } = parseTagInput(form[key]);
    invalidTags.push(...invalid);
    if (tags.length > 0) criteria[key] = tags;
  }

  const days = (value) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
  };

  if (form.engagementType) {
    const d = days(form.engagementDays);
    if (d) criteria.engagement = { type: form.engagementType, days: d };
  }
  const created = days(form.createdWithinDays);
  if (created) criteria.createdWithinDays = created;

  return { criteria, invalidTags };
};

/**
 * Converts stored criteria back to form field strings.
 */
export const criteriaToForm = (criteria = {}) => ({
  tagsAny: (criteria.tagsAny ?? []).join(', '),
  tagsAll: (criteria.tagsAll ?? []).join(', '),
  tagsNone: (criteria.tagsNone ?? []).join(', '),
  engagementType: criteria.engagement?.type ?? '',
  engagementDays: criteria.engagement?.days ? String(criteria.engagement.days) : '30',
  createdWithinDays: criteria.createdWithinDays ? String(criteria.createdWithinDays) : '',
});

/**
 * Validates the segment form. Returns field errors (empty object when valid).
 */
export const validateSegmentForm = (name, form) => {
  const errors = {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length < 2) errors.name = 'Segment name must be at least 2 characters long.';
  else if (trimmed.length > 120) errors.name = 'Segment name cannot exceed 120 characters.';

  const { criteria, invalidTags } = buildCriteriaFromForm(form);
  if (invalidTags.length > 0) {
    errors.criteria = `Invalid tags: ${invalidTags.join(', ')}. Use letters, numbers, spaces, hyphens or underscores.`;
  } else if (Object.keys(criteria).length === 0) {
    errors.criteria = 'Add at least one rule.';
  }
  return errors;
};

/**
 * One-line, human-readable summary of criteria for lists.
 */
export const describeCriteria = (criteria = {}) => {
  const parts = [];
  if (criteria.tagsAny?.length) parts.push(`has any of: ${criteria.tagsAny.join(', ')}`);
  if (criteria.tagsAll?.length) parts.push(`has all of: ${criteria.tagsAll.join(', ')}`);
  if (criteria.tagsNone?.length) parts.push(`has none of: ${criteria.tagsNone.join(', ')}`);
  if (criteria.engagement) {
    const label = { opened: 'opened', clicked: 'clicked', not_opened: 'did not open' }[criteria.engagement.type];
    if (label) parts.push(`${label} in the last ${criteria.engagement.days} days`);
  }
  if (criteria.createdWithinDays) parts.push(`added in the last ${criteria.createdWithinDays} days`);
  return parts.length > 0 ? parts.join(' · ') : 'No rules';
};

/**
 * Friendly message for segment / audience API failures.
 */
export const getSegmentErrorMessage = (error) => {
  switch (error?.response?.status) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 404:
      return 'This item no longer exists. Refresh and try again.';
    case 409:
      return error?.response?.data?.message || 'A segment with this name already exists.';
    case 422:
      return 'That audience is too large for one campaign (limit 5,000 recipients).';
    default:
      return 'Something went wrong. Please try again.';
  }
};

export const MAX_CUSTOM_FIELDS = 10;
const CUSTOM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Parses "key=value" lines into custom fields (keys lower-cased). Blank lines and blank values
 * are skipped.
 *
 * @param {string} input
 * @returns {{ fields: Record<string, string>, error: string|null }}
 */
export const parseCustomFieldsInput = (input) => {
  const fields = {};
  if (typeof input !== 'string') return { fields, error: null };
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) return { fields: {}, error: `Use key=value on each line (problem: "${trimmed.slice(0, 40)}").` };
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length > 30 || !CUSTOM_KEY_PATTERN.test(key)) {
      return { fields: {}, error: `Invalid field name "${key.slice(0, 40)}". Use lowercase letters, numbers and underscores, starting with a letter.` };
    }
    if (value.length > 200) return { fields: {}, error: `Value for "${key}" cannot exceed 200 characters.` };
    if (key in fields) return { fields: {}, error: `Duplicate field "${key}".` };
    if (value) fields[key] = value;
  }
  if (Object.keys(fields).length > MAX_CUSTOM_FIELDS) {
    return { fields: {}, error: `A contact can have at most ${MAX_CUSTOM_FIELDS} custom fields.` };
  }
  return { fields, error: null };
};

/**
 * Formats stored custom fields back into editable "key=value" lines.
 */
export const formatCustomFieldsInput = (fields) =>
  fields && typeof fields === 'object'
    ? Object.entries(fields)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')
    : '';
