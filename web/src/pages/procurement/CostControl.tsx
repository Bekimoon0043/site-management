import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import type { BoqItem } from '../../lib/contract';
import { canProcure, type BudgetLine, type CommittedCostRow, type CostControlRow } from '../../lib/contract-procurement';
import { loadBudgetLines, procRpc } from '../../lib/procurement';
import { money, num, qty } from '../../lib/format';
import { Banner, Bar, Card, DataTable, Drawer, Empty, ErrorBanner, Kpi, Page, Tabs, toast, useBusy, useHashTab, type Column } from '../../components/ui';
import { InventoryValue, MaterialActuals, loadInventoryValue } from '../../components/costing/MaterialCosting';

const TABS = ['lines', 'category', 'boq', 'materials', 'inventory', 'commitments', 'budget'] as const;
type Tab = (typeof TABS)[number];

interface Agg { key: string; label: string; budget: number; committed: number; received: number; issued: number; remaining: number; pct: number | null; lines: CostControlRow[] }

const sum = (rows: CostControlRow[], k: 'budget_amount' | 'committed' | 'received' | 'issued' | 'remaining') => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
const agg = (key: string, label: string, lines: CostControlRow[]): Agg => {
  const budget = sum(lines, 'budget_amount'), committed = sum(lines, 'committed'), received = sum(lines, 'received');
  const issued = sum(lines, 'issued');
  return { key, label, budget, committed, received, issued, remaining: sum(lines, 'remaining'), pct: budget ? (100 * issued) / budget : null, lines };
};
const tone = (pct: number | null) => (pct === null ? undefined : pct > 100 ? 'danger-text strong' : pct > 85 ? 'warn-text strong' : undefined);

