import { useState } from 'react';
import { importContacts } from '../../api/contacts.js';
import {
  CSV_TEMPLATE,
  validateCsvFile,
  formatImportSummary,
  getImportErrorMessage,
  downloadTextFile,
} from '../../utils/csvHelpers.js';

/**
 * Dialog for importing contacts from a CSV file.
 * Mount only while open.
 *
 * @param {object} props
 * @param {function(): void} props.onClose
 * @param {function(object): void} [props.onImported] - Called with the import result
 */
export const ImportContactsDialog = ({ onClose, onImported }) => {
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [isImporting, setIsImporting] = useState(false);

  const handleFile = (e) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);
    setError(selected ? validateCsvFile(selected) : null);
  };

  const handleImport = async () => {
    const problem = validateCsvFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setIsImporting(true);
    setError(null);
    try {
      const text = await file.text();
      const data = await importContacts(text);
      setResult(data);
      if (typeof onImported === 'function') onImported(data);
    } catch (err) {
      setError(getImportErrorMessage(err));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="import-dialog-title">
      <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => !isImporting && onClose()} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-100">
        <h2 id="import-dialog-title" className="text-lg font-bold text-white">Import Contacts</h2>
        <p className="text-xs text-slate-400 mt-1">
          Upload a CSV with an <code className="text-indigo-300">email</code> column. Optional columns:{' '}
          <code className="text-indigo-300">name</code>, <code className="text-indigo-300">tags</code> (separate tags with <code>;</code>).
          Existing contacts are skipped, never overwritten. Up to 5,000 rows.
        </p>
        <button
          type="button"
          onClick={() => downloadTextFile('contacts-template.csv', CSV_TEMPLATE)}
          className="mt-2 text-xs text-indigo-300 hover:text-indigo-200 underline cursor-pointer"
        >
          Download a template
        </button>

        <div className="mt-4">
          <label htmlFor="import-file" className="block text-xs font-semibold text-slate-300 mb-1.5">
            CSV file
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={handleFile}
            disabled={isImporting}
            className="block w-full text-sm text-slate-300 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
          />
        </div>

        {error && (
          <p className="mt-3 text-xs text-rose-300" role="alert">{error}</p>
        )}

        {result && (
          <div className="mt-4 p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs" role="status">
            <p className="text-emerald-300 font-semibold">{formatImportSummary(result)}</p>
            {result.errors?.length > 0 && (
              <ul className="mt-2 max-h-32 overflow-y-auto text-slate-400 space-y-0.5">
                {result.errors.map((e) => (
                  <li key={`${e.row}-${e.message}`}>
                    Row {e.row}{e.email ? ` (${e.email})` : ''}: {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2.5 mt-5">
          <button type="button" onClick={onClose} disabled={isImporting} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer disabled:opacity-50">
            {result ? 'Done' : 'Cancel'}
          </button>
          {!result && (
            <button type="button" onClick={handleImport} disabled={isImporting || !file} className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer disabled:opacity-50">
              {isImporting ? 'Importing…' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ImportContactsDialog;
