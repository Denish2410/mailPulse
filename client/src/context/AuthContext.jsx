import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { registerUser, loginUser, getCurrentUser, getErrorMessage } from '../api/auth.js';
import { getToken, setToken, clearToken } from '../services/tokenStorage.js';

export const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  // Guard against duplicate concurrent initialization calls
  const isInitializingRef = useRef(false);

  /**
   * Restores user session on initial application load.
   * Reads token from sessionStorage and validates it via GET /api/v1/auth/me.
   */
  const restoreSession = useCallback(async () => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;

    const token = getToken();

    if (!token) {
      setUser(null);
      setIsLoading(false);
      isInitializingRef.current = false;
      return;
    }

    try {
      const userProfile = await getCurrentUser();
      setUser(userProfile || null);
      setAuthError(null);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        // Token invalid/expired, account deleted, or account suspended
        clearToken();
        setUser(null);
      } else {
        // Temporary server/network error
        setAuthError(getErrorMessage(err, 'Unable to verify session with the server.'));
        setUser(null);
      }
    } finally {
      setIsLoading(false);
      isInitializingRef.current = false;
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  /**
   * Log in an existing user and establish the authenticated session.
   *
   * @param {{ email: string, password: string }} credentials
   * @returns {Promise<{ success: boolean, user: object }>}
   */
  const login = useCallback(async ({ email, password }) => {
    setAuthError(null);
    try {
      const data = await loginUser({ email, password });
      if (data?.token) {
        setToken(data.token);
      }
      const safeUser = data?.user || null;
      setUser(safeUser);
      return { success: true, user: safeUser };
    } catch (err) {
      const message = getErrorMessage(err, 'Invalid email or password.');
      setAuthError(message);
      throw new Error(message);
    }
  }, []);

  /**
   * Register a new user and establish the authenticated session.
   *
   * @param {{ name: string, email: string, password: string }} credentials
   * @returns {Promise<{ success: boolean, user: object }>}
   */
  const register = useCallback(async ({ name, email, password }) => {
    setAuthError(null);
    try {
      const data = await registerUser({ name, email, password });
      if (data?.token) {
        setToken(data.token);
      }
      const safeUser = data?.user || null;
      setUser(safeUser);
      return { success: true, user: safeUser };
    } catch (err) {
      const message = getErrorMessage(err, 'Registration failed. Please check your input.');
      setAuthError(message);
      throw new Error(message);
    }
  }, []);

  /**
   * Log out the current user: clears local session token and resets state.
   */
  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setAuthError(null);
  }, []);

  const value = {
    user,
    isAuthenticated: Boolean(user),
    isLoading,
    authError,
    login,
    register,
    logout,
    restoreSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default AuthContext;
