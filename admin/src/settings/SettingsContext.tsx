/**
 * SettingsContext.tsx — App-wide settings persisted to localStorage.
 *
 * Settings are stored as a JSON blob under the key "eo_admin_settings".
 * Components consume settings via the useSettings() hook.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'eo_admin_settings';

export interface AppSettings {
  /** Display name shown as the "agent" on EO events (X-Ray, history). */
  displayName: string;
  /** Site/instance name shown in the header and login screen. */
  siteName: string;
  /** Default content visibility when creating new content. */
  defaultVisibility: 'public' | 'private';
  /** Default content status when creating new content. */
  defaultStatus: 'draft' | 'published';
}

const DEFAULT_SETTINGS: AppSettings = {
  displayName: 'editor',
  siteName: 'EO Admin',
  defaultVisibility: 'public',
  defaultStatus: 'draft',
};

interface SettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  updateSettings: () => {},
  resetSettings: () => {},
});

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persistSettings(next);
      return next;
    });
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_SETTINGS);
    setSettings(DEFAULT_SETTINGS);
  }, []);

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, resetSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
