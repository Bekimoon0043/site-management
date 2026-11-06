// Report an incident or near miss (offline). Anyone on the project; the coordinator and manager are notified
// (critical for serious / lost-time cases) and investigate on the web.
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../lib/app';
import { enqueue, uuid } from '../../lib/sync';
import { today } from '../../lib/format';
import { INCIDENT_KIND_LABELS, type IncidentKind, type IncidentSeverity, type InjuredParty } from '../../lib/contract-site';
import {
  ActionBar, Banner, Card, ChipGroup, Field, PhotoStrip, Screen, haptic, showError, toast, useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField } from '../../components/pickers';

const SEVERITY: { value: IncidentSeverity; label: string; tone: 'neutral' | 'warning' | 'danger' }[] = [
  { value: 'minor', label: 'Minor / first aid', tone: 'neutral' }, { value: 'moderate', label: 'Medical treatment', tone: 'warning' },
  { value: 'serious', label: 'Serious', tone: 'danger' }, { value: 'fatal', label: 'Fatal', tone: 'danger' },
];
const nowHm = () => new Date().toTimeString().slice(0, 5);

export default function ReportIncident() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ kind?: IncidentKind }>();
  const form = useForm();
  const [id] = useState(uuid);
  const [kind, setKind] = useState<IncidentKind>(params.kind ?? 'near_miss');
  const [severity, setSeverity] = useState<IncidentSeverity>('minor');
  const [day, setDay] = useState<string | null>(today());
  const [time, setTime] = useState(nowHm());
  const [where, setWhere] = useState('');
  const [what, setWhat] = useState('');
  const [action, setAction] = useState('');
  const [name, setName] = useState('');
  const [trade, setTrade] = useState('');
  const [party, setParty] = useState<InjuredParty>('own');
  const [care, setCare] = useState<'first_aid' | 'hospital' | 'none'>('first_aid');
  const [lost, setLost] = useState<'no' | 'yes'>('no');
  const [days, setDays] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const disable = useUnsavedGuard(!!what, { what: 'report' });

  const save = () => {
    const e: Errors = {};
    if (!what.trim()) e.what = 'Say what happened';
    if (kind === 'injury' && !name.trim()) e.name = 'Name of the injured person';
    if (!/^\d{1,2}:\d{2}$/.test(time)) e.time = 'Time as HH:MM';
    const at = day ? new Date(`${day}T${time.padStart(5, '0')}:00`) : null;
    if (!at || Number.isNaN(at.getTime())) e.time = 'Pick the date and time';
    else if (at.getTime() > Date.now() + 10 * 60_000) e.time = 'That is in the future';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      enqueue('report_incident', {
        id, project_id: project.id, kind, severity, occurred_at: at!.toISOString(), location_text: where.trim() || undefined, description: what.trim(),
        immediate_action: action.trim() || undefined, injured_name: kind === 'injury' ? name.trim() : undefined, injured_trade: trade.trim() || undefined,
        injured_party: kind === 'injury' ? party : undefined, first_aid: kind === 'injury' && care === 'first_aid', hospital: kind === 'injury' && care === 'hospital',
        lost_time: kind === 'injury' && lost === 'yes', days_lost: lost === 'yes' ? Number(days || 0) : 0,
      }, { entityType: 'hse_incident', entityId: id, label: `${INCIDENT_KIND_LABELS[kind]} reported` });
      haptic('confirm'); toast.success('Reported · the coordinator is notified');
      disable(); router.back();
    } catch (err) { showError(err); }
  };

  return (
    <Screen form={form} footer={<ActionBar primary={{ title: 'Report', variant: 'hero', icon: 'alert-octagon-outline', onPress: save }} />}>
      <Stack.Screen options={{ title: 'Report incident' }} />
      <Card>
        <ChipGroup<IncidentKind> label="What kind" value={kind} onChange={setKind}
          options={(Object.keys(INCIDENT_KIND_LABELS) as IncidentKind[]).map((k) => ({ value: k, label: INCIDENT_KIND_LABELS[k] }))} />
        <ChipGroup<IncidentSeverity> label="How serious" value={severity} onChange={setSeverity} options={SEVERITY} />
      </Card>
      <Card>
        <DateField label="Date" value={day} onChange={setDay} />
        <Field label="Time (HH:MM)" value={time} onChangeText={setTime} error={errors.time} name="time" keyboardType="numbers-and-punctuation" />
        <Field label="Where" optional value={where} onChangeText={setWhere} placeholder="Block, level, grid" />
        <Field label="What happened" value={what} onChangeText={setWhat} error={errors.what} name="what" multiline autoCapitalize="sentences" />
        <Field label="Immediate action taken" optional value={action} onChangeText={setAction} placeholder="First aid, area barricaded, work stopped…" />
      </Card>
      {kind === 'injury' ? (
        <Card>
          <Field label="Injured person" value={name} onChangeText={setName} error={errors.name} name="name" autoCapitalize="words" />
          <Field label="Trade" optional value={trade} onChangeText={setTrade} />
          <ChipGroup<InjuredParty> label="Employed by" value={party} onChange={setParty}
            options={[{ value: 'own', label: 'Our worker' }, { value: 'subcontractor', label: 'Subcontractor' }, { value: 'visitor', label: 'Visitor' }, { value: 'public', label: 'Public' }]} />
          <ChipGroup<'first_aid' | 'hospital' | 'none'> label="Treatment" value={care} onChange={setCare}
            options={[{ value: 'first_aid', label: 'First aid' }, { value: 'hospital', label: 'Hospital / clinic' }, { value: 'none', label: 'None' }]} />
          <ChipGroup<'no' | 'yes'> label="Off work next shift (lost time)?" value={lost} onChange={setLost} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]} />
          {lost === 'yes' ? <Field label="Days off (estimate)" value={days} onChangeText={setDays} keyboardType="number-pad" /> : null}
        </Card>
      ) : null}
      {(severity === 'serious' || severity === 'fatal' || lost === 'yes') ? (
        <Banner tone="danger" title="Call the site manager now" text="Serious and lost-time injuries must also be notified to the labour inspection office." />
      ) : null}
      <PhotoStrip projectId={project.id} entityType="hse_incident" entityId={id} label="Photos of the scene" />
    </Screen>
  );
}
