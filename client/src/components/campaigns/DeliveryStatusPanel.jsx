import { useEffect, useRef, useState } from 'react';
import { getCampaignDeliveries, getErrorMessage } from '../../api/campaigns.js';
import {
  formatDeliverySummary,
  describeDeliveryError,
  getCampaignStatusBadge,
  formatCampaignDate,
} from '../../utils/campaignHelpers.js';

/** Poll interval while a campaign is still sending. */
export const DELIVERY_POLL_INTERVAL_MS = 3000;

/** Number of delivery rows shown in the panel. */
const DELIVERY_PAGE_LIMIT = 100;

const deliveryStatusClass = {
  sent: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  failed: 'bg-rose-500/10 text-rose-300 border-rose-500/20',
  processing: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20',
  pending: 'bg-slate-800/80 text-slate-400 border-slate-700',
};

/**
 * DeliveryStatusPanel (Phase 5)
 *
 * Shows send progress and the per-recipient delivery log of a campaign that has been sent.
 * Polls GET /campaigns/:id/deliveries while the campaign is 'sending' and stops as soon as the
 * server reports a final status. Stale responses (after unmount or campaign switch) are ignored.
 *
 * @param {object} props
 * @param {string} props.campaignId
 * @param {function(string): void} [props.onStatusChange] - Called when the server-reported
 *   campaign status changes (e.g. 'sending' -> 'sent'), so the list can refresh.
 */
export const DeliveryStatusPanel = ({ campaignId, onStatusChange }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [retryTrigger, setRetryTrigger] = useState(0);
  const lastStatusRef = useRef(null);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!campaignId) return undefined;

    let isActive = true;
    let timer = null;
    let controller = null;

    const load = async () => {
      controller = new AbortController();
      try {
        const result = await getCampaignDeliveries(
          campaignId,
          { limit: DELIVERY_PAGE_LIMIT },
          { signal: controller.signal }
        );
        if (!isActive) return;

        setData(result);
        setError(null);
        setIsLoading(false);

        const status = result?.campaignStatus;
        if (status && status !== lastStatusRef.current) {
          const previous = lastStatusRef.current;
          lastStatusRef.current = status;
          if (previous !== null && typeof onStatusChangeRef.current === 'function') {
            onStatusChangeRef.current(status);
          }
        }

        if (status === 'sending') {
          timer = setTimeout(load, DELIVERY_POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        if (!isActive) return;
        setError(getErrorMessage(err, 'Failed to load delivery status.'));
        setIsLoading(false);
      }
    };

    setIsLoading(true);
    load();

    return () => {
      isActive = false;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [campaignId, retryTrigger]);

  if (isLoading && !data) {
    return (
      <div
        className="p-5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-center gap-3 text-sm text-slate-300"
        role="status"
        aria-live="polite"
      >
        <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
        <span>Loading delivery status...</span>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div
        className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs sm:text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        role="alert"
      >
        <span>{error}</span>
        <button
          type="button"
          onClick={() => setRetryTrigger((n) => n + 1)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-100 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500 cursor-pointer self-start sm:self-auto"
        >
          Retry
        </button>
      </div>
    );
  }

  const summary = formatDeliverySummary(data?.summary);
  const status = data?.campaignStatus;
  const statusBadge = getCampaignStatusBadge(status);
  const deliveries = Array.isArray(data?.deliveries) ? data.deliveries : [];
  const totalRows = Number(data?.pagination?.total) || deliveries.length;
  const isSending = status === 'sending';

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <div className="p-4 sm:p-5 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <h4 className="font-bold text-white text-sm sm:text-base">
              {isSending ? 'Sending in progress' : 'Delivery report'}
            </h4>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge.pillClass}`}
            >
              {statusBadge.label}
            </span>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            {summary.processed} / {summary.total} processed
          </span>
        </div>

        <div
          className="w-full h-2 rounded-full bg-slate-800 overflow-hidden"
          role="progressbar"
          aria-label="Campaign send progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={summary.percent}
        >
          <div
            className={`h-full transition-all duration-500 ${
              status === 'failed' ? 'bg-rose-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${summary.percent}%` }}
          />
        </div>

        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-slate-500">Sent</span>
            <span className="text-lg font-bold font-mono text-emerald-400">{summary.sent}</span>
          </div>
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-slate-500">Failed</span>
            <span
              className={`text-lg font-bold font-mono ${
                summary.failed > 0 ? 'text-rose-400' : 'text-slate-300'
              }`}
            >
              {summary.failed}
            </span>
          </div>
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-slate-500">Queued</span>
            <span className="text-lg font-bold font-mono text-slate-300">
              {summary.pending + summary.processing}
            </span>
          </div>
        </div>

        <p className="text-[11px] text-slate-500">
          "Sent" means the message was accepted by the email provider, not that it reached the
          inbox.
        </p>
      </div>

      {deliveries.length > 0 && (
        <div className="rounded-xl border border-slate-800 overflow-hidden max-h-72 overflow-y-auto">
          <table className="min-w-full divide-y divide-slate-800 text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold sticky top-0">
              <tr>
                <th className="py-2.5 px-4">Recipient</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4 hidden sm:table-cell">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 text-slate-200">
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td className="py-2.5 px-4">
                    <div className="font-medium text-white">{delivery.name || '—'}</div>
                    <div className="text-slate-400 font-mono">{delivery.email}</div>
                  </td>
                  <td className="py-2.5 px-4">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                        deliveryStatusClass[delivery.status] || deliveryStatusClass.pending
                      }`}
                    >
                      {delivery.status}
                    </span>
                    {delivery.errorCode && (
                      <div className="text-[11px] text-rose-300/90 mt-1">
                        {describeDeliveryError(delivery.errorCode)}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5 px-4 hidden sm:table-cell text-slate-400">
                    {formatCampaignDate(delivery.sentAt || delivery.failedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalRows > deliveries.length && (
        <p className="text-[11px] text-slate-500">
          Showing the first {deliveries.length} of {totalRows} recipients.
        </p>
      )}
    </div>
  );
};

export default DeliveryStatusPanel;
