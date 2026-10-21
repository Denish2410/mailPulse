import Navbar from '../../components/layout/Navbar.jsx';

/**
 * CampaignsPage Component
 *
 * Page shell for Campaign Management in MailPulse.
 * Provides header, navigation, and workspace container.
 */
export const CampaignsPage = () => {
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
        </div>

        {/* Content Shell */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl shadow-xl overflow-hidden backdrop-blur-sm p-8 sm:p-12 text-center flex flex-col items-center justify-center">
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
          <h2 className="text-lg font-bold text-white mb-2">Campaign Management Workspace</h2>
          <p className="text-sm text-slate-400 max-w-md">
            Campaign list, draft editor, and recipient targeting are being prepared in subsequent steps.
          </p>
        </div>
      </main>
    </div>
  );
};

export default CampaignsPage;
