import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export interface TabDef<K extends string> { key: K; label: ReactNode; count?: number; hot?: boolean }

/**
 * ARIA tabs (←/→/Home/End move focus+selection). Underline style by default;
 * `variant="segmented"` for compact secondary rows, `variant="vertical"` for settings sub-nav.
 */
export function Tabs<K extends string>({ tabs, value, onChange, variant = 'underline', label }: {
  tabs: TabDef<K>[]; value: K; onChange: (k: K) => void; variant?: 'underline' | 'segmented' | 'vertical'; label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.key === value);
    const prev = variant === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
    const next = variant === 'vertical' ? 'ArrowDown' : 'ArrowRight';
    let j = -1;
    if (e.key === next) j = (i + 1) % tabs.length;
    else if (e.key === prev) j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(tabs[j].key);
    ref.current?.querySelectorAll<HTMLButtonElement>('[role=tab]')[j]?.focus();
  };
  const cls = variant === 'segmented' ? 'segmented' : variant === 'vertical' ? 'tabs vertical' : 'tabs';
  return (
    <div ref={ref} className={`${cls} no-print`} role="tablist" aria-label={label} aria-orientation={variant === 'vertical' ? 'vertical' : 'horizontal'} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={t.key === value} tabIndex={t.key === value ? 0 : -1}
          className={variant === 'segmented' ? (t.key === value ? 'active' : '') : t.key === value ? 'tab active' : 'tab'} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className={`tab-count${t.hot && t.count ? ' hot' : ''}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Two-level tabs for pages with many sections (> ~7): groups as underline tabs, items as a segmented row.
 * Keys stay flat so existing `#hash` deep links keep working.
 */
export function TabGroups<K extends string>({ groups, value, onChange }: {
  groups: { label: string; tabs: TabDef<K>[] }[]; value: K; onChange: (k: K) => void;
}) {
  const gi = Math.max(0, groups.findIndex((g) => g.tabs.some((t) => t.key === value)));
  const g = groups[gi];
  return (
    <div className="tab-groups">
      <Tabs label="Section" value={String(gi) as string} onChange={(i) => onChange(groups[Number(i)].tabs[0].key)}
        tabs={groups.map((x, i) => ({ key: String(i), label: x.label, count: x.tabs.reduce((s, t) => s + (t.hot ? t.count ?? 0 : 0), 0) || undefined, hot: true }))} />
      {g.tabs.length > 1 && <Tabs variant="segmented" label={g.label} value={value} onChange={onChange} tabs={g.tabs} />}
    </div>
  );
}

/** Tab state kept in the URL hash so drill-down links (e.g. /store#low) can target a tab. */
export function useHashTab<K extends string>(keys: readonly K[], fallback: K): [K, (k: K) => void] {
  const loc = useLocation();
  const nav = useNavigate();
  const h = decodeURIComponent(loc.hash.replace(/^#/, '')) as K;
  const tab = keys.includes(h) ? h : fallback;
  return [tab, (k: K) => nav({ pathname: loc.pathname, search: loc.search, hash: k }, { replace: true })];
}
