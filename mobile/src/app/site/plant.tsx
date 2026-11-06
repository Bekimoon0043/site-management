// Plant & equipment (offline): daily machine log, owned / hired register, meter,
// hours, fuel, idle reasons and breakdowns. ?id= opens a machine; &log=1 its daily log.
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { enqueue, uuid } from '../../lib/sync';
import { fmtDate, fmtQty, today } from '../../lib/format';
import {
  IDLE_REASONS, PLANT_CATEGORY_LABELS, PLANT_STATUS_LABELS, canSite,
  type PlantCategory, type PlantItem, type PlantLog, type PlantLogStatus, type PlantStatus,
} from '../../lib/contract-site';
import {
  ActionBar, Banner, Button, Card, ChipGroup, EmptyState, Field, Grid, InfoRow, KpiTile, ListRow,
  PhotoStrip, Screen, Section, Segmented, SyncChip, SyncError, Text, haptic, showError, toast,
  useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField } from '../../components/pickers';
import type { Tone } from '../../theme';

const CATEGORIES = Object.keys(PLANT_CATEGORY_LABELS) as PlantCategory[];
const logTone = (s: PlantLogStatus): Tone => s === 'working' ? 'success' : s === 'idle' ? 'warning' : 'danger';
const plantTone = (s: PlantStatus): 'success' | 'danger' | 'neutral' => s === 'active' ? 'success' : s === 'under_repair' ? 'danger' : 'neutral';

