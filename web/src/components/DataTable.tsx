import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3, Download, Printer, Rows3, X } from 'lucide-react';
import { exportExcel } from '../lib/format';
import { setPref, usePrefs, type Density } from '../lib/prefs';
import { useQueryParams } from '../lib/url';
import { Popover, Menu } from './Popover';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  /** Plain value for sorting and Excel export. Defaults to row[key]. */
  value?: (row: T) => unknown;
  align?: 'right' | 'center';
  noExport?: boolean;
  /** Default true. */
  sortable?: boolean;
  /** Identifier column: primary link style + slashed zero. */
  id?: boolean;
  /** Hidden by default (user can show it via the column chooser when `viewKey` is set). */
  hidden?: boolean;
  width?: number;
  className?: string;
}

export interface EmptyState { title: ReactNode; body?: ReactNode; action?: ReactNode }

export interface ServerPaging { page: number; pageSize: number; total: number | null; onPage: (page: number) => void }

type Sort = { key: string; dir: 1 | -1 } | null;

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  /** Stable row key. Defaults to row.id, then index. */
  rowKey?: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  rowClass?: (row: T) => string | undefined;
  /** Highlighted row (e.g. the record open in a drawer). */
  activeKey?: string | null;
  /** Shows Export ▾ (Excel / Print) in the toolbar. */
  exportName?: string;
  /** Fetch every matching row for "Excel (all rows)" — for server-paged tables. */
  onExportAll?: () => Promise<T[]>;
  /** Left side of the toolbar (title, filters, primary action). */
  toolbar?: ReactNode;
  /** Message/structure when there's no data at all (not filtered). */
  empty?: ReactNode | EmptyState;
  /** True when filters are applied — empty then shows "No results · Clear filters" instead of `empty`. */
  filtered?: boolean;
  onClearFilters?: () => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Checkbox column + floating bulk bar. */
  selectable?: boolean;
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  /** Client paging size (ignored when virtualized). */
  pageSize?: number;
  /** 'auto' (default) virtualizes client lists over 200 rows; true/false to force. */
  virtual?: boolean | 'auto';
  /** Sticky first (identifier) column for wide tables. */
  stickyFirst?: boolean;
  /** Server-side paging: rows are the current page only. */
  server?: ServerPaging;
  /** Persist sort/page in the URL with this param prefix ('' for a page's main table). */
  urlKey?: string;
  /** Persist column visibility in localStorage under this key. */
  viewKey?: string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
  /** Rendered as a sticky totals row in <tfoot>. */
  footer?: ReactNode;
  /** CSS max-height of the scroll box; 'none' to grow with the page. */
  maxHeight?: string;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';

function useSortPage(urlKey: string | undefined, defaultSort: DataTableProps<unknown>['defaultSort']) {
  const [params, setParams] = useQueryParams();
  const [localSort, setLocalSort] = useState<Sort>(defaultSort ? { key: defaultSort.key, dir: defaultSort.dir === 'asc' ? 1 : -1 } : null);
  const [localPage, setLocalPage] = useState(0);
  if (urlKey === undefined) return { sort: localSort, setSort: setLocalSort, page: localPage, setPage: setLocalPage };
  const raw = params.get(`${urlKey}sort`);
  const sort: Sort = raw ? { key: raw.replace(/\.(asc|desc)$/, ''), dir: raw.endsWith('.desc') ? -1 : 1 } : localSort;
  const page = Math.max(0, Number(params.get(`${urlKey}page`) ?? 1) - 1);
  return {
    sort,
    setSort: (s: Sort) => setParams((p) => { if (s) p.set(`${urlKey}sort`, `${s.key}.${s.dir === 1 ? 'asc' : 'desc'}`); else p.delete(`${urlKey}sort`); p.delete(`${urlKey}page`); return p; }),
    page,
    setPage: (n: number) => setParams((p) => { if (n > 0) p.set(`${urlKey}page`, String(n + 1)); else p.delete(`${urlKey}page`); return p; }),
  };
}

