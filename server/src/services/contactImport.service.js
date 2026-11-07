import Contact from '../models/Contact.js';
import { parseCsv, CsvError } from '../utils/csv.js';
import { normalizeTags, MAX_TAGS_PER_CONTACT } from '../utils/tags.js';

/**
 * Bulk contact import from CSV text (Phase 3 gap fix).
 *
 * Columns (header required, case-insensitive): `email` (required), `name`, `tags` (separated by
 * `;` or `|`). A missing name falls back to the email's local part. Existing contacts and
 * duplicate rows are skipped (never overwritten). Everything is scoped to `userId`.
 */

export const MAX_IMPORT_ROWS = 5000;
const MAX_REPORTED_ERRORS = 50;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const INSERT_CHUNK = 500;

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
  if (columns.email === undefined) throw new ImportError('The CSV must have an "email" column header.');

  const result = { total: rows.length - 1, created: 0, skipped: 0, invalid: 0, errors: [] };
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

    if (seen.has(email)) {
      result.skipped += 1;
      return undefined;
    }
    seen.add(email);
    candidates.push({ email, name, tags });
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
