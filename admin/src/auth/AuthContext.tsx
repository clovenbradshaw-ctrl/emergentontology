import React, { createContext, useContext, useEffect, useState } from 'react';
import { verifyPassword, saveSession, loadSession, clearSession } from '../xano/client';

interface AuthState {
  isAuthenticated: boolean;
  loading: boolean;
  error: string | null;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  loading: false,
  error: null,
  login: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore session from localStorage on mount
  useEffect(() => {
    if (loadSession()) setIsAuthenticated(true);
  }, []);

  async function handleLogin(password: string) {
    setLoading(true);
    setError(null);
    try {
      const ok = await verifyPassword(password);
      if (!ok) throw new Error('Incorrect password');
      saveSession();
      setIsAuthenticated(true);
    } catch (err) {
      setError((err instanceof Error && err.message) ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    clearSession();
    setIsAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, loading, error, login: handleLogin, logout: handleLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
