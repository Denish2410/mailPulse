import { useState, useEffect, useRef } from 'react';
import { getCampaignReadiness, getErrorMessage } from '../../api/campaigns.js';
import {
  extractReadinessData,
  formatReadinessIssues,
  getReadinessBadge,
  formatReadinessSummary,
  getCampaignStatusBadge,
  formatCampaignDate,
} from '../../utils/campaignHelpers.js';

/**
 * CampaignPreviewDialog Component
 *
 * An accessible modal dialog allowing users to preview and review
 * a saved email campaign draft.
 *
 * Features:
 * - Read-only inspection of campaign metadata, subject, and content.
 * - Live readiness status evaluation with loading and error/retry states.
 * - Clear distinction between total selected, eligible, and unavailable recipients.
 * - Dual-tab content preview: sandboxed iframe for HTML and formatted text for plain text.
 * - STRICT SECURITY: Campaign HTML is rendered exclusively within an iframe
 *   with an empty sandbox attribute (sandbox="") and srcDoc.
 *   Direct DOM injection is NEVER used.
 * - Keyboard navigation (Escape key dismissal) and focus styling.
 * - Read-only safeguards: does not send emails or initiate sending workflows.
 *
 * @param {object} props
 * @param {boolean} [props.isOpen=false] - Dialog visibility
 * @param {object|null} [props.campaign=null] - Saved campaign object to preview
 * @param {function(): void} props.onClose - Close callback
 * @param {function(object): void} [props.onEdit] - Optional callback to switch to editing
 */
