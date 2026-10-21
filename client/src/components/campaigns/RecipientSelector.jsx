import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getContacts, getErrorMessage } from '../../api/contacts.js';
import {
  toggleRecipientId,
  removeRecipientId,
  togglePageRecipients,
} from '../../utils/campaignHelpers.js';

/**
 * RecipientSelector Component
 *
 * A controlled, reusable component for searching, selecting, and managing
 * contact recipients for an email campaign draft.
 *
 * Key guarantees:
 * - Controlled via `selectedIds` and `onChange` props.
 * - Selection persistence: preserves selected contacts across page navigation,
 *   server-side searches, and list refreshes.
 * - Unavailable/deleted contact retention: selected IDs not found in the current
 *   fetched page or contact directory are preserved and rendered with a neutral badge.
 * - Debounced server search (300ms) with request cancellation / stale-request guards.
 * - Compact chip preview with accessible keyboard removal.
 * - Server pagination with per-page limit selector.
 *
 * @param {object} props
 * @param {Array<string>} [props.selectedIds=[]] - Array of selected contact IDs
 * @param {function(Array<string>): void} props.onChange - Callback invoked when selection changes
 * @param {boolean} [props.disabled=false] - Disables interaction
 * @param {string} [props.idPrefix='recipient-selector'] - Unique prefix for accessibility IDs
 * @param {Array<object>} [props.initialKnownContacts=[]] - Optional initial contact details for preview
 */
