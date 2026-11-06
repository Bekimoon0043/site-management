// /plant — plant & equipment: register (owned / hired), daily log per machine (meter, hours, fuel, breakdowns)
// and utilisation over a period. Migration 20261105000030_site_ops.sql.
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import {
  IDLE_REASONS, PLANT_CATEGORY_LABELS, PLANT_STATUS_LABELS, canSite, type PlantCategory, type PlantItem, type PlantLog, type PlantLogStatus, type PlantStatus,
} from '../../lib/contract-site';
import { Attachments } from '../../components/Attachments';
import { Badge, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, Page, Tabs, toast, useBusy, useHashTab, type Tone } from '../../components/ui';
import { addDays, etToday, loadPlant, loadPlantLogs, loadUtilisation, siteRpc } from '../../components/site/data';

const TABS = ['log', 'register', 'utilisation'] as const;
const STATUS_TONE: Record<PlantStatus, Tone> = { active: 'success', under_repair: 'danger', off_hire: 'neutral' };
const LOG_TONE: Record<PlantLogStatus, Tone> = { working: 'success', idle: 'warning', breakdown: 'danger' };

export function Plant() {
  const projectId = useProjectId();
  const [tab, setTab] = useHashTab(TABS, 'log');
  const pq = useAsync(() => loadPlant(projectId), [projectId], { key: 'plant-items' });
  return (
    <Page title="Plant & equipment" subtitle="Machines on site, the daily log of hours, fuel and breakdowns, and how well they are used">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'log', label: 'Daily log' }, { key: 'register', label: 'Register' }, { key: 'utilisation', label: 'Utilisation' }]} />
      <div className="mt-3">
        <ErrorBanner error={pq.error} onRetry={pq.reload} />
        {tab === 'register' ? <Register plant={pq.data} reload={pq.reload} />
          : tab === 'utilisation' ? <Utilisation />
          : <DailyLog plant={pq.data} />}
      </div>
    </Page>
  );
}

