import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../../components/layout/Navbar.jsx';
import { completeGoogleConnection } from '../../api/senderAccounts.js';
import {
  SENDER_ACCOUNTS_PATH,
  CALLBACK_MESSAGES,
  parseOAuthCallback,
  getCallbackErrorMessage,
} from '../../utils/senderAccountHelpers.js';

/**
 * One completion per state value for the lifetime of the page: React StrictMode (and a quick
 * remount) must not post the single-use code twice. Only the outcome is kept, never the code.
 */
const completions = new Map();

const complete = (parsed) => {
  if (!completions.has(parsed.state)) {
    completions.set(
      parsed.state,
      completeGoogleConnection({ state: parsed.state, code: parsed.code }).then(
        ({ senderAccount, created }) => ({ ok: true, email: senderAccount?.email ?? '', created }),
        (err) => ({ ok: false, message: getCallbackErrorMessage(err) })
      )
    );
  }
  return completions.get(parsed.state);
};

/**
 * SenderAccountCallbackPage: where Google sends the browser after the consent screen
 * (GOOGLE_OAUTH_REDIRECT_URI). It sits behind the normal sign-in guard, finishes the connection
 * with the user's own session, removes the code and state from the address bar immediately, and
 * shows a clear result. A refresh or a revisit finds no code and says so; a replayed or expired
 * state is refused by the server.
 */
export const SenderAccountCallbackPage = () => {
  // Read once, on first render: later renders must not depend on the (scrubbed) URL
  const [parsed] = useState(() => parseOAuthCallback(window.location.search));

  const [result, setResult] = useState(
    parsed.kind === 'ready' ? { status: 'working' } : { status: 'error', message: CALLBACK_MESSAGES[parsed.kind] }
  );

  useEffect(() => {
    // The authorization code must not stay in the address bar or the history entry
    if (window.location.search) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    if (parsed.kind !== 'ready') return undefined;
    let active = true;
    complete(parsed).then((outcome) => {
      if (!active) return;
      setResult(
        outcome.ok
          ? { status: 'success', email: outcome.email, created: outcome.created }
          : { status: 'error', message: outcome.message }
      );
    });
    return () => {
      active = false;
    };
  }, [parsed]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl text-center space-y-4">
          <h1 className="text-xl font-bold text-slate-50">Connecting your Gmail account</h1>
          {result.status === 'working' && (
            <p className="text-sm text-slate-300" role="status">Finishing the connection…</p>
          )}
          {result.status === 'success' && (
            <p className="text-sm text-emerald-300" role="status">
              {result.created ? 'Connected' : 'Reconnected'}
              {result.email ? ` ${result.email}` : ''}. You can now choose it as the sender of a campaign.
            </p>
          )}
          {result.status === 'error' && (
            <p className="text-sm text-rose-300" role="alert">{result.message}</p>
          )}
          {result.status !== 'working' && (
            <Link to={SENDER_ACCOUNTS_PATH} className="inline-block text-sm text-indigo-300 hover:text-indigo-200 underline">
              {result.status === 'success' ? 'Go to Gmail accounts' : 'Back to Gmail accounts'}
            </Link>
          )}
        </div>
      </main>
    </div>
  );
};

export default SenderAccountCallbackPage;