export const RecipientSelector = ({
  selectedIds = [],
  onChange,
  disabled = false,
  idPrefix = 'recipient-selector',
  initialKnownContacts = [],
}) => {
  // Query parameters state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Server data state
  const [contacts, setContacts] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Cache of known contacts (ID -> { id, name, email }) to render chips
  // even after navigating pages or filtering searches.
  const [knownContactsMap, setKnownContactsMap] = useState(() => {
    const map = new Map();
    if (Array.isArray(initialKnownContacts)) {
      initialKnownContacts.forEach((c) => {
        if (c && c.id) {
          map.set(c.id, { id: c.id, name: c.name || '', email: c.email || '' });
        }
      });
    }
    return map;
  });

  // Ref to track latest request ID to prevent stale out-of-order race conditions
  const requestIdRef = useRef(0);

  // Normalize selected IDs to a safe array of strings
  const safeSelectedIds = useMemo(() => {
    if (!Array.isArray(selectedIds)) return [];
    return Array.from(new Set(selectedIds.filter((id) => typeof id === 'string' && id.length > 0)));
  }, [selectedIds]);

  const selectedCount = safeSelectedIds.length;

  // 1. Debounce Search Input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 2. Fetch contacts from API on parameter changes
  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;

    setIsLoading(true);
    setLoadError(null);

    getContacts(
      {
        page,
        limit,
        search: debouncedSearch,
      },
      { signal: controller.signal }
    )
      .then((data) => {
        if (!isMounted || currentRequestId !== requestIdRef.current) return;

        if (data) {
          const fetchedContacts = Array.isArray(data.contacts) ? data.contacts : [];
          setContacts(fetchedContacts);

          // Update known contacts cache
          setKnownContactsMap((prev) => {
            const next = new Map(prev);
            fetchedContacts.forEach((contact) => {
              if (contact && contact.id) {
                next.set(contact.id, {
                  id: contact.id,
                  name: contact.name || '',
                  email: contact.email || '',
                });
              }
            });
            return next;
          });

          setPagination(
            data.pagination || {
              page,
              limit,
              total: data.count || 0,
              totalPages: Math.ceil((data.count || 0) / limit),
              hasNextPage: false,
              hasPrevPage: false,
            }
          );
        }
        setIsLoading(false);
      })
      .catch((err) => {
        if (!isMounted || currentRequestId !== requestIdRef.current) return;

        // Ignore user/system aborted requests
        if (
          err.name === 'CanceledError' ||
          err.name === 'AbortError' ||
          err.code === 'ERR_CANCELED'
        ) {
          return;
        }

        setLoadError(getErrorMessage(err, 'Failed to load contacts.'));
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [page, limit, debouncedSearch, refreshTrigger]);

  // Handlers for search input
  const handleSearchChange = (value) => {
    setSearchInput(value);
    setPage(1); // Reset to page 1 on search change
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setPage(1);
  };

  // Selection toggles
  const handleToggleContact = useCallback(
    (contactId) => {
      if (disabled || !onChange) return;
      const updated = toggleRecipientId(safeSelectedIds, contactId);
      onChange(updated);
    },
    [disabled, onChange, safeSelectedIds]
  );

  const handleRemoveChip = useCallback(
    (contactId) => {
      if (disabled || !onChange) return;
      const updated = removeRecipientId(safeSelectedIds, contactId);
      onChange(updated);
    },
    [disabled, onChange, safeSelectedIds]
  );

  const handleSelectAllOnPage = useCallback(() => {
    if (disabled || !onChange || contacts.length === 0) return;
    const updated = togglePageRecipients(safeSelectedIds, contacts);
    onChange(updated);
  }, [disabled, onChange, safeSelectedIds, contacts]);

  const handleDeselectAll = useCallback(() => {
    if (disabled || !onChange) return;
    onChange([]);
  }, [disabled, onChange]);

  // Calculate page select-all status
  const pageContactIds = useMemo(
    () => contacts.map((c) => c.id).filter(Boolean),
    [contacts]
  );
  const isAllPageSelected =
    pageContactIds.length > 0 &&
    pageContactIds.every((id) => safeSelectedIds.includes(id));
  const isSomePageSelected =
    pageContactIds.length > 0 &&
    pageContactIds.some((id) => safeSelectedIds.includes(id)) &&
    !isAllPageSelected;

  // Pagination bounds
  const total = pagination.total || 0;
  const totalPages = pagination.totalPages || 0;
  const startRecord = total === 0 ? 0 : (page - 1) * limit + 1;
  const endRecord = total === 0 ? 0 : Math.min(page * limit, total);

  return (
    <div className="flex flex-col gap-3 w-full" data-testid="recipient-selector">
      {/* Selected Recipients Preview Bar */}
      <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Selected Recipients:
            </span>
            <span
              className="px-2 py-0.5 rounded-full text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
              aria-live="polite"
              aria-atomic="true"
            >
              {selectedCount}
            </span>
          </div>

          {selectedCount > 0 && !disabled && (
            <button
              type="button"
              onClick={handleDeselectAll}
              className="text-xs text-slate-400 hover:text-rose-400 font-medium transition-colors focus:outline-none focus:underline cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Selected Chips */}
        {selectedCount === 0 ? (
          <p className="text-xs text-slate-500 italic py-1">
            No contacts selected. Select recipients from the list below.
          </p>
        ) : (
          <div
            className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1"
            role="region"
            aria-label="Selected recipients list"
          >
            {safeSelectedIds.map((id) => {
              const known = knownContactsMap.get(id);
              const label = known?.name || known?.email || null;
              const isUnavailable = !label;

              return (
                <span
                  key={id}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                    isUnavailable
                      ? 'bg-slate-800/80 text-slate-400 border-slate-700/80'
                      : 'bg-indigo-500/10 text-indigo-200 border-indigo-500/30'
                  }`}
                >
                  <span className="max-w-[140px] sm:max-w-[180px] truncate">
                    {isUnavailable ? 'Unavailable contact' : label}
                  </span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => handleRemoveChip(id)}
                      disabled={disabled}
                      aria-label={`Remove ${isUnavailable ? 'unavailable contact' : label}`}
                      className="text-slate-400 hover:text-rose-400 focus:outline-none focus:text-rose-400 p-0.5 rounded transition-colors cursor-pointer"
                    >
                      <svg
                        className="w-3 h-3"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Search Input & Select-All Row */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <div className="relative flex-1">
          <label htmlFor={`${idPrefix}-search`} className="sr-only">
            Search contacts by name or email
          </label>
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
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
            id={`${idPrefix}-search`}
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search contacts..."
            disabled={disabled}
            className="w-full pl-9 pr-8 py-2 bg-slate-900/80 border border-slate-800 rounded-xl text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors disabled:opacity-60"
          />
          {searchInput && (
            <button
              type="button"
              onClick={handleClearSearch}
              disabled={disabled}
              aria-label="Clear search"
              className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-400 hover:text-slate-200 focus:outline-none cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Page Select-All Button */}
        {contacts.length > 0 && (
          <button
            type="button"
            onClick={handleSelectAllOnPage}
            disabled={disabled || isLoading}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
          >
            <input
              type="checkbox"
              readOnly
              checked={isAllPageSelected}
              ref={(input) => {
                if (input) input.indeterminate = isSomePageSelected;
              }}
              tabIndex={-1}
              aria-hidden="true"
              className="w-3.5 h-3.5 rounded bg-slate-800 border-slate-700 text-indigo-600 pointer-events-none"
            />
            <span>{isAllPageSelected ? 'Deselect page' : 'Select page'}</span>
          </button>
        )}
      </div>

      {/* Contacts List Box */}
      <div className="border border-slate-800 rounded-xl bg-slate-950/60 overflow-hidden min-h-[220px] flex flex-col justify-between">
        {isLoading ? (
          <div className="p-8 flex flex-col items-center justify-center flex-1" role="status" aria-live="polite">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-xs text-slate-400">Loading contacts...</p>
          </div>
        ) : loadError ? (
          <div className="p-6 text-center flex flex-col items-center justify-center flex-1" role="alert">
            <p className="text-xs font-semibold text-rose-400 mb-2">{loadError}</p>
            <button
              type="button"
              onClick={() => setRefreshTrigger((prev) => prev + 1)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : contacts.length === 0 ? (
          <div className="p-6 text-center flex flex-col items-center justify-center flex-1">
            <p className="text-xs text-slate-400 font-medium mb-1">
              {debouncedSearch ? 'No contacts match your search.' : 'No contacts available.'}
            </p>
            {debouncedSearch && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="text-xs text-indigo-400 hover:underline font-medium cursor-pointer"
              >
                Clear search filter
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-800/80 max-h-[260px] overflow-y-auto">
            {contacts.map((contact) => {
              const isSelected = safeSelectedIds.includes(contact.id);
              const inputId = `${idPrefix}-contact-${contact.id}`;

              return (
                <label
                  key={contact.id}
                  htmlFor={inputId}
                  className={`flex items-center gap-3 p-2.5 sm:px-3.5 hover:bg-slate-800/40 transition-colors cursor-pointer select-none ${
                    isSelected ? 'bg-indigo-950/20' : ''
                  }`}
                >
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleToggleContact(contact.id)}
                    disabled={disabled}
                    className="w-4 h-4 rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-indigo-500 focus:ring-offset-slate-900 transition-colors cursor-pointer disabled:opacity-50"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs sm:text-sm font-semibold text-slate-200 truncate">
                      {contact.name || 'Unnamed contact'}
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      {contact.email}
                    </p>
                  </div>
                  {isSelected && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded border border-indigo-500/20">
                      Selected
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {/* Compact Pagination Bar */}
        {!isLoading && !loadError && total > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 p-2 sm:px-3 bg-slate-900/60 border-t border-slate-800 text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <span>
                {startRecord}–{endRecord} of {total}
              </span>
              <div className="flex items-center gap-1">
                <label htmlFor={`${idPrefix}-limit-select`} className="sr-only">
                  Per page
                </label>
                <select
                  id={`${idPrefix}-limit-select`}
                  value={limit}
                  onChange={(e) => {
                    setLimit(Number(e.target.value));
                    setPage(1);
                  }}
                  disabled={disabled}
                  className="bg-slate-800 border border-slate-700 text-slate-300 rounded px-1.5 py-0.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer disabled:opacity-50"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span>
                Page {totalPages === 0 ? 0 : page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={disabled || !pagination.hasPrevPage}
                  aria-label="Previous page of contacts"
                  className="p-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={disabled || !pagination.hasNextPage}
                  aria-label="Next page of contacts"
                  className="p-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RecipientSelector;