function DailyLog({ plant }: { plant?: PlantItem[] }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const [day, setDay] = useState(etToday());
  const lq = useAsync(() => loadPlantLogs(projectId, addDays(day, -1), day), [projectId, day], { key: 'plant-logs' });
  const [open, setOpen] = useState<{ plant: PlantItem; log: PlantLog | null; prev: PlantLog | null } | null>(null);
  const canLog = canSite(auth.profile?.role, 'plant.log');
  const rows = (plant ?? []).filter((p) => p.status !== 'off_hire');
  const logOf = (pid: string, d: string) => (lq.data ?? []).find((l) => l.plant_id === pid && l.log_date === d) ?? null;
  const todays = rows.map((p) => logOf(p.id, day)).filter(Boolean) as PlantLog[];
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Day"><input type="date" value={day} max={etToday()} onChange={(e) => e.target.value && setDay(e.target.value)} /></Field>
      </div>
      <div className="kpis">
        <Kpi label="Machines on site" value={num(rows.length, 0)} />
        <Kpi label="Logged this day" value={`${todays.length} / ${rows.length}`} />
        <Kpi label="Hours worked" value={num(todays.reduce((s, l) => s + Number(l.hours_worked), 0), 1)} />
        <Kpi label="Fuel (litres)" value={num(todays.reduce((s, l) => s + Number(l.fuel_litres), 0), 0)} />
        <Kpi label="Breakdowns" value={num(todays.filter((l) => l.status === 'breakdown').length, 0)} />
      </div>
      <ErrorBanner error={lq.error} onRetry={lq.reload} />
      <Card flush title={`Plant log — ${date(day)}`} sub={canLog ? 'Click a machine to enter or correct its log for the day' : undefined}>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!plant || !lq.data} exportName={`plant-log-${day}`}
          onRowClick={canLog ? (p) => setOpen({ plant: p, log: logOf(p.id, day), prev: logOf(p.id, addDays(day, -1)) }) : undefined}
          empty={{ title: 'No plant registered', body: 'Add the machines on site under Register.' }}
          columns={[
            { key: 'code', label: 'Code', id: true },
            { key: 'name', label: 'Machine', render: (p) => <span>{p.name} <span className="muted small-text">{p.ownership === 'hired' ? `hired${p.supplier ? ` · ${p.supplier}` : ''}` : 'own'}</span></span> },
            { key: 'status', label: 'Today', value: (p) => logOf(p.id, day)?.status ?? '', render: (p) => { const l = logOf(p.id, day); return l ? <Badge tone={LOG_TONE[l.status]} label={l.status} icon={null} /> : <span className="muted">not logged</span>; } },
            { key: 'operator', label: 'Operator', value: (p) => logOf(p.id, day)?.operator_name ?? '' },
            { key: 'meter', label: 'Meter', align: 'right', value: (p) => Number(logOf(p.id, day)?.meter_end ?? p.last_meter ?? 0),
              render: (p) => { const l = logOf(p.id, day); return l?.meter_start != null ? `${num(l.meter_start, 1)} → ${num(l.meter_end, 1)}` : p.last_meter != null ? <span className="muted">{num(p.last_meter, 1)}</span> : '—'; } },
            { key: 'worked', label: 'Worked h', align: 'right', value: (p) => Number(logOf(p.id, day)?.hours_worked ?? 0), render: (p) => (logOf(p.id, day) ? num(logOf(p.id, day)!.hours_worked, 1) : '') },
            { key: 'idle', label: 'Idle h', align: 'right', value: (p) => Number(logOf(p.id, day)?.hours_idle ?? 0), render: (p) => { const l = logOf(p.id, day); return l && Number(l.hours_idle) ? `${num(l.hours_idle, 1)}${l.idle_reason ? ` · ${l.idle_reason}` : ''}` : ''; } },
            { key: 'down', label: 'Breakdown h', align: 'right', value: (p) => Number(logOf(p.id, day)?.hours_breakdown ?? 0), render: (p) => { const l = logOf(p.id, day); return l && Number(l.hours_breakdown) ? num(l.hours_breakdown, 1) : ''; } },
            { key: 'fuel', label: 'Fuel l', align: 'right', value: (p) => Number(logOf(p.id, day)?.fuel_litres ?? 0), render: (p) => { const l = logOf(p.id, day); return l && Number(l.fuel_litres) ? num(l.fuel_litres, 0) : ''; } },
            { key: 'work', label: 'Work done / note', value: (p) => logOf(p.id, day)?.work_done ?? '', render: (p) => { const l = logOf(p.id, day); return l?.breakdown_note ?? l?.work_done ?? ''; } },
          ]} />
      </Card>
      {open && lk.data && <LogDrawer key={open.plant.id + day} day={day} {...open} L={lk.data} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); lq.reload(); }} />}
    </div>
  );
}