/** Cost control: budget vs committed (open PO) vs received into stock vs USED (actual cost = consumption at average cost). Ex-VAT. */
export function CostControl() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const cur = auth.project?.currency ?? 'ETB';
  const [tab, setTab] = useHashTab(TABS, 'lines');
  const [drill, setDrill] = useState<Agg | null>(null);
  const q = useAsync(async () => {
    const [cc, committed, inv] = await Promise.all([
      fetchAll<CostControlRow>((a, b) => supabase.from('v_cost_control').select('*').eq('project_id', projectId).range(a, b)),
      fetchAll<CommittedCostRow>((a, b) => supabase.from('v_committed_cost').select('*').eq('project_id', projectId).range(a, b)),
      loadInventoryValue(projectId),
    ]);
    return { cc, committed, inventory: inv.reduce((s, r) => s + Number(r.value), 0) };
  }, [projectId], { key: 'cost-control', enabled: auth.canSeePrices });

  const data = q.data;
  const total = useMemo(() => agg('all', 'All', data?.cc ?? []), [data]);
  const openCommit = (data?.committed ?? []).reduce((s, r) => s + Number(r.committed_value), 0);
  const byCat = useMemo(() => {
    const m = new Map<string, CostControlRow[]>();
    for (const r of data?.cc ?? []) { const k = r.category ?? '(no category)'; m.set(k, [...(m.get(k) ?? []), r]); }
    return [...m.entries()].map(([k, v]) => agg(k, k, v)).sort((a, b) => b.budget - a.budget);
  }, [data]);
  const byBoq = useMemo(() => {
    const m = new Map<string, CostControlRow[]>();
    for (const r of data?.cc ?? []) if (r.boq_item_id) m.set(r.boq_item_id, [...(m.get(r.boq_item_id) ?? []), r]);
    return [...m.entries()].map(([k, v]) => agg(k, `${v[0].boq_item_no ?? ''} ${v[0].description ?? ''}`.trim(), v)).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]);

  if (!auth.canSeePrices) return <Page title="Cost control"><Empty title="Prices are restricted">Cost control shows money values — your role can't see prices.</Empty></Page>;
  const canEdit = canProcure(auth.profile?.role, 'budget.edit');
  const pctUsed = total.budget ? (100 * total.issued) / total.budget : 0;
  const unbudgeted = Math.max(0, openCommit - total.committed);

  const aggColumns = (first: string): Column<Agg>[] => [
    { key: 'label', label: first, id: true },
    { key: 'budget', label: 'Budget', align: 'right', render: (r) => money(r.budget, cur) },
    { key: 'committed', label: 'Committed', align: 'right', render: (r) => money(r.committed, cur) },
    { key: 'received', label: 'Received into stock', align: 'right', render: (r) => money(r.received, cur) },
    { key: 'issued', label: 'Used (actual)', align: 'right', render: (r) => <strong>{money(r.issued, cur)}</strong> },
    { key: 'remaining', label: 'Remaining', align: 'right', render: (r) => <span className={r.remaining < 0 ? 'danger-text strong' : ''}>{money(r.remaining, cur)}</span> },
    { key: 'pct', label: 'Used', render: (r) => (r.pct === null ? '—' : <Bar pct={r.pct} tone={r.pct > 85 ? 'warn' : undefined} />) },
  ];

  return (
    <Page width="dash" title="Cost control" subtitle="Ex-VAT · materials are cost when used (issued to work, wasted or lost) at moving average cost · received stock is inventory · open POs are commitments · remaining = budget − used">
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <div className="kpis">
        <Kpi label="Budget" value={money(total.budget, cur)} loading={!data} />
        <Kpi label="Committed (open POs)" value={money(total.committed, cur)} loading={!data} hint={unbudgeted > 0 ? `${money(unbudgeted, cur)} outside budget lines` : undefined} />
        <Kpi label="Received into stock" value={money(total.received, cur)} loading={!data} />
        <Kpi label="Used — actual cost" value={money(total.issued, cur)} loading={!data} />
        <Kpi label="Inventory on hand" value={money(data?.inventory ?? 0, cur)} loading={!data} hint="not yet cost" />
        <Kpi label="Remaining" value={money(total.remaining, cur)} loading={!data} status={total.remaining < 0 ? 'danger' : pctUsed > 85 ? 'warning' : undefined} hint={total.budget ? `${num(pctUsed, 1)}% used` : undefined} />
      </div>
      <Tabs label="Cost control" value={tab} onChange={setTab} tabs={[
        { key: 'lines', label: 'Budget lines', count: data?.cc.length },
        { key: 'category', label: 'By category' },
        { key: 'boq', label: 'By BoQ item' },
        { key: 'materials', label: 'Material actuals' },
        { key: 'inventory', label: 'Inventory' },
        { key: 'commitments', label: 'Open commitments', count: data?.committed.length },
        { key: 'budget', label: 'Edit budget' },
      ] as { key: Tab; label: string; count?: number }[]} />
      {data && !data.cc.length && ['lines', 'category', 'boq'].includes(tab) && <Banner tone="info" action={<span className="row">{canEdit && <button className="small" onClick={() => setTab('budget')}>Add budget lines</button>}<button className="small" onClick={() => setTab('materials')}>See material actuals</button></span>}>No budget lines yet — add them per BoQ item, material or category to compare. Material actuals and inventory are shown without a budget.</Banner>}
      {tab === 'lines' && (
        <DataTable rows={data?.cc ?? []} rowKey={(r) => r.budget_line_id} loading={!data} error={q.error} onRetry={q.reload} urlKey="" viewKey="cost-lines" exportName="cost-control" stickyFirst
          onRowClick={(r) => setDrill(agg(r.budget_line_id, r.description ?? r.label ?? r.category ?? '', [r]))} empty={{ title: 'No budget lines' }}
          rowClass={(r) => (Number(r.remaining) < 0 ? 'row-error' : Number(r.pct_used ?? 0) > 85 ? 'row-warn' : undefined)}
          columns={[
            { key: 'description', label: 'Budget line', id: true, value: (r) => r.description ?? r.label ?? r.category },
            { key: 'scope', label: 'Scope', value: (r) => (r.scope === 'boq_item' ? `BoQ ${r.boq_item_no ?? ''}${r.label ? ` · ${r.label}` : ''}` : r.scope === 'material' ? r.label : `Category ${r.category}`) },
            { key: 'category', label: 'Category', hidden: true },
            { key: 'budget_qty', label: 'Budget qty', align: 'right', hidden: true, render: (r) => qty(r.budget_qty) },
            { key: 'budget_rate', label: 'Rate', align: 'right', hidden: true, render: (r) => money(r.budget_rate, cur) },
            { key: 'budget_amount', label: 'Budget', align: 'right', render: (r) => money(r.budget_amount, cur) },
            { key: 'committed', label: 'Committed', align: 'right', render: (r) => money(r.committed, cur) },
            { key: 'received', label: 'Received into stock', align: 'right', render: (r) => money(r.received, cur) },
            { key: 'issued', label: 'Used (actual)', align: 'right', render: (r) => <strong>{money(r.issued, cur)}</strong> },
            { key: 'remaining', label: 'Remaining', align: 'right', render: (r) => <span className={Number(r.remaining) < 0 ? 'danger-text strong' : ''}>{money(r.remaining, cur)}</span> },
            { key: 'remaining_uncommitted', label: 'Free to buy', align: 'right', hidden: true, render: (r) => <span className={Number(r.remaining_uncommitted) < 0 ? 'warn-text' : ''}>{money(r.remaining_uncommitted, cur)}</span> },
            { key: 'pct_used', label: 'Used', render: (r) => (r.pct_used === null ? '—' : <Bar pct={Number(r.pct_used)} tone={Number(r.pct_used) > 85 ? 'warn' : undefined} />) },
          ]} />
      )}
      {tab === 'category' && <DataTable rows={byCat} rowKey={(r) => r.key} loading={!data} exportName="cost-by-category" onRowClick={setDrill} columns={aggColumns('Category')} empty="No budget lines." maxHeight="none" />}
      {tab === 'boq' && <DataTable rows={byBoq} rowKey={(r) => r.key} loading={!data} exportName="cost-by-boq" onRowClick={setDrill} columns={aggColumns('BoQ item')} empty="No BoQ-scoped budget lines." maxHeight="none" />}
      {tab === 'materials' && <MaterialActuals projectId={projectId} cur={cur} />}
      {tab === 'inventory' && <InventoryValue projectId={projectId} cur={cur} />}
      {tab === 'commitments' && <Commitments rows={data?.committed} cur={cur} />}
      {tab === 'budget' && lk.data && <BudgetEditor projectId={projectId} L={lk.data} canEdit={canEdit} cur={cur} />}
      {drill && data && <DrillDrawer a={drill} committed={data.committed} cur={cur} tonePct={tone(drill.pct)} onClose={() => setDrill(null)} />}
    </Page>
  );
}

