import { useState, useEffect } from 'react';
import { getContactTags } from '../../api/contacts.js';
import { getSegments } from '../../api/segments.js';
import { applyCampaignAudience } from '../../api/campaigns.js';
import { getSegmentErrorMessage } from '../../utils/segmentHelpers.js';

/**
 * Fill a saved campaign draft's recipients from a tag or a saved segment.
 * The server resolves the audience once and stores it as the recipient list (a snapshot).
 *
 * @param {object} props
 * @param {string} props.campaignId
 * @param {string[]} props.currentRecipientIds - Selection currently in the form
 * @param {function(string[]): void} props.onApplied - Receives the new recipient ID list
 * @param {boolean} [props.disabled]
 */
export const AudiencePicker = ({ campaignId, currentRecipientIds, onApplied, disabled = false }) => {
  const [tags, setTags] = useState([]);
  const [segments, setSegments] = useState([]);
  const [source, setSource] = useState(''); // 'tag:<tag>' | 'segment:<id>'
  const [mode, setMode] = useState('replace');
  const [state, setState] = useState({ status: 'idle', message: '' });

  useEffect(() => {
    const controller = new AbortController();
    getContactTags({ signal: controller.signal }).then(setTags).catch(() => {});
    getSegments({ limit: 100 }, { signal: controller.signal })
      .then((data) => setSegments(data?.segments ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (tags.length === 0 && segments.length === 0) return null;

  const handleApply = async () => {
    if (!source || state.status === 'applying') return;
    setState({ status: 'applying', message: '' });
    try {
      const target = source.startsWith('tag:')
        ? { tags: [source.slice(4)], mode }
        : { segmentId: source.slice(8), mode };
      const data = await applyCampaignAudience(campaignId, target);
      const serverIds = data?.campaign?.recipientIds ?? [];
      // Keep unsaved local picks when adding; replace discards them by design
      const next = mode === 'add' ? [...new Set([...currentRecipientIds, ...serverIds])] : serverIds;
      onApplied(next);
      setState({
        status: 'done',
        message: `${data?.matched ?? 0} matching ${data?.matched === 1 ? 'contact' : 'contacts'} applied (${next.length} recipients).`,
      });
    } catch (err) {
      setState({ status: 'error', message: getSegmentErrorMessage(err) });
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 rounded-xl bg-slate-950/50 border border-slate-800">
      <span className="text-xs font-semibold text-slate-300">Add recipients by tag or segment</span>
      <div className="flex flex-col sm:flex-row gap-2">
        <label htmlFor="campaign-audience-source" className="sr-only">Audience source</label>
        <select
          id="campaign-audience-source"
          value={source}
          disabled={disabled}
          onChange={(e) => {
            setSource(e.target.value);
            setState({ status: 'idle', message: '' });
          }}
          className="flex-1 px-3 py-2 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">Choose a tag or segment…</option>
          {segments.length > 0 && (
            <optgroup label="Segments">
              {segments.map((s) => (
                <option key={s.id} value={`segment:${s.id}`}>{s.name}</option>
              ))}
            </optgroup>
          )}
          {tags.length > 0 && (
            <optgroup label="Tags">
              {tags.map((t) => (
                <option key={t.tag} value={`tag:${t.tag}`}>{t.tag} ({t.count})</option>
              ))}
            </optgroup>
          )}
        </select>
        <label htmlFor="campaign-audience-mode" className="sr-only">Apply mode</label>
        <select
          id="campaign-audience-mode"
          value={mode}
          disabled={disabled}
          onChange={(e) => setMode(e.target.value)}
          className="px-3 py-2 bg-slate-950/80 border border-slate-800 rounded-xl text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="replace">Replace recipients</option>
          <option value="add">Add to recipients</option>
        </select>
        <button
          type="button"
          onClick={handleApply}
          disabled={disabled || !source || state.status === 'applying'}
          className="px-3 py-2 rounded-xl text-xs sm:text-sm font-semibold text-indigo-200 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {state.status === 'applying' ? 'Applying…' : 'Apply'}
        </button>
      </div>
      {state.status === 'done' && <p className="text-xs text-emerald-300" role="status">{state.message}</p>}
      {state.status === 'error' && <p className="text-xs text-rose-300" role="alert">{state.message}</p>}
      <p className="text-[11px] text-slate-500">
        The audience is applied now and saved to this draft. Unsubscribed contacts are never added.
      </p>
    </div>
  );
};

export default AudiencePicker;