function LogDrawer({ plant, log, prev, day, onClose, onSaved }: { plant: PlantItem; log: PlantLog | null; prev: PlantLog | null; day: string; L: Lookups; onClose: () => void; onSaved: () => void }) {
  const projectId = useProjectId();
  const [id] = useState(() => log?.id ?? crypto.randomUUID());
  const start0 = log?.meter_start ?? prev?.meter_end ?? plant.last_meter;
  const [f, setF] = useState({
    status: (log?.status ?? 'working') as PlantLogStatus, operator_name: log?.operator_name ?? prev?.operator_name ?? '',
    meter_start: start0 == null ? '' : String(start0), meter_end: log?.meter_end == null ? '' : String(log.meter_end),
    hours_worked: log ? String(log.hours_worked) : '', hours_idle: String(log?.hours_idle ?? 0), idle_reason: log?.idle_reason ?? '',
    hours_breakdown: String(log?.hours_breakdown ?? 0), breakdown_note: log?.breakdown_note ?? '', fuel_litres: String(log?.fuel_litres ?? 0), work_done: log?.work_done ?? '',
  });
  const { busy, error, run } = useBusy();
  const meterHours = plant.meter_unit === 'hours' && f.meter_start !== '' && f.meter_end !== '' ? Number(f.meter_end) - Number(f.meter_start) : null;
  const n = (v: string) => (v === '' ? undefined : Number(v));
  const save = () => void run(async () => {
    await siteRpc('log_plant', { id, plant_id: plant.id, log_date: day, status: f.status, operator_name: f.operator_name || undefined,
      meter_start: n(f.meter_start), meter_end: n(f.meter_end), hours_worked: f.hours_worked === '' ? undefined : Number(f.hours_worked),
      hours_idle: n(f.hours_idle), idle_reason: f.idle_reason || undefined, hours_breakdown: n(f.hours_breakdown), breakdown_note: f.breakdown_note || undefined,
      fuel_litres: n(f.fuel_litres), work_done: f.work_done || undefined });
    toast.success(`${plant.code} logged for ${date(day)}${f.status === 'breakdown' ? ' — the coordinator is told about the breakdown' : ''}`);
    onSaved();
  });
  return (
    <Drawer onClose={onClose} title={`${plant.code} · ${plant.name}`} subtitle={`Daily log ${date(day)}`}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PlantLogStatus })}>
            <option value="working">Working</option><option value="idle">Idle all day</option><option value="breakdown">Breakdown</option>
          </select>
        </Field>
        <Field label="Operator / driver"><input value={f.operator_name} onChange={(e) => setF({ ...f, operator_name: e.target.value })} /></Field>
        {plant.meter_unit !== 'none' && <>
          <Field label={`Meter at start (${plant.meter_unit})`}><input type="number" step="0.1" value={f.meter_start} onChange={(e) => setF({ ...f, meter_start: e.target.value })} /></Field>
          <Field label={`Meter at end (${plant.meter_unit})`}><input type="number" step="0.1" value={f.meter_end} onChange={(e) => setF({ ...f, meter_end: e.target.value })} /></Field>
        </>}
        <Field label="Hours worked" hint={meterHours != null ? `From the meter: ${num(meterHours, 1)} h (leave empty to use it)` : undefined}>
          <input type="number" min={0} max={24} step="0.5" value={f.hours_worked} placeholder={meterHours != null ? String(meterHours) : ''} onChange={(e) => setF({ ...f, hours_worked: e.target.value })} />
        </Field>
        <Field label="Fuel issued (litres)"><input type="number" min={0} step="1" value={f.fuel_litres} onChange={(e) => setF({ ...f, fuel_litres: e.target.value })} /></Field>
        <Field label="Idle hours"><input type="number" min={0} max={24} step="0.5" value={f.hours_idle} onChange={(e) => setF({ ...f, hours_idle: e.target.value })} /></Field>
        {Number(f.hours_idle) > 0 && (
          <Field label="Idle because">
            <input list="idle-reasons" value={f.idle_reason} onChange={(e) => setF({ ...f, idle_reason: e.target.value })} />
            <datalist id="idle-reasons">{IDLE_REASONS.map((r) => <option key={r} value={r} />)}</datalist>
          </Field>
        )}
        <Field label="Breakdown hours"><input type="number" min={0} max={24} step="0.5" value={f.hours_breakdown} onChange={(e) => setF({ ...f, hours_breakdown: e.target.value })} /></Field>
        {(f.status === 'breakdown' || Number(f.hours_breakdown) > 0) && <Field label="What broke" required={f.status === 'breakdown'} wide><input value={f.breakdown_note} onChange={(e) => setF({ ...f, breakdown_note: e.target.value })} /></Field>}
        <Field label="Work done" wide><input value={f.work_done} onChange={(e) => setF({ ...f, work_done: e.target.value })} placeholder="e.g. Bulk excavation zone A, loading trucks" /></Field>
      </div>
      <div className="row mt-2"><button className="primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save log</button></div>
      {log && <Card title="Photos (meter, damage)"><Attachments entityType="plant_log" entityId={log.id} projectId={projectId} canAdd /></Card>}
    </Drawer>
  );
}