function readHidden(viewKey: string | undefined, columns: Column<unknown>[]): Set<string> {
  if (viewKey) {
    try { const v = localStorage.getItem(`sc.cols.${viewKey}`); if (v) return new Set(JSON.parse(v) as string[]); } catch { /* ignore */ }
  }
  return new Set(columns.filter((c) => c.hidden).map((c) => c.key));
}

/**
 * Data table v2. Sortable keyboard headers (aria-sort), sticky header inside its scroll box,
 * optional sticky first column, selection + bulk bar, roving-focus rows (↑/↓ or J/K, Enter, Space/X),
 * skeleton / empty / no-results / error states, paging or virtualization (>200 rows), Excel + print.
 * See components/README.md for usage.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    rows, columns: allColumns, rowKey, onRowClick, rowClass, activeKey, exportName, onExportAll, toolbar, empty = 'No records',
    filtered, onClearFilters, loading, error, onRetry, selectable, bulkActions, pageSize = 50, virtual = 'auto',
    stickyFirst, server, urlKey, viewKey, defaultSort, footer, maxHeight,
  } = props;
  const keyOf = (r: T, i: number) => (rowKey ? rowKey(r, i) : String((r as { id?: string }).id ?? i));
  const val = (c: Column<T>, r: T) => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);

  const [hidden, setHidden] = useState(() => readHidden(viewKey, allColumns as Column<unknown>[]));
  const columns = allColumns.filter((c) => !hidden.has(c.key));
  const { sort, setSort, page, setPage } = useSortPage(urlKey, defaultSort);
  const [printAll, setPrintAll] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const { density } = usePrefs();

  // Sort once per (rows, sort): precompute the sort value per row (no lookups per comparison).
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = allColumns.find((x) => x.key === sort.key);
    if (!c) return rows;
    const withVal = rows.map((r) => [r, c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]] as const);
    withVal.sort(([, va], [, vb]) => {
      if (va === vb) return 0;
      if (isBlank(va)) return 1;
      if (isBlank(vb)) return -1;
      const na = Number(va), nb = Number(vb);
      const cmp = Number.isFinite(na) && Number.isFinite(nb) && typeof va !== 'boolean' ? na - nb : String(va).localeCompare(String(vb), undefined, { numeric: true });
      return cmp * sort.dir;
    });
    return withVal.map(([r]) => r);
  }, [rows, sort, allColumns]);

  const isVirtual = !server && !printAll && (virtual === true || (virtual === 'auto' && sorted.length > 200));
  const pages = server ? Math.max(1, Math.ceil((server.total ?? 0) / server.pageSize)) : Math.max(1, Math.ceil(sorted.length / pageSize));
  const curPage = server ? server.page : Math.min(page, pages - 1);
  const visible = server || printAll || isVirtual ? sorted : sorted.slice(curPage * pageSize, (curPage + 1) * pageSize);

  useEffect(() => {
    const before = () => setPrintAll(true);
    const after = () => setPrintAll(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, []);

  const rowH = density === 'compact' ? 31 : density === 'comfortable' ? 45 : 37;
  const virt = useVirtualizer({
    count: isVirtual ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 10,
    enabled: isVirtual,
  });
  const vItems = isVirtual ? virt.getVirtualItems() : [];
  const renderIdx: number[] = isVirtual ? vItems.map((v) => v.index) : visible.map((_, i) => i);
  const padTop = isVirtual && vItems.length ? vItems[0].start : 0;
  const padBottom = isVirtual && vItems.length ? virt.getTotalSize() - vItems[vItems.length - 1].end : 0;

  // Selection
  const selectedRows = selectable ? sorted.filter((r, i) => selected.has(keyOf(r, i))) : [];
  const pageKeys = visible.map((r) => keyOf(r, sorted.indexOf(r)));
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const somePageSelected = pageKeys.some((k) => selected.has(k));
  const toggle = (k: string) => setSelected((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const clearSel = () => setSelected(new Set());

  // Keyboard: roving focus across rows
  const interactive = !!onRowClick || !!selectable;
  const focusRow = (i: number) => {
    const j = Math.max(0, Math.min(visible.length - 1, i));
    setActive(j);
    if (isVirtual) virt.scrollToIndex(j);
    requestAnimationFrame(() => tbodyRef.current?.querySelector<HTMLElement>(`tr[data-idx="${j}"]`)?.focus());
  };
  const onRowKey = (e: KeyboardEvent, i: number, r: T) => {
    if ((e.target as HTMLElement).closest('input, button, select, textarea, a') && e.target !== e.currentTarget) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); focusRow(i + 1); }
    else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); focusRow(i - 1); }
    else if (k === 'Home') { e.preventDefault(); focusRow(0); }
    else if (k === 'End') { e.preventDefault(); focusRow(visible.length - 1); }
    else if (k === 'Enter' && onRowClick) { e.preventDefault(); onRowClick(r); }
    else if ((k === ' ' || k === 'x') && selectable) { e.preventDefault(); toggle(keyOf(r, sorted.indexOf(r))); }
  };

  const doExport = async (all: boolean) => {
    const cols = (all ? allColumns : columns).filter((c) => !c.noExport);
    const data = all && onExportAll ? await onExportAll() : sorted;
    void exportExcel(exportName ?? 'export', data.map((r) => Object.fromEntries(cols.map((c) => {
      const v = val(c, r);
      return [c.label, isBlank(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : v];
    }))));
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) el.classList.toggle('scrolled-x', el.scrollLeft > 0);
  };

  const colCount = columns.length + (selectable ? 1 : 0);
  const stickyIdx = stickyFirst || columns[0]?.id ? 0 : -1;
  const count = server ? server.total : sorted.length;
  const showToolbar = !!(exportName || toolbar || viewKey);
  const emptyState: EmptyState = typeof empty === 'object' && empty !== null && 'title' in (empty as object) ? empty as EmptyState : { title: empty as ReactNode };

  let bodyState: ReactNode = null;
  if (error && !rows.length) {
    bodyState = (
      <tr><td colSpan={colCount} className="empty-cell">
        <div className="banner error" role="alert" style={{ justifyContent: 'center' }}>
          <span>{error}</span>{onRetry && <button className="small" onClick={onRetry}>Retry</button>}
        </div>
      </td></tr>
    );
  } else if (loading && !rows.length) {
    bodyState = Array.from({ length: 8 }, (_, i) => (
      <tr key={`sk${i}`}>{columns.map((c, j) => <td key={c.key}><span className="skel" style={{ width: `${40 + ((i * 7 + j * 13) % 50)}%`, marginLeft: c.align === 'right' ? 'auto' : undefined }} /></td>)}{selectable && <td />}</tr>
    ));
  } else if (!visible.length) {
    bodyState = (
      <tr><td colSpan={colCount} className="empty-cell">
        {filtered ? (
          <div className="stack tight" style={{ alignItems: 'center' }}>
            <span>No records match these filters.</span>
            {onClearFilters && <button className="small" onClick={onClearFilters}>Clear filters</button>}
          </div>
        ) : (
          <div className="stack tight" style={{ alignItems: 'center' }}>
            <span className={emptyState.body || emptyState.action ? 'empty-title' : ''} style={{ color: 'var(--text)' }}>{emptyState.title}</span>
            {emptyState.body && <span>{emptyState.body}</span>}
            {emptyState.action}
          </div>
        )}
      </td></tr>
    );
  }

  return (
    <div className={`table-wrap${maxHeight === 'none' ? ' no-max' : ''}`}>
      {showToolbar && (
        <div className="table-toolbar no-print">
          <div className="row">{toolbar}</div>
          <div className="row">
            {count !== null && <span className="table-count">{loading && rows.length ? 'Updating… ' : ''}{(count ?? 0).toLocaleString()} {count === 1 ? 'record' : 'records'}</span>}
            <DensityMenu density={density} />
            {viewKey && <ColumnMenu columns={allColumns as Column<unknown>[]} hidden={hidden} onChange={(h) => {
              setHidden(h);
              try { localStorage.setItem(`sc.cols.${viewKey}`, JSON.stringify([...h])); } catch { /* ignore */ }
            }} />}
            {exportName && (
              <Popover align="right" trigger={(p) => <button className="small" {...p} disabled={!sorted.length}><Download size={14} aria-hidden />Export</button>}>
                {(close) => <Menu items={[
                  { label: 'Excel — current view', icon: <Download size={14} />, onClick: () => { void doExport(false); close(); } },
                  ...(onExportAll || viewKey ? [{ label: onExportAll ? 'Excel — all matching rows' : 'Excel — all columns', icon: <Download size={14} />, onClick: () => { void doExport(true); close(); } }] : []),
                  null,
                  { label: 'Print / PDF', icon: <Printer size={14} />, onClick: () => { close(); setTimeout(() => window.print(), 50); } },
                ]} />}
              </Popover>
            )}
          </div>
        </div>
      )}
      {selectable && allPageSelected && !isVirtual && pages > 1 && selectedRows.length < sorted.length && (
        <div className="select-banner no-print">
          All {pageKeys.length} on this page selected · <button className="link-btn" onClick={() => setSelected(new Set(sorted.map(keyOf)))}>Select all {sorted.length} matching</button>
        </div>
      )}
      <div className="table-scroll" ref={scrollRef} onScroll={onScroll} style={maxHeight && maxHeight !== 'none' ? { maxHeight } : undefined}>
        <table>
          <thead>
            <tr>
              {selectable && (
                <th className="check-col">
                  <input type="checkbox" aria-label="Select all on this page" checked={allPageSelected}
                    ref={(el) => { if (el) el.indeterminate = !allPageSelected && somePageSelected; }}
                    onChange={() => setSelected((s) => { const n = new Set(s); pageKeys.forEach((k) => (allPageSelected ? n.delete(k) : n.add(k))); return n; })} />
                </th>
              )}
              {columns.map((c, ci) => {
                const sortable = c.sortable !== false && !!c.label;
                const dir = sort?.key === c.key ? sort.dir : 0;
                return (
                  <th key={c.key} className={[c.align, ci === stickyIdx ? 'sticky-col' : ''].filter(Boolean).join(' ') || undefined}
                    aria-sort={sortable ? (dir === 1 ? 'ascending' : dir === -1 ? 'descending' : 'none') : undefined} style={c.width ? { width: c.width } : undefined}>
                    {sortable ? (
                      <button type="button" className="th-btn" onClick={() => setSort(dir === 0 ? { key: c.key, dir: 1 } : dir === 1 ? { key: c.key, dir: -1 } : null)}>
                        {c.label}
                        <span className="sort-ic" aria-hidden>{dir === 1 ? <ArrowUp size={12} /> : dir === -1 ? <ArrowDown size={12} /> : <ArrowUpDown size={12} />}</span>
                      </button>
                    ) : c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {bodyState}
            {!bodyState && padTop > 0 && <tr aria-hidden style={{ height: padTop }}><td colSpan={colCount} style={{ padding: 0, border: 0, height: padTop }} /></tr>}
            {!bodyState && renderIdx.map((i) => {
              const r = visible[i];
              const absIdx = server || isVirtual || printAll ? i : curPage * pageSize + i;
              const k = keyOf(r, absIdx);
              const isSel = selectable && selected.has(k);
              const cls = [onRowClick ? 'clickable' : '', isSel ? 'selected' : '', activeKey && activeKey === k ? 'row-active' : '', rowClass?.(r) ?? ''].filter(Boolean).join(' ');
              return (
                <tr key={k} data-idx={i} data-index={i} ref={isVirtual ? virt.measureElement : undefined} className={cls || undefined}
                  tabIndex={interactive ? (i === active ? 0 : -1) : undefined}
                  aria-selected={selectable ? isSel : undefined}
                  onFocus={interactive ? () => setActive(i) : undefined}
                  onKeyDown={interactive ? (e) => onRowKey(e, i, r) : undefined}
                  onClick={onRowClick ? (e) => { if (!(e.target as HTMLElement).closest('button, a, input, select, textarea, label')) onRowClick(r); } : undefined}>
                  {selectable && (
                    <td className="check-col" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" tabIndex={-1} aria-label="Select row" checked={!!isSel} onChange={() => toggle(k)} />
                    </td>
                  )}
                  {columns.map((c, ci) => {
                    let content: ReactNode;
                    if (c.render) content = c.render(r);
                    else { const v = val(c, r); content = isBlank(v) ? <span className="muted-dash">—</span> : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v); }
                    const tdCls = [c.align, ci === stickyIdx ? 'sticky-col' : '', c.className].filter(Boolean).join(' ');
                    return <td key={c.key} className={tdCls || undefined}>{c.id ? <span className="id-link code">{content}</span> : content}</td>;
                  })}
                </tr>
              );
            })}
            {!bodyState && padBottom > 0 && <tr aria-hidden style={{ height: padBottom }}><td colSpan={colCount} style={{ padding: 0, border: 0, height: padBottom }} /></tr>}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
      {!isVirtual && !printAll && pages > 1 && (
        <div className="pager no-print">
          <span className="pager-info">
            Rows {(curPage * (server?.pageSize ?? pageSize) + 1).toLocaleString()}–{Math.min((curPage + 1) * (server?.pageSize ?? pageSize), count ?? 0).toLocaleString()} of {(count ?? 0).toLocaleString()}
          </span>
          <button className="icon-btn sm" aria-label="Previous page" disabled={curPage === 0} onClick={() => (server ? server.onPage(curPage - 1) : setPage(curPage - 1))}><ChevronLeft size={16} /></button>
          <span className="tnum">Page {curPage + 1} of {pages.toLocaleString()}</span>
          <button className="icon-btn sm" aria-label="Next page" disabled={curPage >= pages - 1} onClick={() => (server ? server.onPage(curPage + 1) : setPage(curPage + 1))}><ChevronRight size={16} /></button>
        </div>
      )}
      {selectable && selectedRows.length > 0 && (
        <div className="bulk-bar no-print" role="region" aria-label="Bulk actions">
          <strong>{selectedRows.length} selected</strong>
          {bulkActions?.(selectedRows, clearSel)}
          <button className="ghost small" onClick={clearSel}><X size={14} aria-hidden />Clear</button>
        </div>
      )}
    </div>
  );
}

function DensityMenu({ density }: { density: Density }) {
  const opts: { v: Density; label: string }[] = [{ v: 'compact', label: 'Compact' }, { v: 'default', label: 'Default' }, { v: 'comfortable', label: 'Comfortable' }];
  return (
    <Popover align="right" trigger={(p) => <button className="icon-btn sm" title="Row density" aria-label="Row density" {...p}><Rows3 size={15} /></button>}>
      {(close) => <Menu items={opts.map((o) => ({ label: o.label, hint: o.v === density ? '✓' : undefined, onClick: () => { setPref('density', o.v); close(); } }))} />}
    </Popover>
  );
}

function ColumnMenu({ columns, hidden, onChange }: { columns: Column<unknown>[]; hidden: Set<string>; onChange: (h: Set<string>) => void }) {
  return (
    <Popover align="right" trigger={(p) => <button className="icon-btn sm" title="Columns" aria-label="Choose columns" {...p}><Columns3 size={15} /></button>}>
      {() => (
        <div className="menu popover-scroll">
          <div className="menu-label">Columns</div>
          {columns.filter((c) => c.label).map((c) => (
            <label key={c.key} className="menu-item">
              <input type="checkbox" checked={!hidden.has(c.key)} onChange={() => { const n = new Set(hidden); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); onChange(n); }} />
              <span className="grow">{c.label}</span>
            </label>
          ))}
        </div>
      )}
    </Popover>
  );
}
