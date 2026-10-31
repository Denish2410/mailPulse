import { formatCampaignDate, getCampaignStatusBadge, isCampaignEditable } from '../../utils/campaignHelpers.js';

/**
 * CampaignsTable Component
 *
 * Renders the tabular list of email campaigns, supporting loading skeleton,
 * initial empty state, and filtered no-results state.
 * Never renders raw HTML content.
 */
export const CampaignsTable = ({
  campaigns = [],
  isLoading = false,
  hasActiveFilters = false,
  onResetFilters,
  onNewCampaign,
  onPreviewCampaign,
  onViewAnalytics,
  onEditCampaign,
  onDeleteCampaign,
}) => {
  // 1. Loading State: Skeleton Rows
  if (isLoading) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[300px]" role="status" aria-live="polite">
        <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-slate-400 font-medium">Loading campaigns...</p>
      </div>
    );
  }

  // 2. Initial Empty State (No campaigns created yet)
  if (campaigns.length === 0 && !hasActiveFilters) {
    return (
      <div className="py-16 px-6 text-center flex flex-col items-center justify-center">
        <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center mb-4">
          <svg
            className="w-7 h-7"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-white mb-1">No campaigns yet</h3>
        <p className="text-sm text-slate-400 max-w-md mb-6">
          Get started by creating your first email campaign draft to engage your audience.
        </p>
        <button
          type="button"
          onClick={onNewCampaign}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span>New Campaign</span>
        </button>
      </div>
    );
  }

  // 3. Filtered No-Results State
  if (campaigns.length === 0 && hasActiveFilters) {
    return (
      <div className="py-16 px-6 text-center flex flex-col items-center justify-center">
        <div className="w-14 h-14 rounded-2xl bg-slate-800/60 border border-slate-700 text-slate-400 flex items-center justify-center mb-4">
          <svg
            className="w-7 h-7"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-white mb-1">No matching campaigns</h3>
        <p className="text-sm text-slate-400 max-w-md mb-6">
          No campaigns matched your search query. Try adjusting your search term or clear the filter.
        </p>
        <button
          type="button"
          onClick={onResetFilters}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
        >
          <span>Clear Search</span>
        </button>
      </div>
    );
  }

  // 4. Tabular List
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-sm" aria-label="Campaigns list">
        <thead>
          <tr className="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-900/60">
            <th scope="col" className="py-3.5 pl-4 sm:pl-6 pr-4">Campaign</th>
            <th scope="col" className="py-3.5 px-4 hidden md:table-cell">Subject</th>
            <th scope="col" className="py-3.5 px-4 hidden sm:table-cell">Status</th>
            <th scope="col" className="py-3.5 px-4 hidden lg:table-cell">Recipients</th>
            <th scope="col" className="py-3.5 px-4 hidden sm:table-cell">Updated</th>
            <th scope="col" className="py-3.5 pl-4 pr-4 sm:pr-6 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {campaigns.map((campaign) => {
            const statusBadge = getCampaignStatusBadge(campaign.status);
            const recipientCount = Number(campaign.recipientsCount) || 0;

            return (
              <tr
                key={campaign.id}
                className="hover:bg-slate-800/30 transition-colors group"
              >
                {/* Campaign Name & Mobile Subject Preview */}
                <td className="py-3.5 pl-4 sm:pl-6 pr-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-slate-800 to-indigo-950 border border-slate-700 text-indigo-300 font-bold text-xs flex items-center justify-center shrink-0">
                      <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-100 group-hover:text-indigo-200 transition-colors truncate max-w-xs sm:max-w-sm">
                        {campaign.name}
                      </div>
                      <div className="md:hidden text-xs text-slate-400 truncate max-w-xs mt-0.5">
                        {campaign.subject}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Subject (Desktop) */}
                <td className="py-3.5 px-4 hidden md:table-cell text-slate-300 text-xs truncate max-w-xs">
                  {campaign.subject}
                </td>

                {/* Status Badge */}
                <td className="py-3.5 px-4 hidden sm:table-cell">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusBadge.pillClass}`}>
                    {statusBadge.label}
                  </span>
                </td>

                {/* Recipients Count Badge */}
                <td className="py-3.5 px-4 hidden lg:table-cell text-xs text-slate-300">
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-800/60 border border-slate-700/60 font-mono text-xs text-slate-300">
                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    <span>{recipientCount} {recipientCount === 1 ? 'contact' : 'contacts'}</span>
                  </span>
                </td>

                {/* Last Updated Date */}
                <td className="py-3.5 px-4 hidden sm:table-cell text-xs text-slate-400">
                  {formatCampaignDate(campaign.updatedAt || campaign.createdAt)}
                </td>

                {/* Row Actions */}
                <td className="py-3.5 pl-4 pr-4 sm:pr-6 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-1.5">
                    {/* Preview & Review Action */}
                    <button
                      type="button"
                      onClick={() => onPreviewCampaign && onPreviewCampaign(campaign)}
                      aria-label={`Preview & review campaign ${campaign.name}`}
                      title="Preview & Review"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-300 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                        />
                      </svg>
                    </button>

                    {/* View Analytics Action */}
                    <button
                      type="button"
                      onClick={() => onViewAnalytics && onViewAnalytics(campaign)}
                      aria-label={`View tracking analytics for ${campaign.name}`}
                      title="Tracking Analytics"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                        />
                      </svg>
                    </button>

                    {/* Edit & Delete are only offered for drafts; sent campaigns are locked */}
                    {isCampaignEditable(campaign) && (
                    <>
                    {/* Edit Action */}
                    <button
                      type="button"
                      onClick={() => onEditCampaign && onEditCampaign(campaign)}
                      aria-label={`Edit campaign ${campaign.name}`}
                      title="Edit campaign"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                        />
                      </svg>
                    </button>

                    {/* Delete Action */}
                    <button
                      type="button"
                      onClick={() => onDeleteCampaign(campaign)}
                      aria-label={`Delete campaign ${campaign.name}`}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 focus:outline-none focus:ring-2 focus:ring-rose-500 transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                    </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default CampaignsTable;
