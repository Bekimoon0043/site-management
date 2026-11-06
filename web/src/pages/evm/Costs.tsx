import { useMemo, useState } from 'react';
import { Plus, Sparkles, Undo2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, DEVICE_ID, fetchAll, supabase } from '../../lib/supabase';
import { date, money as fmtMoney, num } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { COST_CATEGORY_LABELS, type CostCategory, type EvmProject } from '../../lib/contract-schedule';
import { Badge, Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, FilterBar, FilterSelect, Modal, Page, QtyInput, ReasonModal, SearchInput, Tabs, toast, useBusy, useHashTab } from '../../components/ui';
import { eatToday, isAm, moneyShort, planRpc, tr, useSchedules } from '../../components/evm/data';
import '../../components/evm/evm.css';

interface CostEntry {
  id: string; number: string; entry_date: string; original_entry_date: string | null; category: CostCategory; task_id: string | null; description: string;
  supplier_id: string | null; subcontractor: string | null; qty: number | null; uom: string | null; rate: number | null; amount: number;
  source: string; source_ref: string | null; is_estimate: boolean; reversal_of: string | null; created_by: string | null; created_at: string;
}
interface Usage { id: string; usage_date: string; kind: 'labour' | 'equipment' | 'subcontract'; task_id: string | null; trade_id: string | null; equipment: string | null; subcontractor: string | null; qty: number; uom: string; diary_id: string | null; remarks: string | null; created_by: string | null }
interface Rate { id: string; project_id: string | null; kind: 'labour' | 'equipment' | 'subcontract'; trade_id: string | null; equipment: string | null; subcontractor: string | null; uom: string; rate: number; valid_from: string }
interface TaskOpt { id: string; wbs: string | null; name: string; is_summary: boolean }
interface Trade { id: string; name: string; name_am: string | null }

