import { useState, useRef } from 'react';
import MergeTagToolbar from './MergeTagToolbar.jsx';
import {
  insertAtSelection,
  validateTemplateForm,
  getTemplateErrorMessage,
} from '../../utils/templateHelpers.js';

const inputClass =
  'w-full px-3.5 py-2.5 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';

/**
 * Create / edit dialog for a template. Mount it only while open (key it by template id) so the
 * form state initializes from the template each time.
 *
 * @param {object} props
 * @param {object|null} [props.template] - Template being edited, or null to create
 * @param {function(): void} props.onClose
 * @param {function(object): Promise<void>} props.onSubmit - Receives { name, subject, textContent, htmlContent }
 */
export const TemplateFormDialog = ({ template = null, onClose, onSubmit }) => {
  const [form, setForm] = useState({
    name: template?.name ?? '',
    subject: template?.subject ?? '',
    textContent: template?.textContent ?? '',
    htmlContent: template?.htmlContent ?? '',
  });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastFieldRef = useRef('htmlContent');
  const fieldRefs = useRef({});

  const setField = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: null }));
  };

  const handleInsert = (snippet) => {
    const field = lastFieldRef.current;
    const el = fieldRefs.current[field];
    const { value, cursor } = insertAtSelection(
      form[field],
      snippet,
      el?.selectionStart,
      el?.selectionEnd
    );
    setForm((prev) => ({ ...prev, [field]: value }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange?.(cursor, cursor);
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    const found = validateTemplateForm(form);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setIsSubmitting(true);
    setServerError(null);
    try {
      await onSubmit({ ...form, name: form.name.trim(), subject: form.subject.trim() });
    } catch (err) {
      setServerError(getTemplateErrorMessage(err));
      setIsSubmitting(false);
    }
  };

  const field = (name, label, multiline, rows = 5) => {
    const Tag = multiline ? 'textarea' : 'input';
    return (
      <div>
        <label htmlFor={`template-${name}`} className="block text-xs font-semibold text-slate-300 mb-1.5">
          {label}
        </label>
        <Tag
          id={`template-${name}`}
          ref={(el) => {
            fieldRefs.current[name] = el;
          }}
          value={form[name]}
          onChange={setField(name)}
          onFocus={() => {
            lastFieldRef.current = name;
          }}
          disabled={isSubmitting}
          {...(multiline ? { rows } : { type: 'text' })}
          className={`${inputClass} ${multiline ? 'font-mono resize-y' : ''}`}
        />
        {errors[name] && (
          <p className="mt-1 text-xs text-rose-400" role="alert">
            {errors[name]}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="template-dialog-title">
      <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => !isSubmitting && onClose()} aria-hidden="true" />
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 id="template-dialog-title" className="text-lg font-bold text-slate-50">
            {template ? 'Edit Template' : 'New Template'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Use merge tags like {'{{firstName | "there"}}'} to personalize each email.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
          {serverError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs rounded-xl" role="alert">
              {serverError}
            </div>
          )}
          {field('name', 'Template name *', false)}
          {field('subject', 'Subject', false)}
          <MergeTagToolbar onInsert={handleInsert} disabled={isSubmitting} />
          {field('textContent', 'Plain text body', true, 5)}
          {field('htmlContent', 'HTML body', true, 8)}

          <div className="flex justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : template ? 'Save Changes' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TemplateFormDialog;
