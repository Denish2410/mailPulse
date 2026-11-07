import Contact from '../models/Contact.js';
import { parseCsv, CsvError } from '../utils/csv.js';
import { normalizeTags, MAX_TAGS_PER_CONTACT } from '../utils/tags.js';
import { normalizeCustomFields, normalizeCustomKey } from '../utils/customFields.js';

/**
 * Bulk contact import from CSV text (Phase 3 gap fix).
 *
 * Columns (header required, case-insensitive): `email` (required), `name`, `tags` (separated by
 * `;` or `|`). Any other column is imported as a custom field (header lower-cased, spaces and
 * punctuation turned into `_`; `custom:<key>` also works). The `status` and `created` columns written
 * by the export are ignored. A missing name falls back to the email's local part. Existing contacts and
 * duplicate rows are skipped (never overwritten). Everything is scoped to `userId`.
 */

export const MAX_IMPORT_ROWS = 5000;
const MAX_REPORTED_ERRORS = 50;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const INSERT_CHUNK = 500;
export const RESERVED_COLUMNS = ['email', 'name', 'tags', 'status', 'created'];

/**
 * Maps a CSV header to a custom field key, or null when it should be ignored.
 */
export const headerToCustomKey = (header) => {
  const text = String(header ?? '').trim().toLowerCase();
  if (!text) return null;
  const explicit = text.startsWith('custom:') ? text.slice('custom:'.length).trim() : null;
  if (explicit !== null) return normalizeCustomKey(explicit);
  if (RESERVED_COLUMNS.includes(text)) return null;
  return normalizeCustomKey(text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''));
};

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const readRow = (row, columns) => {
  const cell = (key) => (columns[key] === undefined ? '' : (row[columns[key]] ?? '').trim());
  return { email: cell('email'), name: cell('name'), tags: cell('tags') };
};

/**
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string} csvText
 * @returns {Promise<{ total: number, created: number, skipped: number, invalid: number,
 *   errors: Array<{ row: number, email: string, message: string }> }>}
 */
export const importContactsFromCsv = async (userId, csvText) => {
  let rows;
  try {
    rows = parseCsv(csvText, { maxRows: MAX_IMPORT_ROWS });
  } catch (err) {
    if (err instanceof CsvError) throw new ImportError(err.message);
    throw err;
  }
  if (rows.length === 0) throw new ImportError('The CSV file is empty.');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const columns = {};
  for (const key of ['email', 'name', 'tags']) {
    const index = header.indexOf(key);
    if (index !== -1) columns[key] = index;
  }
  const customColumns = [];
  const usedKeys = new Set();
  const ignoredColumns = [];
  rows[0].forEach((rawHeader, index) => {
    const lowered = rawHeader.trim().toLowerCase();
    if (['email', 'name', 'tags'].includes(lowered)) return;
    const key = headerToCustomKey(rawHeader);
    if (key && !usedKeys.has(key)) {
      usedKeys.add(key);
      customColumns.push({ key, index });
    } else if (!RESERVED_COLUMNS.includes(lowered) && rawHeader.trim()) {
      ignoredColumns.push(rawHeader.trim().slice(0, 40));
    }
  });
  if (columns.email === undefined) throw new ImportError('The CSV must have an "email" column header.');

  const result = { total: rows.length - 1, created: 0, skipped: 0, invalid: 0, errors: [], ignoredColumns };
  const reject = (rowNumber, email, message) => {
    result.invalid += 1;
    if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push({ row: rowNumber, email, message });
  };

  const candidates = [];
  const seen = new Set();
  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2; // 1-based with header on row 1
    const { email: rawEmail, name: rawName, tags: rawTags } = readRow(row, columns);
    const email = rawEmail.toLowerCase();

    if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
      return reject(rowNumber, rawEmail.slice(0, 254), 'Invalid email address.');
    }
    const name = (rawName || email.split('@')[0]).slice(0, 100);
    if (name.length < 2) return reject(rowNumber, email, 'Name must be at least 2 characters.');

    const tagParts = rawTags ? rawTags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [];
    const tags = normalizeTags(tagParts);
    if (tags.length !== new Set(tagParts.map((t) => t.toLowerCase())).size) {
      return reject(rowNumber, email, 'Contains an invalid tag.');
    }
    if (tags.length > MAX_TAGS_PER_CONTACT) {
      return reject(rowNumber, email, `At most ${MAX_TAGS_PER_CONTACT} tags per contact.`);
    }

    const customInput = {};
    for (const { key, index } of customColumns) {
      const value = (row[index] ?? '').trim();
      if (value) customInput[key] = value;
    }
    const { fields: customFields, error: customError } = normalizeCustomFields(customInput);
    if (customError) return reject(rowNumber, email, customError);

    if (seen.has(email)) {
      result.skipped += 1;
      return undefined;
    }
    seen.add(email);
    candidates.push({ email, name, tags, ...(Object.keys(customFields).length > 0 && { customFields }) });
    return undefined;
  });

  if (candidates.length === 0) return result;

  const existing = new Set(
    (await Contact.find({ userId, email: { $in: candidates.map((c) => c.email) } }).select('email').lean()).map(
      (c) => c.email
    )
  );
  const fresh = candidates.filter((c) => !existing.has(c.email));
  result.skipped += candidates.length - fresh.length;

  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const chunk = fresh.slice(i, i + INSERT_CHUNK).map((c) => ({ ...c, userId }));
    try {
      const inserted = await Contact.insertMany(chunk, { ordered: false });
      result.created += inserted.length;
    } catch (err) {
      // A concurrent insert of the same email is a duplicate, not a failure
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      const done = err.result?.insertedCount ?? err.insertedDocs?.length ?? 0;
      result.created += done;
      result.skipped += chunk.length - done;
    }
  }

  return result;
};
