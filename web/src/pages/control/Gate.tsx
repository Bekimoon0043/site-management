import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Truck } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { canControl, type GateEvent, type GatePass, type GatePassLine, type GatePassType, type VehicleMovement } from '../../lib/contract-control';
import { nextNumber, optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, dateTime, dueIn, humanize, today, since } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { SBadge } from '../../components/field/StatusBadge';
import {
  Badge, Banner, DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterDate, FilterSelect, FilterToggle, Page, QtyInput, SearchInput, Tabs, toast, useBusy, useHashTab,
} from '../../components/ui';

const TABS = ['passes', 'vehicles', 'events'] as const;
type Tab = (typeof TABS)[number];
export type GpRow = GatePass & { gate_pass_lines: Pick<GatePassLine, 'id' | 'qty' | 'qty_returned' | 'deleted_at'>[] };
const OUT = ['exited', 'partially_returned'];
export const GP_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', pending: 'Awaiting approval', approved: 'Approved — ready to leave', rejected: 'Rejected', exited: 'Left site',
  partially_returned: 'Part returned', returned: 'Returned', cancelled: 'Cancelled',
};

/** Gate passes (outgoing material control), vehicle log and gate event history (P1-10 / D1). */
export function Gate() {
  const [tab, setTab] = useHashTab<Tab>(TABS, 'passes');
  return (
    <Page title="Gate & vehicles" subtitle="Material gate passes, returnables on loan, the vehicle log and checks at the gate">
      <Tabs label="Gate sections" value={tab} onChange={setTab} tabs={[{ key: 'passes', label: 'Gate passes' }, { key: 'vehicles', label: 'Vehicle log' }, { key: 'events', label: 'Gate events' }]} />
      {tab === 'passes' && <PassesTab />}
      {tab === 'vehicles' && <VehiclesTab />}
      {tab === 'events' && <EventsTab />}
    </Page>
  );
}

function PassesTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<GpRow>((a, b) => supabase.from('gate_passes').select('*, gate_pass_lines(id, qty, qty_returned, deleted_at)')
    .eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b)), [projectId], { key: 'gate-passes' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: '', type: '', overdue: '', q: '' });
  const [creating, setCreating] = useState(false);
  const L = lk.data;
  const t = today();
  const isOverdue = (r: GpRow) => r.pass_type === 'returnable' && OUT.includes(r.status) && !!r.expected_return && r.expected_return < t;
  const term = f.q.toLowerCase();
  const all = q.data ?? [];
  const rows = all.filter((r) => (!f.status || (f.status === 'out' ? OUT.includes(r.status) : r.status === f.status)) && (!f.type || r.pass_type === f.type)
    && (!f.overdue || isOverdue(r)) && (!term || `${r.number} ${r.destination} ${r.vehicle_plate ?? ''} ${r.purpose}`.toLowerCase().includes(term)));
  const onLoan = all.filter((r) => r.pass_type === 'returnable' && OUT.includes(r.status)).length;
  const overdue = all.filter(isOverdue).length;
  return (
    <>
      {overdue > 0 && <Banner tone="error" action={<button className="small" onClick={() => setF('overdue', '1')}>Show</button>}>{overdue} returnable gate pass{overdue === 1 ? ' is' : 'es are'} overdue for return.</Banner>}
      <ErrorBanner error={q.error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}
        right={canControl(auth.profile?.role, 'gatepass.create') && <button className="primary" onClick={() => setCreating(true)}><Plus size={14} aria-hidden />New gate pass</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Pass no., destination, plate" />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'out', label: `Out on loan (${onLoan})` }, ...Object.entries(GP_STATUS_LABEL).map(([k, v]) => ({ value: k, label: v }))]} />
        <FilterSelect label="Type" value={f.type} onChange={(v) => setF('type', v)} options={[{ value: 'returnable', label: 'Returnable' }, { value: 'non_returnable', label: 'Non-returnable' }]} />
        <FilterToggle label="Overdue returns" checked={!!f.overdue} onChange={(v) => setF('overdue', v ? '1' : '')} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !L} error={q.error} onRetry={q.reload} urlKey="" stickyFirst exportName="gate-passes" viewKey="gate-passes"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => nav(`/gate/${r.id}`)}
        empty={{ title: 'No gate passes yet', body: 'Every material leaving site needs an approved gate pass — returnable (formwork, tools) or non-returnable (scrap, supplier returns).' }}
        columns={[
          { key: 'number', label: 'Pass', id: true },
          { key: 'status', label: 'Status', value: (r) => GP_STATUS_LABEL[r.status], render: (r) => <SBadge gate value={r.status} label={r.status === 'pending' ? 'Awaiting approval' : undefined} /> },
          { key: 'pass_type', label: 'Type', value: (r) => humanize(r.pass_type), render: (r) => <Badge tone={r.pass_type === 'returnable' ? 'info' : 'neutral'} label={r.pass_type === 'returnable' ? 'Returnable' : 'Non-returnable'} icon={null} /> },
          { key: 'destination', label: 'Destination' },
          { key: 'purpose', label: 'Purpose' },
          { key: 'vehicle_plate', label: 'Vehicle' },
          { key: 'lines', label: 'Lines', align: 'right', value: (r) => r.gate_pass_lines.filter((l) => !l.deleted_at).length },
          { key: 'expected_return', label: 'Return due', value: (r) => r.expected_return, render: (r) => {
            if (!r.expected_return) return '';
            const d = OUT.includes(r.status) ? dueIn(r.expected_return) : null;
            return <span className="nowrap">{date(r.expected_return)}{d?.text && <span className={`small-text ${d.late ? 'danger-text' : 'muted'}`}> · {d.text}</span>}</span>;
          } },
          { key: 'requested_by', label: 'Requested by', value: (r) => L?.person(r.requested_by) },
          { key: 'created_at', label: 'Created', value: (r) => r.created_at, render: (r) => dateTime(r.created_at) },
          { key: 'store', label: 'Store', hidden: true, value: (r) => L?.store(r.store_id) },
          { key: 'driver_name', label: 'Driver', hidden: true },
          { key: 'approved', label: 'Approved by', hidden: true, value: (r) => L?.person(r.approved_by) },
        ]} />
      {creating && <GatePassForm onClose={() => setCreating(false)} onSaved={(id) => nav(`/gate/${id}`)} />}
    </>
  );
}

