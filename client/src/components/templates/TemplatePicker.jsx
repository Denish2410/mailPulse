import { useState, useEffect } from 'react';
import { getTemplates } from '../../api/templates.js';

/**
 * "Start from template" selector. Loads the user's templates once and reports the chosen one.
 * Failure to load is non-fatal: the picker simply hides itself.
 *
 * @param {object} props
 * @param {function(object): void} props.onApply - Receives the full template
 * @param {boolean} [props.disabled]
 */
export const TemplatePicker = ({ onApply, disabled = false }) => {
  const [templates, setTemplates] = useState([]);
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    getTemplates({ limit: 100 }, { signal: controller.signal })
      .then((data) => setTemplates(data?.templates ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (templates.length === 0) return null;

  const selected = templates.find((t) => t.id === selectedId);

  return (
    <div className="flex flex-col sm:flex-row sm:items-end gap-2 p-3 rounded-xl bg-slate-950/50 border border-slate-800">
      <div className="flex-1">
        <label htmlFor="campaign-form-template" className="block text-xs font-semibold text-slate-300 mb-1.5">
          Start from template
        </label>
        <select
          id="campaign-form-template"
          value={selectedId}
          disabled={disabled}
          onChange={(e) => setSelectedId(e.target.value)}
          className="w-full px-3 py-2 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Choose a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={disabled || !selected}
        onClick={() => selected && onApply(selected)}
        className="px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        Apply (replaces subject &amp; body)
      </button>
    </div>
  );
};

export default TemplatePicker;
