// Resources (MS Project resource sheet / assignments / resource usage) for the Schedule page and the task drawer.
import { useMemo, useState } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import { money, num } from '../../lib/format';
import {
  RESOURCE_KIND_LABELS, type ResourceKind, type ResourceUsage, type ScheduleResource, type TaskAssignment,
} from '../../lib/contract-schedule-edit';
import { Badge, Banner, Card, DataTable, Empty, ErrorBanner, Field, Loading, Modal, useBusy } from '../ui';
import { d2, type SchedHeader, type SchedTask } from './data';
import { editRpc, loadAssignments, loadResourceRates, loadResources, loadTaskCosts, loadTrades } from './editing';

const KINDS = Object.keys(RESOURCE_KIND_LABELS) as ResourceKind[];
const unitHint = (k: ResourceKind) => (k === 'material' ? 'Quantity unit, e.g. m3, kg, pcs' : k === 'equipment' ? 'e.g. machine-day' : 'e.g. man-day');

// ---------------------------------------------------------------------------
// Resource sheet
// ---------------------------------------------------------------------------
export function ResourceSheet({ projectId, L, canEdit }: { projectId: string; L: Lookups; canEdit: boolean }) {
  const auth = useAuth();
  const q = useAsync(() => loadResources(projectId), [projectId], { key: 'sched-resources' });
  const rq = useAsync(() => loadResourceRates(projectId), [projectId], { key: 'sched-resource-rates', enabled: auth.canSeePrices });
  const [edit, setEdit] = useState<ScheduleResource | 'new' | null>(null);
  const rates = useMemo(() => new Map((rq.data ?? []).map((r) => [r.resource_id, r])), [rq.data]);
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={6} />;
  return (
    <Card title="Resource sheet" sub="Labour trades, crews, equipment and materials the plan needs. Max units = how many are available per day."
      actions={canEdit ? <button className="small primary" onClick={() => setEdit('new')}><Plus size={14} />Resource</button> : undefined} flush>
      {!q.data.length ? <div className="pad"><Empty inline title="No resources yet">Add the crews and machines you plan with, then assign them to tasks (task drawer › Resources).</Empty></div> : (
        <DataTable rows={q.data} rowKey={(r) => r.id} maxHeight="60vh" onRowClick={canEdit ? (r) => setEdit(r) : undefined} exportName="resources"
          columns={[
            { key: 'code', label: 'Code', id: true },
            { key: 'name', label: 'Name' },
            { key: 'kind', label: 'Type', value: (r) => RESOURCE_KIND_LABELS[r.kind] },
            { key: 'unit', label: 'Unit' },
            { key: 'max_units', label: 'Max units', align: 'right', value: (r) => (r.kind === 'material' ? null : Number(r.max_units)), render: (r) => (r.kind === 'material' ? '—' : num(r.max_units, 1)) },
            ...(auth.canSeePrices ? [
              { key: 'rate', label: 'Standard rate', align: 'right' as const, value: (r: ScheduleResource) => rates.get(r.id)?.std_rate ?? null, render: (r: ScheduleResource) => money(rates.get(r.id)?.std_rate) },
              { key: 'per_use', label: 'Cost / use', align: 'right' as const, value: (r: ScheduleResource) => rates.get(r.id)?.cost_per_use ?? null, render: (r: ScheduleResource) => money(rates.get(r.id)?.cost_per_use) },
            ] : []),
            { key: 'link', label: 'Linked to', value: (r) => (r.material_spec_id ? L.spec(r.material_spec_id) : ''), render: (r) => (r.material_spec_id ? L.spec(r.material_spec_id) : r.labour_trade_id ? 'labour trade' : '') },
            { key: 'is_active', label: 'Status', value: (r) => (r.is_active ? 'active' : 'inactive'), render: (r) => (r.is_active ? null : <Badge tone="neutral" label="inactive" icon={null} />) },
          ]} />
      )}
      {edit && <ResourceModal projectId={projectId} L={L} res={edit === 'new' ? null : edit} rate={edit === 'new' ? undefined : rates.get(edit.id)} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ResourceModal({ projectId, L, res, rate, onClose }: {
  projectId: string; L: Lookups; res: ScheduleResource | null; rate: { std_rate: number; cost_per_use: number } | undefined; onClose: () => void;
}) {
  const auth = useAuth();
  const trades = useAsync(loadTrades, [], { key: 'labour-trades', staleTime: 30 * 60_000 });
  const [f, setF] = useState({
    code: res?.code ?? '', name: res?.name ?? '', kind: (res?.kind ?? 'labour') as ResourceKind, unit: res?.unit ?? 'man-day',
    max_units: String(res?.max_units ?? 1), trade: res?.labour_trade_id ?? '', spec: res?.material_spec_id ?? '',
    rate: rate ? String(rate.std_rate) : '', per_use: rate ? String(rate.cost_per_use) : '', active: res?.is_active ?? true, notes: res?.notes ?? '',
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await editRpc('save_schedule_resource', {
      ...(res ? { id: res.id } : {}), project_id: projectId, code: f.code.trim(), name: f.name.trim(), kind: f.kind, unit: f.unit.trim() || undefined,
      max_units: Number(f.max_units) || 1, labour_trade_id: f.kind === 'labour' || f.kind === 'crew' ? f.trade || null : null,
      material_spec_id: f.kind === 'material' ? f.spec || null : null, notes: f.notes.trim() || null, is_active: f.active,
      ...(auth.canSeePrices ? { std_rate: Number(f.rate) || 0, cost_per_use: Number(f.per_use) || 0 } : {}),
    });
    onClose();
  });
  return (
    <Modal title={res ? `Resource ${res.code}` : 'New resource'} size="md" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.code.trim() || !f.name.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Code" required><input value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="e.g. MSN, EXC20" data-autofocus /></Field>
        <Field label="Name" required><input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Mason crew" /></Field>
        <Field label="Type">
          <select value={f.kind} onChange={(e) => { const k = e.target.value as ResourceKind; set({ kind: k, unit: k === 'material' ? 'm3' : k === 'equipment' ? 'machine-day' : 'man-day' }); }}>
            {KINDS.map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Unit" hint={unitHint(f.kind)}><input value={f.unit} onChange={(e) => set({ unit: e.target.value })} /></Field>
        {f.kind !== 'material' && <Field label="Max units per day" hint="e.g. 6 masons, 1 excavator"><input type="number" min={0.1} step="0.5" value={f.max_units} onChange={(e) => set({ max_units: e.target.value })} /></Field>}
        {(f.kind === 'labour' || f.kind === 'crew') && (
          <Field label="Labour trade" hint="Links the plan to site-diary labour">
            <select value={f.trade} onChange={(e) => set({ trade: e.target.value })}><option value="">—</option>{(trades.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </Field>
        )}
        {f.kind === 'material' && (
          <Field label="Material" hint="Links to the store catalogue">
            <select value={f.spec} onChange={(e) => set({ spec: e.target.value })}><option value="">—</option>{L.specs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </Field>
        )}
        {auth.canSeePrices && (
          <>
            <Field label={f.kind === 'material' ? 'Rate per unit (ETB)' : 'Rate per day (ETB)'}><input type="number" min={0} step="0.01" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></Field>
            <Field label="Cost per use (ETB)" hint="e.g. mobilisation of a machine"><input type="number" min={0} step="0.01" value={f.per_use} onChange={(e) => set({ per_use: e.target.value })} /></Field>
          </>
        )}
        <Field label="Notes" wide><input value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
        {res && <Field label="Active" check><input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} /></Field>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Task drawer: assignments
// ---------------------------------------------------------------------------
export function AssignmentsTab({ task, canEdit }: { task: SchedTask; canEdit: boolean }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const rq = useAsync(() => loadResources(projectId), [projectId], { key: 'sched-resources' });
  const aq = useAsync(async () => (await loadAssignments(task.schedule_id)).filter((a) => a.task_id === task.id), [task.id], { key: 'sched-task-assignments' });
  const cq = useAsync(() => loadTaskCosts(task.id), [task.id], { key: 'sched-task-costs', enabled: auth.canSeePrices });
  const [rows, setRows] = useState<{ resource_id: string; units: string }[] | null>(null);
  const { busy, error, run } = useBusy();
  if (rq.error || aq.error) return <ErrorBanner error={rq.error ?? aq.error} onRetry={() => { rq.reload(); aq.reload(); }} />;
  if (!rq.data || !aq.data) return <Loading lines={3} />;
  if (task.is_summary) return <p className="muted">Assign resources to the detailed tasks; a summary adds them up.</p>;
  const resources = rq.data.filter((r) => r.is_active);
  const byId = new Map(rq.data.map((r) => [r.id, r]));
  const list = rows ?? aq.data.map((a: TaskAssignment) => ({ resource_id: a.resource_id, units: String(Number(a.units)) }));
  const dirty = rows !== null;
  const cost = new Map((cq.data ?? []).map((c) => [c.resource_id, c]));
  const total = (cq.data ?? []).reduce((s, c) => s + Number(c.cost ?? 0), 0);
  const save = () => void run(async () => {
    await editRpc('assign_resources', { task_id: task.id, assignments: list.filter((r) => r.resource_id).map((r) => ({ resource_id: r.resource_id, units: Number(r.units) })) });
    setRows(null); aq.reload(); cq.reload();
  });
  const dur = Number(task.duration_days ?? 0);
  return (
    <div className="stack">
      <ErrorBanner error={error} />
      {!resources.length ? <Banner tone="info">No resources in this project yet — add them on Schedule › Resources.</Banner> : null}
      {list.length === 0 && !canEdit && <p className="muted">No resources assigned.</p>}
      {list.length > 0 && (
        <table className="plain-table">
          <thead><tr><th>Resource</th><th className="num">Units</th><th className="num">Work</th>{auth.canSeePrices && <th className="num">Cost</th>}{canEdit && <th />}</tr></thead>
          <tbody>
            {list.map((r, k) => {
              const res = byId.get(r.resource_id);
              const work = res?.kind === 'material' ? Number(r.units) : Number(r.units) * dur;
              return (
                <tr key={k}>
                  <td>{canEdit ? (
                    <select value={r.resource_id} aria-label="Resource" onChange={(e) => setRows(list.map((x, j) => (j === k ? { ...x, resource_id: e.target.value } : x)))}>
                      <option value="">Choose…</option>
                      {resources.map((x) => <option key={x.id} value={x.id} disabled={x.id !== r.resource_id && list.some((y) => y.resource_id === x.id)}>{x.code} · {x.name}</option>)}
                    </select>
                  ) : `${res?.code ?? ''} · ${res?.name ?? ''}`}</td>
                  <td className="num">{canEdit ? <input type="number" min={0.001} step="any" value={r.units} aria-label="Units" style={{ width: 90 }}
                    onChange={(e) => setRows(list.map((x, j) => (j === k ? { ...x, units: e.target.value } : x)))} /> : num(r.units, 2)}
                    <span className="muted small-text"> {res?.kind === 'material' ? res.unit : '/day'}</span></td>
                  <td className="num">{num(work, 1)} <span className="muted small-text">{res?.kind === 'material' ? res.unit : res?.unit ?? 'days'}</span></td>
                  {auth.canSeePrices && <td className="num">{dirty ? '…' : money(cost.get(r.resource_id)?.cost)}</td>}
                  {canEdit && <td><button className="link-btn" onClick={() => setRows(list.filter((_, j) => j !== k))}>Remove</button></td>}
                </tr>
              );
            })}
          </tbody>
          {auth.canSeePrices && !dirty && total > 0 && <tfoot><tr><td colSpan={3}>Task cost from resources</td><td className="num strong">{money(total)}</td>{canEdit && <td />}</tr></tfoot>}
        </table>
      )}
      {canEdit && resources.length > 0 && (
        <div className="row">
          <button className="small" onClick={() => setRows([...list, { resource_id: '', units: '1' }])}><Plus size={14} />Assign resource</button>
          <span className="grow" />
          {dirty && <><button className="small" onClick={() => setRows(null)}>Cancel</button><button className="small primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save</button></>}
        </div>
      )}
      <p className="muted small-text mb-0">Labour / equipment: units per working day × {num(dur, 1)} d = work. Materials: total quantity. A baseline costed “from resources” uses these costs.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resource usage (weekly demand vs capacity, over-allocation, levelling hints)
// ---------------------------------------------------------------------------
export function ResourceUsageView({ schedule, onOpenTask }: { schedule: SchedHeader; onOpenTask: (id: string) => void }) {
  const [basis, setBasis] = useState<'plan' | 'forecast'>('plan');
  const q = useAsync(async () => {
    const { data, error } = await supabase.rpc('get_resource_usage', { p: { schedule_id: schedule.id, basis } });
    if (error) throw new Error(error.message);
    return data as ResourceUsage;
  }, [schedule.id, basis], { key: 'sched-resource-usage' });
  const [pick, setPick] = useState<{ res: string; week: string } | null>(null);
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={6} />;
  const weeks = [...new Set(q.data.resources.flatMap((r) => r.weeks.map((w) => w.week)))].sort();
  const overN = q.data.resources.reduce((s, r) => s + r.weeks.filter((w) => w.over).length, 0);
  const sel = pick ? q.data.resources.find((r) => r.id === pick.res)?.weeks.find((w) => w.week === pick.week) : undefined;
  const selRes = pick ? q.data.resources.find((r) => r.id === pick.res) : undefined;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <div className="segmented" role="tablist" aria-label="Dates">
          <button role="tab" aria-selected={basis === 'plan'} onClick={() => setBasis('plan')}>Planned dates</button>
          <button role="tab" aria-selected={basis === 'forecast'} onClick={() => setBasis('forecast')}>Forecast dates</button>
        </div>
        <span className="muted small-text">{d2(q.data.from)} → {d2(q.data.to)} · peak daily units per week vs. max units</span>
        <span className="grow" />
        {overN > 0 ? <Badge tone="danger" icon={TriangleAlert} label={`${overN} over-allocated week${overN === 1 ? '' : 's'}`} /> : q.data.resources.length ? <Badge tone="success" label="No over-allocation" icon={null} /> : null}
      </div>
      {!q.data.resources.length ? <Empty title="No resources assigned">Add resources on the Resources tab and assign them to tasks (task drawer › Resources).</Empty> : (
        <div className="ru-wrap">
          <table className="ru-table">
            <thead><tr><th className="ru-res">Resource</th>{weeks.map((w) => <th key={w} title={`Week of ${d2(w)}`}>{w.slice(8, 10)}/{w.slice(5, 7)}</th>)}</tr></thead>
            <tbody>
              {q.data.resources.map((r) => {
                const byWeek = new Map(r.weeks.map((w) => [w.week, w]));
                return (
                  <tr key={r.id}>
                    <th className="ru-res" scope="row">{r.code} <span className="muted small-text">{r.name}{r.kind !== 'material' ? ` · max ${num(r.max_units, 0)}` : ` · ${r.unit}`}</span></th>
                    {weeks.map((wk) => {
                      const w = byWeek.get(wk);
                      if (!w) return <td key={wk} />;
                      const load = r.kind === 'material' ? 0 : Number(w.peak) / Number(r.max_units);
                      return (
                        <td key={wk} className={`ru-cell${w.over ? ' over' : load >= 0.8 ? ' high' : ''}${pick?.res === r.id && pick.week === wk ? ' sel' : ''}`}>
                          <button type="button" onClick={() => setPick({ res: r.id, week: wk })} title={`Week of ${d2(wk)}: peak ${num(w.peak, 1)} of ${num(r.max_units, 1)} · ${num(w.demand, 1)} ${r.kind === 'material' ? r.unit : 'unit-days'}`}>
                            {r.kind === 'material' ? num(w.demand, 0) : num(w.peak, 1)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sel && selRes && (
        <Card title={`${selRes.code} · week of ${d2(sel.week)}`} sub={selRes.kind === 'material' ? `${num(sel.demand, 1)} ${selRes.unit} needed`
          : `Peak ${num(sel.peak, 1)} per day against ${num(selRes.max_units, 1)} available · ${num(sel.demand, 1)} unit-days of ${num(sel.capacity, 1)} capacity`}>
          {!sel.over ? <p className="muted mb-0">Within capacity.</p> : (
            <>
              <Banner tone="warn">Over-allocated. Levelling suggestion: move the task(s) with the most float, or add {num(Number(sel.peak) - Number(selRes.max_units), 1)} more {selRes.unit.replace(/-day$/, '')}(s) this week.</Banner>
              <ul className="link-list">
                {[...(sel.tasks ?? [])].sort((a, b) => Number(b.total_float_days ?? -1e9) - Number(a.total_float_days ?? -1e9)).map((t) => (
                  <li key={t.task_id}>
                    <button className="link-btn grow" style={{ textAlign: 'left' }} onClick={() => onOpenTask(t.task_id)}>{t.uid} · {t.name}</button>
                    <span className="small-text">{num(t.units, 1)}/day</span>
                    {Number(t.total_float_days) > 0
                      ? <Badge tone="success" label={`${num(t.total_float_days, 0)} d float — can move`} icon={null} />
                      : <Badge tone="danger" label="critical — keep" icon={null} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
