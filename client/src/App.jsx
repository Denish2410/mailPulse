import ConnectivityCheck from './components/common/ConnectivityCheck.jsx'

function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6 selection:bg-indigo-500 selection:text-white">
      <div className="max-w-2xl w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-8 shadow-2xl backdrop-blur-sm text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold tracking-wide uppercase mb-6 border border-indigo-500/20">
          Phase 1 — Foundation
        </div>

        <h1 className="text-4xl font-extrabold tracking-tight text-white mb-3">
          MailPulse
        </h1>
        <p className="text-slate-400 text-base mb-8 max-w-lg mx-auto">
          Full-Stack Email Campaign Management &amp; Analytics Platform. Foundation architecture and initial project structure established.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left mb-8">
          <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-750">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">Frontend Stack</h2>
            <ul className="text-xs text-slate-400 space-y-1">
              <li>• React 19 + Vite</li>
              <li>• Tailwind CSS</li>
              <li>• React Router</li>
              <li>• Axios &amp; Recharts</li>
            </ul>
          </div>
          <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-750">
            <h2 className="text-sm font-semibold text-slate-200 mb-2">Backend Stack</h2>
            <ul className="text-xs text-slate-400 space-y-1">
              <li>• Node.js (ES Modules) + Express</li>
              <li>• MongoDB + Mongoose</li>
              <li>• Zod &amp; Rate Limiting</li>
              <li>• Helmet &amp; Morgan</li>
            </ul>
          </div>
        </div>

        <ConnectivityCheck />
      </div>
    </div>
  )
}

export default App

