import React, { createContext, useContext, useEffect, useState } from 'react';
import { login, logout, loadCredentials, type MatrixCredentials } from '../matrix/client';

// SHA-256 of "@adaptivespiral194456:hyphae.social"
const APPROVED_USER_HASH = '82ebeb180d165c28fc40ce79a8cbd3b3ccbbcb70ccf47166fc86c58a560edba7';

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
      const userHash = await sha256(newCreds.user_id);
      if (userHash !== APPROVED_USER_HASH) {
        await logout(newCreds).catch(() => {});
        throw new Error('Access denied: unauthorized user');
      }
      setCreds(newCreds);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
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
