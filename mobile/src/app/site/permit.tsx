// Permits to work (offline): request or edit, check precautions, approve / reject,
// cancel and close. One route serves the register and ?id= / ?new=1 forms.
import React, { useState } from 'react';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import { enqueue, uuid } from '../../lib/sync';
import { fmtDateTime, isoDate } from '../../lib/format';
import { personName } from '../../lib/queries';
import {
  PERMIT_PRECAUTIONS, PERMIT_STATUS_LABELS, PERMIT_TYPE_LABELS, canSite, permitExpired, permitLive,
  type PermitType, type Precaution, type WorkPermit,
} from '../../lib/contract-site';
import {
  ActionBar, Banner, Button, Card, ChipGroup, EmptyState, Field, InfoRow, ListRow, PhotoStrip, ReasonSheet,
  Screen, Section, SyncChip, SyncError, Text, haptic, showError, toast, useForm, useUnsavedGuard, type Errors,
} from '../../components/ui';
import { DateField } from '../../components/pickers';
import type { Tone } from '../../theme';

const TYPES = Object.keys(PERMIT_TYPE_LABELS) as PermitType[];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const localDateTime = (day: string, time: string) => {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const d = new Date(`${day}T${time}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const statusTone = (w: WorkPermit): Tone => permitExpired(w) ? 'danger' : permitLive(w) ? 'success'
  : w.status === 'requested' ? 'warning' : w.status === 'rejected' ? 'danger' : w.status === 'approved' ? 'info' : 'neutral';
const statusLabel = (w: WorkPermit) => permitExpired(w) ? 'Expired — close' : permitLive(w) ? 'Live' : PERMIT_STATUS_LABELS[w.status];

export default function PermitScreen() {
  const params = useLocalSearchParams<{ id?: string; new?: '1' }>();
  const { project } = useSession();
  const permit = useData(() => params.id ? get<WorkPermit>('work_permits', params.id) : null, [params.id]);
  if (params.new === '1' || params.id) {
    if (params.id && !permit) return <Screen><Stack.Screen options={{ title: 'Permit to work' }} /><EmptyState icon="cloud-off-outline" title="Not on this phone yet" body="Sync and try again." /></Screen>;
    return <PermitEditor key={permit?.id ?? 'new'} permit={permit} />;
  }
  return <PermitRegister key={project.id} />;
}

function PermitRegister() {
  const { profile, project } = useSession();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const permits = useData(() => list<WorkPermit>('work_permits', { project: project.id })
    .filter((w) => filter === 'all' || w.status === 'requested' || w.status === 'approved')
    .sort((a, b) => b.created_at.localeCompare(a.created_at)), [project.id, filter]);
  const canRequest = canSite(profile.role, 'permit.request');
  return (
    <Screen footer={canRequest ? <ActionBar primary={{ title: 'Request permit', variant: 'hero', icon: 'plus', onPress: () => router.push('/site/permit?new=1') }} /> : undefined}>
      <Stack.Screen options={{ title: 'Permits to work' }} />
      <Banner tone="info" title="No approval, no high-risk work" text="The coordinator or manager checks every precaution on site before approving. Stop work when the permit expires." />
      <ChipGroup<'open' | 'all'> value={filter} onChange={setFilter} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All permits' }]} />
      {permits.length ? (
        <Card flush>
          {permits.map((w) => (
            <ListRow key={w.id} id={w.id} title={w.description} subtitle={`${w.number} · ${PERMIT_TYPE_LABELS[w.permit_type]}`}
              meta={`${fmtDateTime(w.valid_from)} → ${fmtDateTime(w.valid_to)} · ${personName(w.requested_by)}`}
              icon="fire" iconTone={statusTone(w)} chip={{ label: statusLabel(w), tone: statusTone(w) }} sync={w._pending ? 'pending' : null}
              chevron onPress={(id) => router.push(`/site/permit?id=${id}`)} />
          ))}
        </Card>
      ) : <EmptyState icon="fire" title={filter === 'open' ? 'No open permits' : 'No permits yet'} body="Request a permit before hot work, work at height, excavation, confined-space entry, lifting or electrical work."
        action={canRequest ? { label: 'Request permit', onPress: () => router.push('/site/permit?new=1') } : undefined} />}
    </Screen>
  );
}

function PermitEditor({ permit }: { permit: WorkPermit | null }) {
  const { profile, project } = useSession();
  const form = useForm();
  const [id] = useState(() => permit?.id ?? uuid());
  const [{ start, end }] = useState(() => {
    const from = permit ? new Date(permit.valid_from) : new Date();
    return { start: from, end: permit ? new Date(permit.valid_to) : new Date(from.getTime() + 8 * 3600_000) };
  });
  const [type, setType] = useState<PermitType>(permit?.permit_type ?? 'hot_work');
  const [description, setDescription] = useState(permit?.description ?? '');
  const [location, setLocation] = useState(permit?.location_text ?? '');
  const [fromDay, setFromDay] = useState(isoDate(start));
  const [fromTime, setFromTime] = useState(hm(start));
  const [toDay, setToDay] = useState(isoDate(end));
  const [toTime, setToTime] = useState(hm(end));
  const [crew, setCrew] = useState(permit?.crew_size == null ? '' : String(permit.crew_size));
  const [supervisor, setSupervisor] = useState(permit?.supervisor_name ?? profile.full_name ?? '');
  const [precautions, setPrecautions] = useState<Precaution[]>(permit?.precautions ?? PERMIT_PRECAUTIONS.hot_work.map((text) => ({ text, done: false })));
  const [extra, setExtra] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [dialog, setDialog] = useState<'reject' | 'close' | 'cancel' | null>(null);
  const [dirty, setDirty] = useState(false);
  const disable = useUnsavedGuard(dirty, { what: 'permit' });
  const editable = !permit || (permit.status === 'requested' && (permit.requested_by === profile.id || canSite(profile.role, 'permit.approve')));
  const canApprove = permit?.status === 'requested' && canSite(profile.role, 'permit.approve') && (permit.requested_by !== profile.id || profile.role === 'admin');
  const canClose = permit?.status === 'approved' && (permit.requested_by === profile.id || canSite(profile.role, 'permit.close'));
  const canCancel = permit?.status === 'requested' && (permit.requested_by === profile.id || canSite(profile.role, 'permit.approve'));
  const checkable = editable || canApprove;
  const allDone = precautions.length > 0 && precautions.every((p) => p.done);
  const touch = () => setDirty(true);

  const save = () => {
    const e: Errors = {};
    const from = localDateTime(fromDay, fromTime), to = localDateTime(toDay, toTime);
    if (!description.trim()) e.description = 'Describe the work';
    if (!from) e.from = 'Enter a valid start date and time (HH:MM)';
    if (!to) e.to = 'Enter a valid end date and time (HH:MM)';
    if (from && to && to <= from) e.to = 'The permit must end after it starts';
    if (from && to && to.getTime() - from.getTime() > 7 * 86400_000) e.to = 'A permit is valid for at most 7 days';
    if (crew && (!Number.isInteger(Number(crew)) || Number(crew) <= 0)) e.crew = 'Enter a whole number greater than zero';
    if (!precautions.length || precautions.some((p) => !p.text.trim())) e.precautions = 'List at least one precaution';
    setErrors(e);
    if (Object.keys(e).length) { form.focusFirstError(e); return; }
    try {
      enqueue('request_permit', {
        id, project_id: project.id, permit_type: type, description: description.trim(), location_text: location.trim() || undefined,
        valid_from: from!.toISOString(), valid_to: to!.toISOString(), crew_size: crew ? Number(crew) : undefined,
        supervisor_name: supervisor.trim() || undefined, precautions: precautions.map((p) => ({ ...p, text: p.text.trim() })),
      }, { entityType: 'work_permit', entityId: id, label: permit ? `${permit.number} updated` : 'Permit requested' });
      haptic('confirm'); toast.success(permit ? 'Permit updated · saved on phone' : 'Permit requested · waiting for approval');
      disable(); router.replace(`/site/permit?id=${id}`);
    } catch (err) { showError(err); }
  };

  const act = (action: 'approve' | 'reject' | 'close' | 'cancel', comment?: string) => {
    if (!permit) return;
    if (action === 'approve' && !allDone) { showError(new Error('Tick every precaution after checking it on site')); return; }
    try {
      enqueue('permit_action', { permit_id: permit.id, action, comment: comment || undefined, precautions: action === 'approve' ? precautions : undefined },
        { entityType: 'work_permit', entityId: permit.id, label: `${permit.number} ${action}` });
      setDialog(null); setDirty(false); haptic(action === 'reject' ? 'reject' : 'confirm');
      toast.success({ approve: 'Approved · work may start', reject: 'Permit rejected', close: 'Permit closed · area left safe', cancel: 'Request cancelled' }[action]);
      disable(); router.replace('/site/permit');
    } catch (err) { showError(err); }
  };

  let footer: React.ReactNode;
  if (canApprove) footer = <ActionBar summary={`${precautions.filter((p) => p.done).length}/${precautions.length} precautions checked`} warning={!allDone}
    primary={{ title: 'Approve permit', variant: 'hero', icon: 'check', onPress: () => act('approve') }}
    secondary={editable ? { title: 'Save changes', onPress: save } : { title: 'Reject', variant: 'dangerOutline', onPress: () => setDialog('reject') }} />;
  else if (editable) footer = <ActionBar summary={`${precautions.filter((p) => p.done).length}/${precautions.length} precautions in place`}
    primary={{ title: permit ? 'Save permit' : 'Request permit', variant: 'hero', icon: permit ? 'check' : 'send-outline', onPress: save }} />;
  else if (canClose) footer = <ActionBar summary={permit && permitExpired(permit) ? 'Expired — stop work and close it' : 'Close when the work is complete and the area is safe'}
    warning={!!permit && permitExpired(permit)} primary={{ title: 'Close permit', variant: permit && permitExpired(permit) ? 'hero' : 'primary', icon: 'check', onPress: () => setDialog('close') }} />;

  return (
    <Screen form={form} footer={footer}>
      <Stack.Screen options={{ title: permit ? permit.number : 'Request permit' }} />
      {permit ? <SyncError entityId={permit.id} /> : null}
      {permit ? <Card>
        <InfoRow label="Status" value={statusLabel(permit)}
          tone={statusTone(permit) === 'danger' ? 'danger' : statusTone(permit) === 'warning' ? 'warning' : statusTone(permit) === 'success' ? 'success' : 'default'} />
        <InfoRow label="Type" value={PERMIT_TYPE_LABELS[permit.permit_type]} />
        <InfoRow label="Requested by" value={personName(permit.requested_by)} />
        <SyncChip entityId={permit.id} showSynced />
      </Card> : <Banner tone="info" text="Request before work starts. Approval is by a coordinator or manager who is not the requester." />}
      {permit && permitExpired(permit) ? <Banner tone="danger" title="Permit expired" text="Stop the work. Close this permit only after the work is finished and the area is safe." /> : null}
      {permit?.decision_comment ? <Banner tone={permit.status === 'rejected' ? 'danger' : 'info'} title={permit.status === 'rejected' ? 'Rejected' : 'Decision note'} text={permit.decision_comment} /> : null}

      <Card>
        {editable ? <>
          <ChipGroup<PermitType> label="Type of work" scroll value={type} onChange={(v) => {
            touch(); setType(v); setPrecautions(PERMIT_PRECAUTIONS[v].map((text) => ({ text, done: false })));
          }} options={TYPES.map((v) => ({ value: v, label: PERMIT_TYPE_LABELS[v] }))} />
          <Field label="Work to be done" value={description} onChangeText={(v) => { touch(); setDescription(v); }} error={errors.description} name="description" multiline autoCapitalize="sentences" />
          <Field label="Where" optional value={location} onChangeText={(v) => { touch(); setLocation(v); }} placeholder="Block, level, grid" />
        </> : <>
          <Text variant="titleSm">{permit?.description}</Text>
          <InfoRow label="Where" value={permit?.location_text ?? '—'} />
        </>}
      </Card>

      <Card>
        {editable ? <>
          <DateField label="Valid from — date" value={fromDay} onChange={(v) => { touch(); setFromDay(v); }} />
          <Field label="Start time (HH:MM)" value={fromTime} onChangeText={(v) => { touch(); setFromTime(v); }} error={errors.from} name="from" keyboardType="numbers-and-punctuation" />
          <DateField label="Valid to — date" value={toDay} onChange={(v) => { touch(); setToDay(v); }} />
          <Field label="End time (HH:MM)" value={toTime} onChangeText={(v) => { touch(); setToTime(v); }} error={errors.to} name="to" hint="At most 7 days" keyboardType="numbers-and-punctuation" />
          <Field label="Crew size" optional value={crew} onChangeText={(v) => { touch(); setCrew(v); }} error={errors.crew} name="crew" keyboardType="number-pad" />
          <Field label="Supervisor on the job" optional value={supervisor} onChangeText={(v) => { touch(); setSupervisor(v); }} autoCapitalize="words" />
        </> : <>
          <InfoRow label="Valid from" value={fmtDateTime(permit?.valid_from)} />
          <InfoRow label="Valid to" value={fmtDateTime(permit?.valid_to)} />
          <InfoRow label="Crew" value={permit?.crew_size ?? '—'} />
          <InfoRow label="Supervisor" value={permit?.supervisor_name ?? '—'} />
        </>}
      </Card>

      <Section title="Precautions" action={checkable ? 'Check all' : undefined} onAction={() => { touch(); setPrecautions(precautions.map((p) => ({ ...p, done: true }))); }}>
        <Card flush>
          {precautions.map((p, i) => <ListRow key={`${i}-${p.text}`} id={String(i)} title={p.text} icon={p.done ? 'check-circle-outline' : 'circle-outline'}
            iconTone={p.done ? 'success' : 'neutral'} chip={p.done ? { label: 'In place', tone: 'success' } : { label: 'Not checked', tone: 'warning' }}
            onPress={checkable ? () => { touch(); setPrecautions(precautions.map((x, k) => k === i ? { ...x, done: !x.done } : x)); } : undefined} />)}
        </Card>
        {errors.precautions ? <Text variant="bodySm" tone="danger">{errors.precautions}</Text> : null}
        {canApprove && !allDone ? <Banner tone="warning" text="Tick each item only after physically checking it on site. Approval stays unavailable until every item is in place." /> : null}
        {editable ? <Card>
          <Field label="Add another precaution" optional value={extra} onChangeText={setExtra} placeholder="Site-specific control" />
          <Button title="Add precaution" variant="tonal" size="sm" icon="plus" disabled={!extra.trim()} onPress={() => {
            touch(); setPrecautions([...precautions, { text: extra.trim(), done: false }]); setExtra('');
          }} />
        </Card> : null}
      </Section>

      <PhotoStrip projectId={project.id} entityType="work_permit" entityId={id} label="Permit / precaution photos" />
      {permit?.approved_at && permit.status !== 'rejected' ? <Text variant="caption" tone="muted">Approved {fmtDateTime(permit.approved_at)} by {personName(permit.approved_by)}</Text> : null}
      {permit?.closed_at ? <Text variant="caption" tone="muted">Closed {fmtDateTime(permit.closed_at)} by {personName(permit.closed_by)}{permit.close_note ? ` · ${permit.close_note}` : ''}</Text> : null}
      {canApprove && editable ? <Button title="Reject permit" variant="dangerOutline" icon="close" onPress={() => setDialog('reject')} /> : null}
      {canCancel ? <Button title="Cancel request" variant="ghost" icon="cancel" onPress={() => setDialog('cancel')} /> : null}

      {dialog ? <ReasonSheet visible onClose={() => setDialog(null)} title={dialog === 'reject' ? 'Reject permit' : dialog === 'close' ? 'Close permit' : 'Cancel request'}
        subtitle={dialog === 'close' ? 'Confirm that the work is finished, equipment is safe and the area is clear.' : undefined}
        reasons={dialog === 'reject' ? ['Precautions not in place', 'Work method unclear', 'Permit dates not suitable', 'Other high-risk work nearby'] : []}
        confirmLabel={dialog === 'reject' ? 'Reject' : dialog === 'close' ? 'Close permit' : 'Cancel request'} variant={dialog === 'close' ? 'primary' : 'danger'}
        allowEmpty={dialog !== 'reject'} placeholder={dialog === 'close' ? 'Work finished; area checked and left safe' : undefined}
        onConfirm={(reason) => act(dialog, reason)} /> : null}
    </Screen>
  );
}
