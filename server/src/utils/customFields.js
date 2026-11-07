/**
 * Contact custom fields (key/value text) used as merge tags: {{custom.company}}.
 *
 * Keys are lowercase snake_case (letter first, up to 30 chars). Values are trimmed text up to 200
 * characters. At most 10 fields per contact. Invalid entries are rejected, never silently fixed,
 * except for case and surrounding whitespace.
 */

export const MAX_CUSTOM_FIELDS = 10;
export const MAX_CUSTOM_KEY_LENGTH = 30;
export const MAX_CUSTOM_VALUE_LENGTH = 200;
export const CUSTOM_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * @param {unknown} value
 * @returns {string|null} Normalized key, or null if invalid
 */
export const normalizeCustomKey = (value) => {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key.length < 1 || key.length > MAX_CUSTOM_KEY_LENGTH || !CUSTOM_KEY_PATTERN.test(key)) return null;
  return key;
};

/**
 * Normalizes a plain object (or Map) of custom fields.
 *
 * @param {unknown} input
 * @returns {{ fields: Record<string, string>, error: string|null }}
 */
export const normalizeCustomFields = (input) => {
  const entries = input instanceof Map ? [...input.entries()] : input && typeof input === 'object' && !Array.isArray(input) ? Object.entries(input) : null;
  if (!entries) return { fields: {}, error: 'Custom fields must be an object.' };

  const fields = {};
  for (const [rawKey, rawValue] of entries) {
    const key = normalizeCustomKey(rawKey);
    if (!key) {
      return { fields: {}, error: `Invalid custom field name "${String(rawKey).slice(0, 40)}". Use lowercase letters, numbers and underscores, starting with a letter (max ${MAX_CUSTOM_KEY_LENGTH} characters).` };
    }
    if (typeof rawValue !== 'string') return { fields: {}, error: `Custom field "${key}" must be text.` };
    const value = rawValue.trim();
    if (value.length > MAX_CUSTOM_VALUE_LENGTH) {
      return { fields: {}, error: `Custom field "${key}" cannot exceed ${MAX_CUSTOM_VALUE_LENGTH} characters.` };
    }
    if (key in fields) return { fields: {}, error: `Duplicate custom field "${key}".` };
    if (value !== '') fields[key] = value;
  }
  if (Object.keys(fields).length > MAX_CUSTOM_FIELDS) {
    return { fields: {}, error: `A contact can have at most ${MAX_CUSTOM_FIELDS} custom fields.` };
  }
  return { fields, error: null };
};

/**
 * Plain-object view of a stored value (Map, lean object or missing).
 */
export const toPlainCustomFields = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return typeof value === 'object' ? { ...value } : {};
};
