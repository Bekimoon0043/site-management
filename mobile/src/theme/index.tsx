// Theme provider, mode setting (System / Light / Dark / Sunlight) and makeStyles.
import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { kvGet, kvSet } from '../lib/db';
import { dark, light, sunlight, type Theme, type ThemeMode } from './tokens';

export * from './tokens';
export * from './status';

// ---------------------------------------------------------------------------
// UI preferences (persisted in kv; readable outside React)
// ---------------------------------------------------------------------------

interface Prefs { mode: ThemeMode; haptics: boolean }
let prefs: Prefs = { mode: 'system', haptics: true };
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribePrefs = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getPrefs = () => prefs;

/** Reads persisted prefs once the local DB is open. Safe to call repeatedly. */
export function loadUiPrefs() {
  if (loaded) return;
  try {
    const m = kvGet('ui:theme') as ThemeMode | null;
    const h = kvGet('ui:haptics');
    prefs = { mode: m && ['system', 'light', 'dark', 'sunlight'].includes(m) ? m : 'system', haptics: h !== '0' };
    loaded = true;
    emit();
  } catch {
    // DB not open yet.
  }
}

export function setThemeMode(mode: ThemeMode) {
  prefs = { ...prefs, mode };
  try { kvSet('ui:theme', mode); } catch { /* not open */ }
  emit();
}
export function setHapticsEnabled(on: boolean) {
  prefs = { ...prefs, haptics: on };
  try { kvSet('ui:haptics', on ? '1' : '0'); } catch { /* not open */ }
  emit();
}
export const hapticsEnabled = () => prefs.haptics;

export function useUiPrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, getPrefs);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const ThemeCtx = createContext<Theme>(light);

export function resolveTheme(mode: ThemeMode, scheme: string | null | undefined): Theme {
  if (mode === 'sunlight') return sunlight;
  if (mode === 'dark') return dark;
  if (mode === 'light') return light;
  return scheme === 'dark' ? dark : light;
}

export function ThemeProvider({ children, ready = true }: { children: React.ReactNode; ready?: boolean }) {
  if (ready && !loaded) loadUiPrefs();
  const { mode } = useUiPrefs();
  const scheme = useColorScheme();
  const t = resolveTheme(mode, scheme);
  return <ThemeCtx.Provider value={t}>{children}</ThemeCtx.Provider>;
}

/** Current theme. Stable reference per mode. */
export const useTheme = (): Theme => useContext(ThemeCtx);

/**
 * Build a cached StyleSheet per theme:
 *   const useStyles = makeStyles((t) => ({ row: { backgroundColor: t.surface } }));
 *   const s = useStyles();
 */
type Styles = Parameters<typeof StyleSheet.create>[0];
export function makeStyles<S extends Styles>(fn: (t: Theme) => S & Styles): () => Readonly<S> {
  const cache = new WeakMap<Theme, Readonly<S>>();
  return function useStyles() {
    const t = useTheme();
    let s = cache.get(t);
    if (!s) {
      s = StyleSheet.create(fn(t)) as Readonly<S>;
      cache.set(t, s);
    }
    return s;
  };
}
