import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicForm, subscribeToPublicForm } from '../../api/signupForms.js';
import { validateSubscribeInput, getSubscribeErrorMessage } from '../../utils/signupFormHelpers.js';

const SLUG_PATTERN = /^[a-f0-9]{24}$/;

/**
 * SubscribePage: public (no sign-in) subscribe form. Shows the same confirmation whatever the
 * server decides, so it cannot be used to discover who is already subscribed.
 */
export const SubscribePage = () => {
  const { slug = '' } = useParams();
  const validSlug = SLUG_PATTERN.test(slug);
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(validSlug ? 'loading' : 'unavailable');
  const [values, setValues] = useState({ email: '', name: '', website: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!validSlug) return undefined;
    let active = true;
    getPublicForm(slug)
      .then((data) => {
        if (!active) return;
        setForm(data);
        setStatus('ready');
      })
      .catch(() => active && setStatus('unavailable'));
    return () => {
      active = false;
    };
  }, [slug, validSlug]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting) return;
    const found = validateSubscribeInput(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setIsSubmitting(true);
    setServerError(null);
    try {
      await subscribeToPublicForm(slug, values);
      setStatus('sent');
    } catch (err) {
      setServerError(getSubscribeErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-xl space-y-5">
          {status === 'loading' && <p className="text-sm text-slate-300" role="status">Loading…</p>}
          {status === 'unavailable' && (
            <p className="text-sm text-rose-300" role="alert">This signup form is not available.</p>
          )}
          {status === 'sent' && (
            <div role="status" className="space-y-2 text-sm">
              <h1 className="text-xl font-bold text-white">Check your inbox</h1>
              <p className="text-emerald-300">
                Almost done! We sent a message asking you to confirm your subscription. Nothing is subscribed until you click the link in it.
              </p>
            </div>
          )}
          {status === 'ready' && form && (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <h1 className="text-xl font-bold text-white">{form.name}</h1>
                {form.description && <p className="mt-1 text-sm text-slate-400">{form.description}</p>}
              </div>
              {serverError && <p className="text-xs text-rose-300" role="alert">{serverError}</p>}
              <div>
                <label htmlFor="subscribe-name" className="block text-sm font-medium text-slate-300">Name (optional)</label>
                <input id="subscribe-name" type="text" autoComplete="name" value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} disabled={isSubmitting} className="mt-1 block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white border border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                {errors.name && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.name}</p>}
              </div>
              <div>
                <label htmlFor="subscribe-email" className="block text-sm font-medium text-slate-300">Email address</label>
                <input id="subscribe-email" type="email" autoComplete="email" value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} disabled={isSubmitting} className="mt-1 block w-full rounded-xl px-3.5 py-2.5 text-sm bg-slate-800/80 text-white border border-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                {errors.email && <p className="mt-1 text-xs text-rose-400" role="alert">{errors.email}</p>}
              </div>
              {/* Honeypot: hidden from people and assistive tech, bots tend to fill it */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
                <label htmlFor="subscribe-website">Website</label>
                <input id="subscribe-website" type="text" tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => setValues((v) => ({ ...v, website: e.target.value }))} />
              </div>
              <button type="submit" disabled={isSubmitting} className="w-full py-3 px-4 rounded-xl font-medium text-sm text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 cursor-pointer">
                {isSubmitting ? 'Subscribing…' : 'Subscribe'}
              </button>
              <p className="text-[11px] text-slate-500 text-center">You will get an email to confirm. You can unsubscribe at any time.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default SubscribePage;
