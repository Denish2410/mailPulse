/**
 * Shared shell for the sign-in, registration and password pages.
 *
 * On wide screens a blue brand panel sits beside the form; on small screens only the form shows,
 * exactly like a plain centered card.
 */
const highlights = [
  'Write campaigns with merge tags and A/B subjects',
  'Check readiness and send safely, scheduled or now',
  'Measure opens, clicks, bounces and unsubscribes',
];

export const AuthLayout = ({ children }) => (
  <div className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] bg-slate-950 text-slate-100 selection:bg-indigo-500 selection:text-white">
    <aside
      className="hidden lg:flex relative overflow-hidden flex-col justify-between p-12 xl:p-16 text-white bg-gradient-to-br from-indigo-600 via-indigo-500 to-violet-500"
      aria-hidden="true"
    >
      {/* Decorative shapes */}
      <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-white/10" />
      <div className="absolute top-1/2 -left-32 w-96 h-96 rounded-full bg-white/10" />
      <div className="absolute -bottom-28 right-12 w-72 h-72 rounded-full bg-sky-300/20" />

      <div className="relative flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <span className="text-xl font-bold tracking-tight">MailPulse</span>
      </div>

      <div className="relative max-w-md">
        <h2 className="text-4xl xl:text-5xl font-extrabold leading-tight tracking-tight">
          Write it. Check it. Send it. Measure it.
        </h2>
        <p className="mt-4 text-white/80 text-base">
          Email campaigns that reach the inbox, with the safeguards built in.
        </p>
        <ul className="mt-8 space-y-3">
          {highlights.map((text) => (
            <li key={text} className="flex items-start gap-3 text-sm text-white/90">
              <span className="mt-0.5 w-5 h-5 shrink-0 rounded-full bg-white/20 flex items-center justify-center">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </span>
              {text}
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-white/60">&copy; MailPulse</p>
    </aside>

    <div className="flex flex-col justify-center py-12 sm:px-6 lg:px-8">{children}</div>
  </div>
);

export default AuthLayout;