function Register({ plant, reload }: { plant?: PlantItem[]; reload: () => void }) {
  const auth = useAuth();
  const [open, setOpen] = useState<PlantItem | 'new' | null>(null);
  const edit = canSite(auth.profile?.role, 'plant.edit');
  return (
    <Card flush title="Plant register" actions={edit ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Add machine</button> : undefined}>
      <DataTable rows={plant ?? []} rowKey={(r) => r.id} loading={!plant} onRowClick={edit ? (r) => setOpen(r) : undefined} exportName="plant-register"
        empty={{ title: 'No plant registered', body: 'Add own and hired machines: excavators, mixers, vibrators, generators, cranes, trucks.' }}
        columns={[
          { key: 'code', label: 'Code', id: true },
          { key: 'name', label: 'Machine' },
          { key: 'category', label: 'Type', value: (r) => r.category, render: (r) => PLANT_CATEGORY_LABELS[r.category] },
          { key: 'ownership', label: 'Own / hired', value: (r) => r.ownership, render: (r) => (r.ownership === 'hired' ? `Hired${r.supplier ? ` · ${r.supplier}` : ''}` : 'Own') },
          { key: 'plate_no', label: 'Plate / serial', value: (r) => r.plate_no ?? '' },
          { key: 'last_meter', label: 'Last meter', align: 'right', value: (r) => Number(r.last_meter ?? 0), render: (r) => (r.last_meter == null ? '—' : `${num(r.last_meter, 1)} ${r.meter_unit === 'km' ? 'km' : 'h'}`) },
          { key: 'on_site_from', label: 'On site from', value: (r) => r.on_site_from ?? '', render: (r) => (r.on_site_from ? date(r.on_site_from) : '—') },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={STATUS_TONE[r.status]} label={PLANT_STATUS_LABELS[r.status]} icon={null} /> },
        ]} />
      {open && <PlantDrawer key={open === 'new' ? 'new' : open.id} item={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

function PlantDrawer({ item, onClose, onSaved }: { item: PlantItem | null; onClose: () => void; onSaved: () => void }) {
  const projectId = useProjectId();
  const [id] = useState(() => item?.id ?? crypto.randomUUID());
  const [f, setF] = useState({
    code: item?.code ?? '', name: item?.name ?? '', category: (item?.category ?? 'excavator') as PlantCategory, ownership: item?.ownership ?? 'owned',
    supplier: item?.supplier ?? '', plate_no: item?.plate_no ?? '', meter_unit: item?.meter_unit ?? 'hours', last_meter: item?.last_meter == null ? '' : String(item.last_meter),
    status: (item?.status ?? 'active') as PlantStatus, on_site_from: item?.on_site_from ?? etToday(), notes: item?.notes ?? '',
  });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await siteRpc('save_plant', { id, project_id: projectId, code: f.code, name: f.name, category: f.category, ownership: f.ownership as 'owned' | 'hired',
      supplier: f.supplier || undefined, plate_no: f.plate_no || undefined, meter_unit: f.meter_unit as 'hours' | 'km' | 'none',
      last_meter: f.last_meter === '' ? undefined : Number(f.last_meter), status: f.status, on_site_from: f.on_site_from || undefined, notes: f.notes || undefined });
    toast.success(`${f.code} saved`);
    onSaved();
  });
  return (
    <Drawer onClose={onClose} title={item ? `${item.code} · ${item.name}` : 'Add machine'}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Code" required><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="EX-01" /></Field>
        <Field label="Name / model" required><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="CAT 320 excavator" /></Field>
        <Field label="Type">
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as PlantCategory })}>
            {(Object.keys(PLANT_CATEGORY_LABELS) as PlantCategory[]).map((k) => <option key={k} value={k}>{PLANT_CATEGORY_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Own or hired">
          <select value={f.ownership} onChange={(e) => setF({ ...f, ownership: e.target.value as 'owned' | 'hired' })}><option value="owned">Own</option><option value="hired">Hired</option></select>
        </Field>
        {f.ownership === 'hired' && <Field label="Hired from"><input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>}
        <Field label="Plate / serial no."><input value={f.plate_no} onChange={(e) => setF({ ...f, plate_no: e.target.value })} /></Field>
        <Field label="Meter">
          <select value={f.meter_unit} onChange={(e) => setF({ ...f, meter_unit: e.target.value as 'hours' | 'km' | 'none' })}>
            <option value="hours">Hour meter</option><option value="km">Odometer (km)</option><option value="none">No meter</option>
          </select>
        </Field>
        {f.meter_unit !== 'none' && <Field label="Current reading"><input type="number" step="0.1" value={f.last_meter} onChange={(e) => setF({ ...f, last_meter: e.target.value })} /></Field>}
        <Field label="On site from"><input type="date" value={f.on_site_from} onChange={(e) => setF({ ...f, on_site_from: e.target.value })} /></Field>
        <Field label="Status">
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PlantStatus })}>
            {(Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]).map((k) => <option key={k} value={k}>{PLANT_STATUS_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Notes" wide><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
      <div className="row mt-2"><button className="primary" disabled={busy || !f.code.trim() || !f.name.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></div>
    </Drawer>
  );
}

function Utilisation() {
  const projectId = useProjectId();
  const [from, setFrom] = useState(addDays(etToday(), -29));
  const [to, setTo] = useState(etToday());
  const q = useAsync(() => loadUtilisation(projectId, from, to), [projectId, from, to], { key: 'plant-utilisation' });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const tot = rows.reduce((s, r) => ({ w: s.w + Number(r.hours_worked), i: s.i + Number(r.hours_idle), b: s.b + Number(r.hours_breakdown), f: s.f + Number(r.fuel_litres) }), { w: 0, i: 0, b: 0, f: 0 });
  const util = tot.w + tot.i + tot.b > 0 ? (100 * tot.w) / (tot.w + tot.i + tot.b) : null;
  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="From"><input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} max={etToday()} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
      </div>
      <div className="kpis">
        <Kpi label="Utilisation" value={util == null ? '—' : `${num(util, 1)} %`} hint="Worked ÷ (worked + idle + breakdown)" />
        <Kpi label="Hours worked" value={num(tot.w, 1)} />
        <Kpi label="Idle hours" value={num(tot.i, 1)} />
        <Kpi label="Breakdown hours" value={num(tot.b, 1)} />
        <Kpi label="Fuel (litres)" value={num(tot.f, 0)} hint={tot.w ? `${num(tot.f / tot.w, 2)} l per working hour` : undefined} />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="By machine" sub="Low utilisation on a hired machine = pay for idle time; high litres per hour = check for fuel loss or a fault">
        <DataTable rows={rows} rowKey={(r) => r.plant_id} loading={!q.data} exportName={`plant-utilisation-${from}-${to}`}
          empty={{ title: 'No plant', body: 'Register machines and log them daily.' }}
          columns={[
            { key: 'code', label: 'Code', id: true },
            { key: 'name', label: 'Machine', render: (r) => <span>{r.name} <span className="muted small-text">{r.ownership === 'hired' ? 'hired' : 'own'}</span></span> },
            { key: 'days_logged', label: 'Days logged', align: 'right' },
            { key: 'hours_worked', label: 'Worked h', align: 'right', value: (r) => Number(r.hours_worked), render: (r) => num(r.hours_worked, 1) },
            { key: 'hours_idle', label: 'Idle h', align: 'right', value: (r) => Number(r.hours_idle), render: (r) => num(r.hours_idle, 1) },
            { key: 'hours_breakdown', label: 'Breakdown h', align: 'right', value: (r) => Number(r.hours_breakdown), render: (r) => num(r.hours_breakdown, 1) },
            { key: 'utilisation_pct', label: 'Utilisation', align: 'right', value: (r) => Number(r.utilisation_pct ?? -1),
              render: (r) => (r.utilisation_pct == null ? '—' : <Badge tone={Number(r.utilisation_pct) >= 70 ? 'success' : Number(r.utilisation_pct) >= 50 ? 'warning' : 'danger'} label={`${num(r.utilisation_pct, 1)} %`} icon={null} />) },
            { key: 'fuel_litres', label: 'Fuel l', align: 'right', value: (r) => Number(r.fuel_litres), render: (r) => num(r.fuel_litres, 0) },
            { key: 'litres_per_hour', label: 'l / h', align: 'right', value: (r) => Number(r.litres_per_hour ?? 0), render: (r) => (r.litres_per_hour == null ? '—' : num(r.litres_per_hour, 2)) },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={STATUS_TONE[r.status]} label={PLANT_STATUS_LABELS[r.status]} icon={null} /> },
          ]} />
      </Card>
    </div>
  );
}
