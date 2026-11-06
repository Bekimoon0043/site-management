import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { canField, type CubeDueRow, type MixDesign, type MixSource, type PourSummaryRow } from '../../lib/contract-field';
import { optNum, optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, humanize, num } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { SBadge } from '../../components/field/StatusBadge';
import { Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterDate, FilterSelect, Kpi, Page, QtyInput, SearchInput, Tabs, toast, useBusy, useHashTab } from '../../components/ui';
import { CubeResultsDrawer } from './CubeResults';

const TABS = ['pours', 'cubes', 'mixes'] as const;
type Tab = (typeof TABS)[number];

/** Concrete: pour register (ready-mix tickets, site batches, cement/m³), cube tests due, mix designs (P1-8). */
export function Concrete() {
  const projectId = useProjectId();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'pours');
  const due = useAsync(async () => check(await supabase.from('v_cubes_due').select('*').eq('project_id', projectId).order('due_date')) as CubeDueRow[],
    [projectId], { key: 'cubes-due' });
  const overdue = (due.data ?? []).filter((r) => r.due_status !== 'upcoming').length;
  return (
    <Page title="Concrete" subtitle="Pours, ready-mix tickets, site batching, cube tests and mix designs">
      <Tabs label="Concrete sections" value={tab} onChange={setTab} tabs={[
        { key: 'pours', label: 'Pours' },
        { key: 'cubes', label: 'Cubes due', count: overdue || undefined, hot: overdue > 0 },
        { key: 'mixes', label: 'Mix designs' },
      ]} />
      {tab === 'pours' && <PoursTab />}
      {tab === 'cubes' && <CubesTab rows={due.data} error={due.error} reload={due.reload} />}
      {tab === 'mixes' && <MixesTab />}
    </Page>
  );
}

