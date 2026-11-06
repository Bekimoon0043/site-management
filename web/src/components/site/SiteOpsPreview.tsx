// Approvals inbox: site operations (kind 'site_ops', app.site_ops_approvals_for in 20261105000030_site_ops.sql) —
// permits to approve (precautions ticked here) or close, incidents to investigate, corrective actions.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PlanQueueRow } from '../../lib/approvals';
import { dateTime } from '../../lib/format';
import {
  INCIDENT_KIND_LABELS, INCIDENT_STATUS_LABELS, PERMIT_STATUS_LABELS, PERMIT_TYPE_LABELS, SEVERITY_LABELS, canSite, type Precaution,
} from '../../lib/contract-site';
import { Badge, Banner, ErrorBanner, Loading, ReasonModal, useBusy } from '../ui';
import { loadIncident, loadPermit, siteRpc } from './data';

interface Props { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }

export function SiteOpsPreview(props: Props) {
  return props.row.entity_type === 'work_permit' ? <PermitPreview {...props} /> : <IncidentPreview {...props} />;
}

function PermitPreview({ row, L, onDone, onActions }: Props) {
  const auth = useAuth();
  const q = useAsync(() => loadPermit(row.entity_id), [row.entity_id, row.status], { key: 'work-permit' });
  const [prec, setPrec] = useState<Precaution[] | null>(null);
  const [rej, setRej] = useState(false);
  const { busy, error, run } = useBusy();
  const w = q.data;
  const list = prec ?? w?.precautions ?? [];
  const canApprove = !!w && w.status === 'requested' && canSite(auth.profile?.role, 'permit.approve');
  const approve = () => void run(async () => {
    if (!w) return;
    await siteRpc('permit_action', { permit_id: w.id, action: 'approve', precautions: list });
    onDone(`${w.number} approved — work may start`);
  });
  useEffect(() => { onActions(canApprove ? { approve, reject: () => setRej(true) } : {}); });
  if (!w) return <div className="inbox-preview-body">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />}</div>;
  return (
    <div className="inbox-preview-body">
      <div className="inbox-preview-head">
        <h2><Link to="/safety#permits">{w.number} · {PERMIT_TYPE_LABELS[w.permit_type]} <ExternalLink size={14} aria-hidden /></Link></h2>
        <div className="meta"><Badge tone="warning" label={PERMIT_STATUS_LABELS[w.status]} icon={null} /> · requested by {L.person(w.requested_by)}</div>
      </div>
      <ErrorBanner error={error} />
      <dl className="kv">
        <dt>Work</dt><dd>{w.description}</dd>
        <dt>Where</dt><dd>{w.location_text ?? '—'}</dd>
        <dt>Valid</dt><dd>{dateTime(w.valid_from)} → {dateTime(w.valid_to)}</dd>
        <dt>Crew / supervisor</dt><dd>{w.crew_size ?? '—'} · {w.supervisor_name ?? '—'}</dd>
      </dl>
      <h3>Precautions {canApprove ? '— tick each after checking it on site' : ''}</h3>
      <div className="check-list">
        {list.map((p, i) => (
          <label key={i}><input type="checkbox" checked={p.done} disabled={!canApprove || busy}
            onChange={(e) => setPrec(list.map((x, k) => (k === i ? { ...x, done: e.target.checked } : x)))} />{p.text}</label>
        ))}
      </div>
      {canApprove && !list.every((p) => p.done) && <Banner tone="warn">Approve only when every precaution is in place.</Banner>}
      {w.status === 'approved' && <Banner tone="info">The permit period has ended — close it on the Safety page once the area is safe.</Banner>}
      {rej && <ReasonModal title={`Reject ${w.number}`} label="Why is it rejected" onClose={() => setRej(false)}
        onSubmit={async (comment) => { await siteRpc('permit_action', { permit_id: w.id, action: 'reject', comment }); setRej(false); onDone(`${w.number} rejected`); }} />}
    </div>
  );
}

function IncidentPreview({ row, L, onActions }: Props) {
  const q = useAsync(() => loadIncident(row.entity_id), [row.entity_id, row.status], { key: 'hse-incident' });
  useEffect(() => { onActions({}); });
  const i = q.data;
  if (!i) return <div className="inbox-preview-body">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />}</div>;
  return (
    <div className="inbox-preview-body">
      <div className="inbox-preview-head">
        <h2><Link to="/safety#incidents">{i.number} · {INCIDENT_KIND_LABELS[i.kind]} <ExternalLink size={14} aria-hidden /></Link></h2>
        <div className="meta"><Badge tone={i.severity === 'serious' || i.severity === 'fatal' ? 'danger' : 'warning'} label={SEVERITY_LABELS[i.severity]} icon={null} />
          {' '}· {INCIDENT_STATUS_LABELS[i.status]} · reported by {L.person(i.reported_by)}</div>
      </div>
      <dl className="kv">
        <dt>When</dt><dd>{dateTime(i.occurred_at)}{i.location_text ? ` · ${i.location_text}` : ''}</dd>
        <dt>What happened</dt><dd>{i.description}</dd>
        {i.injured_name && <><dt>Injured</dt><dd>{i.injured_name}{i.injured_trade ? ` (${i.injured_trade})` : ''}{i.lost_time ? ` · ${i.days_lost} days lost` : ''}{i.hospital ? ' · hospital' : ''}</dd></>}
        {i.immediate_action && <><dt>Immediate action</dt><dd>{i.immediate_action}</dd></>}
        {i.corrective_action && <><dt>Corrective action</dt><dd>{i.corrective_action}{i.action_due ? ` · due ${i.action_due}` : ''}</dd></>}
      </dl>
      <p className="muted small-text">{i.status === 'reported' ? 'Open it on the Safety page to record the root cause and corrective action.' : 'When the action is done, the coordinator closes the incident on the Safety page.'}</p>
    </div>
  );
}