interface LineDraft { id: string; material_spec_id: string; description: string; qty: string; uom: string }
const blankLine = (): LineDraft => ({ id: uuid(), material_spec_id: '', description: '', qty: '', uom: '' });

/** Create or edit (draft/pending/rejected) a gate pass; `submit` sends it for approval. */
export function GatePassForm({ pass, lines, onClose, onSaved }: { pass?: GatePass; lines?: GatePassLine[]; onClose: () => void; onSaved: (id: string) => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const L = lk.data;
  const [form, setForm] = useState({
    pass_type: (pass?.pass_type ?? 'returnable') as GatePassType, store_id: pass?.store_id ?? '', destination: pass?.destination ?? '', purpose: pass?.purpose ?? '',
    vehicle_plate: pass?.vehicle_plate ?? '', driver_name: pass?.driver_name ?? '', driver_phone: pass?.driver_phone ?? '', expected_return: pass?.expected_return ?? '',
  });
  const [rows, setRows] = useState<LineDraft[]>(lines?.filter((l) => !l.deleted_at).map((l) => ({ id: l.id, material_spec_id: l.material_spec_id ?? '', description: l.description ?? '', qty: String(l.qty), uom: l.uom ?? '' })) ?? [blankLine()]);
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });
  const setRow = (i: number, patch: Partial<LineDraft>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const { busy, error, run } = useBusy();
  const save = (submit: boolean) => run(async () => {
    const clean = rows.filter((r) => r.material_spec_id || r.description.trim() || r.qty);
    if (!form.destination.trim() || !form.purpose.trim()) throw new Error('Destination and purpose are required.');
    if (form.pass_type === 'returnable' && !form.expected_return) throw new Error('A returnable pass needs an expected return date.');
    if (!clean.length) throw new Error('Add at least one item.');
    if (clean.some((r) => r.material_spec_id) && !form.store_id) throw new Error('Choose the store that stock items leave from.');
    clean.forEach((r, i) => { if (!(Number(r.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero.`); if (!r.material_spec_id && !r.description.trim()) throw new Error(`Line ${i + 1}: choose a material or describe the item.`); });
    const id = pass?.id ?? uuid();
    const number = pass?.number ?? await nextNumber(auth.project?.code ?? 'PRJ', 'GP', 'gate_passes');
    await rpcx('save_gate_pass', {
      id, project_id: projectId, number, pass_type: form.pass_type, store_id: form.store_id || null, destination: form.destination.trim(), purpose: form.purpose.trim(),
      vehicle_plate: optStr(form.vehicle_plate), driver_name: optStr(form.driver_name), driver_phone: optStr(form.driver_phone),
      expected_return: form.pass_type === 'returnable' ? form.expected_return : null, submit,
      lines: clean.map((r) => ({ id: r.id, material_spec_id: r.material_spec_id || null, description: optStr(r.description), qty: Number(r.qty), uom: optStr(r.uom) })),
    });
    toast.success(`${number} ${submit ? 'sent for approval' : 'saved as draft'}`);
    onSaved(id);
  });
  return (
    <Drawer size="lg" title={pass ? `Edit ${pass.number}` : 'New gate pass'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <span className="spacer" />
      <button disabled={busy} onClick={() => void save(false)}>Save draft</button>
      <button className="primary" disabled={busy} onClick={() => void save(true)}>{busy && <span className="spinner" />}Submit for approval</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Type" required>
          <select data-autofocus value={form.pass_type} onChange={(e) => set('pass_type', e.target.value)}>
            <option value="returnable">Returnable (formwork, tools, scaffold)</option><option value="non_returnable">Non-returnable (scrap, supplier return)</option>
          </select>
        </Field>
        {form.pass_type === 'returnable' && <Field label="Expected return" required><input type="date" value={form.expected_return} min={today()} onChange={(e) => set('expected_return', e.target.value)} /></Field>}
        <Field label="From store" hint="Required for stock items"><select value={form.store_id} onChange={(e) => set('store_id', e.target.value)}><option value="">—</option>{(L?.stores ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Destination" required><input value={form.destination} onChange={(e) => set('destination', e.target.value)} placeholder="Sister site, supplier, yard…" /></Field>
        <Field label="Purpose" required wide><input value={form.purpose} onChange={(e) => set('purpose', e.target.value)} /></Field>
        <Field label="Vehicle plate"><input value={form.vehicle_plate} onChange={(e) => set('vehicle_plate', e.target.value.toUpperCase())} placeholder="3-A12345 AA" /></Field>
        <Field label="Driver"><input value={form.driver_name} onChange={(e) => set('driver_name', e.target.value)} /></Field>
        <Field label="Driver phone"><input type="tel" value={form.driver_phone} onChange={(e) => set('driver_phone', e.target.value)} /></Field>
      </div>
      <h3 className="mt-2">Items</h3>
      <DataTable rows={rows.map((r, i) => ({ ...r, _i: i }))} rowKey={(r) => r.id} maxHeight="none" virtual={false} columns={[
        { key: 'spec', label: 'Stock item', sortable: false, render: (r) => (
          <select aria-label="Material" value={r.material_spec_id} onChange={(e) => setRow(r._i, { material_spec_id: e.target.value, uom: L?.specUom(e.target.value) ?? '' })} style={{ maxWidth: 260 }}>
            <option value="">— not a stock item —</option>{(L?.specs ?? []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>) },
        { key: 'description', label: 'Description', sortable: false, render: (r) => <input aria-label="Description" value={r.description} onChange={(e) => setRow(r._i, { description: e.target.value })} placeholder={r.material_spec_id ? 'optional' : 'Item description'} /> },
        { key: 'qty', label: 'Qty', sortable: false, render: (r) => <QtyInput aria-label="Quantity" value={r.qty} onChange={(v) => setRow(r._i, { qty: v })} unit={r.material_spec_id ? L?.specUom(r.material_spec_id) : undefined} width={120} /> },
        { key: 'uom', label: 'Unit', sortable: false, render: (r) => (r.material_spec_id ? <span className="muted">{L?.specUom(r.material_spec_id)}</span> : <input aria-label="Unit" value={r.uom} onChange={(e) => setRow(r._i, { uom: e.target.value })} style={{ width: 60 }} />) },
        { key: 'x', label: '', sortable: false, render: (r) => <button className="icon-btn" aria-label="Remove line" onClick={() => setRows(rows.filter((_, j) => j !== r._i))}><Trash2 size={14} /></button> },
      ]} />
      <button className="mt-2" onClick={() => setRows([...rows, blankLine()])}><Plus size={14} aria-hidden />Add item</button>
      <p className="muted small-text">Stock items leave the store ledger when the guard verifies the exit; returnables move to “on loan” until returned.</p>
    </Drawer>
  );
}

function VehiclesTab() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const q = useAsync(() => fetchAll<VehicleMovement>((a, b) => supabase.from('vehicle_movements').select('*').eq('project_id', projectId).order('at', { ascending: false }).range(a, b), 5000),
    [projectId], { key: 'vehicle-log' });
  const lk = useLookups(projectId);
  const [f, setF, { active, clear }] = useUrlFilters({ dir: '', flagged: '', from: '', to: '', q: '' }, 'v_');
  const [logging, setLogging] = useState(false);
  const term = f.q.toLowerCase();
  const rows = (q.data ?? []).filter((r) => (!f.dir || r.direction === f.dir) && (!f.flagged || r.flagged) && (!f.from || r.at.slice(0, 10) >= f.from) && (!f.to || r.at.slice(0, 10) <= f.to)
    && (!term || `${r.plate} ${r.number} ${r.driver_name ?? ''} ${r.purpose ?? ''}`.toLowerCase().includes(term)));
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}
        right={canControl(auth.profile?.role, 'vehicle.log') && <button className="primary" onClick={() => setLogging(true)}><Truck size={14} aria-hidden />Log vehicle</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Plate, driver, purpose" />
        <FilterSelect label="Direction" value={f.dir} onChange={(v) => setF('dir', v)} options={[{ value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} />
        <FilterToggle label="Flagged" checked={!!f.flagged} onChange={(v) => setF('flagged', v ? '1' : '')} />
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="to" value={f.to} onChange={(v) => setF('to', v)} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !lk.data} error={q.error} onRetry={q.reload} urlKey="v_" exportName="vehicle-log"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => { if (r.linked_doc_type === 'gate_pass' && r.linked_doc_id) nav(`/gate/${r.linked_doc_id}`); else if (r.linked_doc_type === 'grn' && r.linked_doc_id) nav(`/store?open=${r.linked_doc_id}#grn`); }}
        empty={{ title: 'No vehicles logged', body: 'Every vehicle entering or leaving the gate is logged here (mobile gate app or this page).' }}
        columns={[
          { key: 'at', label: 'Time', value: (r) => r.at, render: (r) => dateTime(r.at) },
          { key: 'direction', label: 'Dir.', render: (r) => <Badge tone={r.direction === 'in' ? 'info' : 'primary'} label={r.direction === 'in' ? 'In' : 'Out'} icon={null} /> },
          { key: 'plate', label: 'Plate', id: true },
          { key: 'driver_name', label: 'Driver' },
          { key: 'purpose', label: 'Purpose' },
          { key: 'loaded', label: 'Loaded', value: (r) => (r.loaded ? 'Yes' : 'No') },
          { key: 'linked', label: 'Document', value: (r) => (r.linked_doc_type ? humanize(r.linked_doc_type) : '') },
          { key: 'flagged', label: 'Flag', value: (r) => (r.flagged ? 'Flagged' : ''), render: (r) => (r.flagged ? <SBadge value="critical" label="Loaded, no document" /> : '') },
          { key: 'actor', label: 'Logged by', value: (r) => lk.data?.person(r.actor) },
          { key: 'number', label: 'No.', hidden: true },
        ]} />
      {logging && <LogVehicleDrawer onClose={() => setLogging(false)} />}
    </>
  );
}

function LogVehicleDrawer({ onClose }: { onClose: () => void }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const docs = useAsync(async () => {
    const [gps, grns] = await Promise.all([
      supabase.from('gate_passes').select('id, number, vehicle_plate, status').eq('project_id', projectId).in('status', ['approved', 'exited', 'partially_returned']).order('created_at', { ascending: false }).limit(100).then(check) as Promise<{ id: string; number: string; vehicle_plate: string | null; status: string }[]>,
      supabase.from('grns').select('id, number, vehicle_plate').eq('project_id', projectId).order('received_at', { ascending: false }).limit(100).then(check) as Promise<{ id: string; number: string; vehicle_plate: string | null }[]>,
    ]);
    return { gps, grns };
  }, [projectId], { key: 'gate-docs' });
  const [form, setForm] = useState({ direction: 'in' as 'in' | 'out', plate: '', driver_name: '', purpose: '', loaded: false, doc: '' });
  const { busy, error, run } = useBusy();
  const [docType, docId] = form.doc ? form.doc.split(':') as ['grn' | 'gate_pass', string] : [undefined, undefined];
  const save = () => run(async () => {
    if (!form.plate.trim()) throw new Error('Plate number is required.');
    const number = await nextNumber(auth.project?.code ?? 'PRJ', 'VEH', 'vehicle_movements');
    const r = await rpcx('log_vehicle', { id: uuid(), project_id: projectId, number, direction: form.direction, plate: form.plate.trim(), driver_name: optStr(form.driver_name),
      purpose: optStr(form.purpose), loaded: form.loaded, linked_doc_type: docType, linked_doc_id: docId });
    if (r.flagged) toast.error(`${form.plate.toUpperCase()} logged — loaded exit without a document: critical alert raised`);
    else toast.success(`${form.plate.toUpperCase()} logged ${form.direction}`);
    onClose();
  });
  const plate = form.plate.replace(/[\s-]/g, '').toUpperCase();
  const match = (p: string | null) => !!p && !!plate && p.replace(/[\s-]/g, '').toUpperCase() === plate;
  return (
    <Drawer title="Log vehicle" onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Log</button>
    </>}>
      <ErrorBanner error={error ?? docs.error} />
      <div className="form-grid one">
        <Field label="Direction" required>
          <span className="segmented" role="radiogroup">
            {(['in', 'out'] as const).map((d) => <button key={d} role="radio" aria-checked={form.direction === d} className={`tab${form.direction === d ? ' active' : ''}`} onClick={() => setForm({ ...form, direction: d })}>{d === 'in' ? 'In' : 'Out'}</button>)}
          </span>
        </Field>
        <Field label="Plate" required><input data-autofocus value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })} /></Field>
        <Field label="Driver"><input value={form.driver_name} onChange={(e) => setForm({ ...form, driver_name: e.target.value })} /></Field>
        <Field label="Purpose"><input value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} /></Field>
        <Field label="Loaded" check><input type="checkbox" checked={form.loaded} onChange={(e) => setForm({ ...form, loaded: e.target.checked })} /></Field>
        <Field label="Linked document" hint={form.direction === 'out' && form.loaded && !form.doc ? 'A loaded exit without a gate pass is flagged and raises a critical alert.' : undefined}>
          <select value={form.doc} onChange={(e) => setForm({ ...form, doc: e.target.value })}>
            <option value="">None</option>
            <optgroup label="Gate passes">{(docs.data?.gps ?? []).map((g) => <option key={g.id} value={`gate_pass:${g.id}`}>{match(g.vehicle_plate) ? '★ ' : ''}{g.number}{g.vehicle_plate ? ` · ${g.vehicle_plate}` : ''} · {humanize(g.status)}</option>)}</optgroup>
            <optgroup label="Receipts (GRN)">{(docs.data?.grns ?? []).map((g) => <option key={g.id} value={`grn:${g.id}`}>{match(g.vehicle_plate) ? '★ ' : ''}{g.number}{g.vehicle_plate ? ` · ${g.vehicle_plate}` : ''}</option>)}</optgroup>
          </select>
        </Field>
      </div>
    </Drawer>
  );
}

function EventsTab() {
  const projectId = useProjectId();
  const nav = useNavigate();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<GateEvent & { gate_passes: { number: string; vehicle_plate: string | null } | null }>((a, b) => supabase.from('gate_events')
    .select('*, gate_passes(number, vehicle_plate)').eq('project_id', projectId).order('at', { ascending: false }).range(a, b), 5000), [projectId], { key: 'gate-events' });
  const [f, setF, { active, clear }] = useUrlFilters({ event: '' }, 'e_');
  const rows = (q.data ?? []).filter((r) => !f.event || r.event === f.event);
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}>
        <FilterSelect label="Event" value={f.event} onChange={(v) => setF('event', v)} options={[{ value: 'exit_verified', label: 'Exit verified' }, { value: 'exit_mismatch', label: 'Exit mismatch' }, { value: 'return_in', label: 'Returned in' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !lk.data} error={q.error} onRetry={q.reload} urlKey="e_" exportName="gate-events" filtered={active > 0} onClearFilters={clear}
        onRowClick={(r) => r.gate_pass_id && nav(`/gate/${r.gate_pass_id}`)}
        empty={{ title: 'No gate events', body: 'Exit checks and returns recorded by the guard appear here.' }}
        columns={[
          { key: 'at', label: 'Time', value: (r) => r.at, render: (r) => <span title={dateTime(r.at)}>{dateTime(r.at)} <span className="muted small-text">({since(r.at)})</span></span> },
          { key: 'event', label: 'Event', render: (r) => <SBadge value={r.event} /> },
          { key: 'pass', label: 'Gate pass', id: true, value: (r) => r.gate_passes?.number },
          { key: 'plate_seen', label: 'Plate seen', render: (r) => <>{r.plate_seen}{r.gate_passes?.vehicle_plate && r.plate_seen && r.matches === false ? <span className="danger-text small-text"> (pass: {r.gate_passes.vehicle_plate})</span> : null}</> },
          { key: 'note', label: 'Note' },
          { key: 'actor', label: 'Guard', value: (r) => lk.data?.person(r.actor) },
        ]} />
    </>
  );
}

export const gpRemaining = (l: Pick<GatePassLine, 'qty' | 'qty_returned'>) => Math.max(0, Number(l.qty) - Number(l.qty_returned));
