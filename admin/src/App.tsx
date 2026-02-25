/**
 * App.tsx — EO Admin SPA root.
 *
 * Routes:
 *   /admin/                      Content list (ContentManager)
 *   /admin/#wiki/<slug>          Wiki editor
 *   /admin/#blog/<slug>          Blog editor
 *   /admin/#page/<slug>          Page builder
 *   /admin/#exp/<slug>           Experiment editor
 *   /admin/#settings             Homeserver settings
 */

import React, { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { XRayProvider, XRayPanel, XRayToggleButton } from './components/XRayOverlay';
import WriteGuard from './components/WriteGuard';
import ContentManager from './editors/ContentManager';
import WikiEditor from './editors/WikiEditor';
import PageBuilder from './editors/PageBuilder';
import ExperimentEditor from './editors/ExperimentEditor';
import type { ContentType } from './eo/types';
import './styles/admin.css';

// Determine site base from Vite config base path (strips /admin/)
const SITE_BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '') || '';

// ── Login form ────────────────────────────────────────────────────────────────

const HYPHAE_HOMESERVER = 'https://hyphae.social';

function LoginForm() {
  const { login, loading, error } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await login(HYPHAE_HOMESERVER, username, password);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">⊡</div>
        <h1>Login</h1>
        <p className="login-sub">Sign in with your hyphae.social account</p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="@you:hyphae.social or username"
              required
              autoComplete="username"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoComplete="current-password"
            />
          </label>
          <button className="btn btn-primary btn-full" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-note">
          Content is stored append-only in your Matrix rooms.
          Credentials are kept in session storage only (cleared on tab close).
        </p>
      </div>
    </div>
  );
}

// ── App shell ─────────────────────────────────────────────────────────────────

type Route =
  | { type: 'list' }
  | { type: 'wiki'; slug: string }
  | { type: 'blog'; slug: string }
  | { type: 'page'; slug: string }
  | { type: 'exp'; slug: string }
  | { type: 'settings' };

function parseHash(hash: string): Route {
  const h = hash.replace('#', '');
  if (!h) return { type: 'list' };
  if (h === 'settings') return { type: 'settings' };
  const [section, ...rest] = h.split('/');
  const slug = rest.join('/');
  if (section === 'wiki' && slug) return { type: 'wiki', slug };
  if (section === 'blog' && slug) return { type: 'blog', slug };
  if (section === 'page' && slug) return { type: 'page', slug };
  if (section === 'exp' && slug) return { type: 'exp', slug };
  return { type: 'list' };
}

function AdminShell() {
  const { creds, logout } = useAuth();
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [currentHistory, setCurrentHistory] = useState<unknown[]>([]);

  useEffect(() => {
    function onHashChange() { setRoute(parseHash(window.location.hash)); }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  function openContent(contentId: string, type: ContentType) {
    const slug = contentId.split(':')[1] ?? contentId;
    navigate(`${type}/${slug}`);
  }

  if (!creds) return <LoginForm />;

  const routeTitle = route.type === 'list' ? 'Content'
    : route.type === 'settings' ? 'Settings'
    : `${route.type}: ${'slug' in route ? route.slug : ''}`;

  return (
    <div className="admin-app">
      {/* Header */}
      <header className="admin-header">
        <button className="admin-logo" onClick={() => navigate('')}>⊡ EO Admin</button>
        <nav className="admin-nav">
          <button className={`nav-btn ${route.type === 'list' ? 'active' : ''}`} onClick={() => navigate('')}>Content</button>
          <button className={`nav-btn ${route.type === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}>Settings</button>
        </nav>
        <div className="admin-header-right">
          <span className="user-badge">{creds.user_id}</span>
          <XRayToggleButton />
          <a className="btn btn-sm" href={`${SITE_BASE}/`} target="_blank" rel="noopener noreferrer">View site ↗</a>
          <button className="btn btn-sm" onClick={() => logout()}>Sign out</button>
        </div>
      </header>

      {/* Breadcrumb */}
      {route.type !== 'list' && (
        <div className="admin-breadcrumb">
          <button onClick={() => navigate('')}>Content</button>
          <span>/</span>
          <span>{routeTitle}</span>
        </div>
      )}

      {/* Main content */}
      <main className="admin-main">
        {route.type === 'list' && (
          <ContentManager siteBase={SITE_BASE} onOpen={openContent} />
        )}
        {route.type === 'wiki' && (
          <WriteGuard contentId={`wiki:${route.slug}`}>
            <WikiEditor contentId={`wiki:${route.slug}`} siteBase={SITE_BASE} />
          </WriteGuard>
        )}
        {route.type === 'blog' && (
          <WriteGuard contentId={`blog:${route.slug}`}>
            <WikiEditor contentId={`blog:${route.slug}`} siteBase={SITE_BASE} />
          </WriteGuard>
        )}
        {route.type === 'page' && (
          <WriteGuard contentId={`page:${route.slug}`}>
            <PageBuilder contentId={`page:${route.slug}`} siteBase={SITE_BASE} />
          </WriteGuard>
        )}
        {route.type === 'exp' && (
          <WriteGuard contentId={`exp:${route.slug}`}>
            <ExperimentEditor contentId={`exp:${route.slug}`} siteBase={SITE_BASE} />
          </WriteGuard>
        )}
        {route.type === 'settings' && <SettingsPanel />}
      </main>

      {/* X-Ray panel (fixed, bottom-right) */}
      <XRayPanel history={currentHistory as Parameters<typeof XRayPanel>[0]['history']} />
    </div>
  );
}

function SettingsPanel() {
  const { creds } = useAuth();
  return (
    <div className="settings-panel">
      <h2>Settings</h2>
      <div className="settings-info">
        <div className="info-row"><span>Homeserver</span><code>{creds?.homeserver}</code></div>
        <div className="info-row"><span>User ID</span><code>{creds?.user_id}</code></div>
        <div className="info-row"><span>Device ID</span><code>{creds?.device_id}</code></div>
      </div>
      <div className="settings-note">
        <strong>Multiple editors:</strong> Any Matrix user with room write permissions can use this admin.
        Invite editors to the relevant rooms via your Matrix client (e.g., Element).
        All edits are attributed to the editor's Matrix user ID.
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <AuthProvider>
      <XRayProvider>
        <AdminShell />
      </XRayProvider>
    </AuthProvider>
  );
}