export const CampaignPreviewDialog = ({
  isOpen = false,
  campaign = null,
  onClose,
  onEdit,
}) => {
  // Readiness evaluation state
  const [readinessData, setReadinessData] = useState(null);
  const [isLoadingReadiness, setIsLoadingReadiness] = useState(true);
  const [readinessError, setReadinessError] = useState(null);
  const [retryTrigger, setRetryTrigger] = useState(0);

  // Content inspection tab: 'html' | 'text' | 'recipients'
  const [activeTab, setActiveTab] = useState('html');

  // Track latest request to guard against stale out-of-order responses
  const requestIdRef = useRef(0);

  // Synchronize tab preference based on available campaign content
  useEffect(() => {
    if (!isOpen || !campaign) return;

    const hasHtml = Boolean(campaign.htmlContent && campaign.htmlContent.trim().length > 0);
    const hasText = Boolean(campaign.textContent && campaign.textContent.trim().length > 0);

    if (hasHtml) {
      setActiveTab('html');
    } else if (hasText) {
      setActiveTab('text');
    } else {
      setActiveTab('html');
    }
  }, [isOpen, campaign?.id]);

  // Fetch campaign readiness from backend
  useEffect(() => {
    if (!isOpen || !campaign?.id) {
      setReadinessData(null);
      setReadinessError(null);
      setIsLoadingReadiness(false);
      return;
    }

    let isMounted = true;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;

    setIsLoadingReadiness(true);
    setReadinessError(null);

    getCampaignReadiness(campaign.id, { signal: controller.signal })
      .then((data) => {
        if (isMounted && currentRequestId === requestIdRef.current) {
          const parsed = extractReadinessData(data);
          setReadinessData(parsed);
          setReadinessError(null);
          setIsLoadingReadiness(false);
        }
      })
      .catch((err) => {
        if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
          return;
        }
        if (isMounted && currentRequestId === requestIdRef.current) {
          setReadinessError(
            getErrorMessage(err, 'Failed to evaluate campaign readiness. Please try again.')
          );
          setIsLoadingReadiness(false);
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [isOpen, campaign?.id, retryTrigger]);

  // Handle Escape key
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

  // Presentation summaries
  const statusBadge = getCampaignStatusBadge(campaign.status);
  const summary = formatReadinessSummary(readinessData?.summary || {});
  const issues = formatReadinessIssues(readinessData?.issues || []);
  const readinessBadge = getReadinessBadge(readinessData?.isReady === true);

  const hasHtml = Boolean(campaign.htmlContent && campaign.htmlContent.trim().length > 0);
  const hasText = Boolean(campaign.textContent && campaign.textContent.trim().length > 0);

  // Recipient numbers
  const totalSelectedCount = Array.isArray(campaign.recipientIds)
    ? campaign.recipientIds.length
    : campaign.recipientsCount || 0;
  const eligibleCount = summary.eligibleRecipientsCount;
  const missingCount = summary.missingRecipientsCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-preview-title"
      aria-describedby="campaign-preview-desc"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal Dialog Card */}
      <div className="relative w-full max-w-4xl max-h-[92vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-10 flex flex-col">
        {/* Dialog Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90 shrink-0">
          <div className="flex-1 pr-4 min-w-0">
            <div className="flex items-center gap-2.5 mb-1 flex-wrap">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold tracking-wide uppercase bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                Preview & Review
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusBadge.pillClass}`}
              >
                {statusBadge.label}
              </span>
            </div>
            <h2
              id="campaign-preview-title"
              className="text-lg sm:text-xl font-bold text-white truncate"
            >
              {campaign.name}
            </h2>
            <p id="campaign-preview-desc" className="text-xs text-slate-400 mt-0.5">
              Review campaign details, email content, and sending readiness before scheduling.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview dialog"
            className="p-1.5 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 flex flex-col gap-5">
          {/* Section 1: Campaign Metadata Strip */}
          <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="min-w-0 flex-1">
              <span className="text-slate-400 font-medium block mb-0.5">Email Subject</span>
              <span className="text-white font-semibold text-sm break-words">{campaign.subject}</span>
            </div>

            <div className="flex items-center gap-4 text-slate-400 shrink-0">
              <div>
                <span className="block text-[11px] text-slate-500">Last updated</span>
                <span className="text-slate-300 font-mono">
                  {formatCampaignDate(campaign.updatedAt || campaign.createdAt)}
                </span>
              </div>
            </div>
          </div>

          {/* Section 2: Live Readiness Evaluation Banner */}
          {isLoadingReadiness ? (
            <div
              className="p-5 rounded-xl bg-slate-950/60 border border-slate-800 flex items-center justify-center gap-3 text-sm text-slate-300"
              role="status"
              aria-live="polite"
            >
              <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin shrink-0" />
              <span>Evaluating campaign readiness and verifying recipient contacts...</span>
            </div>
          ) : readinessError ? (
            <div
              className="p-4 sm:p-5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs sm:text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg"
              role="alert"
            >
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-rose-400 shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div>
                  <h4 className="font-semibold text-rose-200">Unable to check readiness</h4>
                  <p className="text-xs text-rose-300/90 mt-0.5">{readinessError}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRetryTrigger((prev) => prev + 1)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-100 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500 cursor-pointer self-start sm:self-auto shrink-0"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>Retry Check</span>
              </button>
            </div>
          ) : readinessData?.isReady ? (
            /* Ready for Review State */
            <div
              className="p-4 sm:p-5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 flex items-start gap-3.5"
              role="status"
            >
              <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-bold text-white text-sm sm:text-base">Ready for Review</h4>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${readinessBadge.pillClass}`}>
                    {readinessBadge.label}
                  </span>
                </div>
                <p className="text-xs text-emerald-300/90 mt-1">
                  This campaign satisfies all requirements. Subject line, message content, and verified recipients are ready for dispatch.
                </p>
              </div>
            </div>
          ) : (
            /* Needs Attention / Issues Found State */
            <div
              className="p-4 sm:p-5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 flex flex-col gap-3"
              role="alert"
            >
              <div className="flex items-start gap-3.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                    />
                  </svg>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-bold text-white text-sm sm:text-base">Needs Attention</h4>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${readinessBadge.pillClass}`}>
                      {readinessBadge.label}
                    </span>
                  </div>
                  <p className="text-xs text-amber-300/90 mt-0.5">
                    Resolve the following issues before this campaign can be sent:
                  </p>
                </div>
              </div>

              {issues.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1.5 pl-11 text-xs">
                  {issues.map((issue, idx) => (
                    <li key={idx} className="flex items-start gap-2 text-slate-200">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                      <span>{issue}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Section 3: Summary Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {/* Metric 1: Eligible Recipients */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col">
              <span className="text-slate-400 font-medium text-[11px] uppercase tracking-wider mb-1">
                Eligible Contacts
              </span>
              <span className="text-lg font-bold text-white font-mono">
                {isLoadingReadiness ? '—' : eligibleCount}
              </span>
              <span className="text-[11px] text-emerald-400 mt-0.5">Verified active</span>
            </div>

            {/* Metric 2: Missing / Unavailable Recipients */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col">
              <span className="text-slate-400 font-medium text-[11px] uppercase tracking-wider mb-1">
                Unavailable
              </span>
              <span
                className={`text-lg font-bold font-mono ${
                  missingCount > 0 ? 'text-amber-400' : 'text-slate-300'
                }`}
              >
                {isLoadingReadiness ? '—' : missingCount}
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">
                {missingCount > 0 ? 'Deleted / unowned' : 'None missing'}
              </span>
            </div>

            {/* Metric 3: Total Selected */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col">
              <span className="text-slate-400 font-medium text-[11px] uppercase tracking-wider mb-1">
                Total Selected
              </span>
              <span className="text-lg font-bold text-white font-mono">
                {isLoadingReadiness
                  ? totalSelectedCount
                  : summary.totalRecipients || totalSelectedCount}
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">In draft</span>
            </div>

            {/* Metric 4: Content Type */}
            <div className="p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 flex flex-col">
              <span className="text-slate-400 font-medium text-[11px] uppercase tracking-wider mb-1">
                Content Type
              </span>
              <span className="text-sm font-semibold text-white truncate mt-1">
                {hasHtml && hasText
                  ? 'HTML & Plain Text'
                  : hasHtml
                  ? 'HTML only'
                  : hasText
                  ? 'Plain Text only'
                  : 'No Content'}
              </span>
              <span className="text-[11px] text-slate-500 mt-auto">
                {hasHtml ? 'Rich layout' : 'Text message'}
              </span>
            </div>
          </div>

          {/* Section 4: Content & Recipient Tabs */}
          <div>
            <div className="flex border-b border-slate-800 gap-2 overflow-x-auto" role="tablist">
              {/* HTML Tab */}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'html'}
                onClick={() => setActiveTab('html')}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'html'
                    ? 'border-indigo-500 text-white bg-slate-800/40 rounded-t-lg'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>HTML Preview</span>
                {hasHtml && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="HTML content available" />
                )}
              </button>

              {/* Plain Text Tab */}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'text'}
                onClick={() => setActiveTab('text')}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'text'
                    ? 'border-indigo-500 text-white bg-slate-800/40 rounded-t-lg'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Plain Text</span>
                {hasText && (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Plain text available" />
                )}
              </button>

              {/* Recipients Tab */}
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'recipients'}
                onClick={() => setActiveTab('recipients')}
                className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                  activeTab === 'recipients'
                    ? 'border-indigo-500 text-white bg-slate-800/40 rounded-t-lg'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <span>Eligible Recipients</span>
                <span className="px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 font-mono text-[10px]">
                  {eligibleCount}
                </span>
              </button>
            </div>

            {/* Tab Body Panels */}
            <div className="pt-3">
              {/* Tab 1: HTML Preview Panel */}
              {activeTab === 'html' && (
                <div>
                  {hasHtml ? (
                    <div>
                      {/* STRICT SECURITY REQUIREMENT:
                          Rendered in an iframe with sandbox="" (scripts and same-origin access are disabled).
                          Direct DOM injection is NEVER used. */}
                      <iframe
                        title="Campaign HTML Email Preview"
                        sandbox=""
                        srcDoc={campaign.htmlContent}
                        className="w-full h-80 sm:h-96 rounded-xl bg-white border border-slate-700/60 shadow-inner"
                      />
                      <p className="mt-1.5 text-[11px] text-slate-500 flex items-center gap-1">
                        <svg className="w-3.5 h-3.5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                        <span>Secure sandboxed preview. Embedded scripts, popups, and parent DOM access are disabled.</span>
                      </p>
                    </div>
                  ) : (
                    <div className="p-8 text-center flex flex-col items-center justify-center bg-slate-950/40 border border-slate-800 rounded-xl">
                      <p className="text-xs sm:text-sm text-slate-400 font-medium">
                        No HTML content provided for this campaign.
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        You can add HTML markup in the campaign editor.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Plain Text Panel */}
              {activeTab === 'text' && (
                <div>
                  {hasText ? (
                    <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 text-slate-200 text-xs sm:text-sm font-mono whitespace-pre-wrap break-words max-h-80 sm:max-h-96 overflow-y-auto">
                      {campaign.textContent}
                    </div>
                  ) : (
                    <div className="p-8 text-center flex flex-col items-center justify-center bg-slate-950/40 border border-slate-800 rounded-xl">
                      <p className="text-xs sm:text-sm text-slate-400 font-medium">
                        No plain text content provided for this campaign.
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        You can compose plain text content in the campaign editor.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Eligible Recipients List Panel */}
              {activeTab === 'recipients' && (
                <div className="flex flex-col gap-3">
                  {missingCount > 0 && (
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs flex items-center gap-2">
                      <svg className="w-4 h-4 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span>
                        Notice: {missingCount} recipient(s) originally stored on this draft could not be verified. They may have been deleted or belong to a different account.
                      </span>
                    </div>
                  )}

                  {isLoadingReadiness ? (
                    <div className="py-8 flex items-center justify-center text-xs text-slate-400 gap-2">
                      <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                      <span>Loading verified recipient list...</span>
                    </div>
                  ) : readinessData?.summary?.eligibleRecipients &&
                    readinessData.summary.eligibleRecipients.length > 0 ? (
                    <div className="rounded-xl border border-slate-800 overflow-hidden max-h-80 overflow-y-auto">
                      <table className="min-w-full divide-y divide-slate-800 text-left text-xs">
                        <thead className="bg-slate-950/80 text-slate-400 uppercase tracking-wider font-semibold sticky top-0">
                          <tr>
                            <th className="py-2.5 px-4">Name</th>
                            <th className="py-2.5 px-4">Email</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 bg-slate-900/40 text-slate-200">
                          {readinessData.summary.eligibleRecipients.map((rec, i) => (
                            <tr key={rec.id || i} className="hover:bg-slate-800/40 transition-colors">
                              <td className="py-2.5 px-4 font-medium text-white">{rec.name || '—'}</td>
                              <td className="py-2.5 px-4 text-slate-300 font-mono">{rec.email}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="p-8 text-center flex flex-col items-center justify-center bg-slate-950/40 border border-slate-800 rounded-xl">
                      <p className="text-xs sm:text-sm text-slate-400 font-medium">
                        No eligible recipients found.
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        Select contacts in the campaign editor to add recipients.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Dialog Footer */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-6 py-4 border-t border-slate-800 bg-slate-900/90 shrink-0">
          <span className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Read-only preview. Sending is not available in this phase.</span>
          </span>

          <div className="flex items-center justify-end gap-2.5">
            {onEdit && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onEdit(campaign);
                }}
                className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 hover:text-white border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
              >
                Edit Campaign
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CampaignPreviewDialog;
