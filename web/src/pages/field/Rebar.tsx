import { useMemo, useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { Attachments } from '../../components/Attachments';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { bbsWeightKg, canField, type BbsLine, type BbsSchedule, type RebarReconciliationRow } from '../../lib/contract-field';
import { nextNumber, optNum, optStr, rpcx, uuid } from '../../lib/fieldx';
import { cellNum, cellStr, date, num, pick } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { ImportWizard, type ImportRow } from '../../components/ImportWizard';
import { SBadge } from '../../components/field/StatusBadge';
import {
  Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterSelect, FilterToggle, Kpi, Loading, Modal, Page, SearchInput, Tabs, toast, useBusy, useHashTab,
} from '../../components/ui';

const TABS = ['schedules', 'reconciliation', 'import'] as const;
type Tab = (typeof TABS)[number];
type BbsRow = BbsSchedule & { bbs_lines: { weight_kg: number; deleted_at: string | null }[] };

/** Diameter from a rebar grade label ('S-400 Ø16' → 16), same rule as app.spec_diameter. */
export const specDiameter = (grade: string) => { const m = /(?:Ø|ø|Φ|φ|dia\.?\s*)\s*(\d{1,2})/i.exec(grade); return m ? Number(m[1]) : null; };
const rebarSpecs = (L: Lookups) => L.specs.filter((s) => /reinforc|rebar/i.test(s.category) && specDiameter(s.grade) !== null);

/** Rebar: bar bending schedules per element, BBS Excel import, and BBS vs take-off vs issued reconciliation (P1-9). */
export function Rebar() {
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'schedules');
  const canEdit = canField(auth.profile?.role, 'bbs.edit');
  return (
    <Page title="Rebar & BBS" subtitle="Bar bending schedules per element and rebar reconciliation (FR-CC-05)">
      <Tabs label="Rebar sections" value={tab} onChange={setTab} tabs={[
        { key: 'schedules', label: 'Schedules (BBS)' }, { key: 'reconciliation', label: 'Reconciliation' },
        ...(canEdit ? [{ key: 'import' as Tab, label: 'Import BBS from Excel' }] : []),
      ]} />
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'reconciliation' && <ReconciliationTab />}
      {tab === 'import' && canEdit && <ImportTab onDone={() => setTab('schedules')} />}
    </Page>
  );
}

function SchedulesTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<BbsRow>((a, b) => supabase.from('bbs_schedules').select('*, bbs_lines(weight_kg, deleted_at)').eq('project_id', projectId)
    .is('deleted_at', null).order('created_at', { ascending: false }).range(a, b)), [projectId], { key: 'bbs-schedules' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: '', element: '', block: '', q: '' }, 'b_');
  const [peek, setPeek] = useUrlParam('peek');
  const [creating, setCreating] = useState(false);
  const L = lk.data;
  const rows = (q.data ?? []).filter((r) => {
    const el = L?.elements.find((e) => e.id === r.element_id);
    return (!f.status || r.status === f.status) && (!f.element || r.element_id === f.element) && (!f.block || el?.block_id === f.block)
      && (!f.q || `${r.number} ${L?.element(r.element_id)} ${r.drawing_ref ?? ''}`.toLowerCase().includes(f.q.toLowerCase()));
  });
  const kg = (r: BbsRow) => r.bbs_lines.filter((l) => !l.deleted_at).reduce((s, l) => s + Number(l.weight_kg), 0);
  const current = (q.data ?? []).find((r) => r.id === peek);
  return (
    <>
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear} right={canField(auth.profile?.role, 'bbs.edit') && <button className="primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden />New BBS</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="BBS no., element, drawing" />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'draft', label: 'Draft' }, { value: 'approved', label: 'Approved' }, { value: 'superseded', label: 'Superseded' }]} />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Element" value={f.element} onChange={(v) => setF('element', v)} options={(L?.elements ?? []).map((e) => ({ value: e.id, label: L!.element(e.id) }))} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="b_" stickyFirst exportName="bbs-register" activeKey={peek}
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => setPeek(r.id, true)}
        empty={{ title: 'No bar bending schedules', body: 'Import BBS sheets from Excel or enter them per element.' }}
        columns={[
          { key: 'number', label: 'BBS', id: true },
          { key: 'element', label: 'Element', value: (r) => L?.element(r.element_id) },
          { key: 'revision', label: 'Rev', align: 'right' },
          { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status} /> },
          { key: 'kg', label: 'Weight', align: 'right', value: kg, render: (r) => <>{num(kg(r), 1)}<span className="unit">kg</span></> },
          { key: 'lines', label: 'Lines', align: 'right', value: (r) => r.bbs_lines.filter((l) => !l.deleted_at).length },
          { key: 'drawing_ref', label: 'Drawing' },
          { key: 'approved', label: 'Approved', value: (r) => (r.approved_by ? `${L?.person(r.approved_by)} · ${date(r.approved_at)}` : '') },
        ]} />
      {current && L && <BbsDrawer bbs={current} L={L} onClose={() => setPeek(null)} />}
      {creating && L && <BbsEditor L={L} onClose={() => setCreating(false)} onSaved={(id) => { setCreating(false); setPeek(id); }} />}
    </>
  );
}

