/**
 * Pure helpers for contact CSV import / export UI.
 */

export const MAX_CSV_BYTES = 900000;
export const CSV_TEMPLATE = 'name,email,tags\nJane Doe,jane@example.com,vip;lead\n';

/**
 * Validates a user-selected file before reading it.
 *
 * @param {{ name?: string, size?: number }|null|undefined} file
 * @returns {string|null} Error message, or null when acceptable
 */
export const validateCsvFile = (file) => {
  if (!file) return 'Choose a CSV file to import.';
  if (typeof file.name !== 'string' || !/\.(csv|txt)$/i.test(file.name)) {
    return 'Only .csv files are supported.';
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return 'The selected file is empty.';
  if (file.size > MAX_CSV_BYTES) return 'The file is too large (limit about 900 KB, up to 5,000 rows).';
  return null;
};

/**
 * One-line summary of an import result.
 *
 * @param {{ created?: number, skipped?: number, invalid?: number }|null|undefined} result
 * @returns {string}
 */
export const formatImportSummary = (result) => {
  const created = result?.created ?? 0;
  const skipped = result?.skipped ?? 0;
  const invalid = result?.invalid ?? 0;
  const parts = [`${created} imported`];
  if (skipped > 0) parts.push(`${skipped} skipped (already exist)`);
  if (invalid > 0) parts.push(`${invalid} invalid`);
  return parts.join(', ');
};

/**
 * Friendly import error message.
 */
export const getImportErrorMessage = (error) => {
  const status = error?.response?.status;
  if (status === 400) return error.response?.data?.message || 'The CSV could not be read.';
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 413) return 'The file is too large.';
  return 'Import failed. Please try again.';
};

/**
 * Triggers a browser download of text content. Browser-only; returns false when unavailable.
 */
export const downloadTextFile = (filename, text, mime = 'text/csv;charset=utf-8') => {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
};