function Commitments({ rows, cur }: { rows: CommittedCostRow[] | undefined; cur: string }) {
  const nav = useNavigate();
  return (
    <DataTable rows={rows ?? []} rowKey={(r) => r.po_line_id} loading={!rows} urlKey="c." exportName="open-commitments" stickyFirst onRowClick={(r) => nav(`/procurement/po/${r.po_id}`)}
      empty={{ title: 'No open commitments', body: 'Approved and sent POs with an outstanding balance appear here.' }} columns={[
        { key: 'po_number', label: 'PO', id: true },
        { key: 'supplier_name', label: 'Supplier' },
        { key: 'label', label: 'Material' },
        { key: 'category', label: 'Category' },
        { key: 'outstanding_qty', label: 'Outstanding', align: 'right', render: (r) => num(r.outstanding_qty, 3) },
        { key: 'unit_price', label: 'Unit price', align: 'right', render: (r) => money(r.unit_price, cur) },
        { key: 'committed_value', label: 'Committed', align: 'right', render: (r) => money(r.committed_value, cur) },
        { key: 'boq', label: 'BoQ linked', value: (r) => (r.boq_item_id ? 'Yes' : '') },
      ]} />
  );
}

function DrillDrawer({ a, committed, cur, tonePct, onClose }: { a: Agg; committed: CommittedCostRow[]; cur: string; tonePct?: string; onClose: () => void }) {
  const nav = useNavigate();
  const match = (c: CommittedCostRow) => a.lines.some((l) => l.scope === 'boq_item'
    ? c.boq_item_id === l.boq_item_id && (!l.material_spec_id || c.material_spec_id === l.material_spec_id)
    : l.scope === 'material' ? c.material_spec_id === l.material_spec_id : c.category === l.category);
  const rows = committed.filter(match);
  return (
    <Drawer size="lg" title={a.label || 'Budget'} subtitle={`${a.lines.length} budget line${a.lines.length === 1 ? '' : 's'}`} onClose={onClose}>
      <div className="stack">
        <dl className="kv">
          <dt>Budget</dt><dd>{money(a.budget, cur)}</dd>
          <dt>Committed</dt><dd>{money(a.committed, cur)}</dd>
          <dt>Received into stock</dt><dd>{money(a.received, cur)}</dd>
          <dt>Used (actual cost)</dt><dd>{money(a.issued, cur)}</dd>
          <dt>Remaining</dt><dd className={a.remaining < 0 ? 'danger-text strong' : ''}>{money(a.remaining, cur)}</dd>
          <dt>Used</dt><dd className={tonePct}>{a.pct === null ? '—' : `${num(a.pct, 1)}%`}</dd>
        </dl>
        <Card title="Open commitments" flush>
          <DataTable rows={rows} rowKey={(r) => r.po_line_id} maxHeight="none" empty="No open PO lines in this scope." onRowClick={(r) => nav(`/procurement/po/${r.po_id}`)} columns={[
            { key: 'po_number', label: 'PO', id: true },
            { key: 'supplier_name', label: 'Supplier' },
            { key: 'label', label: 'Material' },
            { key: 'outstanding_qty', label: 'Outstanding', align: 'right', render: (r) => num(r.outstanding_qty, 3) },
            { key: 'committed_value', label: 'Committed', align: 'right', render: (r) => money(r.committed_value, cur) },
          ]} />
        </Card>
        <p className="muted small-text mb-0">Received = GRNs into stock at PO price; used = issues to work, returns, wastage and count variances at moving average cost. Open the Store register for the documents.</p>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Budget editor (save_budget)
// ---------------------------------------------------------------------------

type Scope = 'boq_item' | 'material' | 'category';
interface Row { id: string; scope: Scope; boq_item_id: string; material_spec_id: string; category: string; description: string; budget_qty: string; budget_rate: string; budget_amount: string; deleted?: boolean; dirty?: boolean }
const fromLine = (b: BudgetLine): Row => ({
  id: b.id, scope: b.boq_item_id ? 'boq_item' : b.material_spec_id ? 'material' : 'category', boq_item_id: b.boq_item_id ?? '', material_spec_id: b.material_spec_id ?? '',
  category: b.category ?? '', description: b.description ?? '', budget_qty: b.budget_qty?.toString() ?? '', budget_rate: b.budget_rate?.toString() ?? '', budget_amount: String(b.budget_amount),
});

function BudgetEditor({ projectId, L, canEdit, cur }: { projectId: string; L: Lookups; canEdit: boolean; cur: string }) {
  const q = useAsync(async () => {
    const [lines, boq] = await Promise.all([
      loadBudgetLines(projectId),
      supabase.from('boq_items').select('*').eq('project_id', projectId).is('deleted_at', null).order('item_no').then(check),
    ]);
    return { lines, boq: boq as BoqItem[] };
  }, [projectId], { key: 'budget-lines' });
  const [rows, setRows] = useState<Row[] | null>(null);
  const { busy, error, run } = useBusy();
  // Server state replaces local rows unless there are unsaved edits.
  useEffect(() => { if (q.data) setRows((cur) => (cur && cur.some((r) => r.dirty || r.deleted) ? cur : q.data!.lines.map(fromLine))); }, [q.data]);
  const categories = useMemo(() => [...new Set(L.specs.map((s) => s.category))].sort(), [L.specs]);
  if (!q.data || !rows) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Card><Empty inline>Loading budget…</Empty></Card>;
  const set = (id: string, patch: Partial<Row>) => setRows(rows.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)));
  const amount = (r: Row) => (r.budget_amount !== '' ? Number(r.budget_amount) : Number(r.budget_qty) * Number(r.budget_rate));
  const changed = rows.filter((r) => r.dirty || r.deleted);
  const visible = rows.filter((r) => !r.deleted);
  const save = () => run(async () => {
    const lines = changed.filter((r) => !(r.deleted && !q.data!.lines.some((l) => l.id === r.id))).map((r, i) => {
      if (r.deleted) return { id: r.id, deleted: true };
      if (r.scope === 'boq_item' && !r.boq_item_id) throw new Error(`Row ${i + 1}: choose a BoQ item`);
      if (r.scope === 'material' && !r.material_spec_id) throw new Error(`Row ${i + 1}: choose a material`);
      if (r.scope === 'category' && !r.category.trim()) throw new Error(`Row ${i + 1}: enter a category`);
      const amt = amount(r);
      if (!Number.isFinite(amt) || amt < 0) throw new Error(`Row ${i + 1}: enter an amount or qty × rate`);
      return {
        id: r.id, boq_item_id: r.scope === 'boq_item' ? r.boq_item_id : undefined,
        material_spec_id: r.scope !== 'category' && r.material_spec_id ? r.material_spec_id : undefined,
        category: r.scope === 'category' ? r.category.trim() : undefined, description: r.description || undefined,
        budget_qty: r.budget_qty ? Number(r.budget_qty) : undefined, budget_rate: r.budget_rate ? Number(r.budget_rate) : undefined, budget_amount: amt,
      };
    });
    await procRpc('save_budget', { project_id: projectId, lines });
    toast.success(`Budget saved (${lines.length} line${lines.length === 1 ? '' : 's'} changed)`);
    setRows(rows.filter((r) => !r.deleted).map((r) => ({ ...r, dirty: false })));
  });
  const totalBudget = visible.reduce((s, r) => s + (Number.isFinite(amount(r)) ? amount(r) : 0), 0);
  return (
    <Card title="Budget lines" sub={`Total ${money(totalBudget, cur)} · scope: BoQ item (optionally one material) › material › category`} flush
      actions={canEdit ? <button className="small" onClick={() => setRows([...rows, { id: crypto.randomUUID(), scope: 'category', boq_item_id: '', material_spec_id: '', category: '', description: '', budget_qty: '', budget_rate: '', budget_amount: '', dirty: true }])}><Plus size={14} aria-hidden />Add line</button> : undefined}>
      <ErrorBanner error={error} />
      {!canEdit && <div className="pad"><Banner tone="info">Only coordinators and managers with price access can edit the budget.</Banner></div>}
      <div className="table-scroll" style={{ maxHeight: 'none' }}><table>
        <thead><tr><th>Scope</th><th>BoQ item / material / category</th><th>Description</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Amount</th><th /></tr></thead>
        <tbody>
          {visible.map((r, i) => (
            <tr key={r.id}>
              <td><select value={r.scope} disabled={!canEdit} onChange={(e) => set(r.id, { scope: e.target.value as Scope })} aria-label={`Row ${i + 1} scope`}>
                <option value="boq_item">BoQ item</option><option value="material">Material</option><option value="category">Category</option></select></td>
              <td>
                {r.scope === 'boq_item' && <select value={r.boq_item_id} disabled={!canEdit} onChange={(e) => set(r.id, { boq_item_id: e.target.value })} aria-label={`Row ${i + 1} BoQ item`}>
                  <option value="">Choose…</option>{q.data!.boq.map((b) => <option key={b.id} value={b.id}>{b.item_no} — {b.description.slice(0, 60)}</option>)}</select>}
                {r.scope !== 'category' && <select value={r.material_spec_id} disabled={!canEdit} onChange={(e) => set(r.id, { material_spec_id: e.target.value })} aria-label={`Row ${i + 1} material`} style={r.scope === 'boq_item' ? { marginTop: 4 } : undefined}>
                  <option value="">{r.scope === 'boq_item' ? 'All materials' : 'Choose…'}</option>{L.specs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>}
                {r.scope === 'category' && <><input list="budget-cats" value={r.category} disabled={!canEdit} onChange={(e) => set(r.id, { category: e.target.value })} aria-label={`Row ${i + 1} category`} /></>}
              </td>
              <td><input value={r.description} disabled={!canEdit} onChange={(e) => set(r.id, { description: e.target.value })} aria-label={`Row ${i + 1} description`} /></td>
              <td className="right"><input type="number" className="num-input" step="any" min={0} value={r.budget_qty} disabled={!canEdit} onChange={(e) => set(r.id, { budget_qty: e.target.value })} aria-label={`Row ${i + 1} quantity`} /></td>
              <td className="right"><input type="number" className="num-input" step="any" min={0} value={r.budget_rate} disabled={!canEdit} onChange={(e) => set(r.id, { budget_rate: e.target.value })} aria-label={`Row ${i + 1} rate`} /></td>
              <td className="right"><input type="number" className="num-input" step="any" min={0} value={r.budget_amount} disabled={!canEdit}
                placeholder={r.budget_qty && r.budget_rate ? num(Number(r.budget_qty) * Number(r.budget_rate), 2) : ''} onChange={(e) => set(r.id, { budget_amount: e.target.value })} aria-label={`Row ${i + 1} amount`} /></td>
              <td>{canEdit && <button className="icon-btn" aria-label={`Delete row ${i + 1}`} onClick={() => setRows(rows.map((x) => (x.id === r.id ? { ...x, deleted: true } : x)))}><Trash2 size={14} /></button>}</td>
            </tr>
          ))}
          {!visible.length && <tr><td colSpan={7} className="muted">No budget lines. {canEdit && 'Add one per BoQ item, material or category.'}</td></tr>}
        </tbody>
      </table></div>
      <datalist id="budget-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      {canEdit && changed.length > 0 && (
        <div className="save-bar">
          <span className="grow">{changed.length} unsaved change{changed.length === 1 ? '' : 's'} · amount defaults to qty × rate</span>
          <button onClick={() => setRows(q.data!.lines.map(fromLine))} disabled={busy}>Discard</button>
          <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save budget</button>
        </div>
      )}
    </Card>
  );
}
