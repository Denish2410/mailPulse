import { Navigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth.js';

/**
 * Route guard component for public-only auth routes (e.g. /login and /register).
 *
 * - While the session is being restored: Displays a clean loading state.
 * - If already authenticated: Redirects to intended destination or /dashboard.
 * - If unauthenticated: Renders the public route outlet.
 */
export const PublicOnlyRoute = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div
        className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100"
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-col items-center gap-4 bg-slate-900/60 border border-slate-800 rounded-2xl p-8 backdrop-blur-sm shadow-xl">
          <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-400 font-medium tracking-wide">
            Loading MailPulse...
          </p>
        </div>
      </div>
    );
  }

  if (isAuthenticated) {
    const destination = location.state?.from?.pathname || '/dashboard';
    return <Navigate to={destination} replace />;
  }

  return <Outlet />;
};

export default PublicOnlyRoute;
