/**
 * Minimal RFC 4180 CSV helpers (no dependencies).
 *
 * parseCsv:  quoted fields, escaped quotes (""), CRLF/LF/CR newlines, embedded newlines in quotes,
 *            UTF-8 BOM stripped, blank lines skipped.
 * toCsv:     quotes fields containing commas, quotes or newlines, and neutralizes spreadsheet
 *            formula injection (cells starting with = + - @ or a tab/CR get a leading apostrophe).
 */

export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
  }
}

/**
 * @param {string} text
 * @param {{ maxRows?: number }} [options] - Throws CsvError when more data rows are present
 * @returns {string[][]} Rows of fields (header row included)
 */
export const parseCsv = (text, { maxRows = Infinity } = {}) => {
  if (typeof text !== 'string') throw new CsvError('CSV content must be text.');
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0].trim() === '')) {
      rows.push(row);
      if (rows.length - 1 > maxRows) throw new CsvError(`CSV cannot contain more than ${maxRows} rows.`);
    }
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      endRow();
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError('CSV has an unterminated quoted field.');
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  return rows;
};

const FORMULA_START = /^[=+\-@\t\r]/;

export const escapeCsvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * @param {string[]} header
 * @param {Array<Array<unknown>>} rows
 * @returns {string} CSV text with CRLF line endings
 */
export const toCsv = (header, rows) =>
  [header, ...rows].map((r) => r.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