const TABS = ['entries', 'usage', 'rates', 'coverage'] as const;
const KINDS = ['labour', 'equipment', 'subcontract'] as const;
const catLabel = (c: string) => tr(COST_CATEGORY_LABELS[c as CostCategory]?.en ?? c, COST_CATEGORY_LABELS[c as CostCategory]?.am);
const docNo = (code: string) => `${code}-CE-W${DEVICE_ID.replace(/-/g, '').slice(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

/** Actual cost for EVM: cost entries (labour, equipment, subcontract, overhead), resource usage, rates, diary-hour estimates. Price roles only. */
export function Costs() {
  const projectId = useProjectId();
  const auth = useAuth();
  const currency = auth.project?.currency ?? 'ETB';
  const code = auth.project?.code ?? 'PRJ';
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const [tab, setTab] = useHashTab(TABS, 'entries');
  const [f, setF, { active, clear }] = useUrlFilters({ cat: '', q: '' }, 'c');
  const [newEntry, setNewEntry] = useState(false);
  const [newUsage, setNewUsage] = useState(false);
  const [rateEdit, setRateEdit] = useState<Rate | 'new' | null>(null);
  const [reverse, setReverse] = useState<CostEntry | null>(null);
  const [estimating, setEstimating] = useState(false);
  const canRecord = !!role && ['coordinator', 'manager', 'procurement', 'admin', 'office_engineer'].includes(role);
  const canRates = !!role && ['coordinator', 'manager', 'procurement', 'admin'].includes(role);
  const canUsage = !!role && ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'].includes(role);
  const sch = useSchedules(projectId);
  const schedule = sch.data?.[0];

  const q = useAsync(async () => {
    const [entries, usage, rates, trades, tasks] = await Promise.all([
      fetchAll<CostEntry>((a, b) => supabase.from('cost_entries').select('*').eq('project_id', projectId).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).range(a, b)),
      fetchAll<Usage>((a, b) => supabase.from('resource_usage').select('*').eq('project_id', projectId).order('usage_date', { ascending: false }).range(a, b)),
      supabase.from('cost_rates').select('*').or(`project_id.eq.${projectId},project_id.is.null`).order('valid_from', { ascending: false }).then(check) as Promise<Rate[]>,
      supabase.from('labour_trades').select('id, name, name_am').is('deleted_at', null).order('sort_order').then(check) as Promise<Trade[]>,
      fetchAll<TaskOpt>((a, b) => supabase.from('schedule_tasks').select('id, wbs, name, is_summary').eq('project_id', projectId).is('deleted_at', null).order('sort_order').range(a, b)),
    ]);
    return { entries, usage, rates, trades, tasks };
  }, [projectId], { key: 'costs' });
  const pj = useAsync(async () => (schedule ? check(await supabase.from('v_evm_project').select('*').eq('schedule_id', schedule.id).maybeSingle()) as EvmProject | null : null),
    [schedule?.id], { key: 'costs-evm-project', enabled: !!schedule });

  const d = q.data;
  const taskName = useMemo(() => new Map((d?.tasks ?? []).map((t) => [t.id, `${t.wbs ? `${t.wbs} ` : ''}${t.name}`])), [d?.tasks]);
  const tradeName = useMemo(() => new Map((d?.trades ?? []).map((t) => [t.id, tr(t.name, t.name_am)])), [d?.trades]);
  const reversed = new Set((d?.entries ?? []).filter((e) => e.reversal_of).map((e) => e.reversal_of!));
  const entries = (d?.entries ?? []).filter((e) => (!f.cat || e.category === f.cat) && (!f.q || `${e.number} ${e.description} ${e.subcontractor ?? ''}`.toLowerCase().includes(f.q.toLowerCase())));
  const estimated = new Set((d?.entries ?? []).filter((e) => e.source_ref?.startsWith('usage:')).map((e) => e.source_ref!.slice(6)));
  const unestimated = (d?.usage ?? []).filter((u) => !estimated.has(u.id));

  // Coverage: by category per month (last 6 months) + allocation to tasks.
  const months = useMemo(() => {
    const out: string[] = [];
    const t = new Date(`${eatToday().slice(0, 7)}-01T00:00:00Z`);
    for (let i = 5; i >= 0; i--) out.push(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    return out;
  }, []);
  const cov = (['labour', 'equipment', 'subcontract', 'overhead', 'material_direct', 'other'] as CostCategory[]).map((c) => {
    const row: Record<string, number | string> = { category: c };
    for (const m of months) row[m] = (d?.entries ?? []).filter((e) => e.category === c && e.entry_date.startsWith(m)).reduce((s, e) => s + Number(e.amount), 0);
    return row;
  });

  const actions = tab === 'entries' && canRecord ? <button className="primary" onClick={() => setNewEntry(true)}><Plus size={14} aria-hidden />{tr('Record cost', 'ወጪ መዝግብ')}</button>
    : tab === 'usage' && canUsage ? <button className="primary" onClick={() => setNewUsage(true)}><Plus size={14} aria-hidden />{tr('Record usage', 'አጠቃቀም መዝግብ')}</button>
      : tab === 'rates' && canRates ? <button className="primary" onClick={() => setRateEdit('new')}><Plus size={14} aria-hidden />{tr('New rate', 'አዲስ ዋጋ')}</button> : null;

  if (!auth.canSeePrices) return <Page title={tr('Actual costs', 'ትክክለኛ ወጪ')}><Empty title="No access">Costs are visible to price roles only.</Empty></Page>;

  return (
    <Page title={tr('Actual costs', 'ትክክለኛ ወጪ')} breadcrumbs={[{ label: tr('Earned value', 'የተገኘ እሴት'), to: '/evm' }, { label: tr('Costs', 'ወጪዎች') }]}
      subtitle="Labour, equipment, subcontract and overhead costs feed actual cost (AC). Materials count when used (issues − returns + wastage and stock-count differences) at moving average cost — purchases and stock on hand are not actual cost."
      actions={<>{canRates && <button onClick={() => setEstimating(true)}><Sparkles size={14} aria-hidden />{tr('Estimate from site diary hours', 'ከሳይት ማስታወሻ ሰዓት ግምት')}</button>}{actions}</>}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'entries', label: tr('Cost entries', 'የወጪ መዝገብ'), count: d?.entries.length },
        { key: 'usage', label: tr('Resource usage', 'የሀብት አጠቃቀም'), count: d?.usage.length },
        { key: 'rates', label: tr('Cost rates', 'የወጪ ተመን'), count: d?.rates.length },
        { key: 'coverage', label: tr('Coverage', 'ሽፋን'), count: unestimated.length || undefined, hot: unestimated.length > 0 },
      ]} />
      <ErrorBanner error={q.error} onRetry={q.reload} />

      {tab === 'entries' && (
        <>
          <FilterBar active={active} onClear={clear}>
            <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Number, description…" />
            <FilterSelect label="Category" value={f.cat} onChange={(v) => setF('cat', v)} options={Object.keys(COST_CATEGORY_LABELS).map((c) => ({ value: c, label: catLabel(c) }))} />
          </FilterBar>
          <DataTable rows={entries} loading={!d} rowKey={(r) => r.id} filtered={active > 0} onClearFilters={clear} exportName="cost-entries" stickyFirst
            empty={{ title: 'No cost entries yet', body: 'Record payroll, plant hire, subcontract certificates and site overhead here.' }}
            footer={entries.length ? <tr><td colSpan={99} className="strong">Total {fmtMoney(entries.reduce((s, e) => s + Number(e.amount), 0), currency)}</td></tr> : undefined}
            columns={[
              { key: 'number', label: 'No.', id: true },
              { key: 'entry_date', label: tr('Date', 'ቀን'), render: (r) => <>{date(r.entry_date)}{r.original_entry_date && <div className="muted xs-text">work {date(r.original_entry_date)} (rolled past closed period)</div>}</> },
              { key: 'category', label: tr('Category', 'ዓይነት'), render: (r) => catLabel(r.category) },
              { key: 'description', label: tr('Description', 'መግለጫ'), render: (r) => <>{r.description}{r.subcontractor ? <span className="muted"> · {r.subcontractor}</span> : null}</> },
              { key: 'task_id', label: tr('Task', 'ሥራ'), render: (r) => (r.task_id ? taskName.get(r.task_id) ?? '?' : <span className="muted">project level</span>), value: (r) => (r.task_id ? taskName.get(r.task_id) : '') },
              { key: 'qty', label: tr('Qty', 'መጠን'), align: 'right', render: (r) => (r.qty != null ? `${num(r.qty)} ${r.uom ?? ''}` : '') },
              { key: 'rate', label: tr('Rate', 'ተመን'), align: 'right', render: (r) => (r.rate != null ? num(r.rate) : '') },
              { key: 'amount', label: tr('Amount', 'መጠን (ብር)'), align: 'right', render: (r) => <span className={Number(r.amount) < 0 ? 'danger-text' : ''}>{fmtMoney(r.amount, currency)}</span> },
              { key: 'flags', label: '', sortable: false, noExport: true, render: (r) => <span className="row nowrap">
                {r.is_estimate && <Badge tone="violet" label="Estimate" icon={null} outline />}
                {r.reversal_of && <Badge value="reversed" label="Reversal" />}
                {reversed.has(r.id) && <Badge tone="neutral" label="Reversed" icon={null} />}
                {canRecord && !r.reversal_of && !reversed.has(r.id) && <button className="small ghost" onClick={() => setReverse(r)} title="Reverse with a reason"><Undo2 size={12} aria-hidden />Reverse</button>}
              </span> },
            ]} />
        </>
      )}

      {tab === 'usage' && (
        <DataTable rows={d?.usage ?? []} loading={!d} rowKey={(r) => r.id} exportName="resource-usage"
          empty={{ title: 'No resource usage yet', body: 'Man-hours and machine-hours from the site diary appear here; rates turn them into estimated cost.' }}
          columns={[
            { key: 'usage_date', label: tr('Date', 'ቀን'), render: (r) => date(r.usage_date) },
            { key: 'kind', label: tr('Kind', 'ዓይነት'), render: (r) => catLabel(r.kind) },
            { key: 'what', label: tr('Trade / equipment', 'ሙያ / መሣሪያ'), value: (r) => (r.trade_id ? tradeName.get(r.trade_id) : r.equipment ?? r.subcontractor), render: (r) => (r.trade_id ? tradeName.get(r.trade_id) ?? '?' : r.equipment ?? r.subcontractor ?? '') },
            { key: 'task_id', label: tr('Task', 'ሥራ'), render: (r) => (r.task_id ? taskName.get(r.task_id) ?? '?' : '') },
            { key: 'qty', label: tr('Qty', 'መጠን'), align: 'right', render: (r) => `${num(r.qty)} ${r.uom}` },
            { key: 'est', label: tr('Costed', 'ተገምቷል'), render: (r) => (estimated.has(r.id) ? <Badge tone="success" label="Estimated" /> : <Badge tone="neutral" label="Not costed" icon={null} />) },
            { key: 'remarks', label: tr('Remarks', 'ማስታወሻ'), render: (r) => r.remarks ?? (r.diary_id ? 'from site diary' : '') },
          ]} />
      )}

      {tab === 'rates' && (
        <DataTable rows={d?.rates ?? []} loading={!d} rowKey={(r) => r.id} exportName="cost-rates" onRowClick={canRates ? (r) => setRateEdit(r) : undefined}
          empty={{ title: 'No cost rates yet', body: 'Add a rate per trade (birr / man-hour) or per machine (birr / hour) to estimate cost from site diary hours.' }}
          columns={[
            { key: 'kind', label: tr('Kind', 'ዓይነት'), render: (r) => catLabel(r.kind) },
            { key: 'what', label: tr('Trade / equipment', 'ሙያ / መሣሪያ'), render: (r) => (r.trade_id ? tradeName.get(r.trade_id) ?? '?' : r.equipment ?? r.subcontractor ?? <span className="muted">any</span>) },
            { key: 'rate', label: tr('Rate', 'ተመን'), align: 'right', render: (r) => `${fmtMoney(r.rate, currency)} / ${r.uom}` },
            { key: 'valid_from', label: tr('Valid from', 'ከ'), render: (r) => date(r.valid_from) },
            { key: 'project_id', label: tr('Scope', 'ወሰን'), render: (r) => (r.project_id ? 'This project' : 'Company-wide') },
          ]} />
      )}

      {tab === 'coverage' && (
        <div className="stack">
          <div className="grid-2">
            <Card title={tr('Cost linked to schedule tasks', 'ከሥራዎች ጋር የተያያዘ ወጪ')}>
              {!pj.data ? <p className="muted mb-0">{schedule ? 'No earned value yet (needs an approved baseline).' : 'No schedule yet.'}</p> : (
                <div className="stack tight">
                  <div className={`cov-bar${Number(pj.data.ac_coverage_pct ?? 0) < 80 ? ' warn' : ''}`} role="img" aria-label={`${num(pj.data.ac_coverage_pct, 0)} %`}><span style={{ width: `${Math.min(100, Number(pj.data.ac_coverage_pct ?? 0))}%` }} /></div>
                  <p className="mb-0"><strong>{num(pj.data.ac_coverage_pct ?? 0, 0)} %</strong> of actual cost ({moneyShort(pj.data.ac, currency)}) is allocated to tasks; {moneyShort(pj.data.ac_unallocated, currency)} counts at project level only.</p>
                  <p className="muted small-text mb-0">Cost basis: {pj.data.cost_basis === 'materials' ? 'materials only' : 'full (materials + labour, equipment, subcontract, overhead)'} · status date {date(pj.data.status_date)}</p>
                  {Number(pj.data.ac_coverage_pct ?? 0) < 80 && <Banner tone="warn">Link cost entries to a task (or WBS summary) so task and WBS CPI are meaningful.</Banner>}
                </div>
              )}
            </Card>
            <Card title={tr('Usage not yet costed', 'ያልተገመተ አጠቃቀም')}>
              <p className="mb-0"><strong>{unestimated.length}</strong> usage record{unestimated.length === 1 ? '' : 's'} ({num(unestimated.reduce((s, u) => s + Number(u.qty), 0), 0)} hours) have no cost yet.</p>
              <p className="muted small-text">Usage without a matching rate stays uncosted. Add rates, then run the estimate. Estimates are flagged and replaced by real costs when they arrive.</p>
              {canRates && <button onClick={() => setEstimating(true)} disabled={!unestimated.length}><Sparkles size={14} aria-hidden />Estimate from site diary hours</button>}
            </Card>
          </div>
          <Card flush title={tr('Costs recorded by month', 'በወር የተመዘገበ ወጪ')} sub="An empty month usually means costs were not imported yet">
            <DataTable rows={cov} rowKey={(r) => String(r.category)} maxHeight="none" exportName="cost-coverage" columns={[
              { key: 'category', label: tr('Category', 'ዓይነት'), render: (r) => catLabel(String(r.category)) },
              ...months.map((m) => ({ key: m, label: m, align: 'right' as const, render: (r: Record<string, number | string>) => (Number(r[m]) ? moneyShort(r[m], '') : <span className="warn-text">—</span>) })),
            ]} />
          </Card>
        </div>
      )}

      {newEntry && d && <CostEntryDrawer projectId={projectId} code={code} currency={currency} tasks={d.tasks} suppliers={lk.data?.suppliers ?? []} onClose={() => setNewEntry(false)} />}
      {newUsage && d && <UsageDrawer projectId={projectId} tasks={d.tasks} trades={d.trades} onClose={() => setNewUsage(false)} />}
      {rateEdit && d && <RateModal projectId={projectId} rate={rateEdit === 'new' ? null : rateEdit} trades={d.trades} onClose={() => setRateEdit(null)} />}
      {reverse && (
        <ReasonModal title={`Reverse ${reverse.number}?`} danger confirm="Reverse" onClose={() => setReverse(null)}
          onSubmit={async (reason) => {
            await planRpc('reverse_cost_entry', { id: crypto.randomUUID(), number: `${reverse.number}-R`, reversal_of: reverse.id, reason });
            toast.success(`${reverse.number} reversed`);
          }}>
          <p className="muted small-text mb-0">A negative entry of {fmtMoney(-reverse.amount, currency)} is posted (in the next open period if this one is closed).</p>
        </ReasonModal>
      )}
      {estimating && <EstimateModal projectId={projectId} pending={unestimated.length} onClose={() => setEstimating(false)} />}
    </Page>
  );
}

function TaskSelect({ tasks, value, onChange }: { tasks: TaskOpt[]; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Project level (no task)</option>
      {tasks.map((t) => <option key={t.id} value={t.id}>{t.is_summary ? '▸ ' : '   '}{t.wbs ? `${t.wbs} ` : ''}{t.name}</option>)}
    </select>
  );
}

function CostEntryDrawer({ projectId, code, currency, tasks, suppliers, onClose }: {
  projectId: string; code: string; currency: string; tasks: TaskOpt[]; suppliers: { id: string; name: string }[]; onClose: () => void;
}) {
  const [f, setF] = useState({ entry_date: eatToday(), category: 'labour' as CostCategory, description: '', task_id: '', supplier_id: '', subcontractor: '', qty: '', uom: '', rate: '', amount: '', is_estimate: false, source_ref: '' });
  const { busy, error, run } = useBusy();
  const calc = f.qty && f.rate ? Math.round(Number(f.qty) * Number(f.rate) * 100) / 100 : null;
  const amount = f.amount ? Number(f.amount) : calc;
  const save = () => run(async () => {
    const number = docNo(code);
    const r = await planRpc('record_actual_cost', {
      id: crypto.randomUUID(), project_id: projectId, number, entry_date: f.entry_date, category: f.category, description: f.description.trim(),
      task_id: f.task_id || undefined, supplier_id: f.supplier_id || undefined, subcontractor: f.subcontractor.trim() || undefined,
      qty: f.qty ? Number(f.qty) : undefined, uom: f.uom.trim() || undefined, rate: f.rate ? Number(f.rate) : undefined,
      amount: f.amount ? Number(f.amount) : undefined, is_estimate: f.is_estimate, source: 'manual', source_ref: f.source_ref.trim() || undefined,
    });
    toast.success(r.rolled_to_next_period ? `${number} recorded — dated ${date(String(r.entry_date))} because that period is closed` : `${number} recorded`);
    onClose();
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  return (
    <Drawer title={isAm() ? 'ወጪ መዝግብ' : 'Record actual cost'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !f.description.trim() || amount == null} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Work date" required hint="The day the work was done (not the invoice date)"><input type="date" value={f.entry_date} max={eatToday()} onChange={(e) => set('entry_date', e.target.value)} /></Field>
        <Field label="Category" required><select value={f.category} onChange={(e) => set('category', e.target.value as CostCategory)}>
          {Object.keys(COST_CATEGORY_LABELS).map((c) => <option key={c} value={c}>{catLabel(c)}</option>)}
        </select></Field>
        <Field label="Description" required wide><input value={f.description} data-autofocus onChange={(e) => set('description', e.target.value)} placeholder="e.g. Steel fixers payroll, week 44" /></Field>
        <Field label="Task / WBS" wide hint="Link to a task so task-level CPI is meaningful"><TaskSelect tasks={tasks} value={f.task_id} onChange={(v) => set('task_id', v)} /></Field>
        {f.category === 'subcontract'
          ? <Field label="Subcontractor"><input value={f.subcontractor} onChange={(e) => set('subcontractor', e.target.value)} /></Field>
          : <Field label="Supplier"><select value={f.supplier_id} onChange={(e) => set('supplier_id', e.target.value)}><option value="">—</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
        <Field label="Reference"><input value={f.source_ref} onChange={(e) => set('source_ref', e.target.value)} placeholder="Invoice / payroll no." /></Field>
        <Field label="Quantity"><QtyInput value={f.qty} onChange={(v) => set('qty', v)} unit={f.uom || undefined} /></Field>
        <Field label="Unit"><input value={f.uom} onChange={(e) => set('uom', e.target.value)} placeholder="man-hour, hr, m³…" /></Field>
        <Field label="Rate"><QtyInput value={f.rate} onChange={(v) => set('rate', v)} unit={currency} /></Field>
        <Field label="Amount (ex-VAT)" hint={calc != null && !f.amount ? `= ${fmtMoney(calc, currency)} from qty × rate` : undefined}><QtyInput value={f.amount} onChange={(v) => set('amount', v)} unit={currency} width={160} /></Field>
        <Field label="This is an estimate (accrual)" check><input type="checkbox" checked={f.is_estimate} onChange={(e) => set('is_estimate', e.target.checked)} /></Field>
      </div>
    </Drawer>
  );
}

function UsageDrawer({ projectId, tasks, trades, onClose }: { projectId: string; tasks: TaskOpt[]; trades: Trade[]; onClose: () => void }) {
  const [f, setF] = useState({ usage_date: eatToday(), kind: 'labour' as Usage['kind'], trade_id: '', equipment: '', subcontractor: '', task_id: '', qty: '', uom: 'man-hour', remarks: '' });
  const { busy, error, run } = useBusy();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const save = () => run(async () => {
    await planRpc('record_resource_usage', { id: crypto.randomUUID(), project_id: projectId, usage_date: f.usage_date, kind: f.kind, task_id: f.task_id || undefined,
      trade_id: f.kind === 'labour' ? f.trade_id || undefined : undefined, equipment: f.kind === 'equipment' ? f.equipment.trim() || undefined : undefined,
      subcontractor: f.kind === 'subcontract' ? f.subcontractor.trim() || undefined : undefined, qty: Number(f.qty), uom: f.uom.trim(), remarks: f.remarks.trim() || undefined });
    toast.success('Usage recorded');
    onClose();
  });
  return (
    <Drawer title="Record resource usage" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !(Number(f.qty) > 0) || !f.uom.trim()} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Date" required><input type="date" value={f.usage_date} onChange={(e) => set('usage_date', e.target.value)} /></Field>
        <Field label="Kind" required><select value={f.kind} onChange={(e) => { const k = e.target.value as Usage['kind']; setF({ ...f, kind: k, uom: k === 'labour' ? 'man-hour' : k === 'equipment' ? 'hr' : f.uom }); }}>
          {KINDS.map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}
        </select></Field>
        {f.kind === 'labour' && <Field label="Trade"><select value={f.trade_id} onChange={(e) => set('trade_id', e.target.value)}><option value="">—</option>{trades.map((t) => <option key={t.id} value={t.id}>{tr(t.name, t.name_am)}</option>)}</select></Field>}
        {f.kind === 'equipment' && <Field label="Equipment"><input value={f.equipment} onChange={(e) => set('equipment', e.target.value)} placeholder="Excavator, mixer…" /></Field>}
        {f.kind === 'subcontract' && <Field label="Subcontractor"><input value={f.subcontractor} onChange={(e) => set('subcontractor', e.target.value)} /></Field>}
        <Field label="Task / WBS" wide><TaskSelect tasks={tasks} value={f.task_id} onChange={(v) => set('task_id', v)} /></Field>
        <Field label="Quantity" required><QtyInput value={f.qty} onChange={(v) => set('qty', v)} unit={f.uom} /></Field>
        <Field label="Unit" required><input value={f.uom} onChange={(e) => set('uom', e.target.value)} /></Field>
        <Field label="Remarks" wide><input value={f.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>
    </Drawer>
  );
}

function RateModal({ projectId, rate, trades, onClose }: { projectId: string; rate: Rate | null; trades: Trade[]; onClose: () => void }) {
  const [f, setF] = useState({ kind: rate?.kind ?? 'labour', trade_id: rate?.trade_id ?? '', equipment: rate?.equipment ?? '', subcontractor: rate?.subcontractor ?? '',
    uom: rate?.uom ?? 'man-hour', rate: rate ? String(rate.rate) : '', valid_from: rate?.valid_from ?? eatToday(), company: rate ? !rate.project_id : false });
  const { busy, error, run } = useBusy();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const save = () => run(async () => {
    await planRpc('save_cost_rate', { id: rate?.id ?? crypto.randomUUID(), project_id: f.company ? undefined : projectId, kind: f.kind as Rate['kind'],
      trade_id: f.kind === 'labour' ? f.trade_id || undefined : undefined, equipment: f.kind === 'equipment' ? f.equipment.trim() || undefined : undefined,
      subcontractor: f.kind === 'subcontract' ? f.subcontractor.trim() || undefined : undefined, uom: f.uom.trim(), rate: Number(f.rate), valid_from: f.valid_from });
    toast.success('Rate saved');
    onClose();
  });
  return (
    <Modal title={rate ? 'Edit cost rate' : 'New cost rate'} onClose={onClose} size="md" footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !(Number(f.rate) >= 0) || !f.rate || !f.uom.trim()} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Kind"><select value={f.kind} disabled={!!rate} onChange={(e) => set('kind', e.target.value as Rate['kind'])}>{KINDS.map((k) => <option key={k} value={k}>{catLabel(k)}</option>)}</select></Field>
        {f.kind === 'labour' && <Field label="Trade" hint="Blank = any trade"><select value={f.trade_id} disabled={!!rate} onChange={(e) => set('trade_id', e.target.value)}><option value="">Any</option>{trades.map((t) => <option key={t.id} value={t.id}>{tr(t.name, t.name_am)}</option>)}</select></Field>}
        {f.kind === 'equipment' && <Field label="Equipment" hint="Blank = any"><input value={f.equipment} disabled={!!rate} onChange={(e) => set('equipment', e.target.value)} /></Field>}
        {f.kind === 'subcontract' && <Field label="Subcontractor" hint="Blank = any"><input value={f.subcontractor} disabled={!!rate} onChange={(e) => set('subcontractor', e.target.value)} /></Field>}
        <Field label="Unit" required><input value={f.uom} onChange={(e) => set('uom', e.target.value)} /></Field>
        <Field label="Rate (ex-VAT)" required><QtyInput value={f.rate} onChange={(v) => set('rate', v)} /></Field>
        <Field label="Valid from" required><input type="date" value={f.valid_from} onChange={(e) => set('valid_from', e.target.value)} /></Field>
        <Field label="Company-wide (all projects)" check><input type="checkbox" checked={f.company} disabled={!!rate} onChange={(e) => set('company', e.target.checked)} /></Field>
      </div>
    </Modal>
  );
}

function EstimateModal({ projectId, pending, onClose }: { projectId: string; pending: number; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(eatToday());
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    const r = await planRpc('estimate_costs_from_usage', { project_id: projectId, from: from || undefined, to: to || undefined });
    const n = Number(r.created ?? 0);
    toast.success(n ? `${n} estimated cost entr${n === 1 ? 'y' : 'ies'} created` : 'Nothing to estimate — check that rates exist for the units used');
    onClose();
  });
  return (
    <Modal title="Estimate cost from site diary hours" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Create estimates</button>
    </>}>
      <ErrorBanner error={error} />
      <p className="muted small-text">{pending} usage record{pending === 1 ? '' : 's'} have no cost yet. Each one with a matching rate becomes an estimated cost entry (hours × rate). Closed periods are skipped.</p>
      <div className="form-grid">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
