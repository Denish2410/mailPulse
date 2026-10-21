/**
 * CampaignFilters Component
 *
 * Provides responsive search control for campaigns by name or subject
 * with clear/reset capability.
 */
export const CampaignFilters = ({
  search = '',
  onSearchChange,
  onReset,
  disabled = false,
}) => {
  const hasActiveFilters = Boolean(search.trim());

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full">
      {/* Search Input */}
      <div className="relative flex-1">
        <label htmlFor="campaign-search-input" className="sr-only">
          Search campaigns by name or subject
        </label>
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-500">
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
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        <input
          id="campaign-search-input"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by campaign name or subject..."
          disabled={disabled}
          className="w-full pl-10 pr-4 py-2.5 bg-slate-900/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-60"
        />
      </div>

      {/* Reset Action */}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={onReset}
          disabled={disabled}
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-medium text-slate-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
        >
          <svg
            className="w-3.5 h-3.5 text-slate-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
          <span>Reset</span>
        </button>
      )}
    </div>
  );
};

export default CampaignFilters;
