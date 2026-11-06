// /safety — HSE register: incidents & near misses (report → investigate → close), permits to work
// (request → approve with precautions → close) and toolbox talks. Migration 20261105000030_site_ops.sql.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { date, dateTime, num } from '../../lib/format';
import {
  INCIDENT_KIND_LABELS, INCIDENT_STATUS_LABELS, PERMIT_PRECAUTIONS, PERMIT_STATUS_LABELS, PERMIT_TYPE_LABELS, SEVERITY_LABELS, TOOLBOX_TOPICS,
  canSite, permitExpired, permitLive, type HseIncident, type IncidentKind, type IncidentSeverity, type InjuredParty, type PermitType,
  type Precaution, type ToolboxTalk, type WorkPermit,
} from '../../lib/contract-site';
import { Attachments } from '../../components/Attachments';
import {
  Badge, Banner, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, Page, ReasonModal, Tabs, toast, useBusy, useHashTab, type Tone,
} from '../../components/ui';
import { addDays, etToday, fromLocalInput, loadIncidents, loadPermits, loadToolboxTalks, siteRpc, toLocalInput } from '../../components/site/data';

const TABS = ['incidents', 'permits', 'toolbox'] as const;
const INC_TONE: Record<HseIncident['status'], Tone> = { reported: 'warning', action: 'info', closed: 'success' };
const SEV_TONE: Record<IncidentSeverity, Tone> = { minor: 'neutral', moderate: 'warning', serious: 'danger', fatal: 'danger' };
const PERMIT_TONE: Record<WorkPermit['status'], Tone> = { requested: 'warning', approved: 'success', rejected: 'danger', closed: 'neutral', cancelled: 'neutral' };

export function Safety() {
  const projectId = useProjectId();
  const [tab, setTab] = useHashTab(TABS, 'incidents');
  const inc = useAsync(() => loadIncidents(projectId), [projectId], { key: 'hse-incidents' });
  const per = useAsync(() => loadPermits(projectId), [projectId], { key: 'work-permits' });
  const tbt = useAsync(() => loadToolboxTalks(projectId), [projectId], { key: 'toolbox-talks' });
  const today = etToday();
  const lastLti = (inc.data ?? []).filter((i) => i.kind === 'injury' && (i.lost_time || i.severity === 'serious' || i.severity === 'fatal'))
    .map((i) => i.occurred_at.slice(0, 10)).sort().pop();
  const daysSince = lastLti ? Math.round((Date.parse(today) - Date.parse(lastLti)) / 86400_000) : null;
  const monthStart = today.slice(0, 8) + '01';
  const nearMisses = (inc.data ?? []).filter((i) => i.kind === 'near_miss' && i.occurred_at.slice(0, 10) >= monthStart).length;
  const open = (inc.data ?? []).filter((i) => i.status !== 'closed').length;
  const live = (per.data ?? []).filter((w) => permitLive(w)).length;
  const weekTalks = (tbt.data ?? []).filter((t) => t.held_on >= addDays(today, -6));
  return (
    <Page title="Safety (HSE)" subtitle="Incidents and near misses, permits to work and toolbox talks — reported on site, followed up by the coordinator">
      <div className="kpis">
        <Kpi label="Days without a lost-time injury" value={daysSince == null ? '—' : num(daysSince, 0)} hint={lastLti ? `Last on ${date(lastLti)}` : 'None recorded'} />
        <Kpi label="Open incidents" value={num(open, 0)} />
        <Kpi label="Near misses this month" value={num(nearMisses, 0)} hint="Reporting near misses prevents injuries" />
        <Kpi label="Live permits to work" value={num(live, 0)} />
        <Kpi label="Toolbox talks, last 7 days" value={num(weekTalks.length, 0)} hint={`${num(weekTalks.reduce((s, t) => s + t.attendees_count, 0), 0)} attendances`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'incidents', label: 'Incidents & near misses' }, { key: 'permits', label: 'Permits to work' }, { key: 'toolbox', label: 'Toolbox talks' }]} />
      <div className="mt-3">
        {tab === 'incidents' ? <Incidents rows={inc.data} error={inc.error} reload={inc.reload} />
          : tab === 'permits' ? <Permits rows={per.data} error={per.error} reload={per.reload} />
          : <Toolbox rows={tbt.data} error={tbt.error} reload={tbt.reload} />}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------
