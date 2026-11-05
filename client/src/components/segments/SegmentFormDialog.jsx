import { useState, useEffect, useRef } from 'react';
import {
  ENGAGEMENT_OPTIONS,
  buildCriteriaFromForm,
  criteriaToForm,
  validateSegmentForm,
  getSegmentErrorMessage,
} from '../../utils/segmentHelpers.js';
import { previewSegmentCriteria } from '../../api/segments.js';

const inputClass =
  'w-full px-3.5 py-2.5 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';

/**
 * Create / edit dialog for a segment with a live match preview.
 * Mount only while open (key by segment id) so state initializes from the segment.
 *
 * @param {object} props
 * @param {object|null} [props.segment] - Segment being edited, or null to create
 * @param {function(): void} props.onClose
 * @param {function(object): Promise<void>} props.onSubmit - Receives { name, description, criteria }
 */
export const SegmentFormDialog = ({ segment = null, onClose, onSubmit }) => {
  const [name, setName] = useState(segment?.name ?? '');
  const [description, setDescription] = useState(segment?.description ?? '');
  const [form, setForm] = useState(criteriaToForm(segment?.criteria));
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [preview, setPreview] = useState({ status: 'idle', total: 0, sample: [] });
  const previewIdRef = useRef(0);

  const setField = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, criteria: null }));
  };

  // Debounced live preview of the current rules
  useEffect(() => {
    const { criteria, invalidTags } = buildCriteriaFromForm(form);
    if (invalidTags.length > 0 || Object.keys(criteria).length === 0) {
      setPreview({ status: 'idle', total: 0, sample: [] });
      return undefined;
    }
    const requestId = ++previewIdRef.current;
    const timer = setTimeout(async () => {
      setPreview((prev) => ({ ...prev, status: 'loading' }));
      try {
        const result = await previewSegmentCriteria(criteria);
        if (requestId === previewIdRef.current) {
          setPreview({ status: 'ready', total: result?.total ?? 0, sample: result?.sample ?? [] });
        }
      } catch {
        if (requestId === previewIdRef.current) setPreview({ status: 'error', total: 0, sample: [] });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [form]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    const found = validateSegmentForm(name, form);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }
    setIsSubmitting(true);
    setServerError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        criteria: buildCriteriaFromForm(form).criteria,
      });
    } catch (err) {
      setServerError(getSegmentErrorMessage(err));
      setIsSubmitting(false);
    }
  };

  const tagField = (key, label, hint) => (
    <div>
      <label htmlFor={`segment-${key}`} className="block text-xs font-semibold text-slate-300 mb-1.5">
        {label}
      </label>
      <input
        id={`segment-${key}`}
        type="text"
        value={form[key]}
        onChange={setField(key)}
        disabled={isSubmitting}
        placeholder={hint}
        className={inputClass}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="segment-dialog-title">
      <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => !isSubmitting && onClose()} aria-hidden="true" />
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col">
        <div className="px-6 py-4 border-b border-slate-800">
          <h2 id="segment-dialog-title" className="text-lg font-bold text-white">
            {segment ? 'Edit Segment' : 'New Segment'}
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Rules are combined with AND. Unsubscribed contacts are always excluded.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
          {serverError && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs rounded-xl" role="alert">
              {serverError}
            </div>
          )}

          <div>
            <label htmlFor="segment-name" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Segment name *
            </label>
            <input id="segment-name" type="text" value={name} onChange={(e) => setName(e.target.value)} disabled={isSubmitting} className={inputClass} />
            {errors.name && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.name}</p>}
          </div>

          <div>
            <label htmlFor="segment-description" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Description
            </label>
            <input id="segment-description" type="text" value={description} onChange={(e) => setDescription(e.target.value)} disabled={isSubmitting} className={inputClass} />
          </div>

          <fieldset className="flex flex-col gap-3 p-4 rounded-xl border border-slate-800">
            <legend className="px-2 text-xs font-semibold text-slate-400">Rules</legend>
            {tagField('tagsAny', 'Has any of these tags', 'vip, lead')}
            {tagField('tagsAll', 'Has all of these tags', 'newsletter')}
            {tagField('tagsNone', 'Has none of these tags', 'do-not-promote')}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="segment-engagement" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Engagement
                </label>
                <select id="segment-engagement" value={form.engagementType} onChange={setField('engagementType')} disabled={isSubmitting} className={inputClass}>
                  {ENGAGEMENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="segment-engagement-days" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  …in the last (days)
                </label>
                <input id="segment-engagement-days" type="number" min="1" max="365" value={form.engagementDays} onChange={setField('engagementDays')} disabled={isSubmitting || !form.engagementType} className={inputClass} />
              </div>
            </div>

            <div>
              <label htmlFor="segment-created" className="block text-xs font-semibold text-slate-300 mb-1.5">
                Added in the last (days)
              </label>
              <input id="segment-created" type="number" min="1" max="365" value={form.createdWithinDays} onChange={setField('createdWithinDays')} disabled={isSubmitting} placeholder="Any time" className={inputClass} />
            </div>
            {errors.criteria && <p className="text-xs text-rose-400" role="alert">{errors.criteria}</p>}
          </fieldset>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-300" role="status" aria-live="polite">
            {preview.status === 'idle' && 'Add a rule to preview matching contacts.'}
            {preview.status === 'loading' && 'Counting matching contacts…'}
            {preview.status === 'error' && 'Could not preview this segment right now.'}
            {preview.status === 'ready' && (
              <>
                <strong className="text-white">{preview.total}</strong> matching {preview.total === 1 ? 'contact' : 'contacts'}
                {preview.sample.length > 0 && (
                  <span className="text-slate-400"> — e.g. {preview.sample.slice(0, 3).map((c) => c.name).join(', ')}</span>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-2.5 pt-2">
            <button type="button" onClick={onClose} disabled={isSubmitting} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 cursor-pointer disabled:opacity-50">
              {isSubmitting ? 'Saving…' : segment ? 'Save Changes' : 'Create Segment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SegmentFormDialog;
