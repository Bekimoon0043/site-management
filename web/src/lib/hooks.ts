import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { check, fetchAll, supabase } from './supabase';
import { invalidateAfterWrite, queryClient } from './query';
import type { Block, Element, Level, Profile, Store, Supplier, Zone } from './contract';

export interface Async<T> {
  data: T | undefined;
  error: string | null;
  /** True while a request is in flight (also during background refresh — check `data` for first load). */
  loading: boolean;
  reload: () => void;
}

export interface AsyncOptions {
  /** Cache key prefix. Give one wherever possible: same key + deps = shared cache across pages. */
  key?: string;
  staleTime?: number;
  enabled?: boolean;
  /** Poll interval (ms) while the tab is visible. */
  refetchInterval?: number;
}

/** djb2 — stable fallback cache key from the loader's source when no `key` is given. */
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Runs an async loader keyed on `deps`, backed by TanStack Query: cached across navigation,
 * deduped, stale-while-revalidate, previous data kept while new deps load. API unchanged
 * from the hand-rolled version so pages migrate for free; pass `opts.key` for a readable key.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: AsyncOptions = {}): Async<T> {
  const key = opts.key ?? `fn:${hash(fn.toString())}`;
  const q = useQuery({
    queryKey: [key, ...deps],
    queryFn: fn,
    staleTime: opts.staleTime,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
    placeholderData: keepPreviousData,
  });
  return {
    data: q.data,
    error: q.error ? (q.error instanceof Error ? q.error.message : String(q.error)) : null,
    loading: q.isFetching || q.isPending,
    reload: () => { void q.refetch(); },
  };
}

/** Invalidate cached queries whose key starts with one of these prefixes. */
export function invalidate(...keys: string[]) {
  for (const k of keys) void queryClient.invalidateQueries({ queryKey: [k] });
}

export interface SpecRow {
  id: string; material_id: string; category: string; material_name: string; grade: string; label: string; uom: string;
  wastage_pct: number; min_level: number; reorder_level: number; lead_time_days: number; is_active: boolean;
}

export interface Lookups {
  blocks: Block[];
  levels: Level[];
  zones: Zone[];
  stores: Store[];
  elements: Element[];
  specs: SpecRow[];
  /** Members of this project (person() also resolves non-members). */
  profiles: Profile[];
  suppliers: Supplier[];
  block: (id: string | null | undefined) => string;
  level: (id: string | null | undefined) => string;
  store: (id: string | null | undefined) => string;
  element: (id: string | null | undefined) => string;
  spec: (id: string | null | undefined) => string;
  specUom: (id: string | null | undefined) => string;
  person: (id: string | null | undefined) => string;
}

/** Drop cached lookups (call after editing master data). */
export function invalidateLookups() {
  invalidateAfterWrite({ lookups: true });
}

async function loadLookups(projectId: string): Promise<Lookups> {
  const [blocks, levels, zones, stores, elements, specs, profiles, suppliers, members] = await Promise.all([
    supabase.from('blocks').select('*').eq('project_id', projectId).is('deleted_at', null).order('code').then(check),
    supabase.from('levels').select('*').eq('project_id', projectId).is('deleted_at', null).order('sort_order').then(check),
    supabase.from('zones').select('*').eq('project_id', projectId).is('deleted_at', null).order('name').then(check),
    supabase.from('stores').select('*').eq('project_id', projectId).is('deleted_at', null).order('name').then(check),
    fetchAll<Element>((a, b) => supabase.from('elements').select('*').eq('project_id', projectId).is('deleted_at', null).order('code').range(a, b)),
    fetchAll<SpecRow>((a, b) => supabase.from('v_specs').select('*').order('label').range(a, b)),
    supabase.from('profiles').select('*').order('full_name').then(check),
    supabase.from('suppliers').select('*').is('deleted_at', null).order('name').then(check),
    supabase.from('project_members').select('user_id').eq('project_id', projectId).then(check) as Promise<{ user_id: string }[]>,
  ]);
  // Pickers and "waiting for" lists show this project's people only; names still resolve for everyone.
  const memberIds = new Set(members.map((m) => m.user_id));
  const projectPeople = (profiles as Profile[]).filter((p) => memberIds.has(p.id));
  const idx = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const b = idx(blocks as Block[]), l = idx(levels as Level[]), s = idx(stores as Store[]);
  const e = idx(elements), sp = idx(specs), pr = idx(profiles as Profile[]);
  const elLabel = new Map<string, string>();
  for (const el of elements) {
    const loc = [b.get(el.block_id ?? '')?.code, l.get(el.level_id ?? '')?.code].filter(Boolean).join('/');
    elLabel.set(el.id, loc ? `${el.code} (${loc})` : el.code);
  }
  return {
    blocks: blocks as Block[], levels: levels as Level[], zones: zones as Zone[], stores: stores as Store[],
    elements, specs, profiles: projectPeople, suppliers: suppliers as Supplier[],
    block: (id) => (id ? b.get(id)?.code ?? '?' : ''),
    level: (id) => (id ? l.get(id)?.code ?? '?' : ''),
    store: (id) => (id ? s.get(id)?.name ?? '?' : ''),
    element: (id) => (id ? elLabel.get(id) ?? (e.has(id) ? e.get(id)!.code : '?') : ''),
    spec: (id) => (id ? sp.get(id)?.label ?? '?' : ''),
    specUom: (id) => (id ? sp.get(id)?.uom ?? '' : ''),
    person: (id) => (id ? pr.get(id)?.full_name || pr.get(id)?.email || '?' : ''),
  };
}

/** Project master data + id→label helpers. Cached 10 min; shared by every page. */
export function useLookups(projectId: string): Async<Lookups> {
  return useAsync(() => loadLookups(projectId), [projectId], { key: 'lookups', staleTime: 10 * 60_000, enabled: !!projectId });
}
