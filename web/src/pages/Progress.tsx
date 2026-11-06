import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups, type Lookups } from '../lib/hooks';
import { fetchAll, supabase } from '../lib/supabase';
import { ELEMENT_TYPES } from '../lib/contract';
import { date, humanize, num, shortDate } from '../lib/format';
import { delayedElements, type RollupRow } from '../lib/domain';
import type { ProgressQueueRow } from '../lib/approvals';
import { useUrlFilters, useUrlParam } from '../lib/url';
import { ProgressPreview } from '../components/approval/Previews';
import { Badge, Bar, Card, DataTable, Drawer, ErrorBanner, FilterBar, FilterSelect, Loading, Page, SearchInput, Tabs, useHashTab } from '../components/ui';


const SCurve = lazy(() => import('../components/charts/SCurve').then((m) => ({ default: m.SCurve })));

const TABS = ['rollup', 'elements', 'delays', 'verify', 'scurve'] as const;
type Tab = (typeof TABS)[number];

export function Progress() {
  const projectId = useProjectId();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'rollup');
  const lk = useLookups(projectId);
  return (
    <Page title="Progress" subtitle="Element-level progress, verification and planned vs actual">
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'rollup', label: 'By block / level' },
        { key: 'elements', label: 'Elements' },
        { key: 'delays', label: 'Delay report' },
        { key: 'verify', label: 'Verification' },
        { key: 'scurve', label: 'S-curve' },
      ]} />
      <ErrorBanner error={lk.error} onRetry={lk.reload} />
      {!lk.data ? <Loading lines={8} /> : (
        <>
          {tab === 'rollup' && <Rollup projectId={projectId} />}
          {tab === 'elements' && <ElementProgress L={lk.data} />}
          {tab === 'delays' && <Delays L={lk.data} />}
          {tab === 'verify' && <VerifyList L={lk.data} projectId={projectId} />}
          {tab === 'scurve' && <Suspense fallback={<Card title="Progress: planned vs actual"><Loading lines={6} /></Card>}><SCurve L={lk.data} projectId={projectId} /></Suspense>}
        </>
      )}
    </Page>
  );
}

interface TreeRow { key: string; kind: 'block' | 'level'; block: string; label: string; elements: number; completed: number; delayed: number; pct: number }

/** Block → level tree table with expand/collapse. */
function Rollup({ projectId }: { projectId: string }) {
  const q = useAsync(() => fetchAll<RollupRow>((a, b) => supabase.from('v_progress_rollup').select('*').eq('project_id', projectId).order('block_code').order('level_code').range(a, b)), [projectId], { key: 'rollup' });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const tree = useMemo(() => {
    const blocks = new Map<string, { b: TreeRow; levels: TreeRow[]; w: number }>();
    for (const r of q.data ?? []) {
      const bk = r.block_code ?? '—';
      const cur = blocks.get(bk) ?? { b: { key: `b:${bk}`, kind: 'block', block: bk, label: bk, elements: 0, completed: 0, delayed: 0, pct: 0 }, levels: [], w: 0 };
      cur.b.elements += Number(r.elements); cur.b.completed += Number(r.completed); cur.b.delayed += Number(r.delayed);
      cur.w += Number(r.avg_progress_pct) * Number(r.elements);
      cur.levels.push({ key: `l:${bk}:${r.level_code}`, kind: 'level', block: bk, label: r.level_code ?? '(no level)', elements: Number(r.elements), completed: Number(r.completed), delayed: Number(r.delayed), pct: Number(r.avg_progress_pct) });
      blocks.set(bk, cur);
    }
    return [...blocks.values()].map((x) => ({ ...x, b: { ...x.b, pct: x.b.elements ? x.w / x.b.elements : 0 } }));
  }, [q.data]);
  const rows = tree.flatMap((t) => [t.b, ...(open.has(t.b.block) ? t.levels : [])]);
  const toggle = (b: string) => setOpen((s) => { const n = new Set(s); if (n.has(b)) n.delete(b); else n.add(b); return n; });
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={rows} loading={!q.data} rowKey={(r) => r.key} exportName="progress-by-level" onRowClick={(r) => r.kind === 'block' && toggle(r.block)}
        toolbar={<button className="small" onClick={() => setOpen(open.size ? new Set() : new Set(tree.map((t) => t.b.block)))}>{open.size ? 'Collapse all' : 'Expand all'}</button>}
        empty={{ title: 'No elements yet', body: 'Import elements under Elements & BoQ to track progress.' }}
        columns={[
          { key: 'label', label: 'Block / level', sortable: false, render: (r) => r.kind === 'block'
            ? <span className="strong row nowrap">{open.has(r.block) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}Block {r.label}</span>
            : <span style={{ paddingLeft: 28 }}>{r.label}</span> },
          { key: 'elements', label: 'Elements', align: 'right', sortable: false },
          { key: 'completed', label: 'Completed', align: 'right', sortable: false },
          { key: 'delayed', label: 'Delayed', align: 'right', sortable: false, render: (r) => (r.delayed ? <span className="danger-text strong">{r.delayed}</span> : '0') },
          { key: 'pct', label: 'Progress', sortable: false, render: (r) => <Bar pct={r.pct} /> },
        ]} />
    </>
  );
}

