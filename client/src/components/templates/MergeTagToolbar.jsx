import { MERGE_TAG_OPTIONS, formatMergeTag } from '../../utils/templateHelpers.js';

/**
 * Row of buttons that insert merge tags (e.g. {{firstName}}) into the focused field.
 *
 * @param {object} props
 * @param {function(string): void} props.onInsert - Receives the tag snippet to insert
 * @param {boolean} [props.disabled]
 */
export const MergeTagToolbar = ({ onInsert, disabled = false }) => (
  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert merge tag">
    <span className="text-[11px] text-slate-500 mr-1">Insert:</span>
    {MERGE_TAG_OPTIONS.map(({ tag, label, example }) => (
      <button
        key={tag}
        type="button"
        disabled={disabled}
        onClick={() => onInsert(formatMergeTag(tag))}
        title={`${label} — e.g. ${example}`}
        className="px-2 py-1 rounded-md text-[11px] font-mono text-indigo-300 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer"
      >
        {`{{${tag}}}`}
      </button>
    ))}
  </div>
);

export default MergeTagToolbar;
