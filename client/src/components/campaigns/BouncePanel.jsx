import { useState, useEffect } from 'react';
import { getCampaignBounces } from '../../api/campaigns.js';
import { extractBounceData, getBounceTypeInfo, formatBounceRate } from '../../utils/bounceHelpers.js';
import { formatCampaignDate } from '../../utils/campaignHelpers.js';

/**
 * Bounces & complaints for a campaign. Loads independently of the engagement analytics so a
 * failure here never hides the rest of the dialog; it renders nothing when there is nothing to
 * report or the request fails.
 *
 * @param {object} props
 * @param {string} props.campaignId
 * @param {number} [props.sentCount] - Messages accepted by the transport (for the bounce rate)
 */
export const BouncePanel = ({ campaignId, sentCount }) => {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!campaignId) return undefined;
    const controller = new AbortController();
    getCampaignBounces(campaignId, { signal: controller.signal })
      .then((payload) => setData(extractBounceData(payload)))
      .catch(() => setData(null));
    return () => controller.abort();
  }, [campaignId]);

  if (!data || data.summary.total === 0) return null;
  const { summary, events } = data;

  return (
    <div className="flex flex-col gap-2.5" aria-label="Bounces and complaints">
      <h3 className="text-sm font-semibold text-slate-50">Bounces &amp; Complaints</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-center">
        {[
          ['Hard bounces', summary.hardBounces],
          ['Soft bounces', summary.softBounces],
          ['Complaints', summary.complaints],
          ['Bounce rate', formatBounceRate(summary, sentCount)],
        ].map(([label, value]) => (
          <div key={label} className="p-3 rounded-xl bg-slate-950/60 border border-slate-800">
            <div className="text-lg font-bold text-slate-50">{value}</div>
            <div className="text-[11px] text-slate-400">{label}</div>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-slate-950/40">
        {events.slice(0, 10).map((event) => {
          const info = getBounceTypeInfo(event.eventType);
          return (
            <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
              <span className={`px-2 py-0.5 rounded-full font-medium ${info.pillClass}`} title={info.note}>
                {info.label}
              </span>
              <span className="font-mono text-slate-300 break-all">{event.email}</span>
              {event.reason && <span className="text-slate-500 truncate max-w-[16rem]">{event.reason}</span>}
              <span className="ml-auto text-slate-500">{formatCampaignDate(event.occurredAt)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default BouncePanel;
