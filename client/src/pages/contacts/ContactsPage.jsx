import Navbar from '../../components/layout/Navbar.jsx';

/**
 * ContactsPage - Phase 3, Step 5.3 Placeholder
 *
 * Minimal placeholder page registered under the protected /contacts route.
 * Full contact management interface, filters, and forms will be integrated in Step 5.4.
 */
export const ContactsPage = () => {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-indigo-500 selection:text-white">
      <Navbar />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-3 border border-indigo-500/20">
            Phase 3 — Contacts
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white">
            Contacts
          </h1>
          <p className="mt-2 text-sm text-slate-400 max-w-2xl">
            The contact management interface, search, filtering, and forms will be integrated in the next step.
          </p>
        </div>
      </main>
    </div>
  );
};

export default ContactsPage;
