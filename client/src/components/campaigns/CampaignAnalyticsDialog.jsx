import { useState, useEffect, useRef } from 'react';
import { getCampaignAnalytics } from '../../api/campaigns.js';
import { getErrorMessage } from '../../lib/api.js';
import {
  extractAnalyticsData,
  formatAnalyticsMetrics,
  getCampaignStatusBadge,
  formatCampaignDate,
} from '../../utils/campaignHelpers.js';

/**
 * CampaignAnalyticsDialog Component
 *
 * An accessible modal dialog displaying open and click tracking analytics
 * for an email campaign.
 *
 * Features:
 * - Real-time metrics overview: Open rate, Click-through rate (CTR), Click-to-delivered rate.
 * - Raw count metrics: Total opens, unique opens, total clicks, unique clicks.
 * - Per-link engagement breakdown table with total and unique click counts.
 * - Recent tracking activity feed showing live open and click events.
 * - Safe error handling with retry capability and loading skeletons.
 * - Fully accessible with keyboard navigation (Escape key dismissal) and ARIA attributes.
 *
 * @param {object} props
 * @param {boolean} [props.isOpen=false] - Dialog visibility
 * @param {object|null} [props.campaign=null] - Campaign object
 * @param {function(): void} props.onClose - Close callback
 */
