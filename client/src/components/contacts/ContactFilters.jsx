/**
 * ContactFilters Component
 *
 * Provides responsive search and email domain filter controls
 * with instant reset capability.
 */
export const ContactFilters = ({
  search = '',
  onSearchChange,
  domain = '',
  onDomainChange,
  onReset,
  disabled = false,
}) => {
  const hasActiveFilters = Boolean(search.trim() || domain.trim());

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full">
      {/* Search Input */}
      <div className="relative flex-1">
        <label htmlFor="contact-search-input" className="sr-only">
          Search contacts by name or email
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
          id="contact-search-input"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by name or email..."
          disabled={disabled}
          className="w-full pl-10 pr-4 py-2.5 bg-slate-900/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-60"
        />
      </div>

      {/* Domain Filter Input */}
      <div className="relative sm:w-64">
        <label htmlFor="contact-domain-input" className="sr-only">
          Filter by email domain
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
              d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <input
          id="contact-domain-input"
          type="text"
          value={domain}
          onChange={(e) => onDomainChange(e.target.value)}
          placeholder="Domain (e.g. gmail.com)"
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

export default ContactFilters;
