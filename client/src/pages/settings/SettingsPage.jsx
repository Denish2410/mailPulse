import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Navbar from '../../components/layout/Navbar.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { updateProfile, exportAccountData, deleteAccount, getErrorMessage } from '../../api/auth.js';
import {
  MAX_MAILING_ADDRESS_LENGTH,
  validateProfileForm,
  getDeleteAccountErrorMessage,
  getExportFileName,
} from '../../utils/accountHelpers.js';

const inputClass =
  'w-full px-3.5 py-2.5 bg-slate-900/80 border border-slate-800 rounded-xl text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60';
const cardClass = 'p-5 sm:p-6 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col gap-4';

/**
 * SettingsPage: profile (name and the postal address printed in every email footer), data
 * export, and permanent account deletion.
 */
export const SettingsPage = () => {
  const { user, updateUserProfile, logout } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name || '');
  const [mailingAddress, setMailingAddress] = useState(user?.mailingAddress || '');
  const [errors, setErrors] = useState({});
  const [profileState, setProfileState] = useState({ status: 'idle', message: '' });

  const [exportState, setExportState] = useState({ status: 'idle', message: '' });

  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [deleteState, setDeleteState] = useState({ status: 'idle', message: '' });

  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (profileState.status === 'saving') return;
    const validation = validateProfileForm({ name, mailingAddress });
    setErrors(validation.errors);
    if (!validation.isValid) return;

    setProfileState({ status: 'saving', message: '' });
    try {
      const updated = await updateProfile({ name, mailingAddress });
      updateUserProfile(updated);
      setProfileState({ status: 'saved', message: 'Saved.' });
    } catch (err) {
      setProfileState({ status: 'error', message: getErrorMessage(err, 'Could not save your settings.') });
    }
  };

  const handleExport = async () => {
    if (exportState.status === 'working') return;
    setExportState({ status: 'working', message: '' });
    try {
      const text = await exportAccountData();
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = getExportFileName();
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setExportState({ status: 'done', message: 'Your data was downloaded.' });
    } catch (err) {
      setExportState({ status: 'error', message: getErrorMessage(err, 'Could not export your data.') });
    }
  };

  const handleDelete = async (e) => {
    e.preventDefault();
    if (deleteState.status === 'working' || !password) return;
    setDeleteState({ status: 'working', message: '' });
    try {
      await deleteAccount({ password });
      logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setDeleteState({ status: 'error', message: getDeleteAccountErrorMessage(err) });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 flex flex-col gap-6">
        <header>
          <h1 className="text-2xl font-bold text-white">Account settings</h1>
          <p className="text-sm text-slate-400 mt-1">{user?.email}</p>
        </header>

        <form onSubmit={handleSaveProfile} className={cardClass} noValidate>
          <h2 className="text-base font-semibold text-white">Profile</h2>
          <div>
            <label htmlFor="settings-name" className="block text-xs font-semibold text-slate-300 mb-1.5">Name</label>
            <input id="settings-name" className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            {errors.name && <p role="alert" className="mt-1 text-xs text-rose-400">{errors.name}</p>}
          </div>
          <div>
            <label htmlFor="settings-address" className="block text-xs font-semibold text-slate-300 mb-1.5">
              Mailing address
            </label>
            <textarea
              id="settings-address"
              rows={3}
              maxLength={MAX_MAILING_ADDRESS_LENGTH}
              className={inputClass}
              value={mailingAddress}
              onChange={(e) => setMailingAddress(e.target.value)}
              placeholder={'Company name\n123 Main Street, City, Country'}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Printed at the bottom of every campaign email. Anti-spam laws (such as CAN-SPAM) require a valid postal
              address, and in production you cannot send or schedule without one.
            </p>
            {errors.mailingAddress && <p role="alert" className="mt-1 text-xs text-rose-400">{errors.mailingAddress}</p>}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={profileState.status === 'saving'}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {profileState.status === 'saving' ? 'Saving…' : 'Save changes'}
            </button>
            {profileState.status === 'saved' && <span role="status" className="text-xs text-emerald-300">{profileState.message}</span>}
            {profileState.status === 'error' && <span role="alert" className="text-xs text-rose-300">{profileState.message}</span>}
          </div>
        </form>

        <section className={cardClass}>
          <h2 className="text-base font-semibold text-white">Your data</h2>
          <p className="text-sm text-slate-400">
            Download everything MailPulse stores for your account (contacts, campaigns, templates, segments,
            suppressions, forms and delivery records) as a JSON file.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleExport}
              disabled={exportState.status === 'working'}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-100 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {exportState.status === 'working' ? 'Preparing…' : 'Download my data'}
            </button>
            {exportState.status === 'done' && <span role="status" className="text-xs text-emerald-300">{exportState.message}</span>}
            {exportState.status === 'error' && <span role="alert" className="text-xs text-rose-300">{exportState.message}</span>}
          </div>
        </section>

        <section className={`${cardClass} border-rose-500/30`}>
          <h2 className="text-base font-semibold text-rose-200">Delete account</h2>
          <p className="text-sm text-slate-400">
            Permanently deletes your account and all of its data. This cannot be undone. Campaigns that are sending
            or scheduled must finish or be cancelled first.
          </p>
          {!confirming ? (
            <div>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-rose-100 bg-rose-600/80 hover:bg-rose-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-rose-400"
              >
                Delete my account…
              </button>
            </div>
          ) : (
            <form onSubmit={handleDelete} className="flex flex-col gap-3">
              <div>
                <label htmlFor="settings-delete-password" className="block text-xs font-semibold text-slate-300 mb-1.5">
                  Enter your password to confirm
                </label>
                <input
                  id="settings-delete-password"
                  type="password"
                  autoComplete="current-password"
                  className={inputClass}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={!password || deleteState.status === 'working'}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-rose-400"
                >
                  {deleteState.status === 'working' ? 'Deleting…' : 'Permanently delete'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(false);
                    setPassword('');
                    setDeleteState({ status: 'idle', message: '' });
                  }}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              {deleteState.status === 'error' && <p role="alert" className="text-xs text-rose-300">{deleteState.message}</p>}
            </form>
          )}
        </section>
      </main>
    </div>
  );
};

export default SettingsPage;
