import { useEffect, useId, useState, type ReactNode } from 'react';
import { CircleAlert, Search, X } from 'lucide-react';

/**
 * Labelled form control. Label above (12/500), hint/error below, "*" when required.
 * Wraps its child in a <label>, so clicking the label focuses the control.
 */
export function Field({ label, children, hint, error, wide, required, check }: {
  label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string | null; wide?: boolean; required?: boolean;
  /** Checkbox layout: control left, label right. */
  check?: boolean;
}) {
  return (
    <label className={`field${wide ? ' wide' : ''}${check ? ' check' : ''}`}>
      <span>{label}{required && <span className="req" aria-hidden>*</span>}</span>
      {children}
      {error ? <small className="err"><CircleAlert size={12} aria-hidden />{error}</small> : hint && <small className="hint">{hint}</small>}
    </label>
  );
}

/** Plain <select> with an "All" (placeholder) option. */
export function Select<V extends string>({ value, onChange, options, placeholder, disabled, 'aria-label': ariaLabel }: {
  value: V | ''; onChange: (v: V | '') => void; options: { value: V; label: string }[]; placeholder?: string; disabled?: boolean; 'aria-label'?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as V | '')} disabled={disabled} aria-label={ariaLabel}>
      <option value="">{placeholder ?? 'All'}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Number input with unit suffix inside the field. */
export function QtyInput({ value, onChange, unit, min, max, width = 120, ...rest }: {
  value: string; onChange: (v: string) => void; unit?: string; min?: number; max?: number; width?: number; 'aria-label'?: string; disabled?: boolean;
}) {
  return (
    <span className="input-unit" style={{ width }}>
      <input type="number" inputMode="decimal" step="any" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} style={{ width: '100%' }} {...rest} />
      {unit && <span className="suffix">{unit}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Filter bar: search box (focus with "/") + chip-style filters + "Clear filters" when any active.
// ---------------------------------------------------------------------------

export function FilterBar({ children, active = 0, onClear, right }: { children: ReactNode; active?: number; onClear?: () => void; right?: ReactNode }) {
  return (
    <div className="filter-bar no-print" role="search">
      {children}
      {active > 0 && onClear && <button className="link-btn clear-filters" onClick={onClear}>Clear filters</button>}
      {right && <><span className="spacer" />{right}</>}
    </div>
  );
}

/** Chip-style select: shows "Label: value", highlighted when set, × clears. */
export function FilterSelect<V extends string>({ label, value, onChange, options, allLabel = 'All' }: {
  label: string; value: V | ''; onChange: (v: V | '') => void; options: { value: V; label: string }[]; allLabel?: string;
}) {
  const id = useId();
  return (
    <span className={`filter-chip${value ? ' active' : ''}`}>
      <label className="chip-label" htmlFor={id}>{label}{value ? ':' : ''}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as V | '')}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {value && <button className="chip-clear" aria-label={`Clear ${label}`} onClick={() => onChange('')}><X size={12} /></button>}
    </span>
  );
}

/** Chip-style date filter. */
export function FilterDate({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <span className={`filter-chip${value ? ' active' : ''}`}>
      <label className="chip-label" htmlFor={id}>{label}</label>
      <input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} />
      {value && <button className="chip-clear" aria-label={`Clear ${label}`} onClick={() => onChange('')}><X size={12} /></button>}
    </span>
  );
}

/** Chip-style on/off filter. */
export function FilterToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`filter-chip toggle${checked ? ' active' : ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}
    </label>
  );
}

/** Chip-style free-text filter (e.g. supplier name). Debounced. */
export function FilterText({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useDebounced(value, onChange);
  return (
    <span className={`filter-chip${value ? ' active' : ''}`}>
      <span className="chip-label">{label}</span>
      <input value={v} placeholder={placeholder ?? 'any'} onChange={(e) => setV(e.target.value)} style={{ width: 120 }} aria-label={label} />
      {value && <button className="chip-clear" aria-label={`Clear ${label}`} onClick={() => { setV(''); onChange(''); }}><X size={12} /></button>}
    </span>
  );
}

/** Local input state that reports to `onCommit` after `ms` of no typing; resyncs when `value` changes elsewhere. */
export function useDebounced(value: string, onCommit: (v: string) => void, ms = 250): [string, (v: string) => void] {
  const [local, setLocal] = useState(value);
  const [last, setLast] = useState(value);
  if (value !== last) { setLast(value); setLocal(value); }
  useEffect(() => {
    if (local === value) return;
    const t = setTimeout(() => onCommit(local), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);
  return [local, setLocal];
}

/** Page search box. "/" focuses it from anywhere on the page (global shortcut). Debounced 250 ms. */
export function SearchInput({ value, onChange, placeholder = 'Search…', width }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  const [v, setV] = useDebounced(value, onChange);
  return (
    <span className="search-box">
      <Search size={14} aria-hidden />
      <input type="search" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} data-page-search aria-label={placeholder}
        style={width ? { width } : undefined} onKeyDown={(e) => { if (e.key === 'Escape') { setV(''); onChange(''); (e.target as HTMLInputElement).blur(); } }} />
      {!v && <span className="kbd" aria-hidden>/</span>}
    </span>
  );
}

/** busy/error state around an async action: `const { busy, error, run } = useBusy(); run(async () => …)`. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}