function PoursTab() {
  const projectId = useProjectId();
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<PourSummaryRow>((a, b) => supabase.from('v_pour_summary').select('*').eq('project_id', projectId).order('pour_date', { ascending: false }).range(a, b)),
    [projectId], { key: 'pour-summary' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: '', method: '', mix: '', from: '', to: '', q: '' }, 'p_');
  const all = q.data ?? [];
  const mixes = [...new Set(all.map((r) => r.mix_code))].sort();
  const rows = all.filter((r) => (!f.status || r.status === f.status) && (!f.method || r.method === f.method) && (!f.mix || r.mix_code === f.mix)
    && (!f.from || r.pour_date >= f.from) && (!f.to || r.pour_date <= f.to) && (!f.q || r.number.toLowerCase().includes(f.q.toLowerCase())));
  const vol = rows.reduce((s, r) => s + Number(r.actual_m3 ?? r.accepted_m3 ?? 0), 0);
  const rejected = rows.reduce((s, r) => s + Number(r.trucks_rejected), 0);
  const variance = rows.filter((r) => r.cement_variance_pct !== null);
  const avgVar = variance.length ? variance.reduce((s, r) => s + Number(r.cement_variance_pct), 0) / variance.length : null;
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="kpis">
        <Kpi label="Concrete placed" loading={!q.data} value={num(vol, 1)} unit="m³" hint={`${rows.length} pours`} />
        <Kpi label="Rejected trucks" loading={!q.data} value={rejected} status={rejected ? 'warning' : undefined} />
        <Kpi label="Cement vs design" loading={!q.data} value={avgVar === null ? '—' : `${avgVar >= 0 ? '+' : ''}${num(avgVar, 1)}`} unit={avgVar === null ? undefined : '%'}
          status={avgVar !== null && avgVar > 5 ? 'danger' : undefined} hint="Average issued cement/m³ vs mix design" />
        <Kpi label="Failed cube sets" loading={!q.data} value={rows.reduce((s, r) => s + Number(r.cube_sets_failed), 0)} status={rows.some((r) => r.cube_sets_failed > 0) ? 'danger' : undefined} />
      </div>
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Pour no." />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={['planned', 'in_progress', 'completed', 'cancelled'].map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect label="Method" value={f.method} onChange={(v) => setF('method', v)} options={[{ value: 'ready_mix', label: 'Ready-mix' }, { value: 'site_batched', label: 'Site batched' }]} />
        <FilterSelect label="Mix" value={f.mix} onChange={(v) => setF('mix', v)} options={mixes.map((m) => ({ value: m, label: m }))} />
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="to" value={f.to} onChange={(v) => setF('to', v)} />
      </FilterBar>
      <DataTable rows={rows} rowKey={(r) => r.pour_id} loading={!q.data} error={q.error} onRetry={q.reload} urlKey="p_" stickyFirst exportName="pour-register" viewKey="pours"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/concrete/pours/${r.pour_id}`)}
        empty={{ title: 'No pours yet', body: 'Pours logged on site (trucks, batches, samples) appear here.' }}
        columns={[
          { key: 'number', label: 'Pour', id: true },
          { key: 'pour_date', label: 'Date', value: (r) => r.pour_date, render: (r) => date(r.pour_date) },
          { key: 'grade', label: 'Grade', value: (r) => `${r.grade} (${r.mix_code})` },
          { key: 'method', label: 'Method', value: (r) => (r.method === 'ready_mix' ? 'Ready-mix' : 'Site batched') },
          { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status} /> },
          { key: 'planned_m3', label: 'Planned', align: 'right', render: (r) => <>{num(r.planned_m3, 2)}<span className="unit">m³</span></> },
          { key: 'actual_m3', label: 'Actual', align: 'right', render: (r) => (r.actual_m3 === null ? '' : <>{num(r.actual_m3, 2)}<span className="unit">m³</span></>) },
          { key: 'over_pour_pct', label: 'Over-pour', align: 'right', render: (r) => (r.over_pour_pct === null ? '' : <span className={Number(r.over_pour_pct) > 5 ? 'danger-text' : ''}>{num(r.over_pour_pct, 1)}%</span>) },
          { key: 'trucks', label: 'Trucks', align: 'right', render: (r) => <>{r.trucks}{r.trucks_rejected > 0 && <span className="danger-text small-text"> · {r.trucks_rejected} rej.</span>}{r.trucks_awaiting > 0 && <span className="warn-text small-text"> · {r.trucks_awaiting} wait</span>}</> },
          { key: 'cement', label: 'Cement kg/m³', align: 'right', value: (r) => r.issued_cement_kg_per_m3 ?? r.batched_cement_kg_per_m3,
            render: (r) => { const v = r.issued_cement_kg_per_m3 ?? r.batched_cement_kg_per_m3; return v === null ? '' : <span title={`Design ${num(r.design_cement_kg_per_m3, 0)} kg/m³`}>{num(v, 0)}{r.design_cement_kg_per_m3 ? <span className="unit">/ {num(r.design_cement_kg_per_m3, 0)}</span> : null}</span>; } },
          { key: 'cement_variance_pct', label: 'Cement var.', align: 'right', render: (r) => (r.cement_variance_pct === null ? '' : <span className={Number(r.cement_variance_pct) > 5 ? 'danger-text strong' : ''}>{Number(r.cement_variance_pct) > 0 ? '+' : ''}{num(r.cement_variance_pct, 1)}%</span>) },
          { key: 'cubes', label: 'Cubes', value: (r) => `${r.cube_sets_passed}/${r.cube_sets}`, render: (r) => (!r.cube_sets ? '' : r.cube_sets_failed ? <SBadge value="fail" label={`${r.cube_sets_failed} failed`} /> : <span>{r.cube_sets_passed}/{r.cube_sets} passed</span>) },
          { key: 'accepted_m3', label: 'Accepted m³', align: 'right', hidden: true, render: (r) => num(r.accepted_m3, 2) },
          { key: 'cement_bags', label: 'Cement bags', align: 'right', hidden: true },
        ]} />
    </>
  );
}

function CubesTab({ rows, error, reload }: { rows: CubeDueRow[] | undefined; error: string | null; reload: () => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const [f, setF, { active, clear }] = useUrlFilters({ due: '' }, 'c_');
  const [entering, setEntering] = useState<CubeDueRow | null>(null);
  const canEnter = canField(auth.profile?.role, 'cube.results');
  const list = (rows ?? []).filter((r) => !f.due || (f.due === 'now' ? r.due_status !== 'upcoming' : r.due_status === f.due));
  return (
    <>
      <ErrorBanner error={error ?? lk.error} onRetry={reload} />
      <FilterBar active={active} onClear={clear}>
        <FilterSelect label="Due" value={f.due} onChange={(v) => setF('due', v)} options={[{ value: 'now', label: 'Due or overdue' }, { value: 'overdue', label: 'Overdue' }, { value: 'due', label: 'Due today' }, { value: 'upcoming', label: 'Upcoming' }]} />
      </FilterBar>
      <DataTable rows={list} rowKey={(r) => `${r.cube_set_id}:${r.age_days}`} loading={!rows || !lk.data} urlKey="c_" exportName="cubes-due"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => (canEnter ? setEntering(r) : nav(`/concrete/pours/${r.pour_id}`))}
        empty={{ title: 'No cube tests outstanding', body: 'Cube sets sampled at pours appear here until their 7- and 28-day results are entered.' }}
        columns={[
          { key: 'number', label: 'Cube set', id: true },
          { key: 'pour_number', label: 'Pour' },
          { key: 'element', label: 'Element', value: (r) => lk.data?.element(r.element_id) },
          { key: 'age_days', label: 'Age', align: 'right', render: (r) => <>{r.age_days}<span className="unit">d</span></> },
          { key: 'due_date', label: 'Due', value: (r) => r.due_date, render: (r) => date(r.due_date) },
          { key: 'due_status', label: 'Status', render: (r) => <SBadge value={r.due_status} /> },
          { key: 'cubes_count', label: 'Cubes', align: 'right' },
          { key: 'lab_name', label: 'Lab' },
          { key: 'act', label: '', noExport: true, sortable: false, render: (r) => canEnter && <button className="small" onClick={(e) => { e.stopPropagation(); setEntering(r); }}><FlaskConical size={14} aria-hidden />Enter results</button> },
        ]} />
      {entering && <CubeResultsDrawer cubeSetId={entering.cube_set_id} age={entering.age_days} onClose={() => setEntering(null)} />}
    </>
  );
}

function MixesTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(async () => {
    const [mixes, used] = await Promise.all([
      supabase.from('mix_designs').select('*').eq('project_id', projectId).is('deleted_at', null).order('code').then(check) as Promise<MixDesign[]>,
      supabase.from('pours').select('mix_design_id').eq('project_id', projectId).then(check) as Promise<{ mix_design_id: string }[]>,
    ]);
    return { mixes, used: new Set(used.map((u) => u.mix_design_id)) };
  }, [projectId], { key: 'mix-designs' });
  const [editing, setEditing] = useState<MixDesign | 'new' | null>(null);
  const canEdit = canField(auth.profile?.role, 'mix.edit');
  const L = lk.data;
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar right={canEdit && <button className="primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden />New mix design</button>}><span /></FilterBar>
      <DataTable rows={q.data?.mixes ?? []} loading={!q.data || !L} exportName="mix-designs" onRowClick={(r) => setEditing(r)}
        empty={{ title: 'No mix designs', body: 'Add the project\'s concrete grades with design cement content to compare against batching and issues.' }}
        columns={[
          { key: 'code', label: 'Code', id: true },
          { key: 'grade', label: 'Grade' },
          { key: 'source', label: 'Source', value: (r) => (r.source === 'ready_mix' ? 'Ready-mix' : 'Site batched') },
          { key: 'target_strength_mpa', label: 'fck', align: 'right', render: (r) => <>{num(r.target_strength_mpa, 1)}<span className="unit">MPa</span></> },
          { key: 'cement_kg_per_m3', label: 'Cement', align: 'right', render: (r) => (r.cement_kg_per_m3 === null ? '' : <>{num(r.cement_kg_per_m3, 0)}<span className="unit">kg/m³</span></>) },
          { key: 'water_cement_ratio', label: 'w/c', align: 'right', render: (r) => num(r.water_cement_ratio, 2) },
          { key: 'slump', label: 'Slump', align: 'right', value: (r) => r.target_slump_mm, render: (r) => (r.target_slump_mm === null ? '' : <>{r.target_slump_mm} ± {r.slump_tolerance_mm}<span className="unit">mm</span></>) },
          { key: 'spec', label: 'Received as', value: (r) => L?.spec(r.material_spec_id) },
          { key: 'cement_spec', label: 'Cement', hidden: true, value: (r) => L?.spec(r.cement_spec_id) },
          { key: 'used', label: 'Used', value: (r) => (q.data?.used.has(r.id) ? 'Yes' : ''), render: (r) => (q.data?.used.has(r.id) ? <SBadge value="active" label="In use" /> : '') },
        ]} />
      {editing && <MixDrawer mix={editing === 'new' ? null : editing} used={editing !== 'new' && !!q.data?.used.has(editing.id)} readOnly={!canEdit} onClose={() => setEditing(null)} />}
    </>
  );
}

function MixDrawer({ mix, used, readOnly, onClose }: { mix: MixDesign | null; used: boolean; readOnly: boolean; onClose: () => void }) {
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const s = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const [form, setForm] = useState({
    code: mix?.code ?? '', grade: mix?.grade ?? '', source: (mix?.source ?? 'ready_mix') as MixSource, material_spec_id: mix?.material_spec_id ?? '',
    target_strength_mpa: s(mix?.target_strength_mpa), cement_spec_id: mix?.cement_spec_id ?? '', cement_kg_per_m3: s(mix?.cement_kg_per_m3),
    water_cement_ratio: s(mix?.water_cement_ratio), sand_m3_per_m3: s(mix?.sand_m3_per_m3), aggregate_m3_per_m3: s(mix?.aggregate_m3_per_m3),
    target_slump_mm: s(mix?.target_slump_mm), slump_tolerance_mm: s(mix?.slump_tolerance_mm ?? 25), remarks: mix?.remarks ?? '',
  });
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  const { busy, error, run } = useBusy();
  const locked = readOnly || used;
  const specs = lk.data?.specs ?? [];
  const concrete = specs.filter((x) => /concrete/i.test(x.category) || /concrete/i.test(x.material_name));
  const cement = specs.filter((x) => /cement/i.test(x.category));
  const save = () => run(async () => {
    if (!form.grade.trim()) throw new Error('Grade is required.');
    if (form.source === 'ready_mix' && !form.material_spec_id) throw new Error('A ready-mix design needs the concrete material it is received as.');
    await rpcx('save_mix_design', {
      id: mix?.id ?? uuid(), project_id: projectId, code: optStr(form.code), grade: form.grade.trim(), source: form.source,
      material_spec_id: optStr(form.material_spec_id), target_strength_mpa: optNum(form.target_strength_mpa), cement_spec_id: optStr(form.cement_spec_id),
      cement_kg_per_m3: optNum(form.cement_kg_per_m3), water_cement_ratio: optNum(form.water_cement_ratio), sand_m3_per_m3: optNum(form.sand_m3_per_m3),
      aggregate_m3_per_m3: optNum(form.aggregate_m3_per_m3), target_slump_mm: optNum(form.target_slump_mm), slump_tolerance_mm: optNum(form.slump_tolerance_mm),
      remarks: optStr(form.remarks),
    });
    toast.success(`Mix ${form.code || form.grade} saved`);
    onClose();
  });
  return (
    <Drawer title={mix ? `Mix ${mix.code}` : 'New mix design'} onClose={onClose} footer={<>
      <button onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
      {!locked && <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>}
    </>}>
      <ErrorBanner error={error} />
      {used && <Banner tone="info">This mix design is used by pours and can't be changed — create a new mix design instead.</Banner>}
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Grade" required hint="e.g. C-25/30"><input data-autofocus value={form.grade} onChange={(e) => set('grade', e.target.value)} /></Field>
          <Field label="Code" hint="Defaults to the grade"><input value={form.code} onChange={(e) => set('code', e.target.value)} /></Field>
          <Field label="Source" required>
            <select value={form.source} onChange={(e) => set('source', e.target.value)}><option value="ready_mix">Ready-mix</option><option value="site">Site batched</option></select>
          </Field>
          <Field label="Target strength (fck)" hint="Characteristic cube strength; derived from the grade if blank"><QtyInput value={form.target_strength_mpa} onChange={(v) => set('target_strength_mpa', v)} unit="MPa" /></Field>
          <Field label="Received as (concrete material)" required={form.source === 'ready_mix'}>
            <select value={form.material_spec_id} onChange={(e) => set('material_spec_id', e.target.value)}>
              <option value="">—</option>
              {(concrete.length ? concrete : specs).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Cement material">
            <select value={form.cement_spec_id} onChange={(e) => set('cement_spec_id', e.target.value)}>
              <option value="">—</option>
              {(cement.length ? cement : specs).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Cement content"><QtyInput value={form.cement_kg_per_m3} onChange={(v) => set('cement_kg_per_m3', v)} unit="kg/m³" /></Field>
          <Field label="Water / cement ratio"><QtyInput value={form.water_cement_ratio} onChange={(v) => set('water_cement_ratio', v)} /></Field>
          <Field label="Sand"><QtyInput value={form.sand_m3_per_m3} onChange={(v) => set('sand_m3_per_m3', v)} unit="m³/m³" /></Field>
          <Field label="Aggregate"><QtyInput value={form.aggregate_m3_per_m3} onChange={(v) => set('aggregate_m3_per_m3', v)} unit="m³/m³" /></Field>
          <Field label="Target slump"><QtyInput value={form.target_slump_mm} onChange={(v) => set('target_slump_mm', v)} unit="mm" /></Field>
          <Field label="Slump tolerance"><QtyInput value={form.slump_tolerance_mm} onChange={(v) => set('slump_tolerance_mm', v)} unit="± mm" /></Field>
          <Field label="Remarks" wide><textarea rows={2} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
        </div>
      </fieldset>
    </Drawer>
  );
}
