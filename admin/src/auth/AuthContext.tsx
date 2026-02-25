import React, { createContext, useContext, useEffect, useState } from 'react';
import { login, logout, loadCredentials, type MatrixCredentials } from '../matrix/client';

interface AuthState {
  creds: MatrixCredentials | null;
  loading: boolean;
  error: string | null;
  login: (homeserver: string, username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  creds: null,
  loading: false,
  error: null,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [creds, setCreds] = useState<MatrixCredentials | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore session from sessionStorage on mount
  useEffect(() => {
    const stored = loadCredentials();
    if (stored) setCreds(stored);
  }, []);

  async function handleLogin(homeserver: string, username: string, password: string) {
    setLoading(true);
    setError(null);
    try {
      const newCreds = await login(homeserver, username, password);
      setCreds(newCreds);
    } catch (err) {
      setError((err instanceof Error && err.message) ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    if (!creds) return;
    await logout(creds);
    setCreds(null);
  }

  return (
    <AuthContext.Provider value={{ creds, loading, error, login: handleLogin, logout: handleLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