function ElementProgress({ L }: { L: Lookups }) {
  const [f, setF, { active, clear }] = useUrlFilters({ block: '', level: '', type: '', status: '', q: '' }, 'e');
  const term = f.q.toLowerCase();
  const rows = L.elements.filter((e) => (!f.block || e.block_id === f.block) && (!f.level || e.level_id === f.level) && (!f.type || e.element_type === f.type)
    && (!f.status || e.status === f.status) && (!term || e.code.toLowerCase().includes(term)));
  return (
    <div className="stack">
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Element code" />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={L.blocks.map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Level" value={f.level} onChange={(v) => setF('level', v)} options={L.levels.filter((l) => !f.block || l.block_id === f.block).map((l) => ({ value: l.id, label: `${L.block(l.block_id)}/${l.code}` }))} />
        <FilterSelect label="Type" value={f.type} onChange={(v) => setF('type', v)} options={ELEMENT_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={['not_started', 'in_progress', 'completed'].map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      <DataTable rows={rows} exportName="progress-by-element" urlKey="e" stickyFirst filtered={active > 0} onClearFilters={clear}
        empty={{ title: 'No elements yet', action: <Link to="/elements#import">Import elements</Link> }} columns={[
        { key: 'code', label: 'Element', id: true, value: (e) => L.element(e.id) },
        { key: 'element_type', label: 'Type', value: (e) => humanize(e.element_type) },
        { key: 'planned_start', label: 'Planned start', render: (e) => shortDate(e.planned_start) },
        { key: 'planned_finish', label: 'Planned finish', render: (e) => shortDate(e.planned_finish) },
        { key: 'actual_start', label: 'Actual start', render: (e) => shortDate(e.actual_start) },
        { key: 'actual_finish', label: 'Actual finish', render: (e) => shortDate(e.actual_finish) },
        { key: 'status', label: 'Status', render: (e) => <Badge value={e.status} /> },
        { key: 'progress_pct', label: 'Verified progress', render: (e) => <Bar pct={Number(e.progress_pct)} /> },
      ]} />
    </div>
  );
}

function Delays({ L }: { L: Lookups }) {
  const rows = useMemo(() => delayedElements(L), [L]);
  return (
    <DataTable rows={rows} exportName="delay-report" defaultSort={{ key: 'days', dir: 'desc' }} stickyFirst
      empty={{ title: 'No delayed elements', body: 'Every element is on or ahead of its planned dates (FR-PG-04).' }} columns={[
      { key: 'code', label: 'Element', id: true, value: (e) => L.element(e.id) },
      { key: 'element_type', label: 'Type', value: (e) => humanize(e.element_type) },
      { key: 'reason', label: 'Delay', render: (e) => <Badge tone={e.reason === 'Finished late' ? 'warning' : 'danger'} label={e.reason} /> },
      { key: 'days', label: 'Days late', align: 'right', render: (e) => <span className={e.days > 14 ? 'danger-text strong' : ''}>{e.days}</span> },
      { key: 'planned_start', label: 'Planned start', render: (e) => date(e.planned_start) },
      { key: 'planned_finish', label: 'Planned finish', render: (e) => date(e.planned_finish) },
      { key: 'actual_start', label: 'Actual start', render: (e) => date(e.actual_start) },
      { key: 'progress_pct', label: 'Progress', render: (e) => <Bar pct={Number(e.progress_pct)} /> },
    ]} />
  );
}

/** History of progress reports. Pending ones are verified in the Approvals inbox (same component). */
function VerifyList({ L, projectId }: { L: Lookups; projectId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF, { active, clear }] = useUrlFilters({ vstatus: 'reported' });
  const q = useAsync(() => fetchAll<ProgressQueueRow>((a, b) => {
    let qb = supabase.from('progress_updates').select('*, element_activities(name, seq, is_hold_point)').eq('project_id', projectId);
    if (f.vstatus) qb = qb.eq('status', f.vstatus);
    return qb.order('created_at', { ascending: false }).range(a, b);
  }), [projectId, f.vstatus], { key: 'progress-updates' });
  const [openId, setOpenId] = useUrlParam('open');
  const open = q.data?.find((r) => r.id === openId) ?? null;
  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear} right={can('progress.verify') && <Link to="/approvals?type=progress">Verify in Approvals inbox <ArrowRight size={12} aria-hidden /></Link>}>
        <FilterSelect label="Status" value={f.vstatus} onChange={(v) => setF('vstatus', v)} options={['reported', 'verified', 'adjusted', 'rejected'].map((s) => ({ value: s, label: s === 'reported' ? 'To verify' : humanize(s) }))} />
      </FilterBar>
      <DataTable rows={q.data ?? []} loading={!q.data} exportName="progress-updates" urlKey="v" activeKey={openId} filtered={!!f.vstatus && f.vstatus !== 'reported'} onClearFilters={clear}
        onRowClick={(r) => (r.status === 'reported' && can('progress.verify') ? nav(`/approvals?type=progress&id=${r.id}`) : setOpenId(r.id, true))}
        empty={{ title: 'Nothing waiting for verification', body: 'Progress reported from site appears here.' }} columns={[
        { key: 'report_date', label: 'Date', render: (r) => date(r.report_date) },
        { key: 'element', label: 'Element', id: true, value: (r) => L.element(r.element_id) },
        { key: 'activity', label: 'Activity', value: (r) => r.element_activities?.name ?? '',
          render: (r) => <>{r.element_activities?.name}{r.element_activities?.is_hold_point && <> <Badge value="hold_point" /></>}</> },
        { key: 'pct_complete', label: 'Reported %', align: 'right', render: (r) => num(r.pct_complete, 1) },
        { key: 'qty_achieved', label: 'Qty achieved', align: 'right', value: (r) => (r.qty_achieved === null ? '' : `${num(r.qty_achieved)} ${r.uom ?? ''}`) },
        { key: 'reported_by', label: 'Reported by', value: (r) => L.person(r.reported_by) },
        { key: 'remarks', label: 'Remarks', hidden: true },
        { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'verified_pct', label: 'Verified %', align: 'right', render: (r) => (r.verified_pct === null ? <span className="muted-dash">—</span> : num(r.verified_pct, 1)) },
      ]} />
      {open && (
        <Drawer title="Progress report" onClose={() => setOpenId(null)} size="lg">
          <div className="inbox-preview" style={{ maxHeight: 'none' }}>
            <ProgressPreview row={open} L={L} onActions={() => undefined} readOnly onDone={() => setOpenId(null)} />
          </div>
        </Drawer>
      )}
    </div>
  );
}