function Incidents({ rows, error, reload }: { rows?: HseIncident[]; error: string | null | undefined; reload: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const [open, setOpen] = useState<HseIncident | 'new' | null>(null);
  return (
    <Card flush title="Incident register" actions={canSite(auth.profile?.role, 'incident.report') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Report incident / near miss</button> : undefined}>
      <ErrorBanner error={error} onRetry={reload} />
      <DataTable rows={rows ?? []} rowKey={(r) => r.id} loading={!rows} onRowClick={(r) => setOpen(r)} exportName="hse-incidents"
        empty={{ title: 'No incidents recorded', body: 'Report every injury and near miss — near misses are the warnings before an accident.' }}
        columns={[
          { key: 'number', label: 'No.', id: true },
          { key: 'occurred_at', label: 'When', value: (r) => r.occurred_at, render: (r) => dateTime(r.occurred_at) },
          { key: 'kind', label: 'Type', value: (r) => r.kind, render: (r) => INCIDENT_KIND_LABELS[r.kind] },
          { key: 'severity', label: 'Severity', value: (r) => r.severity, render: (r) => <Badge tone={SEV_TONE[r.severity]} label={r.severity} icon={null} /> },
          { key: 'description', label: 'What happened', render: (r) => <span title={r.description}>{r.description.slice(0, 80)}</span> },
          { key: 'lost', label: 'Days lost', align: 'right', value: (r) => r.days_lost, render: (r) => (r.lost_time ? num(r.days_lost, 0) : '—') },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={INC_TONE[r.status]} label={INCIDENT_STATUS_LABELS[r.status]} icon={null} /> },
          { key: 'by', label: 'Reported by', value: (r) => lk.data?.person(r.reported_by) ?? '' },
        ]} />
      {open && lk.data && <IncidentDrawer key={open === 'new' ? 'new' : open.id} inc={open === 'new' ? null : open} L={lk.data} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

export function IncidentDrawer({ inc, L, onClose, onSaved }: { inc: HseIncident | null; L: Lookups; onClose: () => void; onSaved: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const role = auth.profile?.role;
  const [id] = useState(() => inc?.id ?? crypto.randomUUID());
  const editable = !inc || (inc.status === 'reported' && (inc.reported_by === auth.profile?.id || canSite(role, 'incident.investigate')));
  const [f, setF] = useState({
    kind: (inc?.kind ?? 'near_miss') as IncidentKind, severity: (inc?.severity ?? 'minor') as IncidentSeverity,
    occurred_at: toLocalInput(inc?.occurred_at ?? new Date().toISOString()), location_text: inc?.location_text ?? '', description: inc?.description ?? '',
    immediate_action: inc?.immediate_action ?? '', injured_name: inc?.injured_name ?? '', injured_trade: inc?.injured_trade ?? '',
    injured_party: (inc?.injured_party ?? 'own') as InjuredParty, body_part: inc?.body_part ?? '', first_aid: inc?.first_aid ?? false,
    hospital: inc?.hospital ?? false, lost_time: inc?.lost_time ?? false, days_lost: String(inc?.days_lost ?? 0),
  });
  const [inv, setInv] = useState({
    root_cause: inc?.root_cause ?? '', corrective_action: inc?.corrective_action ?? '', action_owner: inc?.action_owner ?? '', action_due: inc?.action_due ?? '',
    reported_to_authority: inc?.reported_to_authority ?? false, authority_ref: inc?.authority_ref ?? '', close_note: '',
  });
  const { busy, error, run } = useBusy();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const save = () => void run(async () => {
    const r = await siteRpc('report_incident', { id, project_id: projectId, kind: f.kind, severity: f.severity, occurred_at: fromLocalInput(f.occurred_at),
      location_text: f.location_text || undefined, description: f.description, immediate_action: f.immediate_action || undefined,
      injured_name: f.injured_name || undefined, injured_trade: f.injured_trade || undefined, injured_party: f.kind === 'injury' ? f.injured_party : undefined,
      body_part: f.body_part || undefined, first_aid: f.first_aid, hospital: f.hospital, lost_time: f.lost_time, days_lost: Number(f.days_lost || 0) });
    toast.success(`${String(r.number)} ${inc ? 'saved' : 'reported — the coordinator is notified'}`);
    onSaved();
  });
  const act = (action: 'investigate' | 'close' | 'update') => void run(async () => {
    await siteRpc('incident_action', { incident_id: id, action, root_cause: inv.root_cause || undefined, corrective_action: inv.corrective_action || undefined,
      action_owner: inv.action_owner || undefined, action_due: inv.action_due || undefined, reported_to_authority: inv.reported_to_authority,
      authority_ref: inv.authority_ref || undefined, close_note: inv.close_note || undefined });
    toast.success(action === 'investigate' ? 'Investigation saved — the action owner is notified' : action === 'close' ? 'Incident closed' : 'Saved');
    onSaved();
  });
  const investigator = !!inc && inc.status !== 'closed' && canSite(role, 'incident.investigate');
  const needsAuthority = f.kind === 'injury' && (f.lost_time || f.severity === 'serious' || f.severity === 'fatal');
  return (
    <Drawer size="lg" onClose={onClose} title={inc ? `${inc.number} · ${INCIDENT_KIND_LABELS[inc.kind]}` : 'Report incident or near miss'}
      subtitle={inc ? <Badge tone={INC_TONE[inc.status]} label={INCIDENT_STATUS_LABELS[inc.status]} icon={null} /> : 'Report straight away; details can be added during the investigation'}>
      <ErrorBanner error={error} />
      <fieldset disabled={!editable} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <Field label="Type" required>
            <select value={f.kind} onChange={(e) => set('kind', e.target.value as IncidentKind)}>
              {(Object.keys(INCIDENT_KIND_LABELS) as IncidentKind[]).map((k) => <option key={k} value={k}>{INCIDENT_KIND_LABELS[k]}</option>)}
            </select>
          </Field>
          <Field label="Severity">
            <select value={f.severity} onChange={(e) => set('severity', e.target.value as IncidentSeverity)}>
              {(Object.keys(SEVERITY_LABELS) as IncidentSeverity[]).map((k) => <option key={k} value={k}>{SEVERITY_LABELS[k]}</option>)}
            </select>
          </Field>
          <Field label="When it happened" required><input type="datetime-local" value={f.occurred_at} onChange={(e) => set('occurred_at', e.target.value)} /></Field>
          <Field label="Where"><input value={f.location_text} onChange={(e) => set('location_text', e.target.value)} placeholder="Block, level, grid" /></Field>
          <Field label="What happened" required wide><textarea rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
          <Field label="Immediate action taken" wide><input value={f.immediate_action} onChange={(e) => set('immediate_action', e.target.value)} placeholder="First aid, area barricaded, work stopped…" /></Field>
        </div>
        {f.kind === 'injury' && (
          <div className="form-grid">
            <Field label="Injured person" required><input value={f.injured_name} onChange={(e) => set('injured_name', e.target.value)} /></Field>
            <Field label="Trade"><input value={f.injured_trade} onChange={(e) => set('injured_trade', e.target.value)} /></Field>
            <Field label="Employed by">
              <select value={f.injured_party} onChange={(e) => set('injured_party', e.target.value as InjuredParty)}>
                <option value="own">Our worker</option><option value="subcontractor">Subcontractor</option><option value="visitor">Visitor</option><option value="public">Member of the public</option>
              </select>
            </Field>
            <Field label="Body part"><input value={f.body_part} onChange={(e) => set('body_part', e.target.value)} /></Field>
            <Field label="First aid given" check><input type="checkbox" checked={f.first_aid} onChange={(e) => set('first_aid', e.target.checked)} /></Field>
            <Field label="Taken to hospital / clinic" check><input type="checkbox" checked={f.hospital} onChange={(e) => set('hospital', e.target.checked)} /></Field>
            <Field label="Lost time (off work next shift)" check><input type="checkbox" checked={f.lost_time} onChange={(e) => set('lost_time', e.target.checked)} /></Field>
            {f.lost_time && <Field label="Days lost"><input type="number" min={0} value={f.days_lost} onChange={(e) => set('days_lost', e.target.value)} /></Field>}
          </div>
        )}
      </fieldset>
      {editable && <div className="row mt-2"><button className="primary" disabled={busy || !f.description.trim()} onClick={save}>{busy && <span className="spinner" />}{inc ? 'Save report' : 'Report'}</button></div>}
      {inc && <Card title="Photos"><Attachments entityType="hse_incident" entityId={inc.id} projectId={projectId} canAdd={inc.status !== 'closed'} /></Card>}

      {inc && (inc.status !== 'reported' || investigator) && (
        <Card title="Investigation" sub="Root cause and corrective action — the owner gets it in their inbox">
          <fieldset disabled={!investigator} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
            <Field label="Root cause" wide><textarea rows={2} value={inv.root_cause} onChange={(e) => setInv({ ...inv, root_cause: e.target.value })} /></Field>
            <Field label="Corrective action" wide><textarea rows={2} value={inv.corrective_action} onChange={(e) => setInv({ ...inv, corrective_action: e.target.value })} /></Field>
            <Field label="Action owner">
              <select value={inv.action_owner} onChange={(e) => setInv({ ...inv, action_owner: e.target.value })}>
                <option value="">—</option>{L.profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
            </Field>
            <Field label="Action due"><input type="date" value={inv.action_due} onChange={(e) => setInv({ ...inv, action_due: e.target.value })} /></Field>
            <Field label="Notified to the labour inspection office" check><input type="checkbox" checked={inv.reported_to_authority} onChange={(e) => setInv({ ...inv, reported_to_authority: e.target.checked })} /></Field>
            {inv.reported_to_authority && <Field label="Notification ref."><input value={inv.authority_ref} onChange={(e) => setInv({ ...inv, authority_ref: e.target.value })} /></Field>}
            {inc.status === 'action' && <Field label="Closing note" wide><input value={inv.close_note} onChange={(e) => setInv({ ...inv, close_note: e.target.value })} placeholder="Action done and checked" /></Field>}
          </fieldset>
          {needsAuthority && !inv.reported_to_authority && inc.status !== 'closed' && <Banner tone="warn">Lost-time, serious and fatal injuries must be notified to the labour inspection office (Labour Proclamation 1156/2019) before the incident can be closed.</Banner>}
          {investigator && (
            <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
              <button className={inc.status === 'reported' ? 'primary' : undefined} disabled={busy || !inv.root_cause.trim() || !inv.corrective_action.trim()} onClick={() => act('investigate')}>Save investigation</button>
              {inc.status === 'action' && <button className="primary" disabled={busy} onClick={() => act('close')}>Close incident</button>}
            </div>
          )}
          {inc.status === 'closed' && <p className="muted small-text mb-0">Closed {dateTime(inc.closed_at)} by {L.person(inc.closed_by)}{inc.close_note ? ` — ${inc.close_note}` : ''}</p>}
        </Card>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Permits to work
// ---------------------------------------------------------------------------
function Permits({ rows, error, reload }: { rows?: WorkPermit[]; error: string | null | undefined; reload: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const [open, setOpen] = useState<WorkPermit | 'new' | null>(null);
  return (
    <Card flush title="Permits to work" sub="Hot work, work at height, excavation, confined space, lifting and electrical work need an approved permit before starting"
      actions={canSite(auth.profile?.role, 'permit.request') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Request permit</button> : undefined}>
      <ErrorBanner error={error} onRetry={reload} />
      <DataTable rows={rows ?? []} rowKey={(r) => r.id} loading={!rows} onRowClick={(r) => setOpen(r)} exportName="work-permits"
        empty={{ title: 'No permits yet', body: 'Request a permit before high-risk work starts.' }}
        columns={[
          { key: 'number', label: 'No.', id: true },
          { key: 'permit_type', label: 'Type', value: (r) => r.permit_type, render: (r) => PERMIT_TYPE_LABELS[r.permit_type] },
          { key: 'description', label: 'Work', render: (r) => <span title={r.description}>{r.description.slice(0, 70)}{r.location_text ? ` · ${r.location_text}` : ''}</span> },
          { key: 'valid', label: 'Valid', value: (r) => r.valid_from, render: (r) => `${dateTime(r.valid_from)} → ${dateTime(r.valid_to)}` },
          { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => (permitExpired(r) ? <Badge tone="danger" label="Expired — close it" icon={null} />
            : <Badge tone={permitLive(r) ? 'success' : PERMIT_TONE[r.status]} label={permitLive(r) ? 'Live' : PERMIT_STATUS_LABELS[r.status]} icon={null} />) },
          { key: 'by', label: 'Requested by', value: (r) => lk.data?.person(r.requested_by) ?? '' },
        ]} />
      {open && lk.data && <PermitDrawer key={open === 'new' ? 'new' : open.id} permit={open === 'new' ? null : open} L={lk.data} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

export function PermitDrawer({ permit, L, onClose, onSaved }: { permit: WorkPermit | null; L: Lookups; onClose: () => void; onSaved: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const role = auth.profile?.role;
  const me = auth.profile?.id;
  const [id] = useState(() => permit?.id ?? crypto.randomUUID());
  const editable = !permit || (permit.status === 'requested' && (permit.requested_by === me || canSite(role, 'permit.approve')));
  const now = new Date();
  const [f, setF] = useState({
    permit_type: (permit?.permit_type ?? 'hot_work') as PermitType, description: permit?.description ?? '', location_text: permit?.location_text ?? '',
    valid_from: toLocalInput(permit?.valid_from ?? now.toISOString()), valid_to: toLocalInput(permit?.valid_to ?? new Date(now.getTime() + 8 * 3600_000).toISOString()),
    crew_size: String(permit?.crew_size ?? ''), supervisor_name: permit?.supervisor_name ?? '',
  });
  const [prec, setPrec] = useState<Precaution[]>(permit?.precautions ?? PERMIT_PRECAUTIONS.hot_work.map((text) => ({ text, done: false })));
  const [extra, setExtra] = useState('');
  const [dlg, setDlg] = useState<'reject' | 'close' | null>(null);
  const { busy, error, run } = useBusy();
  const canApprove = permit?.status === 'requested' && canSite(role, 'permit.approve') && (permit.requested_by !== me || role === 'admin');
  const save = () => void run(async () => {
    const r = await siteRpc('request_permit', { id, project_id: projectId, permit_type: f.permit_type, description: f.description, location_text: f.location_text || undefined,
      valid_from: fromLocalInput(f.valid_from), valid_to: fromLocalInput(f.valid_to), crew_size: f.crew_size ? Number(f.crew_size) : undefined,
      supervisor_name: f.supervisor_name || undefined, precautions: prec });
    toast.success(`${String(r.number)} ${permit ? 'saved' : 'requested — waiting for approval'}`);
    onSaved();
  });
  const act = (action: 'approve' | 'reject' | 'close' | 'cancel', comment?: string) => void run(async () => {
    await siteRpc('permit_action', { permit_id: id, action, comment, precautions: action === 'approve' ? prec : undefined });
    toast.success({ approve: 'Permit approved — work may start', reject: 'Permit rejected', close: 'Permit closed', cancel: 'Permit cancelled' }[action]);
    onSaved();
  });
  const allDone = prec.length > 0 && prec.every((p) => p.done);
  return (
    <Drawer size="lg" onClose={onClose} title={permit ? `${permit.number} · ${PERMIT_TYPE_LABELS[permit.permit_type]}` : 'Request a permit to work'}
      subtitle={permit ? (permitExpired(permit) ? <Badge tone="danger" label="Expired — stop work and close the permit" icon={null} /> : <Badge tone={PERMIT_TONE[permit.status]} label={PERMIT_STATUS_LABELS[permit.status]} icon={null} />)
        : 'The coordinator or manager checks the precautions on site before approving'}>
      <ErrorBanner error={error} />
      {permit?.decision_comment && <Banner tone={permit.status === 'rejected' ? 'error' : 'info'}>“{permit.decision_comment}” — {L.person(permit.approved_by)}</Banner>}
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Type of work" required>
          <select value={f.permit_type} onChange={(e) => {
            const t = e.target.value as PermitType;
            setF({ ...f, permit_type: t });
            if (!permit) setPrec(PERMIT_PRECAUTIONS[t].map((text) => ({ text, done: false })));
          }}>
            {(Object.keys(PERMIT_TYPE_LABELS) as PermitType[]).map((k) => <option key={k} value={k}>{PERMIT_TYPE_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="Location"><input value={f.location_text} onChange={(e) => setF({ ...f, location_text: e.target.value })} placeholder="Block, level, grid" /></Field>
        <Field label="Work to be done" required wide><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="From" required><input type="datetime-local" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></Field>
        <Field label="To" required hint="At most 7 days"><input type="datetime-local" value={f.valid_to} onChange={(e) => setF({ ...f, valid_to: e.target.value })} /></Field>
        <Field label="Crew size"><input type="number" min={1} value={f.crew_size} onChange={(e) => setF({ ...f, crew_size: e.target.value })} /></Field>
        <Field label="Supervisor on the job"><input value={f.supervisor_name} onChange={(e) => setF({ ...f, supervisor_name: e.target.value })} /></Field>
      </fieldset>
      <Card title="Precautions" sub={canApprove ? 'Tick each precaution after checking it on site' : 'Tick what is already in place; the approver checks every item'}>
        <div className="check-list">
          {prec.map((p, i) => (
            <label key={i}>
              <input type="checkbox" checked={p.done} disabled={!editable && !canApprove} onChange={(e) => setPrec(prec.map((x, k) => (k === i ? { ...x, done: e.target.checked } : x)))} />
              {p.text}
            </label>
          ))}
        </div>
        {editable && (
          <div className="row mt-2">
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a precaution" />
            <button type="button" className="small" disabled={!extra.trim()} onClick={() => { setPrec([...prec, { text: extra.trim(), done: false }]); setExtra(''); }}>Add</button>
          </div>
        )}
      </Card>
      {permit && <Card title="Photos"><Attachments entityType="work_permit" entityId={permit.id} projectId={projectId} canAdd={['requested', 'approved'].includes(permit.status)} /></Card>}
      <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
        {editable && <button className={canApprove ? undefined : 'primary'} disabled={busy || !f.description.trim()} onClick={save}>{busy && <span className="spinner" />}{permit ? 'Save' : 'Request permit'}</button>}
        {canApprove && <button className="primary" disabled={busy || !allDone} title={allDone ? undefined : 'Tick every precaution first'} onClick={() => act('approve')}>Approve</button>}
        {canApprove && <button disabled={busy} onClick={() => setDlg('reject')}>Reject…</button>}
        {permit?.status === 'requested' && permit.requested_by === me && <button disabled={busy} onClick={() => act('cancel')}>Cancel request</button>}
        {permit?.status === 'approved' && (permit.requested_by === me || canSite(role, 'permit.close')) && <button className={permitExpired(permit) ? 'primary' : undefined} disabled={busy} onClick={() => setDlg('close')}>Close permit…</button>}
      </div>
      {permit?.approved_at && permit.status !== 'rejected' && <p className="muted small-text">Approved {dateTime(permit.approved_at)} by {L.person(permit.approved_by)}</p>}
      {permit?.closed_at && <p className="muted small-text">Closed {dateTime(permit.closed_at)} by {L.person(permit.closed_by)}{permit.close_note ? ` — ${permit.close_note}` : ''}</p>}
      {dlg && <ReasonModal title={dlg === 'reject' ? 'Reject permit' : 'Close permit'} label={dlg === 'reject' ? 'Why is it rejected' : 'Work finished? Area left safe?'}
        onClose={() => setDlg(null)} onSubmit={async (c) => { setDlg(null); act(dlg, c); }} />}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Toolbox talks
// ---------------------------------------------------------------------------
function Toolbox({ rows, error, reload }: { rows?: ToolboxTalk[]; error: string | null | undefined; reload: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const [open, setOpen] = useState<ToolboxTalk | 'new' | null>(null);
  return (
    <Card flush title="Toolbox talks" sub="The morning briefing: today's hazards, attendance and the PPE check"
      actions={canSite(auth.profile?.role, 'toolbox.record') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Record toolbox talk</button> : undefined}>
      <ErrorBanner error={error} onRetry={reload} />
      <DataTable rows={rows ?? []} rowKey={(r) => r.id} loading={!rows} onRowClick={(r) => setOpen(r)} exportName="toolbox-talks"
        empty={{ title: 'No toolbox talks recorded', body: 'Record the daily briefing with the number of workers who attended.' }}
        columns={[
          { key: 'held_on', label: 'Date', value: (r) => r.held_on, render: (r) => date(r.held_on) },
          { key: 'number', label: 'No.', id: true },
          { key: 'topic', label: 'Topic' },
          { key: 'attendees_count', label: 'Attended', align: 'right', value: (r) => r.attendees_count },
          { key: 'ppe', label: 'PPE check', value: (r) => (r.ppe_checked ? 1 : 0), render: (r) => (r.ppe_checked ? (r.ppe_issues ? `Done · ${r.ppe_issues.slice(0, 40)}` : 'Done') : '—') },
          { key: 'by', label: 'Recorded by', value: (r) => lk.data?.person(r.created_by) ?? '' },
        ]} />
      {open && <ToolboxDrawer key={open === 'new' ? 'new' : open.id} talk={open === 'new' ? null : open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); reload(); }} />}
    </Card>
  );
}

function ToolboxDrawer({ talk, onClose, onSaved }: { talk: ToolboxTalk | null; onClose: () => void; onSaved: () => void }) {
  const auth = useAuth();
  const projectId = useProjectId();
  const [id] = useState(() => talk?.id ?? crypto.randomUUID());
  const editable = !talk || talk.created_by === auth.profile?.id || canSite(auth.profile?.role, 'incident.investigate');
  const [f, setF] = useState({
    held_on: talk?.held_on ?? etToday(), topic: talk?.topic ?? '', hazards: talk?.hazards ?? '', presenter_name: talk?.presenter_name ?? auth.profile?.full_name ?? '',
    attendees_count: String(talk?.attendees_count ?? ''), attendee_names: talk?.attendee_names ?? '', trades: (talk?.trades ?? []).join(', '),
    duration_min: String(talk?.duration_min ?? 15), ppe_checked: talk?.ppe_checked ?? true, ppe_issues: talk?.ppe_issues ?? '', notes: talk?.notes ?? '',
  });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const r = await siteRpc('save_toolbox_talk', { id, project_id: projectId, held_on: f.held_on, topic: f.topic, hazards: f.hazards || undefined,
      presenter_name: f.presenter_name || undefined, attendees_count: Number(f.attendees_count), attendee_names: f.attendee_names || undefined,
      trades: f.trades.split(',').map((s) => s.trim()).filter(Boolean), duration_min: f.duration_min ? Number(f.duration_min) : undefined,
      ppe_checked: f.ppe_checked, ppe_issues: f.ppe_issues || undefined, notes: f.notes || undefined });
    toast.success(`${String(r.number)} saved`);
    onSaved();
  });
  return (
    <Drawer onClose={onClose} title={talk ? `${talk.number} · ${talk.topic}` : 'Record toolbox talk'}>
      <ErrorBanner error={error} />
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Date" required><input type="date" value={f.held_on} max={etToday()} onChange={(e) => setF({ ...f, held_on: e.target.value })} /></Field>
        <Field label="Duration (min)"><input type="number" min={1} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} /></Field>
        <Field label="Topic" required wide>
          <input list="tbt-topics" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
          <datalist id="tbt-topics">{TOOLBOX_TOPICS.map((t) => <option key={t} value={t} />)}</datalist>
        </Field>
        <Field label="Hazards discussed" wide><textarea rows={2} value={f.hazards} onChange={(e) => setF({ ...f, hazards: e.target.value })} /></Field>
        <Field label="Presented by"><input value={f.presenter_name} onChange={(e) => setF({ ...f, presenter_name: e.target.value })} /></Field>
        <Field label="Workers attended" required><input type="number" min={1} value={f.attendees_count} onChange={(e) => setF({ ...f, attendees_count: e.target.value })} /></Field>
        <Field label="Trades" hint="Comma separated" wide><input value={f.trades} onChange={(e) => setF({ ...f, trades: e.target.value })} placeholder="Mason, Bar bender, Daily labourer" /></Field>
        <Field label="Names (optional)" wide><textarea rows={2} value={f.attendee_names} onChange={(e) => setF({ ...f, attendee_names: e.target.value })} /></Field>
        <Field label="PPE checked" check><input type="checkbox" checked={f.ppe_checked} onChange={(e) => setF({ ...f, ppe_checked: e.target.checked })} /></Field>
        {f.ppe_checked && <Field label="PPE issues found" wide><input value={f.ppe_issues} onChange={(e) => setF({ ...f, ppe_issues: e.target.value })} placeholder="e.g. 3 without helmets — issued" /></Field>}
        <Field label="Notes" wide><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </fieldset>
      {editable && <div className="row mt-2"><button className="primary" disabled={busy || !f.topic.trim() || !Number(f.attendees_count)} onClick={save}>{busy && <span className="spinner" />}Save</button></div>}
      {talk && <Card title="Attendance sheet / photos"><Attachments entityType="toolbox_talk" entityId={talk.id} projectId={projectId} canAdd /></Card>}
    </Drawer>
  );
}
