/**
 * App.tsx — EO Admin SPA root.
 *
 * Routes:
 *   /admin/                      Content list (ContentManager)
 *   /admin/#wiki/<slug>          Wiki editor
 *   /admin/#blog/<slug>          Blog editor
 *   /admin/#page/<slug>          Page builder
 *   /admin/#exp/<slug>           Experiment editor
 *   /admin/#settings             Settings
 *
 * Auth: password-only (verified client-side via SHA-256 against hardcoded hash).
 * Reads from Xano are public; writes require the password.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { SettingsProvider, useSettings } from './settings/SettingsContext';
import { XRayProvider, XRayPanel, XRayToggleButton } from './components/XRayOverlay';
import ContentManager from './editors/ContentManager';
import WikiEditor from './editors/WikiEditor';
import PageBuilder from './editors/PageBuilder';
import ExperimentEditor from './editors/ExperimentEditor';
import type { ContentType } from './eo/types';
import { upsertCurrentRecord } from './xano/client';
import { fetchCurrentRecordCached } from './xano/stateCache';
import { SPECIAL_PAGES } from './eo/constants';
import './styles/admin.css';

function useTheme() {
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute('data-theme') || 'dark'
  );

  const toggle = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('eo-theme', next);
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label="Toggle light/dark mode"
      title="Toggle light/dark mode"
    >
      <i className={`ph ${theme === 'dark' ? 'ph-sun' : 'ph-moon'}`}></i>
    </button>
  );
}

// Determine site base from Vite config base path (strips /admin/)
const SITE_BASE = import.meta.env.BASE_URL.replace(/\/admin\/?$/, '') || '';

// ── Login form ────────────────────────────────────────────────────────────────

function LoginForm() {
  const { login, loading, error } = useAuth();
  const { settings } = useSettings();
  const [password, setPassword] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await login(password);
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">⊡</div>
        <h1>{settings.siteName || 'EO Admin'}</h1>
        <p className="login-sub">Enter the editor password to continue</p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              autoComplete="current-password"
              autoFocus
            />
          </label>
          <button className="btn btn-primary btn-full" type="submit" disabled={loading}>
            {loading ? 'Checking…' : 'Sign in'}
          </button>
        </form>

        <p className="login-note">
          Content is stored in the Xano EOwiki event log.
          Session persists across browser sessions.
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
  const { isAuthenticated, logout } = useAuth();
  const { settings } = useSettings();
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [currentHistory, setCurrentHistory] = useState<unknown[]>([]);
  const [indexEntries, setIndexEntries] = useState<Array<{ content_id: string; title: string }>>([]);
  const [showSitePreview, setShowSitePreview] = useState(false);

  useEffect(() => {
    function onHashChange() { setRoute(parseHash(window.location.hash)); }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Load index entries for breadcrumb title lookup (Issue 8)
  useEffect(() => {
    async function loadIndex() {
      try {
        const rec = await fetchCurrentRecordCached('site:index');
        if (rec) {
          const parsed = JSON.parse(rec.values) as { entries: Array<{ content_id: string; title: string }> };
          setIndexEntries(parsed.entries ?? []);
        }
      } catch { /* breadcrumb will fall back to slug */ }
    }
    if (isAuthenticated) loadIndex();
  }, [isAuthenticated]);

  function navigate(hash: string) {
    window.location.hash = hash;
  }

  function openContent(contentId: string, type: ContentType) {
    const slug = contentId.split(':')[1] ?? contentId;
    const prefix = type === 'experiment' ? 'exp' : type;
    navigate(`${prefix}/${slug}`);
  }

  if (!isAuthenticated) return <LoginForm />;

  // Compute public site URL for the current route
  function getPreviewUrl(): string {
    if (route.type === 'wiki' || route.type === 'blog' || route.type === 'page' || route.type === 'exp') {
      const slug = 'slug' in route ? route.slug : '';
      return `${SITE_BASE}/${route.type}/${slug}`;
    }
    return `${SITE_BASE}/`;
  }

  const routeTitle = route.type === 'list' ? 'Content'
    : route.type === 'settings' ? 'Settings'
    : (() => {
        const slug = 'slug' in route ? route.slug : '';
        const cid = `${route.type}:${slug}`;
        const fromIndex = indexEntries.find(e => e.content_id === cid)?.title;
        if (fromIndex) return fromIndex;
        const fromSpecial = SPECIAL_PAGES.find(sp => sp.content_id === cid)?.title;
        if (fromSpecial) return fromSpecial;
        return slug;
      })();

  return (
    <div className="admin-app">
      {/* Header */}
      <header className="admin-header">
        <button className="admin-logo" onClick={() => navigate('')}>⊡ {settings.siteName || 'EO Admin'}</button>
        <nav className="admin-nav">
          <button className={`nav-btn ${route.type === 'list' ? 'active' : ''}`} onClick={() => navigate('')}>Content</button>
          <button className={`nav-btn ${route.type === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}>Settings</button>
        </nav>
        <div className="admin-header-right">
          <ThemeToggle />
          <XRayToggleButton />
          <button className="btn btn-sm" onClick={() => setShowSitePreview(true)}>Preview site</button>
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
          <WikiEditor contentId={`wiki:${route.slug}`} siteBase={SITE_BASE} />
        )}
        {route.type === 'blog' && (
          <WikiEditor contentId={`blog:${route.slug}`} siteBase={SITE_BASE} />
        )}
        {route.type === 'page' && (
          <PageBuilder contentId={`page:${route.slug}`} siteBase={SITE_BASE} />
        )}
        {route.type === 'exp' && (
          <ExperimentEditor contentId={`experiment:${route.slug}`} siteBase={SITE_BASE} />
        )}
        {route.type === 'settings' && <SettingsPanel />}
      </main>

      {/* X-Ray panel (fixed, bottom-right) */}
      <XRayPanel history={currentHistory as Parameters<typeof XRayPanel>[0]['history']} />

      {/* Site preview overlay — shows public site as a visitor sees it */}
      {showSitePreview && (
        <div className="site-preview-overlay">
          <div className="site-preview-toolbar">
            <span className="site-preview-label">Site Preview (visitor view)</span>
            <span className="site-preview-url">{getPreviewUrl()}</span>
            <div className="site-preview-actions">
              <a className="btn btn-sm" href={getPreviewUrl()} target="_blank" rel="noopener noreferrer">Open in tab ↗</a>
              <button className="btn btn-sm" onClick={() => setShowSitePreview(false)}>Close</button>
            </div>
          </div>
          <iframe
            className="site-preview-iframe"
            src={getPreviewUrl()}
            title="Site Preview"
          />
        </div>
      )}
    </div>
  );
}

function SettingsPanel() {
  const { settings, updateSettings, resetSettings } = useSettings();
  const [saved, setSaved] = useState(false);
  const [publishingSiteName, setPublishingSiteName] = useState(false);

  function handleChange(field: string, value: string) {
    updateSettings({ [field]: value });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // Publish site name to site:index so the public site picks it up (Issue 6)
  async function publishSiteName() {
    setPublishingSiteName(true);
    try {
      const rec = await fetchCurrentRecordCached('site:index');
      if (rec) {
        const data = JSON.parse(rec.values);
        data.site_settings = { ...data.site_settings, siteName: settings.siteName || 'Emergent Ontology' };
        data.built_at = new Date().toISOString();
        const agent = settings.displayName || 'editor';
        await upsertCurrentRecord('site:index', data, agent, rec);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      }
    } catch (err) {
      console.error('[Settings] Failed to publish site name:', err);
    } finally {
      setPublishingSiteName(false);
    }
  }

  return (
    <div className="settings-panel">
      <h2>Settings</h2>

      {saved && <div className="settings-saved">Settings saved</div>}

      {/* ── Identity ─────────────────────────────────── */}
      <section className="settings-section">
        <h3>Identity</h3>
        <label className="field">
          <span>Display name</span>
          <input
            value={settings.displayName}
            onChange={(e) => handleChange('displayName', e.target.value)}
            placeholder="editor"
          />
          <span className="field-hint">
            Shown as the agent on all events (visible in X-Ray and history).
          </span>
        </label>
        <label className="field">
          <span>Site name</span>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <input
              value={settings.siteName}
              onChange={(e) => handleChange('siteName', e.target.value)}
              placeholder="Emergent Ontology"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-sm btn-primary"
              onClick={publishSiteName}
              disabled={publishingSiteName}
              title="Publish site name to the public site"
            >
              {publishingSiteName ? 'Publishing\u2026' : 'Publish to site'}
            </button>
          </div>
          <span className="field-hint">
            Displayed in the admin header and public site. Click "Publish to site" to update the public site header/footer.
          </span>
        </label>
      </section>

      {/* ── Defaults ─────────────────────────────────── */}
      <section className="settings-section">
        <h3>Content defaults</h3>
        <label className="field">
          <span>Default visibility</span>
          <select
            value={settings.defaultVisibility}
            onChange={(e) => handleChange('defaultVisibility', e.target.value)}
          >
            <option value="public">Public</option>
            <option value="private">Private</option>
          </select>
          <span className="field-hint">
            Visibility applied to newly created content.
          </span>
        </label>
        <label className="field">
          <span>Default status</span>
          <select
            value={settings.defaultStatus}
            onChange={(e) => handleChange('defaultStatus', e.target.value)}
          >
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
          <span className="field-hint">
            Status applied to newly created content.
          </span>
        </label>
      </section>

      {/* ── Backend info (read-only) ─────────────────── */}
      <section className="settings-section">
        <h3>Backend</h3>
        <div className="settings-info">
          <div className="info-row"><span>Backend</span><code>Xano EOwiki</code></div>
          <div className="info-row"><span>Event log</span><code>/api:GGzWIVAW/eowiki</code></div>
          <div className="info-row"><span>Current state</span><code>/api:GGzWIVAW/eowikicurrent</code></div>
        </div>
        <div className="settings-note">
          <strong>Auth:</strong> Write operations require the editor password (hashed SHA-256 client-side).
          Reads are public. Sessions persist across browser sessions via localStorage.
        </div>
      </section>

      {/* ── Reset ────────────────────────────────────── */}
      <div className="settings-reset">
        <button className="btn btn-sm" onClick={resetSettings}>Reset to defaults</button>
      </div>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <SettingsProvider>
      <AuthProvider>
        <XRayProvider>
          <AdminShell />
        </XRayProvider>
      </AuthProvider>
    </SettingsProvider>
  );
}
