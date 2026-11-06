import { useMemo, useState } from 'react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups, type Lookups } from '../lib/hooks';
import { fetchAll, supabase } from '../lib/supabase';
import { MR_STATUS_LABELS, type MaterialRequest, type MrStatus, type ProjectSettings } from '../lib/contract';
import { date, dateTime, humanize, money, num } from '../lib/format';
import { delayedElements, thresholdFor, type BalanceRow, type ConsumptionRow } from '../lib/domain';
import { useUrlFilters } from '../lib/url';
import { Badge, Bar, type Column, DataTable, ErrorBanner, FilterBar, FilterDate, FilterSelect, FilterText, FilterToggle, Page, PrintHeader, PriorityBadge, Signatures } from '../components/ui';

type FilterKey = 'block' | 'level' | 'element' | 'spec' | 'date' | 'user' | 'store' | 'supplier' | 'over';
interface Filters { block: string; level: string; element: string; spec: string; from: string; to: string; user: string; store: string; supplier: string; over: boolean }
type Row = Record<string, unknown>;

interface Ctx { projectId: string; L: Lookups; f: Filters; settings: ProjectSettings | null; currency: string }
interface ReportDef {
  key: string;
  title: string;
  description: string;
  filters: FilterKey[];
  prices?: boolean;
  load: (c: Ctx) => Promise<Row[]>;
  columns: (c: Ctx) => Column<Row>[];
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown) => Number(v ?? 0);
const inRange = (d: unknown, f: Filters) => { const x = s(d).slice(0, 10); return (!f.from || x >= f.from) && (!f.to || x <= f.to); };
/** Element-based filters (element, or block/level via the element). */
function elOk(L: Lookups, elementId: unknown, f: Filters) {
  if (!f.element && !f.block && !f.level) return true;
  if (!elementId) return false;
  const e = L.elements.find((x) => x.id === elementId);
  if (!e) return false;
  return (!f.element || e.id === f.element) && (!f.block || e.block_id === f.block) && (!f.level || e.level_id === f.level);
}

