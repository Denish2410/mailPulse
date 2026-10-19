/**
 * ContactsPagination Component
 *
 * Renders page navigation controls, page size selector,
 * and current record range status.
 */
export const ContactsPagination = ({
  pagination = {},
  onPageChange,
  onLimitChange,
  disabled = false,
}) => {
  const page = pagination.page || 1;
  const limit = pagination.limit || 20;
  const total = pagination.total || 0;
  const totalPages = pagination.totalPages || 0;
  const hasPrev = Boolean(pagination.hasPrevPage);
  const hasNext = Boolean(pagination.hasNextPage);

  const startRecord = total === 0 ? 0 : (page - 1) * limit + 1;
  const endRecord = total === 0 ? 0 : Math.min(page * limit, total);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-3 px-4 sm:px-6 border-t border-slate-800 bg-slate-900/40 text-xs sm:text-sm text-slate-400">
      {/* Range Status & Page Size */}
      <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-start">
        <span>
          Showing{' '}
          <strong className="text-slate-200 font-semibold">{startRecord}</strong>–
          <strong className="text-slate-200 font-semibold">{endRecord}</strong> of{' '}
          <strong className="text-slate-200 font-semibold">{total}</strong> contacts
        </span>

        <div className="flex items-center gap-2">
          <label htmlFor="pagination-limit-select" className="text-xs text-slate-400">
            Per page:
          </label>
          <select
            id="pagination-limit-select"
            value={limit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            disabled={disabled}
            className="bg-slate-800/80 border border-slate-700 text-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
          >
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      {/* Page Navigation Controls */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400 mr-2">
          Page <strong className="text-slate-200 font-semibold">{totalPages === 0 ? 0 : page}</strong> of{' '}
          <strong className="text-slate-200 font-semibold">{totalPages}</strong>
        </span>

        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPrev || disabled}
          aria-label="Previous page"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700/80 hover:text-white border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          <span>Prev</span>
        </button>

        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNext || disabled}
          aria-label="Next page"
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800/80 hover:bg-slate-700/80 hover:text-white border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          <span>Next</span>
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default ContactsPagination;
