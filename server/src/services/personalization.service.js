/**
 * MailPulse Personalization (Phase 10)
 *
 * Renders per-recipient merge tags in a campaign subject, HTML and plain-text body.
 *
 * Supported tags (case-insensitive, whitespace tolerant):
 *   {{name}}  {{firstName}}  {{lastName}}  {{email}}
 * Optional fallback used when the value is empty:
 *   {{name | "Customer"}}   {{firstName | 'there'}}
 *
 * Safety:
 * - Single pass: values are never re-scanned, so a contact named "{{email}}" cannot expand.
 * - HTML output escapes values and fallbacks; subject output has control characters removed so
 *   a recipient name can never inject headers.
 * - Unknown tags and the reserved unsubscribe tags are left untouched for later stages.
 */

export const MERGE_TAGS = Object.freeze(['name', 'firstName', 'lastName', 'email']);

const TAG_LOOKUP = new Map(MERGE_TAGS.map((tag) => [tag.toLowerCase(), tag]));

const TAG_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*(?:\|\s*(?:"([^"{}]*)"|'([^'{}]*)'))?\s*\}\}/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

const stripControlChars = (value) =>
  String(value).replace(new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g'), ' ');

/**
 * Derives the merge variables for a recipient.
 *
 * @param {{ name?: string, email?: string }} recipient
 * @returns {{ name: string, firstName: string, lastName: string, email: string }}
 */
export const buildMergeVariables = (recipient = {}) => {
  const name = typeof recipient.name === 'string' ? recipient.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof recipient.email === 'string' ? recipient.email.trim() : '';
  const parts = name ? name.split(' ') : [];
  return {
    name,
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : '',
    email,
  };
};

/**
 * Renders merge tags in a template string.
 *
 * @param {string} template
 * @param {object} variables - Output of `buildMergeVariables`
 * @param {{ mode?: 'html'|'text'|'subject' }} [options]
 * @returns {string}
 */
export const renderMergeTags = (template, variables, { mode = 'text' } = {}) => {
  if (typeof template !== 'string' || !template.includes('{{')) {
    return typeof template === 'string' ? template : '';
  }

  const sanitize = mode === 'html' ? escapeHtml : mode === 'subject' ? stripControlChars : String;

  return template.replace(TAG_PATTERN, (match, rawTag, dqFallback, sqFallback) => {
    const tag = TAG_LOOKUP.get(rawTag.toLowerCase());
    if (!tag) return match;

    const value = variables?.[tag];
    if (typeof value === 'string' && value.trim() !== '') {
      return sanitize(value);
    }
    const fallback = dqFallback ?? sqFallback;
    return fallback !== undefined ? sanitize(fallback) : '';
  });
};

/**
 * Personalizes a whole message for one recipient.
 *
 * @param {{ subject?: string, text?: string, html?: string }} message
 * @param {{ name?: string, email?: string }} recipient
 * @returns {{ subject: string, text: string, html: string }}
 */
export const personalizeMessage = (message, recipient) => {
  const variables = buildMergeVariables(recipient);
  return {
    subject: renderMergeTags(message?.subject, variables, { mode: 'subject' }).trim(),
    text: renderMergeTags(message?.text, variables, { mode: 'text' }),
    html: renderMergeTags(message?.html, variables, { mode: 'html' }),
  };
};

/**
 * Lists the distinct recognized merge tags used in a template (for UI hints and validation).
 *
 * @param {string} template
 * @returns {string[]}
 */
export const findMergeTags = (template) => {
  if (typeof template !== 'string') return [];
  const found = new Set();
  for (const m of template.matchAll(TAG_PATTERN)) {
    const tag = TAG_LOOKUP.get(m[1].toLowerCase());
    if (tag) found.add(tag);
  }
  return [...found];
};
