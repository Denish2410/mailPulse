/**
 * Contact tag normalization (Phase 11).
 *
 * Tags are stored lowercase so "VIP" and "vip" are the same tag. A tag starts with a letter or
 * digit and may contain letters, digits, spaces, underscores and hyphens (1-30 characters).
 */

export const MAX_TAGS_PER_CONTACT = 20;
export const MAX_TAG_LENGTH = 30;

export const TAG_PATTERN = /^[a-z0-9][a-z0-9 _-]*$/;

/**
 * Normalizes one tag, or returns null when it is not a valid tag.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export const normalizeTag = (value) => {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (tag.length < 1 || tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) return null;
  return tag;
};

/**
 * Normalizes and de-duplicates a list of tags, preserving first-seen order.
 * Invalid entries are dropped.
 *
 * @param {unknown} values
 * @returns {string[]}
 */
export const normalizeTags = (values) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const tag = normalizeTag(value);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
};
