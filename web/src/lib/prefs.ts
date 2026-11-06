import { useSyncExternalStore } from 'react';

/** Per-browser UI preferences in localStorage (never business data). Every access is try/catch'd. */
export type Theme = 'system' | 'light' | 'dark';
export type Density = 'compact' | 'default' | 'comfortable';

interface Prefs { theme: Theme; density: Density; sidebarCollapsed: boolean }

const KEYS = { theme: 'sc.theme', density: 'sc.density', sidebarCollapsed: 'sc.sidebar' } as const;

function read<T extends string>(k: string, fallback: T): T {
  try { return (localStorage.getItem(k) as T | null) ?? fallback; } catch { return fallback; }
}
function write(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

let state: Prefs = {
  theme: read<Theme>(KEYS.theme, 'system'),
  density: read<Density>(KEYS.density, 'default'),
  sidebarCollapsed: read<string>(KEYS.sidebarCollapsed, '') === 'collapsed',
};
const listeners = new Set<() => void>();

/** Reflects theme/density onto <html> so CSS tokens switch. Call once before first render. */
export function applyPrefs() {
  const el = document.documentElement;
  if (state.theme === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', state.theme);
  if (state.density === 'default') el.removeAttribute('data-density'); else el.setAttribute('data-density', state.density);
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  state = { ...state, [key]: value };
  write(KEYS[key], key === 'sidebarCollapsed' ? (value ? 'collapsed' : 'expanded') : String(value));
  applyPrefs();
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
}

/** Last-visited records for the command palette's "Recent" group. */
export interface RecentItem { label: string; hint: string; to: string }
export function pushRecent(item: RecentItem) {
  try {
    const cur = JSON.parse(localStorage.getItem('sc.recent') ?? '[]') as RecentItem[];
    localStorage.setItem('sc.recent', JSON.stringify([item, ...cur.filter((x) => x.to !== item.to)].slice(0, 8)));
  } catch { /* ignore */ }
}
export function getRecent(): RecentItem[] {
  try { return JSON.parse(localStorage.getItem('sc.recent') ?? '[]') as RecentItem[]; } catch { return []; }
}