export const CampaignAnalyticsDialog = ({
  isOpen = false,
  campaign = null,
  onClose,
}) => {
  const [analyticsData, setAnalyticsData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const requestIdRef = useRef(0);

  // Fetch campaign tracking analytics from API
  useEffect(() => {
    if (!isOpen || !campaign?.id) {
      setAnalyticsData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;

    setIsLoading(true);
    setError(null);

    getCampaignAnalytics(campaign.id, { signal: controller.signal })
      .then((data) => {
        if (isMounted && currentRequestId === requestIdRef.current) {
          const parsed = extractAnalyticsData(data);
          setAnalyticsData(parsed);
          setError(null);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
          return;
        }
        if (isMounted && currentRequestId === requestIdRef.current) {
          setError(
            getErrorMessage(err, 'Failed to load campaign analytics. Please try again.')
          );
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isOpen, campaign?.id, refreshTrigger]);

  // Handle Escape key dismissal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !campaign) return null;

  const statusBadge = getCampaignStatusBadge(campaign.status);
  const metrics = analyticsData?.metrics || {};
  const formatted = formatAnalyticsMetrics(metrics);
  const linkBreakdown = analyticsData?.linkBreakdown || [];
  const recentActivity = analyticsData?.recentActivity || [];
  const totalRecipients = analyticsData?.totalRecipients ?? (campaign.recipientsCount || 0);

  const hasAnyActivity =
    (metrics.totalOpens || 0) > 0 || (metrics.totalClicks || 0) > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-analytics-title"
      aria-describedby="campaign-analytics-desc"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog Card */}
      <div className="relative w-full max-w-4xl max-h-[92vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90 shrink-0">
          <div className="flex-1 pr-4 min-w-0">
            <div className="flex items-center gap-2.5 mb-1 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold tracking-wide uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Tracking Analytics
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge.pillClass}`}
              >
                {statusBadge.label}
              </span>
            </div>
            <h2
              id="campaign-analytics-title"
              className="text-lg sm:text-xl font-bold text-white truncate"
            >
              {campaign.name}
            </h2>
            <p id="campaign-analytics-desc" className="text-xs text-slate-400 mt-0.5">
              Live open and click engagement metrics for this campaign.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => setRefreshTrigger((prev) => prev + 1)}
              disabled={isLoading}
              aria-label="Refresh tracking analytics"
              title="Refresh metrics"
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
            >
              <svg
                className={`w-5 h-5 ${isLoading ? 'animate-spin' : ''}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close analytics dialog"
              className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Dialog Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 flex flex-col gap-6">
          {/* Loading Skeleton */}
          {isLoading && !analyticsData && (
            <div className="py-16 text-center flex flex-col items-center justify-center" role="status" aria-live="polite">
              <div className="w-8 h-8 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-sm text-slate-400 font-medium">Loading campaign analytics...</p>
            </div>
          )}

          {/* Error Banner */}
          {error && (
            <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 flex items-start gap-3 text-sm">
              <svg className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-rose-200">Unable to load analytics</p>
                <p className="text-xs text-rose-300/90 mt-0.5">{error}</p>
                <button
                  type="button"
                  onClick={() => setRefreshTrigger((prev) => prev + 1)}
                  className="mt-2.5 px-3 py-1 rounded-lg text-xs font-semibold bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 transition-colors cursor-pointer"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Analytics Content */}
          {analyticsData && (
            <>
              {/* Campaign Summary Bar */}
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                <div className="min-w-0 flex-1">
                  <span className="text-slate-400 font-medium block mb-0.5">Subject</span>
                  <span className="text-white font-semibold text-sm truncate block">
                    {campaign.subject}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-slate-400 shrink-0">
                  <div>
                    <span className="block text-[11px] text-slate-500">Recipients</span>
                    <span className="text-slate-200 font-mono font-medium">
                      {totalRecipients.toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-500">Updated</span>
                    <span className="text-slate-300 font-mono">
                      {formatCampaignDate(campaign.updatedAt || campaign.createdAt)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Key Metrics Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* 1. Open Rate Card */}
                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                      Open Rate
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                      {formatted.openRateFormatted}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {formatted.uniqueOpensFormatted}
                    <span className="text-xs font-normal text-slate-400 ml-1.5">
                      unique opens
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {formatted.totalOpensFormatted} total opens recorded
                  </div>
                </div>

                {/* 2. Click-Through Rate Card */}
                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                      Click-Through Rate (CTR)
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {formatted.ctrFormatted}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {formatted.uniqueClicksFormatted}
                    <span className="text-xs font-normal text-slate-400 ml-1.5">
                      unique clicks
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {formatted.totalClicksFormatted} total clicks recorded
                  </div>
                </div>

                {/* 3. Click-to-Delivered Rate Card */}
                <div className="p-4 rounded-xl bg-slate-950/40 border border-slate-800 sm:col-span-2 lg:col-span-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                      Click-to-Delivered
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                      {formatted.clickToDeliveredFormatted}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-white mt-1">
                    {totalRecipients > 0
                      ? `${((metrics.uniqueClicks / totalRecipients) * 100).toFixed(1)}%`
                      : '0.0%'}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    of {totalRecipients.toLocaleString()} total target recipients
                  </div>
                </div>
              </div>

              {/* No Activity Empty State */}
              {!hasAnyActivity && (
                <div className="py-8 px-4 text-center rounded-xl bg-slate-950/30 border border-slate-800 flex flex-col items-center justify-center">
                  <div className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 text-slate-400 flex items-center justify-center mb-2">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h4 className="text-sm font-semibold text-slate-200">No engagement activity recorded yet</h4>
                  <p className="text-xs text-slate-400 max-w-sm mt-1">
                    Once recipients open this email or click tracked links, real-time engagement data will appear here.
                  </p>
                </div>
              )}

              {/* Link Breakdown Section */}
              {linkBreakdown.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <span>Link Performance Breakdown</span>
                    <span className="text-xs font-normal text-slate-400">
                      ({linkBreakdown.length} {linkBreakdown.length === 1 ? 'link' : 'links'})
                    </span>
                  </h3>
                  <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-950/40">
                    <table className="w-full text-left text-xs" aria-label="Link click breakdown">
                      <thead>
                        <tr className="border-b border-slate-800 text-slate-400 font-medium bg-slate-900/60">
                          <th className="py-2.5 px-3">Target URL</th>
                          <th className="py-2.5 px-3 text-right">Total Clicks</th>
                          <th className="py-2.5 px-3 text-right">Unique Clicks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50">
                        {linkBreakdown.map((link, idx) => (
                          <tr key={idx} className="hover:bg-slate-800/20">
                            <td className="py-2.5 px-3 font-mono text-slate-300 truncate max-w-xs sm:max-w-md">
                              <span title={link.url}>{link.url}</span>
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-slate-200">
                              {link.totalClicks}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono text-emerald-400 font-semibold">
                              {link.uniqueClicks}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Recent Activity Timeline Section */}
              {recentActivity.length > 0 && (
                <div className="flex flex-col gap-2.5">
                  <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                    <span>Recent Activity</span>
                    <span className="text-xs font-normal text-slate-400">
                      (Latest {recentActivity.length} events)
                    </span>
                  </h3>
                  <div className="rounded-xl border border-slate-800 overflow-hidden bg-slate-950/40 max-h-60 overflow-y-auto">
                    <ul className="divide-y divide-slate-800/50 text-xs" aria-label="Recent activity events">
                      {recentActivity.map((event) => (
                        <li key={event.id} className="py-2.5 px-3 flex items-center justify-between gap-3 hover:bg-slate-800/20">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider shrink-0 ${
                                event.eventType === 'click'
                                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                  : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                              }`}
                            >
                              {event.eventType}
                            </span>
                            <span className="font-mono text-slate-300 truncate">
                              {event.recipientEmail}
                            </span>
                            {event.targetUrl && (
                              <span className="hidden sm:inline text-slate-500 font-mono text-[11px] truncate max-w-[200px]" title={event.targetUrl}>
                                → {event.targetUrl}
                              </span>
                            )}
                          </div>
                          <span className="text-slate-500 font-mono text-[11px] shrink-0">
                            {formatCampaignDate(event.timestamp)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-900/90 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default CampaignAnalyticsDialog;