interface LineDraft { id: string; bar_mark: string; material_spec_id: string; diameter_mm: string; shape_code: string; no_of_members: string; bars_per_member: string; cut_length_m: string }
const blankLine = (): LineDraft => ({ id: uuid(), bar_mark: '', material_spec_id: '', diameter_mm: '', shape_code: '', no_of_members: '1', bars_per_member: '', cut_length_m: '' });

function BbsDrawer({ bbs, L, onClose }: { bbs: BbsRow; L: Lookups; onClose: () => void }) {
  const auth = useAuth();
  const q = useAsync(async () => check(await supabase.from('bbs_lines').select('*').eq('bbs_id', bbs.id).is('deleted_at', null).order('line_no')) as BbsLine[],
    [bbs.id, bbs.status], { key: 'bbs-lines' });
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const canEdit = canField(auth.profile?.role, 'bbs.edit');
  if (editing && q.data) return <BbsEditor L={L} bbs={bbs} lines={q.data} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />;
  const total = (q.data ?? []).reduce((s, l) => s + Number(l.weight_kg), 0);
  const byDia = new Map<number, number>();
  for (const l of q.data ?? []) byDia.set(l.diameter_mm, (byDia.get(l.diameter_mm) ?? 0) + Number(l.weight_kg));
  return (
    <Drawer size="lg" title={<>{bbs.number} <SBadge value={bbs.status} /></>} subtitle={`${L.element(bbs.element_id)} · revision ${bbs.revision}${bbs.drawing_ref ? ` · drawing ${bbs.drawing_ref}` : ''}`} onClose={onClose}
      footer={<>
        <button onClick={onClose}>Close</button>
        <span className="spacer" />
        {canEdit && bbs.status === 'draft' && <button onClick={() => setEditing(true)} disabled={!q.data}>Edit lines</button>}
        {canEdit && bbs.status === 'draft' && <button className="primary" onClick={() => setApproving(true)}><Check size={14} aria-hidden />Approve…</button>}
      </>}>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="summary-strip">
        <span className="s">Total <strong>{num(total, 1)} kg</strong></span>
        {[...byDia.entries()].sort((a, b) => a[0] - b[0]).map(([d, w]) => <span key={d} className="s">Ø{d} <strong>{num(w, 1)} kg</strong></span>)}
      </div>
      {!q.data ? <Loading lines={5} /> : (
        <DataTable rows={q.data} maxHeight="none" exportName={bbs.number} columns={[
          { key: 'line_no', label: '#', align: 'right', width: 36 },
          { key: 'bar_mark', label: 'Bar mark', id: true },
          { key: 'diameter_mm', label: 'Ø', align: 'right', render: (r) => <>{r.diameter_mm}<span className="unit">mm</span></> },
          { key: 'spec', label: 'Material', value: (r) => L.spec(r.material_spec_id) },
          { key: 'shape_code', label: 'Shape' },
          { key: 'no_of_members', label: 'Members', align: 'right' },
          { key: 'bars_per_member', label: 'Bars/member', align: 'right' },
          { key: 'cut_length_m', label: 'Cut length', align: 'right', render: (r) => <>{num(r.cut_length_m, 3)}<span className="unit">m</span></> },
          { key: 'total_length_m', label: 'Total length', align: 'right', render: (r) => <>{num(r.total_length_m, 2)}<span className="unit">m</span></> },
          { key: 'weight_kg', label: 'Weight', align: 'right', render: (r) => <>{num(r.weight_kg, 2)}<span className="unit">kg</span></> },
        ]} />
      )}
      {bbs.remarks && <p className="muted">{bbs.remarks}</p>}
      <h3 className="mt-3">Drawings &amp; photos</h3>
      <Attachments entityType="bbs" entityId={bbs.id} canAdd={canEdit || canField(auth.profile?.role, 'pour.write')}
        kinds={['drawing', 'bbs', 'photo', 'document']} emptyText="No drawings or photos — attach the structural drawing and photos of the fixed bars." />
      {approving && <ApproveBbs bbs={bbs} hasSpecs={(q.data ?? []).some((l) => l.material_spec_id)} onClose={() => setApproving(false)} />}
    </Drawer>
  );
}