const REPORTS: ReportDef[] = [
  {
    key: 'mr_register', title: 'Material request register', description: 'Every request line with approval and issue balances',
    filters: ['block', 'element', 'spec', 'date', 'user'],
    load: async ({ projectId, L, f }) => {
      const [lines, mrs, els] = await Promise.all([
        fetchAll<Row>((a, b) => supabase.from('v_mr_line_status').select('*').eq('project_id', projectId).order('number').range(a, b)),
        fetchAll<MaterialRequest>((a, b) => supabase.from('material_requests').select('*').eq('project_id', projectId).range(a, b)),
        fetchAll<{ mr_line_id: string; element_id: string; qty: number }>((a, b) => supabase.from('mr_line_elements').select('mr_line_id, element_id, qty').eq('project_id', projectId).is('deleted_at', null).range(a, b)),
      ]);
      const mr = new Map(mrs.map((m) => [m.id, m]));
      return lines.map((l): Row => {
        const m = mr.get(s(l.mr_id))!;
        const le = els.filter((e) => e.mr_line_id === l.mr_line_id);
        return { ...l, created_at: m?.created_at, block_id: m?.block_id, requested_by: m?.requested_by, element_ids: le.map((e) => e.element_id),
          elements: le.map((e) => `${L.element(e.element_id)} (${num(e.qty)})`).join('; ') };
      }).filter((r) => (!f.block || r.block_id === f.block) && (!f.spec || r.material_spec_id === f.spec) && inRange(r.created_at, f)
        && (!f.user || r.requested_by === f.user) && (!f.element || (r.element_ids as string[]).includes(f.element)));
    },
    columns: ({ L }) => [
      { key: 'number', label: 'MR', id: true },
      { key: 'created_at', label: 'Raised', render: (r) => date(r.created_at) },
      { key: 'status', label: 'Status', value: (r) => MR_STATUS_LABELS[r.status as MrStatus], render: (r) => <Badge value={s(r.status)} label={MR_STATUS_LABELS[r.status as MrStatus]} /> },
      { key: 'priority', label: 'Priority' },
      { key: 'block', label: 'Block', value: (r) => L.block(s(r.block_id)) },
      { key: 'requested_by', label: 'Requested by', value: (r) => L.person(s(r.requested_by)) },
      { key: 'label', label: 'Material' },
      { key: 'elements', label: 'Elements' },
      { key: 'qty', label: 'Requested', align: 'right', render: (r) => num(r.qty, 3) },
      { key: 'approved_qty', label: 'Approved', align: 'right', render: (r) => num(r.approved_qty, 3) },
      { key: 'issued_qty', label: 'Issued', align: 'right', render: (r) => num(r.issued_qty, 3) },
      { key: 'remaining_qty', label: 'Balance', align: 'right', render: (r) => num(r.remaining_qty, 3) },
      { key: 'uom', label: 'Unit' },
      { key: 'required_date', label: 'Required', render: (r) => date(r.required_date) },
    ],
  },
  {
    key: 'ageing', title: 'Approval ageing', description: 'Requests waiting for review or approval, oldest first',
    filters: ['user'],
    load: async ({ projectId, f }) => (await fetchAll<Row>((a, b) => supabase.from('v_request_ageing').select('*').eq('project_id', projectId).order('hours_waiting', { ascending: false }).range(a, b)))
      .filter((r) => !f.user || r.requested_by_name === f.user),
    columns: () => [
      { key: 'number', label: 'MR', id: true },
      { key: 'status', label: 'Status', render: (r) => <Badge value={s(r.status)} /> },
      { key: 'priority', label: 'Priority', render: (r) => <PriorityBadge value={s(r.priority)} /> },
      { key: 'requested_by_name', label: 'Requested by' },
      { key: 'submitted_at', label: 'Submitted', render: (r) => dateTime(r.submitted_at) },
      { key: 'required_date', label: 'Required', render: (r) => date(r.required_date) },
      { key: 'hours_waiting', label: 'Waiting (h)', align: 'right', render: (r) => <span className={n(r.hours_waiting) > 48 ? 'danger-text' : ''}>{num(r.hours_waiting, 0)}</span> },
    ],
  },
  {
    key: 'grn_register', title: 'GRN register', description: 'Deliveries received, accepted and rejected quantities',
    filters: ['spec', 'date', 'store', 'supplier'],
    load: async ({ projectId, L, f }) => (await fetchAll<Row>((a, b) => supabase.from('grn_lines').select('*, grns!inner(*)').eq('project_id', projectId).range(a, b)))
      .map((l): Row => {
        const g = l.grns as Row;
        return { ...l, number: g.number, received_at: g.received_at, store_id: g.store_id, status: g.status, delivery_note_no: g.delivery_note_no, vehicle_plate: g.vehicle_plate,
          supplier: s(g.supplier_name) || (L.suppliers.find((x) => x.id === g.supplier_id)?.name ?? '') };
      })
      .filter((r) => (!f.spec || r.material_spec_id === f.spec) && inRange(r.received_at, f) && (!f.store || r.store_id === f.store)
        && (!f.supplier || s(r.supplier).toLowerCase().includes(f.supplier.toLowerCase())))
      .sort((a, b) => s(b.received_at).localeCompare(s(a.received_at))),
    columns: ({ L }) => [
      { key: 'number', label: 'GRN', id: true },
      { key: 'received_at', label: 'Received', render: (r) => dateTime(r.received_at) },
      { key: 'supplier', label: 'Supplier' },
      { key: 'delivery_note_no', label: 'Delivery note' },
      { key: 'store', label: 'Store', value: (r) => L.store(s(r.store_id)) },
      { key: 'spec', label: 'Material', value: (r) => L.spec(s(r.material_spec_id)) },
      { key: 'ordered_qty', label: 'Ordered', align: 'right', render: (r) => num(r.ordered_qty, 3) },
      { key: 'qty_delivered', label: 'Delivered', align: 'right', render: (r) => num(r.qty_delivered, 3) },
      { key: 'qty_accepted', label: 'Accepted', align: 'right', render: (r) => num(r.qty_accepted, 3) },
      { key: 'qty_rejected', label: 'Rejected', align: 'right', render: (r) => num(r.qty_rejected, 3) },
      { key: 'inspection_result', label: 'Inspection', render: (r) => <Badge value={s(r.inspection_result)} /> },
      { key: 'variance_flag', label: 'Flag', render: (r) => <Badge value={s(r.variance_flag)} outline tone="danger" icon={null} /> },
      { key: 'status', label: 'Status', render: (r) => <Badge value={s(r.status)} /> },
    ],
  },
  {
    key: 'ledger', title: 'Stock ledger', description: 'Every stock movement with running balance per store and material',
    filters: ['store', 'spec', 'element', 'date', 'user'],
    load: async ({ projectId, f }) => {
      return fetchAll<Row>((a, b) => {
        let qb = supabase.from('v_bin_card').select('*').eq('project_id', projectId);
        if (f.store) qb = qb.eq('store_id', f.store);
        if (f.spec) qb = qb.eq('material_spec_id', f.spec);
        if (f.element) qb = qb.eq('element_id', f.element);
        if (f.user) qb = qb.eq('created_by', f.user);
        if (f.from) qb = qb.gte('txn_at', f.from);
        if (f.to) qb = qb.lte('txn_at', `${f.to}T23:59:59`);
        return qb.order('txn_at').order('created_at').range(a, b);
      }, 50000);
    },
    columns: ({ L }) => [
      { key: 'txn_at', label: 'Date', render: (r) => dateTime(r.txn_at) },
      { key: 'store', label: 'Store', value: (r) => L.store(s(r.store_id)) },
      { key: 'label', label: 'Material' },
      { key: 'stock_status', label: 'Stock', render: (r) => <Badge value={s(r.stock_status)} /> },
      { key: 'doc_number', label: 'Document' },
      { key: 'txn_type', label: 'Type', value: (r) => humanize(s(r.txn_type)) },
      { key: 'element_code', label: 'Element' },
      { key: 'qty', label: 'Qty', align: 'right', render: (r) => num(r.qty, 3) },
      { key: 'running_balance', label: 'Balance', align: 'right', render: (r) => num(r.running_balance, 3) },
      { key: 'uom', label: 'Unit' },
      { key: 'created_by', label: 'By', value: (r) => L.person(s(r.created_by)) },
    ],
  },
  {
    key: 'stock_status', title: 'Stock status', description: 'Current balance per store and material, with reorder flags',
    filters: ['store', 'spec'],
    load: async ({ projectId, f }) => (await fetchAll<BalanceRow>((a, b) => supabase.from('v_stock_balance').select('*').eq('project_id', projectId).order('label').range(a, b)))
      .filter((r) => (!f.store || r.store_id === f.store) && (!f.spec || r.material_spec_id === f.spec)) as unknown as Row[],
    columns: () => [
      { key: 'store_name', label: 'Store' },
      { key: 'category', label: 'Category' },
      { key: 'label', label: 'Material' },
      { key: 'stock_status', label: 'Stock', render: (r) => <Badge value={s(r.stock_status)} /> },
      { key: 'qty', label: 'Balance', align: 'right', render: (r) => num(r.qty, 3) },
      { key: 'uom', label: 'Unit' },
      { key: 'reorder_level', label: 'Reorder at', align: 'right', render: (r) => num(r.reorder_level, 3) },
      { key: 'below_reorder', label: 'Low', value: (r) => (r.below_reorder ? 'LOW' : ''), render: (r) => (r.below_reorder ? <Badge value="critical" label="Low" /> : '') },
    ],
  },
  {
    key: 'issues', title: 'Issue register by element', description: 'Materials issued to each structural element (MIV lines)',
    filters: ['block', 'level', 'element', 'spec', 'date', 'user'],
    load: async ({ projectId, L, f }) => (await fetchAll<Row>((a, b) => supabase.from('miv_lines').select('*, mivs!inner(*)').eq('project_id', projectId).range(a, b)))
      .map((l): Row => { const m = l.mivs as Row; return { ...l, number: m.number, issued_at: m.issued_at, issued_to: m.issued_to, store_id: m.store_id, status: m.status, is_emergency: m.is_emergency }; })
      .filter((r) => elOk(L, r.element_id, f) && (!f.spec || r.material_spec_id === f.spec) && inRange(r.issued_at, f) && (!f.user || r.issued_to === f.user))
      .sort((a, b) => L.element(s(a.element_id)).localeCompare(L.element(s(b.element_id))) || s(a.issued_at).localeCompare(s(b.issued_at))),
    columns: ({ L }) => [
      { key: 'element', label: 'Element', value: (r) => L.element(s(r.element_id)) },
      { key: 'number', label: 'MIV' },
      { key: 'issued_at', label: 'Issued', render: (r) => dateTime(r.issued_at) },
      { key: 'spec', label: 'Material', value: (r) => L.spec(s(r.material_spec_id)) },
      { key: 'qty', label: 'Qty', align: 'right', render: (r) => num(r.qty, 3) },
      { key: 'uom', label: 'Unit', value: (r) => L.specUom(s(r.material_spec_id)) },
      { key: 'issued_to', label: 'Issued to', value: (r) => L.person(s(r.issued_to)) },
      { key: 'substitution_reason', label: 'Substitution' },
      { key: 'status', label: 'Status', render: (r) => <>{r.is_emergency ? <Badge value="urgent" label="Emergency" /> : null} <Badge value={s(r.status)} /></> },
    ],
  },
  {
    key: 'consumption', title: 'Consumption vs BoQ', description: 'Take-off vs issued per element and material; variance against earned quantity (FR-CC-01/02)',
    filters: ['block', 'level', 'element', 'spec', 'over'],
    load: async ({ projectId, L, f, settings }) => (await fetchAll<ConsumptionRow>((a, b) => supabase.from('v_element_consumption').select('*').eq('project_id', projectId).range(a, b)))
      .map((r) => ({ ...r, threshold: thresholdFor(settings?.variance_thresholds, r.category) }))
      .filter((r) => elOk(L, r.element_id, f) && (!f.spec || r.material_spec_id === f.spec)
        && (!f.over || (r.threshold !== null && r.variance_pct !== null && Number(r.variance_pct) > r.threshold)))
      .sort((a, b) => a.element_code.localeCompare(b.element_code)) as unknown as Row[],
    columns: ({ L }) => [
      { key: 'element', label: 'Element', value: (r) => L.element(s(r.element_id)) },
      { key: 'label', label: 'Material' },
      { key: 'uom', label: 'Unit' },
      { key: 'planned_qty', label: 'Take-off', align: 'right', render: (r) => num(r.planned_qty, 3) },
      { key: 'allowed_qty', label: 'Incl. wastage', align: 'right', render: (r) => num(r.allowed_qty, 3) },
      { key: 'progress_pct', label: 'Progress %', align: 'right', render: (r) => num(r.progress_pct, 1) },
      { key: 'earned_qty', label: 'Earned', align: 'right', render: (r) => num(r.earned_qty, 3) },
      { key: 'issued_qty', label: 'Issued (net)', align: 'right', render: (r) => num(r.issued_qty, 3) },
      { key: 'wasted_qty', label: 'Wasted', align: 'right', render: (r) => num(r.wasted_qty, 3) },
      { key: 'variance_pct', label: 'Variance %', align: 'right', render: (r) => {
        const over = r.threshold !== null && r.variance_pct !== null && n(r.variance_pct) > n(r.threshold);
        return r.variance_pct === null ? '—' : <span className={over ? 'danger-text' : ''}>{num(r.variance_pct, 1)}%</span>;
      } },
      { key: 'threshold', label: 'Threshold', align: 'right', value: (r) => (r.threshold === null ? '' : `${r.threshold}%`) },
    ],
  },
  {
    key: 'wastage', title: 'Wastage report', description: 'Approved wastage, damage, loss and write-offs',
    filters: ['element', 'spec', 'date', 'store'],
    load: async ({ projectId, L, f }) => (await fetchAll<Row>((a, b) => supabase.from('adjustment_lines').select('*, adjustments!inner(*)').eq('project_id', projectId)
      .neq('adjustments.adj_type', 'count_variance').range(a, b)))
      .map((l): Row => { const a = l.adjustments as Row; return { ...l, number: a.number, adj_type: a.adj_type, reason_code: a.reason_code, status: a.status, created_at: a.created_at, store_id: a.store_id, requested_by: a.requested_by }; })
      .filter((r) => (!f.element || r.element_id === f.element) && (!f.spec || r.material_spec_id === f.spec) && inRange(r.created_at, f) && (!f.store || r.store_id === f.store))
      .map((r): Row => ({ ...r, element_label: L.element(s(r.element_id)) })),
    columns: ({ L }) => [
      { key: 'number', label: 'Number' },
      { key: 'created_at', label: 'Date', render: (r) => date(r.created_at) },
      { key: 'adj_type', label: 'Type', value: (r) => humanize(s(r.adj_type)) },
      { key: 'reason_code', label: 'Reason' },
      { key: 'spec', label: 'Material', value: (r) => L.spec(s(r.material_spec_id)) },
      { key: 'element_label', label: 'Element' },
      { key: 'qty', label: 'Qty lost', align: 'right', value: (r) => -n(r.qty_delta), render: (r) => num(-n(r.qty_delta), 3) },
      { key: 'uom', label: 'Unit', value: (r) => L.specUom(s(r.material_spec_id)) },
      { key: 'requested_by', label: 'Raised by', value: (r) => L.person(s(r.requested_by)) },
      { key: 'status', label: 'Status', render: (r) => <Badge value={s(r.status)} /> },
    ],
  },
  {
    key: 'supplier', title: 'Supplier performance', description: 'Deliveries, shortages, wrong grades and rejections per supplier',
    filters: ['date', 'supplier'],
    load: async ({ projectId, L, f }) => {
      const lines = await fetchAll<Row>((a, b) => supabase.from('grn_lines').select('*, grns!inner(supplier_id, supplier_name, received_at, status, id)').eq('project_id', projectId).range(a, b));
      const agg = new Map<string, Row & { grns: Set<string> }>();
      for (const l of lines) {
        const g = l.grns as Row;
        if (g.status === 'reversed' || !inRange(g.received_at, f)) continue;
        const name = s(g.supplier_name) || L.suppliers.find((x) => x.id === g.supplier_id)?.name || '(not recorded)';
        if (f.supplier && !name.toLowerCase().includes(f.supplier.toLowerCase())) continue;
        const cur = agg.get(name) ?? { supplier: name, grns: new Set<string>(), lines: 0, shortage: 0, excess: 0, wrong_grade: 0, delivered: 0, rejected: 0 };
        cur.grns.add(s(g.id));
        cur.lines = n(cur.lines) + 1;
        if (l.variance_flag) cur[s(l.variance_flag)] = n(cur[s(l.variance_flag)]) + 1;
        cur.delivered = n(cur.delivered) + n(l.qty_delivered);
        cur.rejected = n(cur.rejected) + n(l.qty_rejected);
        agg.set(name, cur);
      }
      const rating = new Map(L.suppliers.map((x) => [x.name, x.rating]));
      return [...agg.values()].map(({ grns, ...r }) => ({ ...r, deliveries: grns.size, reject_pct: n(r.delivered) ? (n(r.rejected) / n(r.delivered)) * 100 : 0, rating: rating.get(s(r.supplier)) ?? null }));
    },
    columns: () => [
      { key: 'supplier', label: 'Supplier' },
      { key: 'deliveries', label: 'Deliveries', align: 'right' },
      { key: 'lines', label: 'Lines', align: 'right' },
      { key: 'shortage', label: 'Shortages', align: 'right' },
      { key: 'excess', label: 'Excess', align: 'right' },
      { key: 'wrong_grade', label: 'Wrong grade', align: 'right' },
      { key: 'reject_pct', label: 'Rejected qty %', align: 'right', render: (r) => num(r.reject_pct, 1) },
      { key: 'rating', label: 'Rating', align: 'right' },
    ],
  },
  {
    key: 'progress', title: 'Progress by element', description: 'Verified progress and dates per element',
    filters: ['block', 'level', 'element'],
    load: async ({ L, f }) => L.elements.filter((e) => elOk(L, e.id, f)) as unknown as Row[],
    columns: ({ L }) => [
      { key: 'element', label: 'Element', value: (r) => L.element(s(r.id)) },
      { key: 'element_type', label: 'Type', value: (r) => humanize(s(r.element_type)) },
      { key: 'planned_start', label: 'Planned start', render: (r) => date(r.planned_start) },
      { key: 'planned_finish', label: 'Planned finish', render: (r) => date(r.planned_finish) },
      { key: 'actual_start', label: 'Actual start', render: (r) => date(r.actual_start) },
      { key: 'actual_finish', label: 'Actual finish', render: (r) => date(r.actual_finish) },
      { key: 'status', label: 'Status', render: (r) => <Badge value={s(r.status)} /> },
      { key: 'progress_pct', label: 'Progress %', render: (r) => <Bar pct={n(r.progress_pct)} /> },
    ],
  },
  {
    key: 'delays', title: 'Delay report', description: 'Elements behind their planned dates (FR-PG-04)',
    filters: ['block', 'level', 'element'],
    load: async ({ L, f }) => delayedElements(L).filter((e) => elOk(L, e.id, f)) as unknown as Row[],
    columns: ({ L }) => [
      { key: 'element', label: 'Element', value: (r) => L.element(s(r.id)) },
      { key: 'reason', label: 'Delay' },
      { key: 'days', label: 'Days late', align: 'right' },
      { key: 'planned_start', label: 'Planned start', render: (r) => date(r.planned_start) },
      { key: 'planned_finish', label: 'Planned finish', render: (r) => date(r.planned_finish) },
      { key: 'progress_pct', label: 'Progress %', align: 'right', render: (r) => num(r.progress_pct, 1) },
    ],
  },
  {
    key: 'cost', title: 'Issued cost per element', description: 'Issued material cost vs take-off value (FR-CC-03)', prices: true,
    filters: ['block', 'level', 'element', 'spec'],
    load: async ({ projectId, L, f }) => (await fetchAll<Row>((a, b) => supabase.from('v_element_cost').select('*').eq('project_id', projectId).range(a, b)))
      .filter((r) => elOk(L, r.element_id, f) && (!f.spec || r.material_spec_id === f.spec)),
    columns: ({ L, currency }) => [
      { key: 'element', label: 'Element', value: (r) => L.element(s(r.element_id)) },
      { key: 'label', label: 'Material' },
      { key: 'issued_qty', label: 'Issued qty', align: 'right', render: (r) => num(r.issued_qty, 3) },
      { key: 'unit_price', label: 'Unit price', align: 'right', render: (r) => money(r.unit_price, currency) },
      { key: 'issued_cost', label: 'Issued cost', align: 'right', render: (r) => money(r.issued_cost, currency) },
      { key: 'planned_cost', label: 'Take-off value', align: 'right', render: (r) => money(r.planned_cost, currency) },
    ],
  },
];

const GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Requests', keys: ['mr_register', 'ageing'] },
  { label: 'Store', keys: ['grn_register', 'ledger', 'stock_status', 'issues', 'wastage', 'supplier'] },
  { label: 'Progress', keys: ['progress', 'delays', 'consumption'] },
  { label: 'Cost', keys: ['cost'] },
];

/** Summary strip values per report (totals above the table). */
function summarize(key: string, rows: Row[]): [string, string][] {
  const out: [string, string][] = [['Rows', rows.length.toLocaleString()]];
  if (key === 'ageing' && rows.length) {
    const h = rows.map((r) => n(r.hours_waiting)).sort((a, b) => a - b);
    out.push(['Median wait', `${num(h[Math.floor(h.length / 2)], 0)} h`], ['Max wait', `${num(h[h.length - 1], 0)} h`], ['> 48 h', String(h.filter((x) => x > 48).length)]);
  }
  if (key === 'stock_status') out.push(['Low', String(rows.filter((r) => r.below_reorder).length)]);
  if (key === 'consumption') out.push(['Over threshold', String(rows.filter((r) => r.threshold !== null && r.variance_pct !== null && n(r.variance_pct) > n(r.threshold)).length)]);
  if (key === 'delays' && rows.length) out.push(['Max days late', String(Math.max(...rows.map((r) => n(r.days))))]);
  if (key === 'cost') out.push(['Issued cost', money(rows.reduce((s, r) => s + n(r.issued_cost), 0), '')], ['Take-off value', money(rows.reduce((s, r) => s + n(r.planned_cost), 0), '')]);
  if (key === 'grn_register') out.push(['Rejected lines', String(rows.filter((r) => n(r.qty_rejected) > 0).length)]);
  return out;
}

