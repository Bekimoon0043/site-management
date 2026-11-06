import { useLocation, useNavigate } from 'react-router-dom';

/** Like useSearchParams, but the setter keeps the URL hash (used for tab state). */
export function useQueryParams(): [URLSearchParams, (fn: (p: URLSearchParams) => URLSearchParams, opts?: { replace?: boolean }) => void] {
  const loc = useLocation();
  const nav = useNavigate();
  const params = new URLSearchParams(loc.search);
  const set = (fn: (p: URLSearchParams) => URLSearchParams, opts: { replace?: boolean } = {}) => {
    const next = fn(new URLSearchParams(window.location.search)).toString();
    nav({ pathname: loc.pathname, search: next ? `?${next}` : '', hash: window.location.hash }, { replace: opts.replace ?? true });
  };
  return [params, set];
}

/**
 * Filter state in the URL query string, so drill-down links and shared links reproduce a view.
 * Updates use `replace` so filters don't spam history. Default values are omitted from the URL.
 *
 *   const [f, setF, { active, clear }] = useUrlFilters({ status: '', block: '', q: '' });
 *   setF('status', 'approved');
 */
export function useUrlFilters<T extends Record<string, string>>(defaults: T, prefix = '') {
  const [params, setParams] = useQueryParams();
  const values = Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, params.get(prefix + k) ?? d])) as T;
  const set = (k: keyof T & string, v: string) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (v === '' || v === defaults[k]) next.delete(prefix + k); else next.set(prefix + k, v);
    next.delete(prefix + 'page');
    return next;
  }, { replace: true });
  const setMany = (patch: Partial<T>) => setParams((p) => {
    const next = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === defaults[k]) next.delete(prefix + k); else next.set(prefix + k, String(v));
    }
    next.delete(prefix + 'page');
    return next;
  }, { replace: true });
  const active = Object.keys(defaults).filter((k) => values[k] !== defaults[k]).length;
  const clear = () => setParams((p) => {
    const next = new URLSearchParams(p);
    for (const k of Object.keys(defaults)) next.delete(prefix + k);
    next.delete(prefix + 'page');
    return next;
  }, { replace: true });
  return [values, set, { active, clear, setMany }] as const;
}

/** One query-string value (e.g. `?peek=<id>` for drawers). push=true adds a history entry so Back closes it. */
export function useUrlParam(name: string): [string | null, (v: string | null, push?: boolean) => void] {
  const [params, setParams] = useQueryParams();
  return [params.get(name), (v, push = false) => setParams((p) => {
    const next = new URLSearchParams(p);
    if (v === null || v === '') next.delete(name); else next.set(name, v);
    return next;
  }, { replace: !push })];
}