function ApproveBbs({ bbs, hasSpecs, onClose }: { bbs: BbsRow; hasSpecs: boolean; onClose: () => void }) {
  const [update, setUpdate] = useState(hasSpecs);
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    const r = await rpcx('approve_bbs', { bbs_id: bbs.id, update_takeoff: update });
    toast.success(`${bbs.number} approved${update ? ` · ${Number(r.takeoffs_updated ?? 0)} take-off line(s) updated` : ''}`);
    onClose();
  });
  return (
    <Modal title={`Approve ${bbs.number}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Approve BBS</button>
    </>}>
      <ErrorBanner error={error} />
      <p className="muted">The previously approved revision for this element becomes <em>superseded</em>.</p>
      <Field label="Update the element's rebar take-off quantities to the BBS weights" check hint={hasSpecs ? 'Per material/grade, converted to the material unit.' : 'No line is linked to a material — nothing to update.'}>
        <input type="checkbox" checked={update} disabled={!hasSpecs} onChange={(e) => setUpdate(e.target.checked)} />
      </Field>
    </Modal>
  );
}

function BbsEditor({ L, bbs, lines, onClose, onSaved }: { L: Lookups; bbs?: BbsRow; lines?: BbsLine[]; onClose: () => void; onSaved: (id: string) => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const specs = rebarSpecs(L);
  const [head, setHead] = useState({ element_id: bbs?.element_id ?? '', drawing_ref: bbs?.drawing_ref ?? '', remarks: bbs?.remarks ?? '' });
  const [rows, setRows] = useState<LineDraft[]>(lines?.map((l) => ({
    id: l.id, bar_mark: l.bar_mark, material_spec_id: l.material_spec_id ?? '', diameter_mm: String(l.diameter_mm), shape_code: l.shape_code ?? '',
    no_of_members: String(l.no_of_members), bars_per_member: String(l.bars_per_member), cut_length_m: String(l.cut_length_m),
  })) ?? [blankLine()]);
  const { busy, error, run } = useBusy();
  const setRow = (i: number, patch: Partial<LineDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const dia = (r: LineDraft) => optNum(r.diameter_mm) ?? (r.material_spec_id ? specDiameter(L.specs.find((s) => s.id === r.material_spec_id)?.grade ?? '') : null);
  const weight = (r: LineDraft) => { const d = dia(r); return d && optNum(r.bars_per_member) && optNum(r.cut_length_m) ? bbsWeightKg(d, optNum(r.no_of_members) ?? 1, Number(r.bars_per_member), Number(r.cut_length_m)) : 0; };
  const total = rows.reduce((s, r) => s + weight(r), 0);
  const save = () => run(async () => {
    if (!head.element_id) throw new Error('Choose the element.');
    const clean = rows.filter((r) => r.bar_mark.trim() || r.bars_per_member || r.cut_length_m);
    if (!clean.length) throw new Error('Add at least one line.');
    clean.forEach((r, i) => {
      if (!r.bar_mark.trim()) throw new Error(`Line ${i + 1}: bar mark is required.`);
      if (!dia(r)) throw new Error(`Line ${i + 1}: choose a material or enter the diameter.`);
      if (!optNum(r.bars_per_member) || !optNum(r.cut_length_m)) throw new Error(`Line ${i + 1}: bars per member and cut length are required.`);
    });
    const id = bbs?.id ?? uuid();
    const number = bbs?.number ?? await nextNumber(auth.project?.code ?? 'PRJ', 'BBS', 'bbs_schedules');
    await rpcx('save_bbs', {
      id, project_id: projectId, number, element_id: head.element_id, drawing_ref: optStr(head.drawing_ref), remarks: optStr(head.remarks),
      lines: clean.map((r) => ({ id: r.id, bar_mark: r.bar_mark.trim(), material_spec_id: optStr(r.material_spec_id), diameter_mm: dia(r) ?? undefined,
        shape_code: optStr(r.shape_code), no_of_members: optNum(r.no_of_members) ?? 1, bars_per_member: Number(r.bars_per_member), cut_length_m: Number(r.cut_length_m) })),
    });
    toast.success(`${number} saved`);
    onSaved(id);
  });
  return (
    <Drawer size="lg" title={bbs ? `Edit ${bbs.number}` : 'New bar bending schedule'} subtitle={`Total ${num(total, 1)} kg · weight = members × bars × length × Ø²/162`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save draft</button>
    </>}>
      <ErrorBanner error={error} />
      {!specs.length && <Banner tone="info">No reinforcement materials with a diameter in the grade (e.g. “S-400 Ø16”) — enter diameters manually.</Banner>}
      <div className="form-grid">
        <Field label="Element" required>
          <select data-autofocus value={head.element_id} disabled={!!bbs} onChange={(e) => setHead({ ...head, element_id: e.target.value })}>
            <option value="">Choose…</option>
            {L.elements.map((e) => <option key={e.id} value={e.id}>{L.element(e.id)}</option>)}
          </select>
        </Field>
        <Field label="Drawing ref"><input value={head.drawing_ref} onChange={(e) => setHead({ ...head, drawing_ref: e.target.value })} /></Field>
        <Field label="Remarks"><input value={head.remarks} onChange={(e) => setHead({ ...head, remarks: e.target.value })} /></Field>
      </div>
      <DataTable rows={rows.map((r, i) => ({ ...r, _i: i }))} rowKey={(r) => r.id} maxHeight="none" virtual={false} columns={[
        { key: 'bar_mark', label: 'Bar mark', sortable: false, render: (r) => <input aria-label="Bar mark" value={r.bar_mark} onChange={(e) => setRow(r._i, { bar_mark: e.target.value })} style={{ width: 70 }} /> },
        { key: 'spec', label: 'Material', sortable: false, render: (r) => (
          <select aria-label="Material" value={r.material_spec_id} onChange={(e) => setRow(r._i, { material_spec_id: e.target.value, diameter_mm: '' })}>
            <option value="">—</option>{specs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>) },
        { key: 'dia', label: 'Ø mm', sortable: false, render: (r) => <input aria-label="Diameter" inputMode="numeric" value={r.diameter_mm} placeholder={dia(r) ? String(dia(r)) : ''} onChange={(e) => setRow(r._i, { diameter_mm: e.target.value })} style={{ width: 50 }} /> },
        { key: 'shape', label: 'Shape', sortable: false, render: (r) => <input aria-label="Shape code" value={r.shape_code} onChange={(e) => setRow(r._i, { shape_code: e.target.value })} style={{ width: 50 }} /> },
        { key: 'members', label: 'Members', sortable: false, render: (r) => <input aria-label="Members" inputMode="numeric" value={r.no_of_members} onChange={(e) => setRow(r._i, { no_of_members: e.target.value })} style={{ width: 55 }} /> },
        { key: 'bars', label: 'Bars/mbr', sortable: false, render: (r) => <input aria-label="Bars per member" inputMode="numeric" value={r.bars_per_member} onChange={(e) => setRow(r._i, { bars_per_member: e.target.value })} style={{ width: 55 }} /> },
        { key: 'len', label: 'Cut length m', sortable: false, render: (r) => <input aria-label="Cut length" inputMode="decimal" value={r.cut_length_m} onChange={(e) => setRow(r._i, { cut_length_m: e.target.value })} style={{ width: 70 }} /> },
        { key: 'kg', label: 'kg', align: 'right', sortable: false, render: (r) => num(weight(r), 2) },
        { key: 'x', label: '', sortable: false, render: (r) => <button className="icon-btn" aria-label="Remove line" onClick={() => setRows(rows.filter((_, j) => j !== r._i))}><Trash2 size={14} /></button> },
      ]} />
      <button className="mt-2" onClick={() => setRows([...rows, blankLine()])}><Plus size={14} aria-hidden />Add line</button>
    </Drawer>
  );
}

function ReconciliationTab() {
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<RebarReconciliationRow>((a, b) => supabase.from('v_rebar_reconciliation').select('*').eq('project_id', projectId)
    .order('element_code').order('diameter_mm').range(a, b)), [projectId], { key: 'rebar-recon' });
  const [f, setF, { active, clear }] = useUrlFilters({ flag: '', block: '', type: '', dia: '', flagged: '' }, 'r_');
  const L = lk.data;
  const all = q.data ?? [];
  const rows = useMemo(() => all.filter((r) => (!f.flag || r.flag === f.flag) && (!f.flagged || r.flag !== 'ok') && (!f.block || r.block_id === f.block)
    && (!f.type || r.element_type === f.type) && (!f.dia || String(r.diameter_mm) === f.dia)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [q.data, f.flag, f.flagged, f.block, f.type, f.dia]);
  const sum = (k: keyof RebarReconciliationRow) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const basis = sum('basis_kg'); const net = sum('net_issued_kg');
  const types = [...new Set(all.map((r) => r.element_type))].sort();
  const dias = [...new Set(all.map((r) => r.diameter_mm))].sort((a, b) => a - b);
  return (
    <>
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <div className="kpis">
        <Kpi label="BBS / take-off basis" loading={!q.data} value={num(basis / 1000, 2)} unit="t" />
        <Kpi label="Net issued" loading={!q.data} value={num(net / 1000, 2)} unit="t" hint="Issued (MIV) − returned (MRN)" />
        <Kpi label="Variance" loading={!q.data} value={basis ? `${net >= basis ? '+' : ''}${num((net / basis - 1) * 100, 1)}` : '—'} unit={basis ? '%' : undefined} status={basis && net / basis - 1 > 0.05 ? 'danger' : undefined} />
        <Kpi label="Flagged rows" loading={!q.data} value={all.filter((r) => r.flag !== 'ok').length} status={all.some((r) => r.flag === 'over') ? 'danger' : undefined} />
      </div>
      <FilterBar active={active} onClear={clear}>
        <FilterToggle label="Flagged only" checked={!!f.flagged} onChange={(v) => setF('flagged', v ? '1' : '')} />
        <FilterSelect label="Flag" value={f.flag} onChange={(v) => setF('flag', v)} options={[{ value: 'over', label: 'Over' }, { value: 'under', label: 'Under' }, { value: 'no_basis', label: 'No basis' }, { value: 'ok', label: 'OK' }]} />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={(L?.blocks ?? []).map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Type" value={f.type} onChange={(v) => setF('type', v)} options={types.map((t) => ({ value: t, label: t }))} />
        <FilterSelect label="Ø" value={f.dia} onChange={(v) => setF('dia', v)} options={dias.map((d) => ({ value: String(d), label: `Ø${d}` }))} />
      </FilterBar>
      <DataTable rows={rows} rowKey={(r) => `${r.element_id}:${r.diameter_mm}`} loading={!q.data || !L} error={q.error} urlKey="r_" stickyFirst exportName="rebar-reconciliation"
        filtered={active > 0} onClearFilters={clear}
        empty={{ title: 'Nothing to reconcile yet', body: 'Rows appear once elements have a BBS, rebar take-offs or rebar issues.' }}
        columns={[
          { key: 'element_code', label: 'Element', id: true, value: (r) => L?.element(r.element_id) ?? r.element_code },
          { key: 'element_type', label: 'Type' },
          { key: 'diameter_mm', label: 'Ø', align: 'right', render: (r) => <>{r.diameter_mm}<span className="unit">mm</span></> },
          { key: 'bbs', label: 'BBS', value: (r) => (r.bbs_number ? `${r.bbs_number} r${r.bbs_revision}` : ''), render: (r) => (r.bbs_number ? <>{r.bbs_number} <SBadge value={r.bbs_status} /></> : '') },
          { key: 'bbs_kg', label: 'BBS kg', align: 'right', render: (r) => num(r.bbs_kg, 1) },
          { key: 'takeoff_kg', label: 'Take-off kg', align: 'right', render: (r) => num(r.takeoff_kg, 1) },
          { key: 'bbs_vs_takeoff_pct', label: 'BBS vs TO', align: 'right', render: (r) => (r.bbs_vs_takeoff_pct === null ? '' : `${Number(r.bbs_vs_takeoff_pct) > 0 ? '+' : ''}${num(r.bbs_vs_takeoff_pct, 1)}%`) },
          { key: 'issued_kg', label: 'Issued kg', align: 'right', render: (r) => num(r.issued_kg, 1) },
          { key: 'returned_kg', label: 'Returned kg', align: 'right', render: (r) => num(r.returned_kg, 1) },
          { key: 'net_issued_kg', label: 'Net kg', align: 'right', render: (r) => num(r.net_issued_kg, 1) },
          { key: 'variance_pct', label: 'Variance', align: 'right', render: (r) => (r.variance_pct === null ? '' : <span className={r.flag === 'over' ? 'danger-text strong' : r.flag === 'under' ? 'warn-text' : ''}>{Number(r.variance_pct) > 0 ? '+' : ''}{num(r.variance_pct, 1)}%</span>) },
          { key: 'allowance_pct', label: 'Allowance', align: 'right', render: (r) => `${num(r.allowance_pct, 1)}%` },
          { key: 'flag', label: 'Flag', render: (r) => <SBadge value={r.flag} /> },
          { key: 'element_status', label: 'Element status', hidden: true },
          { key: 'variance_kg', label: 'Variance kg', align: 'right', hidden: true, render: (r) => num(r.variance_kg, 1) },
        ]}
        footer={rows.length > 0 && <tr><td colSpan={4} className="strong">Total</td><td className="right">{num(sum('bbs_kg'), 0)}</td><td className="right">{num(sum('takeoff_kg'), 0)}</td><td /><td className="right">{num(sum('issued_kg'), 0)}</td><td className="right">{num(sum('returned_kg'), 0)}</td><td className="right">{num(net, 0)}</td><td colSpan={3} /></tr>} />
    </>
  );
}

interface ImportLine { element_id: string; drawing_ref: string | null; bar_mark: string; material_spec_id: string | null; diameter_mm: number; shape_code: string | null; no_of_members: number; bars_per_member: number; cut_length_m: number }
const HEADERS = ['Element ID', 'Block', 'Level', 'Bar mark', 'Diameter', 'Material grade', 'Shape code', 'No of members', 'Bars per member', 'Cut length (m)', 'Drawing ref'];

function ImportTab({ onDone }: { onDone: () => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const L = lk.data;
  if (!L) return <Loading lines={6} />;
  const specs = rebarSpecs(L);
  const validate = async (rows: Record<string, unknown>[]): Promise<ImportRow<ImportLine>[]> => rows.map((r, i) => {
    const code = cellStr(pick(r, 'Element ID', 'Element', 'Code'));
    const block = cellStr(pick(r, 'Block')).toLowerCase();
    const level = cellStr(pick(r, 'Level')).toLowerCase();
    const mark = cellStr(pick(r, 'Bar mark', 'Mark'));
    const grade = cellStr(pick(r, 'Material grade', 'Grade', 'Material'));
    const diaCell = cellNum(pick(r, 'Diameter', 'Dia', 'Ø'));
    const members = cellNum(pick(r, 'No of members', 'Members')) ?? 1;
    const bars = cellNum(pick(r, 'Bars per member', 'No of bars', 'Bars'));
    const len = cellNum(pick(r, 'Cut length (m)', 'Cut length', 'Length'));
    const errors: string[] = [];
    const matches = L.elements.filter((e) => e.code.toLowerCase() === code.toLowerCase()
      && (!block || L.block(e.block_id).toLowerCase() === block) && (!level || L.level(e.level_id).toLowerCase() === level));
    if (!code) errors.push('Element ID missing'); else if (!matches.length) errors.push('Unknown element'); else if (matches.length > 1) errors.push('Element ambiguous — add Block/Level');
    if (!mark) errors.push('Bar mark missing');
    const spec = grade ? specs.find((s) => s.grade.toLowerCase() === grade.toLowerCase() || s.label.toLowerCase() === grade.toLowerCase())
      : diaCell ? specs.find((s) => specDiameter(s.grade) === diaCell) : undefined;
    if (grade && !spec) errors.push(`Unknown rebar grade "${grade}"`);
    const dia = diaCell ?? (spec ? specDiameter(spec.grade) : null);
    if (!dia) errors.push('Diameter missing');
    if (!bars || bars <= 0) errors.push('Bars per member missing');
    if (!len || len <= 0) errors.push('Cut length missing');
    if (len && len > 24) errors.push('Cut length looks like mm — enter metres');
    return {
      rowNo: i + 2, errors,
      record: errors.length ? null : { element_id: matches[0].id, drawing_ref: cellStr(pick(r, 'Drawing ref', 'Drawing')) || null, bar_mark: mark, material_spec_id: spec?.id ?? null,
        diameter_mm: dia!, shape_code: cellStr(pick(r, 'Shape code', 'Shape')) || null, no_of_members: members, bars_per_member: bars!, cut_length_m: len! },
      display: { 'Element ID': code, Block: block, Level: level, 'Bar mark': mark, Diameter: dia ? String(dia) : '', 'Material grade': spec?.grade ?? grade, 'Shape code': cellStr(pick(r, 'Shape code', 'Shape')),
        'No of members': String(members), 'Bars per member': bars === null ? '' : String(bars), 'Cut length (m)': len === null ? '' : String(len), 'Drawing ref': cellStr(pick(r, 'Drawing ref', 'Drawing')),
        kg: dia && bars && len ? num(bbsWeightKg(dia, members, bars, len), 2) : '' },
    };
  });
  const commit = async (records: ImportLine[]) => {
    const byEl = new Map<string, ImportLine[]>();
    for (const r of records) byEl.set(r.element_id, [...(byEl.get(r.element_id) ?? []), r]);
    let n = 0;
    for (const [element_id, lines] of byEl) {
      const number = await nextNumber(auth.project?.code ?? 'PRJ', 'BBS', 'bbs_schedules');
      await rpcx('save_bbs', { id: uuid(), project_id: projectId, number, element_id, drawing_ref: lines.find((l) => l.drawing_ref)?.drawing_ref ?? undefined,
        remarks: 'Imported from Excel', lines: lines.map((l) => ({ id: uuid(), bar_mark: l.bar_mark, material_spec_id: l.material_spec_id ?? undefined, diameter_mm: l.diameter_mm,
          shape_code: l.shape_code ?? undefined, no_of_members: l.no_of_members, bars_per_member: l.bars_per_member, cut_length_m: l.cut_length_m })) });
      n++;
    }
    setTimeout(onDone, 1500);
    return `${n} draft BBS created (${records.length} lines). Review and approve them under Schedules.`;
  };
  return (
    <ImportWizard title="Import bar bending schedules" templateFile="bbs-template.xlsx" headers={HEADERS} required={['Element ID', 'Bar mark', 'Bars per member', 'Cut length (m)']}
      aliases={{ 'Element ID': ['Element', 'Code'], 'Bar mark': ['Mark'], Diameter: ['Dia', 'Ø'], 'Material grade': ['Grade'], 'Shape code': ['Shape'],
        'No of members': ['Members'], 'Bars per member': ['No of bars', 'Bars'], 'Cut length (m)': ['Cut length', 'Length'], 'Drawing ref': ['Drawing'] }}
      example={['C12', 'A', 'L2', 'a1', 16, 'S-400 Ø16', '21', 1, 4, 3.45, 'S-201 rev B']}
      validate={validate} commit={commit}
      note="One draft BBS (next revision) is created per element. Diameter is taken from the grade (e.g. “S-400 Ø16”) when blank. Weight = members × bars × cut length × Ø²/162." />
  );
}