export default function PlantScreen() {
  const params = useLocalSearchParams<{ id?: string; new?: '1'; edit?: '1'; log?: '1'; date?: string }>();
  const item = useData(() => params.id ? get<PlantItem>('plant_items', params.id) : null, [params.id]);
  if (params.new === '1' || params.edit === '1') return <PlantForm key={item?.id ?? 'new'} item={item} />;
  if (params.id && !item) return <Screen><Stack.Screen options={{ title: 'Plant & equipment' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" body="Sync and try again." /></Screen>;
  if (item && params.log === '1') return <PlantLogForm key={`${item.id}-${params.date ?? today()}`} plant={item} day={params.date ?? today()} />;
  if (item) return <PlantDetail plant={item} />;
  return <PlantHome />;
}

function PlantHome() {
  const { profile, project } = useSession();
  const [view, setView] = useState<'daily' | 'register'>('daily');
  const [day, setDay] = useState(today());
  const d = useData(() => {
    const plant = list<PlantItem>('plant_items', { project: project.id }).sort((a, b) => a.code.localeCompare(b.code));
    const logs = list<PlantLog>('plant_logs', { project: project.id });
    return { plant, logs };
  }, [project.id]);
  const machines = d.plant.filter((p) => view === 'register' || p.status !== 'off_hire');
  const machineIds = new Set(machines.map((p) => p.id));
  const logs = d.logs.filter((l) => l.log_date === day && machineIds.has(l.plant_id));
  const canLog = canSite(profile.role, 'plant.log'), canEdit = canSite(profile.role, 'plant.edit');
  const add = () => router.push('/site/plant?new=1');
  return (
    <Screen footer={canEdit ? <ActionBar primary={{ title: 'Add machine', variant: 'hero', icon: 'plus', onPress: add }} /> : undefined}>
      <Stack.Screen options={{ title: 'Plant & equipment' }} />
      <ChipGroup<'daily' | 'register'> value={view} onChange={setView} options={[{ value: 'daily', label: 'Daily log' }, { value: 'register', label: 'Register' }]} />
      {view === 'daily' ? <>
        <DateField label="Log date" value={day} onChange={setDay} />
        {day > today() ? <Banner tone="warning" text="Future days cannot be logged." /> : null}
        <Grid columns={2}>
          <KpiTile label="Machines logged" value={`${logs.length} / ${machines.length}`} sub={fmtDate(day)} zeroIsGood={false} />
          <KpiTile label="Hours worked" value={fmtQty(logs.reduce((s, l) => s + Number(l.hours_worked), 0), 1)} zeroIsGood={false} />
          <KpiTile label="Fuel issued" value={fmtQty(logs.reduce((s, l) => s + Number(l.fuel_litres), 0), 0)} sub="litres" zeroIsGood={false} />
          <KpiTile label="Breakdowns" value={logs.filter((l) => l.status === 'breakdown').length} tone="danger" />
        </Grid>
      </> : <Banner tone="info" text="Register owned and hired machines. Record hired-plant idle time and breakdowns so the coordinator can act." />}
      {machines.length ? <Card flush>
        {machines.map((p) => {
          const log = logs.find((l) => l.plant_id === p.id);
          return <ListRow key={p.id} id={p.id} title={`${p.code} · ${p.name}`}
            subtitle={`${PLANT_CATEGORY_LABELS[p.category]} · ${p.ownership === 'hired' ? `Hired${p.supplier ? ` · ${p.supplier}` : ''}` : 'Owned'}`}
            meta={view === 'daily' ? log ? [log.operator_name, log.work_done ?? log.breakdown_note ?? log.idle_reason].filter(Boolean).join(' · ') || null : 'Not logged for this day'
              : [p.plate_no, p.last_meter != null && p.meter_unit !== 'none' ? `${fmtQty(p.last_meter, 1)} ${p.meter_unit}` : null].filter(Boolean).join(' · ') || null}
            icon="excavator" iconTone={view === 'daily' && log ? logTone(log.status) : plantTone(p.status)}
            chip={view === 'daily' ? log ? { label: log.status, tone: logTone(log.status) } : { label: 'Not logged', tone: 'warning' }
              : { label: PLANT_STATUS_LABELS[p.status], tone: plantTone(p.status) }}
            sync={(view === 'daily' && log ? log._pending : p._pending) ? 'pending' : null} chevron
            onPress={view === 'daily' && canLog && day <= today() ? (id) => router.push(`/site/plant?id=${id}&log=1&date=${day}`) : (id) => router.push(`/site/plant?id=${id}`)} />;
        })}
      </Card> : <EmptyState icon="excavator" title="No plant registered" body="Add excavators, mixers, vibrators, generators, cranes, trucks and other machines on site."
        action={canEdit ? { label: 'Add machine', onPress: add } : undefined} />}
    </Screen>
  );
}

function PlantDetail({ plant }: { plant: PlantItem }) {
  const { profile, project } = useSession();
  const logs = useData(() => list<PlantLog>('plant_logs', { project: project.id })
    .filter((l) => l.plant_id === plant.id).sort((a, b) => b.log_date.localeCompare(a.log_date)), [project.id, plant.id]);
  const recent = logs.filter((l) => l.log_date <= today()).slice(0, 14);
  const worked = recent.reduce((s, l) => s + Number(l.hours_worked), 0);
  const total = recent.reduce((s, l) => s + Number(l.hours_worked) + Number(l.hours_idle) + Number(l.hours_breakdown), 0);
  const todayLog = logs.find((l) => l.log_date === today());
  const canLog = canSite(profile.role, 'plant.log') && plant.status !== 'off_hire';
  const openLog = (date: string) => router.push(`/site/plant?id=${plant.id}&log=1&date=${date}`);
  return (
    <Screen footer={canLog ? <ActionBar primary={{ title: todayLog ? "Edit today's log" : 'Log today', variant: 'hero', icon: 'clipboard-list-outline', onPress: () => openLog(today()) }} /> : undefined}>
      <Stack.Screen options={{ title: `${plant.code} · ${plant.name}` }} />
      <SyncError entityId={plant.id} />
      <Card>
        <InfoRow label="Status" value={PLANT_STATUS_LABELS[plant.status]} tone={plant.status === 'under_repair' ? 'danger' : plant.status === 'active' ? 'success' : 'default'} />
        <InfoRow label="Type" value={PLANT_CATEGORY_LABELS[plant.category]} />
        <InfoRow label="Ownership" value={plant.ownership === 'hired' ? `Hired${plant.supplier ? ` · ${plant.supplier}` : ''}` : 'Owned'} />
        <InfoRow label="Plate / serial" value={plant.plate_no ?? '—'} />
        <InfoRow label="Last meter" value={plant.last_meter == null || plant.meter_unit === 'none' ? '—' : `${fmtQty(plant.last_meter, 1)} ${plant.meter_unit}`} />
        <InfoRow label="On site from" value={plant.on_site_from ? fmtDate(plant.on_site_from) : '—'} />
        {plant.notes ? <Text variant="bodySm" tone="muted">{plant.notes}</Text> : null}
        <SyncChip entityId={plant.id} showSynced />
      </Card>
      {plant.status === 'under_repair' ? <Banner tone="danger" title="Under repair" text="A breakdown was reported. Record a working log only after the machine is fit to return to service." /> : null}
      <Grid columns={2}>
        <KpiTile label="Worked · recent logs" value={fmtQty(worked, 1)} sub={`${recent.length} days`} zeroIsGood={false} />
        <KpiTile label="Utilisation" value={total ? `${fmtQty(100 * worked / total, 1)}%` : '—'} sub="Worked / all recorded hours" zeroIsGood={false} />
      </Grid>
      {canSite(profile.role, 'plant.edit') ? <Button title="Edit machine / off-hire" variant="outline" icon="pencil-outline" onPress={() => router.push(`/site/plant?id=${plant.id}&edit=1`)} /> : null}
      <Section title="Daily logs">
        {recent.length ? <Card flush>{recent.map((l) => <ListRow key={l.id} id={l.log_date} title={fmtDate(l.log_date)}
          subtitle={`${fmtQty(l.hours_worked, 1)} h worked · ${fmtQty(l.hours_idle, 1)} h idle · ${fmtQty(l.hours_breakdown, 1)} h breakdown`}
          meta={[l.operator_name, `${fmtQty(l.fuel_litres, 0)} l fuel`, l.work_done ?? l.breakdown_note ?? l.idle_reason].filter(Boolean).join(' · ')}
          icon="clipboard-text-outline" iconTone={logTone(l.status)} chip={{ label: l.status, tone: logTone(l.status) }} sync={l._pending ? 'pending' : null}
          chevron onPress={canLog ? openLog : undefined} />)}</Card>
          : <EmptyState compact icon="clipboard-text-outline" title="No daily logs" body="Record the meter, operator, hours, fuel and work done each day." />}
      </Section>
    </Screen>
  );
}

function PlantForm({ item }: { item: PlantItem | null }) {
  const { profile, project } = useSession();
  const form = useForm();
  const [id] = useState(() => item?.id ?? uuid());
  const [code, setCode] = useState(item?.code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState<PlantCategory>(item?.category ?? 'excavator');
  const [ownership, setOwnership] = useState<'owned' | 'hired'>(item?.ownership ?? 'owned');
  const [supplier, setSupplier] = useState(item?.supplier ?? '');
  const [plate, setPlate] = useState(item?.plate_no ?? '');
  const [meterUnit, setMeterUnit] = useState<'hours' | 'km' | 'none'>(item?.meter_unit ?? 'hours');
  const [meter, setMeter] = useState(item?.last_meter == null ? '' : String(item.last_meter));
  const [status, setStatus] = useState<PlantStatus>(item?.status ?? 'active');
  const [onSite, setOnSite] = useState(item?.on_site_from ?? today());
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const dirty = code !== (item?.code ?? '') || name !== (item?.name ?? '') || category !== (item?.category ?? 'excavator')
    || ownership !== (item?.ownership ?? 'owned') || supplier !== (item?.supplier ?? '') || plate !== (item?.plate_no ?? '')
    || meterUnit !== (item?.meter_unit ?? 'hours') || meter !== (item?.last_meter == null ? '' : String(item.last_meter))
    || status !== (item?.status ?? 'active') || onSite !== (item?.on_site_from ?? today()) || notes !== (item?.notes ?? '');
  const disable = useUnsavedGuard(dirty, { what: 'machine details' });
  if (!canSite(profile.role, 'plant.edit')) return <Screen><Stack.Screen options={{ title: 'Plant register' }} /><EmptyState icon="lock-outline" title="Not permitted" body="Ask the site engineer or coordinator to update the plant register." /></Screen>;

  const save = () => {
    const e: Errors = {};
    if (!code.trim()) e.code = 'Enter a plant code';
    if (!name.trim()) e.name = 'Enter the machine name or model';
    if (meter && (!Number.isFinite(Number(meter)) || Number(meter) < 0)) e.meter = 'Enter a valid meter reading';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      enqueue('save_plant', {
        id, project_id: project.id, code: code.trim().toUpperCase(), name: name.trim(), category, ownership,
        supplier: ownership === 'hired' ? supplier.trim() || undefined : undefined, plate_no: plate.trim() || undefined,
        meter_unit: meterUnit, last_meter: !item && meterUnit !== 'none' && meter ? Number(meter) : undefined,
        status, on_site_from: onSite || undefined, notes: notes.trim() || undefined,
      }, { entityType: 'plant_item', entityId: id, label: `${code.trim().toUpperCase()} saved` });
      haptic('confirm'); toast.success(`${code.trim().toUpperCase()} saved on phone`);
      disable(); router.replace(`/site/plant?id=${id}`);
    } catch (err) { showError(err); }
  };
  return (
    <Screen form={form} footer={<ActionBar primary={{ title: item ? 'Save machine' : 'Add machine', variant: 'hero', icon: 'check', onPress: save }} />}>
      <Stack.Screen options={{ title: item ? `Edit ${item.code}` : 'Add machine' }} />
      {item ? <SyncError entityId={item.id} /> : null}
      <Card>
        <Field label="Plant code" value={code} onChangeText={setCode} error={errors.code} name="code" autoCapitalize="characters" placeholder="EX-01" />
        <Field label="Name / model" value={name} onChangeText={setName} error={errors.name} name="name" placeholder="CAT 320 excavator" />
        <ChipGroup<PlantCategory> label="Type" scroll value={category} onChange={setCategory} options={CATEGORIES.map((v) => ({ value: v, label: PLANT_CATEGORY_LABELS[v] }))} />
      </Card>
      <Card>
        <Segmented<'owned' | 'hired'> label="Ownership" value={ownership} onChange={setOwnership} options={[{ value: 'owned', label: 'Owned' }, { value: 'hired', label: 'Hired' }]} />
        {ownership === 'hired' ? <Field label="Hired from" optional value={supplier} onChangeText={setSupplier} /> : null}
        <Field label="Plate / serial no." optional value={plate} onChangeText={setPlate} />
        <DateField label="On site from" optional value={onSite} onChange={setOnSite} />
      </Card>
      <Card>
        <ChipGroup<'hours' | 'km' | 'none'> label="Meter" value={meterUnit} onChange={setMeterUnit} options={[{ value: 'hours', label: 'Hour meter' }, { value: 'km', label: 'Odometer (km)' }, { value: 'none', label: 'No meter' }]} />
        {!item && meterUnit !== 'none' ? <Field label="Current reading" optional value={meter} onChangeText={setMeter} error={errors.meter} name="meter" keyboardType="decimal-pad" /> : null}
        {item && meterUnit !== 'none' ? <Banner tone="info" text="The current reading is updated by daily logs and cannot be reduced here." /> : null}
        {item ? <ChipGroup<PlantStatus> label="Status" value={status} onChange={setStatus}
          options={(Object.keys(PLANT_STATUS_LABELS) as PlantStatus[]).map((v) => ({ value: v, label: PLANT_STATUS_LABELS[v], tone: plantTone(v) }))} /> : null}
        <Field label="Notes" optional value={notes} onChangeText={setNotes} multiline />
      </Card>
    </Screen>
  );
}

function PlantLogForm({ plant, day }: { plant: PlantItem; day: string }) {
  const { profile, project } = useSession();
  const form = useForm();
  const logs = useData(() => list<PlantLog>('plant_logs', { project: project.id }).filter((l) => l.plant_id === plant.id), [project.id, plant.id]);
  const existing = logs.find((l) => l.log_date === day) ?? null;
  const previous = logs.filter((l) => l.log_date < day && l.meter_end != null).sort((a, b) => b.log_date.localeCompare(a.log_date))[0] ?? null;
  const [id] = useState(() => existing?.id ?? uuid());
  const [status, setStatus] = useState<PlantLogStatus>(existing?.status ?? 'working');
  const [operator, setOperator] = useState(existing?.operator_name ?? previous?.operator_name ?? '');
  const initialStart = existing?.meter_start ?? previous?.meter_end ?? (day === today() ? plant.last_meter : null);
  const [meterStart, setMeterStart] = useState(initialStart == null ? '' : String(initialStart));
  const [meterEnd, setMeterEnd] = useState(existing?.meter_end == null ? '' : String(existing.meter_end));
  const [worked, setWorked] = useState(existing ? String(existing.hours_worked) : '');
  const [idle, setIdle] = useState(String(existing?.hours_idle ?? 0));
  const [idleReason, setIdleReason] = useState(existing?.idle_reason ?? '');
  const [breakdown, setBreakdown] = useState(String(existing?.hours_breakdown ?? 0));
  const [breakdownNote, setBreakdownNote] = useState(existing?.breakdown_note ?? '');
  const [fuel, setFuel] = useState(String(existing?.fuel_litres ?? 0));
  const [workDone, setWorkDone] = useState(existing?.work_done ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const dirty = status !== (existing?.status ?? 'working') || operator !== (existing?.operator_name ?? previous?.operator_name ?? '')
    || meterStart !== (initialStart == null ? '' : String(initialStart)) || meterEnd !== (existing?.meter_end == null ? '' : String(existing.meter_end))
    || worked !== (existing ? String(existing.hours_worked) : '') || idle !== String(existing?.hours_idle ?? 0)
    || idleReason !== (existing?.idle_reason ?? '') || breakdown !== String(existing?.hours_breakdown ?? 0)
    || breakdownNote !== (existing?.breakdown_note ?? '') || fuel !== String(existing?.fuel_litres ?? 0) || workDone !== (existing?.work_done ?? '');
  const disable = useUnsavedGuard(dirty, { what: 'plant log' });
  if (!canSite(profile.role, 'plant.log')) return <Screen><Stack.Screen options={{ title: plant.code }} /><EmptyState icon="lock-outline" title="Not permitted" body="Ask the site engineer or store keeper to record the daily plant log." /></Screen>;
  const meterHours = plant.meter_unit === 'hours' && meterStart !== '' && meterEnd !== '' ? Number(meterEnd) - Number(meterStart) : null;

  const save = () => {
    const e: Errors = {};
    const values: [keyof Errors, string, string][] = [
      ['meterStart', meterStart, 'opening meter'], ['meterEnd', meterEnd, 'closing meter'], ['worked', worked, 'hours worked'],
      ['idle', idle, 'idle hours'], ['breakdown', breakdown, 'breakdown hours'], ['fuel', fuel, 'fuel'],
    ];
    for (const [key, raw, label] of values) if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) e[key] = `Enter a valid ${label}`;
    if (meterStart && meterEnd && Number(meterEnd) < Number(meterStart)) e.meterEnd = 'Closing meter cannot be lower than opening';
    if (previous?.meter_end != null && meterStart && Number(meterStart) < Number(previous.meter_end)) e.meterStart = `Opening meter is below the previous reading ${previous.meter_end}`;
    const meterWorked = worked ? Number(worked) : Math.max(0, meterHours ?? 0);
    if ([meterWorked, Number(idle || 0), Number(breakdown || 0)].some((n) => n > 24) || meterWorked + Number(idle || 0) + Number(breakdown || 0) > 24) {
      e.worked = 'Worked + idle + breakdown cannot exceed 24 hours';
    }
    if (status === 'breakdown' && !breakdownNote.trim()) e.breakdownNote = 'Describe the breakdown';
    if (day > today()) e.day = 'Cannot log a future day';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      enqueue('log_plant', {
        id, plant_id: plant.id, log_date: day, status, operator_name: operator.trim() || undefined,
        meter_start: plant.meter_unit !== 'none' && meterStart ? Number(meterStart) : undefined,
        meter_end: plant.meter_unit !== 'none' && meterEnd ? Number(meterEnd) : undefined,
        hours_worked: worked ? Number(worked) : status === 'idle' ? 0 : undefined,
        hours_idle: Number(idle || 0), idle_reason: idleReason.trim() || undefined,
        hours_breakdown: Number(breakdown || 0), breakdown_note: breakdownNote.trim() || undefined,
        fuel_litres: Number(fuel || 0), work_done: workDone.trim() || undefined,
      }, { entityType: 'plant_log', entityId: id, label: `${plant.code} · ${day}` });
      haptic(status === 'breakdown' ? 'reject' : 'confirm');
      toast.success(status === 'breakdown' ? `${plant.code} breakdown saved · coordinator notified` : `${plant.code} logged for ${fmtDate(day)}`);
      disable(); router.replace(`/site/plant?id=${plant.id}`);
    } catch (err) { showError(err); }
  };
  return (
    <Screen form={form} footer={<ActionBar summary={meterHours != null && Number.isFinite(meterHours) ? `Meter difference: ${fmtQty(meterHours, 1)} h` : null}
      warning={status === 'breakdown'} primary={{ title: existing ? 'Save log' : 'Save daily log', variant: 'hero', icon: 'check', onPress: save }} />}>
      <Stack.Screen options={{ title: `${plant.code} · daily log` }} />
      {existing ? <SyncError entityId={existing.id} /> : null}
      <Card>
        <InfoRow label="Machine" value={`${plant.code} · ${plant.name}`} />
        <InfoRow label="Date" value={fmtDate(day)} />
        {errors.day ? <Text variant="bodySm" tone="danger">{errors.day}</Text> : null}
        <Segmented<PlantLogStatus> label="Status" value={status} onChange={setStatus} options={[
          { value: 'working', label: 'Working', tone: 'success' }, { value: 'idle', label: 'Idle', tone: 'warning' }, { value: 'breakdown', label: 'Breakdown', tone: 'danger' },
        ]} />
        <Field label="Operator / driver" optional value={operator} onChangeText={setOperator} autoCapitalize="words" />
      </Card>
      {plant.meter_unit !== 'none' ? <Card>
        <Field label={`Meter at start (${plant.meter_unit})`} optional value={meterStart} onChangeText={setMeterStart} error={errors.meterStart} name="meterStart" keyboardType="decimal-pad" />
        <Field label={`Meter at end (${plant.meter_unit})`} optional value={meterEnd} onChangeText={setMeterEnd} error={errors.meterEnd} name="meterEnd" keyboardType="decimal-pad" />
      </Card> : null}
      <Card>
        <Field label="Hours worked" optional value={worked} onChangeText={setWorked} error={errors.worked} name="worked" keyboardType="decimal-pad"
          hint={meterHours != null ? `Leave empty to use the meter difference (${fmtQty(meterHours, 1)} h)` : null} />
        <Field label="Idle hours" value={idle} onChangeText={setIdle} error={errors.idle} name="idle" keyboardType="decimal-pad" />
        {Number(idle) > 0 ? <>
          <ChipGroup label="Common idle reasons" scroll value={IDLE_REASONS.includes(idleReason) ? idleReason : null} onChange={setIdleReason}
            options={IDLE_REASONS.map((r) => ({ value: r, label: r }))} />
          <Field label="Idle because" optional value={idleReason} onChangeText={setIdleReason} />
        </> : null}
        <Field label="Breakdown hours" value={breakdown} onChangeText={setBreakdown} error={errors.breakdown} name="breakdown" keyboardType="decimal-pad" />
        {status === 'breakdown' || Number(breakdown) > 0 ? <Field label="What broke / action taken" value={breakdownNote} onChangeText={setBreakdownNote}
          error={errors.breakdownNote} name="breakdownNote" multiline placeholder="Hydraulic hose burst; machine isolated; mechanic called" /> : null}
        <Field label="Fuel issued (litres)" value={fuel} onChangeText={setFuel} error={errors.fuel} name="fuel" keyboardType="decimal-pad" />
        <Field label="Work done" optional value={workDone} onChangeText={setWorkDone} multiline placeholder="Bulk excavation zone A; loading trucks" />
      </Card>
      {status === 'breakdown' ? <Banner tone="danger" title="Stop and isolate unsafe plant" text="The coordinator and manager are notified when this breakdown syncs. A later working log returns the machine to active." /> : null}
      <PhotoStrip projectId={project.id} entityType="plant_log" entityId={id} label="Meter / damage photos" />
    </Screen>
  );
}
