import { useState, useEffect, useRef } from 'react';
import Navbar from '../../components/layout/Navbar.jsx';
import CampaignFilters from '../../components/campaigns/CampaignFilters.jsx';
import CampaignsTable from '../../components/campaigns/CampaignsTable.jsx';
import CampaignsPagination from '../../components/campaigns/CampaignsPagination.jsx';
import DeleteCampaignDialog from '../../components/campaigns/DeleteCampaignDialog.jsx';
import CampaignFormDialog from '../../components/campaigns/CampaignFormDialog.jsx';
import {
  getCampaigns,
  getCampaignById,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getErrorMessage,
} from '../../api/campaigns.js';
import { computePageAfterDeletion } from '../../utils/campaignHelpers.js';

/**
 * CampaignsPage Component
 *
 * Full campaigns management page coordinating server data fetching,
 * pagination, search, loading/error states, campaign creation/editing,
 * and deletion dialog.
 */
export const CampaignsPage = () => {
  // Query parameters state
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Server data state
  const [campaigns, setCampaigns] = useState([]);
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

  // Form modal dialog states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [activeCampaignForEdit, setActiveCampaignForEdit] = useState(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  // Delete modal dialog state
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [activeCampaignForDelete, setActiveCampaignForDelete] = useState(null);

  // Ref to track latest request ID to prevent stale out-of-order race conditions
  const requestIdRef = useRef(0);
  const editDetailsRequestIdRef = useRef(0);

  // 1. Debounce Search Input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // 2. Fetch Campaigns from API on parameter changes
  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();
    const currentRequestId = ++requestIdRef.current;

    getCampaigns(
      {
        page,
        limit,
        search: debouncedSearch,
      },
      { signal: controller.signal }
    )
      .then((data) => {
        if (isMounted && currentRequestId === requestIdRef.current && data) {
          setCampaigns(data.campaigns || []);
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
          setLoadError(getErrorMessage(err, 'Failed to load campaigns. Please try again.'));
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [page, limit, debouncedSearch, refreshTrigger]);

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

  const handleResetFilters = () => {
    setSearchInput('');
    setDebouncedSearch('');
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

  // Form creation / editing handlers
  const handleOpenCreateDialog = () => {
    setActiveCampaignForEdit(null);
    setIsLoadingDetails(false);
    setIsFormOpen(true);
  };

  const handleOpenEditDialog = async (campaign) => {
    if (!campaign?.id) return;

    // Immediately open dialog with known row data to prevent lag
    setActiveCampaignForEdit(campaign);
    setIsFormOpen(true);
    setIsLoadingDetails(true);

    const currentReqId = ++editDetailsRequestIdRef.current;

    try {
      const fullCampaign = await getCampaignById(campaign.id);
      if (currentReqId === editDetailsRequestIdRef.current && fullCampaign) {
        setActiveCampaignForEdit(fullCampaign);
      }
    } catch (err) {
      // If fetching full campaign details fails, fallback gracefully to existing row data
      if (currentReqId === editDetailsRequestIdRef.current) {
        setNotification({
          type: 'info',
          message: 'Loaded cached campaign data. Refresh if needed.',
        });
      }
    } finally {
      if (currentReqId === editDetailsRequestIdRef.current) {
        setIsLoadingDetails(false);
      }
    }
  };

  const handleFormSubmit = async (payload) => {
    if (activeCampaignForEdit?.id) {
      // Update existing campaign
      const updated = await updateCampaign(activeCampaignForEdit.id, payload);
      setNotification({
        type: 'success',
        message: `Campaign "${updated?.name || payload.name}" updated successfully.`,
      });
    } else {
      // Create new campaign
      const created = await createCampaign(payload);
      setNotification({
        type: 'success',
        message: `Campaign "${created?.name || payload.name}" created successfully.`,
      });
    }

    // Refresh list to show updated/created campaign
    setRefreshTrigger((prev) => prev + 1);
  };

  // Deletion handlers
  const handleOpenDeleteDialog = (campaign) => {
    setActiveCampaignForDelete(campaign);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async (campaignId) => {
    const campaignName = activeCampaignForDelete?.name || 'Campaign';
    await deleteCampaign(campaignId);

    setNotification({
      type: 'success',
      message: `Campaign "${campaignName}" deleted.`,
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

  const hasActiveFilters = Boolean(searchInput.trim());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-2 border border-indigo-500/20">
              Phase 4 — Campaign Management
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Campaigns
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Create, organize, and manage email campaigns for your audience.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex px-3 py-1.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs font-mono text-slate-300">
              {pagination.total} {pagination.total === 1 ? 'Campaign' : 'Campaigns'}
            </span>

            <button
              type="button"
              onClick={handleOpenCreateDialog}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>New Campaign</span>
            </button>
          </div>
        </div>

        {/* Action / Feedback Notification Banner */}
        {notification && (
          <div
            className={`mb-6 p-4 rounded-xl text-sm flex items-center justify-between shadow-lg ${
              notification.type === 'success'
                ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                : 'bg-indigo-500/10 border border-indigo-500/20 text-indigo-300'
            }`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2.5">
              {notification.type === 'success' ? (
                <svg className="w-5 h-5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <span>{notification.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotification(null)}
              aria-label="Dismiss notification"
              className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
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
            <CampaignFilters
              search={searchInput}
              onSearchChange={handleSearchChange}
              onReset={handleResetFilters}
              disabled={isLoading && campaigns.length === 0}
            />
          </div>

          {/* Campaigns Table View */}
          <CampaignsTable
            campaigns={campaigns}
            isLoading={isLoading}
            hasActiveFilters={hasActiveFilters}
            onResetFilters={handleResetFilters}
            onNewCampaign={handleOpenCreateDialog}
            onEditCampaign={handleOpenEditDialog}
            onDeleteCampaign={handleOpenDeleteDialog}
          />

          {/* Pagination Controls */}
          {campaigns.length > 0 && (
            <CampaignsPagination
              pagination={pagination}
              onPageChange={handlePageChange}
              onLimitChange={handleLimitChange}
              disabled={isLoading}
            />
          )}
        </div>
      </main>

      {/* Campaign Create/Edit Dialog */}
      {isFormOpen && (
        <CampaignFormDialog
          key={activeCampaignForEdit?.id || 'create'}
          isOpen={isFormOpen}
          campaign={activeCampaignForEdit}
          isLoadingDetails={isLoadingDetails}
          onClose={() => {
            setIsFormOpen(false);
            setActiveCampaignForEdit(null);
            setIsLoadingDetails(false);
          }}
          onSubmit={handleFormSubmit}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {isDeleteDialogOpen && (
        <DeleteCampaignDialog
          key={activeCampaignForDelete?.id || 'delete'}
          isOpen={isDeleteDialogOpen}
          campaign={activeCampaignForDelete}
          onClose={() => setIsDeleteDialogOpen(false)}
          onConfirm={handleDeleteConfirm}
        />
      )}
    </div>
  );
};

export default CampaignsPage;
