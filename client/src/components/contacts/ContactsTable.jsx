import { formatContactDate } from '../../utils/contactHelpers.js';

/**
 * ContactsTable Component
 *
 * Renders the tabular list of contacts, supporting loading skeleton,
 * initial empty state, and filtered no-results state.
 */
export const ContactsTable = ({
  contacts = [],
  isLoading = false,
  hasActiveFilters = false,
  onResetFilters,
  onAddContact,
  onEditContact,
  onDeleteContact,
}) => {
  // 1. Loading State: Skeleton Rows
  if (isLoading) {
    return (
      <div className="p-8 flex flex-col items-center justify-center min-h-[300px]" role="status" aria-live="polite">
        <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-sm text-slate-400 font-medium">Loading contacts...</p>
      </div>
    );
  }

  // 2. Initial Empty State (No contacts at all in workspace)
  if (contacts.length === 0 && !hasActiveFilters) {
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
              d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
            />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-white mb-1">No contacts yet</h3>
        <p className="text-sm text-slate-400 max-w-md mb-6">
          Get started by adding your first contact to build your audience and launch email campaigns.
        </p>
        <button
          type="button"
          onClick={onAddContact}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span>Add Contact</span>
        </button>
      </div>
    );
  }

  // 3. Filtered No-Results State
  if (contacts.length === 0 && hasActiveFilters) {
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
        <h3 className="text-lg font-bold text-white mb-1">No matching contacts</h3>
        <p className="text-sm text-slate-400 max-w-md mb-6">
          No contacts matched your search or email domain filter. Try adjusting your query or reset filters.
        </p>
        <button
          type="button"
          onClick={onResetFilters}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
        >
          <span>Clear Filters</span>
        </button>
      </div>
    );
  }

  // 4. Contacts Table
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-sm" aria-label="Contacts list">
        <thead>
          <tr className="border-b border-slate-800 text-xs font-semibold text-slate-400 uppercase tracking-wider bg-slate-900/60">
            <th scope="col" className="py-3.5 pl-4 sm:pl-6 pr-4">Contact</th>
            <th scope="col" className="py-3.5 px-4 hidden md:table-cell">Email</th>
            <th scope="col" className="py-3.5 px-4 hidden sm:table-cell">Added</th>
            <th scope="col" className="py-3.5 pl-4 pr-4 sm:pr-6 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/60">
          {contacts.map((contact) => {
            const initial = (contact.name || 'C').trim().charAt(0).toUpperCase();

            return (
              <tr
                key={contact.id}
                className="hover:bg-slate-800/30 transition-colors group"
              >
                {/* Contact Name & Mobile Email */}
                <td className="py-3.5 pl-4 sm:pl-6 pr-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-slate-800 to-indigo-950 border border-slate-700 text-indigo-300 font-bold text-xs flex items-center justify-center shrink-0">
                      {initial}
                    </div>
                    <div>
                      <div className="font-semibold text-slate-100 group-hover:text-indigo-200 transition-colors">
                        {contact.name}
                      </div>
                      <div className="md:hidden text-xs text-slate-400 font-mono mt-0.5">
                        {contact.email}
                      </div>
                    </div>
                  </div>
                </td>

                {/* Email Address (Desktop) */}
                <td className="py-3.5 px-4 hidden md:table-cell text-slate-300 font-mono text-xs">
                  {contact.email}
                </td>

                {/* Added Date */}
                <td className="py-3.5 px-4 hidden sm:table-cell text-xs text-slate-400">
                  {formatContactDate(contact.createdAt)}
                </td>

                {/* Row Actions */}
                <td className="py-3.5 pl-4 pr-4 sm:pr-6 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onEditContact(contact)}
                      aria-label={`Edit contact ${contact.name}`}
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

                    <button
                      type="button"
                      onClick={() => onDeleteContact(contact)}
                      aria-label={`Delete contact ${contact.name}`}
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

export default ContactsTable;
