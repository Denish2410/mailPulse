import { useState, useEffect, useRef } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import ContactFilters from '../../components/contacts/ContactFilters.jsx';
import ContactsTable from '../../components/contacts/ContactsTable.jsx';
import ContactsPagination from '../../components/contacts/ContactsPagination.jsx';
import ContactFormModal from '../../components/contacts/ContactFormModal.jsx';
import DeleteContactDialog from '../../components/contacts/DeleteContactDialog.jsx';
import {
  getContacts,
  createContact,
  updateContact,
  deleteContact,
  getErrorMessage,
} from '../../api/contacts.js';
import {
  normalizeEmailDomain,
  computePageAfterDeletion,
} from '../../utils/contactHelpers.js';

/**
 * ContactsPage Component
 *
 * Full contacts management page coordinating server data fetching,
 * pagination, search, domain filtering, and create/edit/delete modals.
 */
export const ContactsPage = () => {
  // Query parameters state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [debouncedDomain, setDebouncedDomain] = useState('');

  // Server data state
  const [contacts, setContacts] = useState([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [notification, setNotification] = useState(null);

  // Modal dialog states
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [activeContactForEdit, setActiveContactForEdit] = useState(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [activeContactForDelete, setActiveContactForDelete] = useState(null);

  // Ref to track latest request ID to prevent stale out-of-order race conditions
  const requestIdRef = useRef(0);

  // 1. Debounce Search Input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 2. Debounce Domain Filter (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedDomain(normalizeEmailDomain(domainInput));
    }, 300);
    return () => clearTimeout(timer);
  }, [domainInput]);

  // 3. Fetch Contacts from API on parameter changes
  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;

    getContacts(
      {
        page,
        limit,
        search: debouncedSearch,
        emailDomain: debouncedDomain,
      },
      { signal: controller.signal }
    )
      .then((data) => {
        if (isMounted && currentRequestId === requestIdRef.current && data) {
          setContacts(data.contacts || []);
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
          setLoadError(null);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
          return;
        }
        if (isMounted && currentRequestId === requestIdRef.current) {
          setLoadError(getErrorMessage(err, 'Failed to load contacts. Please try again.'));
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [page, limit, debouncedSearch, debouncedDomain, refreshTrigger]);

  // Clear notification banner after 4 seconds
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => {
      setNotification(null);
    }, 4000);
    return () => clearTimeout(timer);
  }, [notification]);

  // Handlers for search & filters
  const handleSearchChange = (val) => {
    setSearchInput(val);
    setPage(1);
  };

  const handleDomainChange = (val) => {
    setDomainInput(val);
    setPage(1);
  };

  const handleResetFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
    setDomainInput('');
    setDebouncedDomain('');
    setPage(1);
  };

  const handlePageChange = (newPage) => {
    setPage(newPage);
    setIsLoading(true);
  };

  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
    setIsLoading(true);
  };

  // Modal Actions
  const handleOpenCreateModal = () => {
    setActiveContactForEdit(null);
    setIsFormModalOpen(true);
  };

  const handleOpenEditModal = (contact) => {
    setActiveContactForEdit(contact);
    setIsFormModalOpen(true);
  };

  const handleOpenDeleteDialog = (contact) => {
    setActiveContactForDelete(contact);
    setIsDeleteDialogOpen(true);
  };

  // Create or Update Submission
  const handleFormSubmit = async (payload) => {
    if (activeContactForEdit?.id) {
      // Update existing contact
      await updateContact(activeContactForEdit.id, payload);
      setNotification({
        type: 'success',
        message: `Contact "${payload.name}" updated successfully.`,
      });
    } else {
      // Create new contact
      await createContact(payload);
      setNotification({
        type: 'success',
        message: `Contact "${payload.name}" added successfully.`,
      });
    }

    // Refresh current view
    setRefreshTrigger((prev) => prev + 1);
  };

  // Delete Submission
  const handleDeleteConfirm = async (contactId) => {
    const contactName = activeContactForDelete?.name || 'Contact';
    await deleteContact(contactId);

    setNotification({
      type: 'success',
      message: `Contact "${contactName}" deleted.`,
    });

    // Compute updated page index if deleting the sole item on the page
    const nextSafePage = computePageAfterDeletion({
      currentPage: page,
      totalCount: pagination.total,
      limit,
    });

    if (nextSafePage !== page) {
      setPage(nextSafePage);
    } else {
      setRefreshTrigger((prev) => prev + 1);
    }
  };

  const hasActiveFilters = Boolean(searchInput.trim() || domainInput.trim());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-2 border border-indigo-500/20">
              Phase 3 — Contact Management
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Contacts
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Organize your subscriber audience, search contacts, and manage recipients for email campaigns.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex px-3 py-1.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs font-mono text-slate-300">
              {pagination.total} {pagination.total === 1 ? 'Contact' : 'Contacts'}
            </span>

            <button
              type="button"
              onClick={handleOpenCreateModal}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>Add Contact</span>
            </button>
          </div>
        </div>

        {/* Success/Action Notification */}
        {notification && (
          <div
            className="mb-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center justify-between shadow-lg"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2.5">
              <svg className="w-5 h-5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
              </svg>
              <span>{notification.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotification(null)}
              aria-label="Dismiss notification"
              className="text-emerald-400 hover:text-emerald-200 transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Load Error Banner with Retry */}
        {loadError && (
          <div
            className="mb-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm flex items-center justify-between shadow-lg"
            role="alert"
          >
            <div className="flex items-center gap-2.5">
              <svg className="w-5 h-5 text-rose-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <span>{loadError}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setIsLoading(true);
                setRefreshTrigger((prev) => prev + 1);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-200 bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/30 transition-colors focus:outline-none focus:ring-2 focus:ring-rose-500 cursor-pointer"
            >
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Main Content Card */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl shadow-xl overflow-hidden backdrop-blur-sm">
          {/* Top Filter Controls */}
          <div className="p-4 sm:p-6 border-b border-slate-800/80">
            <ContactFilters
              search={searchInput}
              onSearchChange={handleSearchChange}
              domain={domainInput}
              onDomainChange={handleDomainChange}
              onReset={handleResetFilters}
              disabled={isLoading && contacts.length === 0}
            />
          </div>

          {/* Contacts Table View */}
          <ContactsTable
            contacts={contacts}
            isLoading={isLoading}
            hasActiveFilters={hasActiveFilters}
            onResetFilters={handleResetFilters}
            onAddContact={handleOpenCreateModal}
            onEditContact={handleOpenEditModal}
            onDeleteContact={handleOpenDeleteDialog}
          />

          {/* Pagination Controls */}
          {contacts.length > 0 && (
            <ContactsPagination
              pagination={pagination}
              onPageChange={handlePageChange}
              onLimitChange={handleLimitChange}
              disabled={isLoading}
            />
          )}
        </div>
      </main>

      {/* Create / Edit Form Modal */}
      {isFormModalOpen && (
        <ContactFormModal
          key={activeContactForEdit?.id || 'new'}
          isOpen={isFormModalOpen}
          contact={activeContactForEdit}
          onClose={() => setIsFormModalOpen(false)}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {isDeleteDialogOpen && (
        <DeleteContactDialog
          key={activeContactForDelete?.id || 'delete'}
          isOpen={isDeleteDialogOpen}
          contact={activeContactForDelete}
          onClose={() => setIsDeleteDialogOpen(false)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  );
};

export default ContactsPage;