export function Reports() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const available = REPORTS.filter((r) => !r.prices || auth.canSeePrices);
  const [uf, setUf, { active, clear }] = useUrlFilters({ r: 'mr_register', block: '', level: '', element: '', spec: '', from: '', to: '', user: '', store: '', supplier: '', over: '' });
  const [search, setSearch] = useState('');
  const def = available.find((r) => r.key === uf.r) ?? available[0];
  const f: Filters = { ...uf, over: uf.over === '1' };
  const set = (k: keyof Filters) => (v: string | boolean) => setUf(k as Exclude<keyof typeof uf, 'r'>, typeof v === 'boolean' ? (v ? '1' : '') : v);

  const ctx = useMemo<Ctx | null>(() => (lk.data ? { projectId, L: lk.data, f, settings: auth.settings, currency: auth.project?.currency ?? 'ETB' } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, lk.data, JSON.stringify(f), auth.settings, auth.project]);
  const q = useAsync(async () => (ctx ? def.load(ctx) : []), [def.key, projectId, JSON.stringify(f), !!lk.data, auth.settings], { key: 'report', enabled: !!ctx });
  const L = lk.data;
  const has = (k: FilterKey) => def.filters.includes(k);
  const ageingUsers = def.key === 'ageing';
  const filterCount = active - (uf.r !== 'mr_register' ? 1 : 0);
  const clearFilters = () => { clear(); setUf('r', def.key); };

  // Filters in words for the print header.
  const words = L ? [
    f.block && `Block ${L.block(f.block)}`, f.level && `Level ${L.level(f.level)}`, f.element && `Element ${L.element(f.element)}`, f.spec && L.spec(f.spec),
    f.store && L.store(f.store), (f.from || f.to) && `${f.from || '…'} – ${f.to || '…'}`, f.user && (ageingUsers ? f.user : L.person(f.user)), f.supplier && `Supplier “${f.supplier}”`, f.over && 'Over threshold only',
  ].filter(Boolean).join(' · ') : '';
  const term = search.toLowerCase();

  return (
    <Page title="Reports" subtitle={`${auth.project?.code ?? ''} · filter, then export to Excel or print (FR-RP-01/02/04)`}>
      <div className="reports-layout">
        <nav className="report-list no-print" aria-label="Reports">
          <input type="search" placeholder="Find a report…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Find a report" />
          {GROUPS.map((g) => {
            const items = available.filter((r) => g.keys.includes(r.key) && (!term || r.title.toLowerCase().includes(term)));
            if (!items.length) return null;
            return (
              <div key={g.label}>
                <div className="menu-label">{g.label}</div>
                {items.map((r) => (
                  <a key={r.key} href={`?r=${r.key}`} className={`report-link${r.key === def.key ? ' active' : ''}`} aria-current={r.key === def.key ? 'page' : undefined}
                    onClick={(e) => { e.preventDefault(); clear(); setUf('r', r.key); }}>{r.title}</a>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="stack" style={{ minWidth: 0 }}>
          <PrintHeader title={def.title} filters={words} />
          <div className="no-print">
            <h2 style={{ fontSize: 'var(--fs-lg)' }}>{def.title}</h2>
            <div className="muted">{def.description}</div>
          </div>
          {L && (
            <FilterBar active={filterCount} onClear={clearFilters}>
              {has('block') && <FilterSelect label="Block" value={f.block} onChange={(v) => { set('block')(v); }} options={L.blocks.map((b) => ({ value: b.id, label: b.code }))} />}
              {has('level') && <FilterSelect label="Level" value={f.level} onChange={set('level')} options={L.levels.filter((l) => !f.block || l.block_id === f.block).map((l) => ({ value: l.id, label: `${L.block(l.block_id)}/${l.code}` }))} />}
              {has('element') && <FilterSelect label="Element" value={f.element} onChange={set('element')} options={L.elements.filter((e) => (!f.block || e.block_id === f.block) && (!f.level || e.level_id === f.level)).map((e) => ({ value: e.id, label: L.element(e.id) }))} />}
              {has('spec') && <FilterSelect label="Material" value={f.spec} onChange={set('spec')} options={L.specs.map((x) => ({ value: x.id, label: x.label }))} />}
              {has('store') && <FilterSelect label="Store" value={f.store} onChange={set('store')} options={L.stores.map((x) => ({ value: x.id, label: x.name }))} />}
              {has('date') && <><FilterDate label="From" value={f.from} onChange={set('from')} /><FilterDate label="To" value={f.to} onChange={set('to')} /></>}
              {has('user') && <FilterSelect label="User" value={f.user} onChange={set('user')} options={L.profiles.map((p) => ({ value: ageingUsers ? p.full_name : p.id, label: p.full_name || p.email || '' }))} />}
              {has('supplier') && <FilterText label="Supplier" value={f.supplier} onChange={set('supplier')} />}
              {has('over') && <FilterToggle label="Over threshold only" checked={f.over} onChange={set('over')} />}
            </FilterBar>
          )}
          <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
          {q.data && (
            <div className="summary-strip">
              {summarize(def.key, q.data).map(([k, v]) => <span className="s" key={k}><span className="muted">{k}</span><strong>{v}</strong></span>)}
            </div>
          )}
          <DataTable rows={q.data ?? []} loading={!q.data || !ctx} columns={ctx ? def.columns(ctx) : []} exportName={`${auth.project?.code ?? 'project'}-${def.key}`} pageSize={100}
            filtered={filterCount > 0} onClearFilters={clearFilters} urlKey="" key={def.key}
            empty={{ title: 'Nothing to report yet', body: def.description }}
            rowKey={(r, i) => s(r.id ?? r.mr_line_id ?? r.supplier) + i} />
          <Signatures />
        </div>
      </div>
    </Page>
  );
}
