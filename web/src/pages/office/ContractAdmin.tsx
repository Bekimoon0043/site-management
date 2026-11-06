// Contract administration registers and the project's configurable response / claim deadlines.
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, humanize, money, num } from '../../lib/format';
import {
  EOT_CAUSE_LABELS, EOT_STATUS_LABELS, RISK_CATEGORIES, type ContractAdminSettings, type EotCause, type EotClaim, type EotStatus,
  type Risk, type RiskCategory,
} from '../../lib/contract-office';
import {
  Badge, Banner, Card, DataTable, Drawer, ErrorBanner, Field, Kpi, Loading, Page, ReasonModal, Tabs, toast, useBusy, useHashTab, type Tone,
} from '../../components/ui';
import { Attachments } from '../../components/Attachments';
import { Rfis } from '../../components/office/Rfis';
import { DocumentRegister, Submittals } from '../../components/office/Documents';
import { Meetings } from '../../components/office/Meetings';
import { addDays, canOffice, loadClaims, loadEvidence, loadRisks, loadSettings, officeRpc, todayEat } from '../../components/office/data';

const TABS = ['rfis', 'documents', 'submittals', 'meetings', 'risks', 'claims', 'settings'] as const;
type Tab = (typeof TABS)[number];

export function ContractAdmin() {
  const projectId = useProjectId();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'rfis');
  return (
    <Page title="Contract administration" subtitle="RFIs, instructions, controlled documents, approvals, actions, risks and delay claims">
      <Tabs label="Contract administration sections" value={tab} onChange={setTab} tabs={[
        { key: 'rfis', label: 'RFIs & instructions' }, { key: 'documents', label: 'Documents' }, { key: 'submittals', label: 'Submittals' },
        { key: 'meetings', label: 'Meetings & actions' }, { key: 'risks', label: 'Risks & issues' }, { key: 'claims', label: 'EOT / delay claims' },
        { key: 'settings', label: 'Deadlines' },
      ]} />
      <div className="mt-3">
        {tab === 'rfis' && <Rfis projectId={projectId} />}
        {tab === 'documents' && <DocumentRegister projectId={projectId} />}
        {tab === 'submittals' && <Submittals projectId={projectId} />}
        {tab === 'meetings' && <Meetings projectId={projectId} />}
        {tab === 'risks' && <Risks projectId={projectId} />}
        {tab === 'claims' && <Claims projectId={projectId} />}
        {tab === 'settings' && <AdminSettings projectId={projectId} />}
      </div>
    </Page>
  );
}

const RISK_TONE: Record<Risk['status'], Tone> = { open: 'warning', occurred: 'danger', closed: 'neutral' };

function Risks({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => loadRisks(projectId), [projectId], { key: 'risks' });
  const [view, setView] = useState<'open' | 'issues' | 'all'>('open');
  const [open, setOpen] = useState<Risk | 'new' | null>(null);
  const rows = q.data ?? [];
  const shown = rows.filter((r) => view === 'all' || (view === 'issues' ? r.kind === 'issue' && r.status !== 'closed' : r.status !== 'closed'));
  const active = rows.filter((r) => r.status !== 'closed');
  const high = active.filter((r) => r.score >= 15).length;
  const reviewDue = active.filter((r) => r.review_by && r.review_by <= todayEat()).length;
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Open risks & issues" value={active.length} />
        <Kpi label="High exposure (score ≥ 15)" value={high} status={high ? 'danger' : 'ok'} />
        <Kpi label="Reviews due" value={reviewDue} status={reviewDue ? 'warning' : 'ok'} />
        <Kpi label="Open issues" value={active.filter((r) => r.kind === 'issue').length} />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Tabs variant="segmented" value={view} onChange={setView} tabs={[{ key: 'open', label: 'Open' }, { key: 'issues', label: 'Issues' }, { key: 'all', label: 'All' }]} />
        {canOffice(auth.profile?.role, 'createRisk') && <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />New risk / issue</button>}
      </div>
      <Card flush>
        <DataTable rows={shown} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="risk-issue-register"
          rowClass={(r) => (r.status !== 'closed' && (r.score >= 15 || (r.review_by != null && r.review_by <= todayEat())) ? 'row-warn' : undefined)}
          empty={{ title: 'No risks or issues here', body: 'Record exposure before it becomes delay or cost; give every item an owner, response and review date.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'kind', label: 'Type', render: (r) => <Badge tone={r.kind === 'issue' ? 'danger' : 'info'} label={humanize(r.kind)} icon={null} /> },
            { key: 'title', label: 'Risk / issue' },
            { key: 'category', label: 'Category', render: (r) => humanize(r.category) },
            { key: 'score', label: 'Score', align: 'right', render: (r) => <span className={r.score >= 15 ? 'danger-text strong' : undefined}>{r.score} <span className="muted small-text">({r.likelihood} × {r.impact})</span></span> },
            { key: 'owner', label: 'Owner', value: (r) => lk.data?.person(r.owner_id) ?? '', render: (r) => lk.data?.person(r.owner_id) || 'Unassigned' },
            { key: 'response_type', label: 'Response', value: (r) => r.response_type ?? '', render: (r) => (r.response_type ? humanize(r.response_type) : '—') },
            { key: 'review_by', label: 'Review by', value: (r) => r.review_by ?? '', render: (r) => (r.review_by ? date(r.review_by) : '—') },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={RISK_TONE[r.status]} label={humanize(r.status)} icon={null} /> },
          ]} />
      </Card>
      {open && <RiskDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} risk={open === 'new' ? null : open} onClose={() => { setOpen(null); q.reload(); }} />}
    </div>
  );
}

function RiskDrawer({ projectId, risk, onClose }: { projectId: string; risk: Risk | null; onClose: () => void }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const editable = risk ? risk.owner_id === auth.profile?.id || canOffice(auth.profile?.role, 'office') : canOffice(auth.profile?.role, 'createRisk');
  const [f, setF] = useState({
    kind: risk?.kind ?? 'risk' as Risk['kind'], title: risk?.title ?? '', description: risk?.description ?? '', category: risk?.category ?? 'other' as RiskCategory,
    likelihood: String(risk?.likelihood ?? 3), impact: String(risk?.impact ?? 3), owner_id: risk?.owner_id ?? '', response_type: risk?.response_type ?? '' as Risk['response_type'] | '',
    response: risk?.response ?? '', cost_exposure: risk?.cost_exposure == null ? '' : String(risk.cost_exposure),
    time_exposure_days: risk?.time_exposure_days == null ? '' : String(risk.time_exposure_days), review_by: risk?.review_by ?? '', status: risk?.status ?? 'open' as Risk['status'],
    client_summary: risk?.client_summary ?? '', client_mitigation: risk?.client_mitigation ?? '',
  });
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const optional = (v: string) => (v === '' ? null : Number(v));
  const save = () => void run(async () => {
    const r = await officeRpc('save_risk', {
      id: risk?.id ?? crypto.randomUUID(), project_id: projectId, ...f, likelihood: Number(f.likelihood), impact: Number(f.impact), owner_id: f.owner_id || null,
      cost_exposure: optional(f.cost_exposure), time_exposure_days: optional(f.time_exposure_days), review_by: f.review_by || null,
    });
    toast.success(`${String(r.number)} saved`);
    onClose();
  });
  const publish = (visible: boolean) => void run(async () => {
    if (!risk) return;
    const { error: publishError } = await supabase.rpc('set_risk_client_visibility', { p: {
      id: risk.id, visible, summary: f.client_summary, mitigation: f.client_mitigation,
    } });
    if (publishError) throw new Error(publishError.message);
    toast.success(visible ? 'Client-safe risk summary published' : 'Risk removed from the client portal');
    onClose();
  });
  return (
    <Drawer size="lg" onClose={onClose} title={risk ? `${risk.number} · ${risk.title}` : 'New risk / issue'}
      subtitle={risk ? <Badge tone={RISK_TONE[risk.status]} label={`${humanize(risk.kind)} · ${humanize(risk.status)}`} icon={null} /> : 'Likelihood × impact, each scored 1–5'}>
      <ErrorBanner error={error} />
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Type"><select value={f.kind} onChange={set('kind')}><option value="risk">Risk — may happen</option><option value="issue">Issue — has happened</option></select></Field>
        <Field label="Title" required wide><input value={f.title} onChange={set('title')} placeholder="e.g. Cement shortage in rainy season" /></Field>
        <Field label="Description / cause" wide><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
        <Field label="Category"><select value={f.category} onChange={set('category')}>{RISK_CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
        <Field label="Owner"><select value={f.owner_id} onChange={set('owner_id')}><option value="">Unassigned</option>{(lk.data?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({humanize(p.role)})</option>)}</select></Field>
        <Field label="Likelihood (1–5)"><input type="number" min={1} max={5} step={1} value={f.likelihood} onChange={set('likelihood')} /></Field>
        <Field label="Impact (1–5)"><input type="number" min={1} max={5} step={1} value={f.impact} onChange={set('impact')} /></Field>
        <Field label="Response"><select value={f.response_type ?? ''} onChange={set('response_type')}><option value="">—</option><option value="avoid">Avoid</option><option value="reduce">Reduce</option><option value="transfer">Transfer</option><option value="accept">Accept</option></select></Field>
        <Field label="Response / mitigation" wide><textarea rows={3} value={f.response} onChange={set('response')} /></Field>
        <Field label="Cost exposure (ETB)"><input type="number" min={0} step="0.01" value={f.cost_exposure} onChange={set('cost_exposure')} /></Field>
        <Field label="Time exposure (days)"><input type="number" min={0} step="0.5" value={f.time_exposure_days} onChange={set('time_exposure_days')} /></Field>
        <Field label="Next review"><input type="date" value={f.review_by} onChange={set('review_by')} /></Field>
        {risk && <Field label="Status"><select value={f.status} onChange={set('status')}><option value="open">Open</option><option value="occurred">Occurred</option><option value="closed">Closed</option></select></Field>}
      </fieldset>
      {risk && ['coordinator', 'manager', 'admin'].includes(auth.profile?.role ?? '') && <Card title="Client-safe publication" sub="Only this wording is shown externally; internal descriptions, owners and cost exposure remain private.">
        <div className="form-grid">
          <Field label="Client summary" required wide><textarea rows={2} value={f.client_summary} onChange={set('client_summary')} placeholder="Plain-language risk or issue summary" /></Field>
          <Field label="Mitigation / next action" wide><textarea rows={2} value={f.client_mitigation} onChange={set('client_mitigation')} placeholder="What is being done and when" /></Field>
        </div>
        <div className="row mt-2">
          <Badge tone={risk.client_visible ? 'success' : 'neutral'} label={risk.client_visible ? 'Published to client' : 'Not published'} icon={null} />
          <button disabled={busy || (!risk.client_visible && !f.client_summary.trim())} onClick={() => publish(!risk.client_visible)}>{risk.client_visible ? 'Remove from client portal' : 'Approve and publish'}</button>
        </div>
      </Card>}
      <p className="muted small-text">Current score: <strong>{Number(f.likelihood || 0) * Number(f.impact || 0)}</strong>. Scores prioritise management attention; they do not establish contractual entitlement.</p>
      {editable && <div className="row mt-2"><button className="primary" disabled={busy || !f.title.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></div>}
      {risk && <><h3 className="mt-4">Evidence & documents</h3><Attachments entityType="risk" entityId={risk.id} /></>}
    </Drawer>
  );
}

const EOT_TONE: Record<EotStatus, Tone> = {
  draft: 'neutral', notice_sent: 'warning', submitted: 'info', granted: 'success', partly_granted: 'success', rejected: 'danger', withdrawn: 'neutral',
};

function Claims({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const q = useAsync(() => loadClaims(projectId), [projectId], { key: 'eot-claims' });
  const [open, setOpen] = useState<EotClaim | 'new' | null>(null);
  const rows = q.data?.claims ?? [];
  const dates = q.data?.dates;
  const active = rows.filter((r) => ['draft', 'notice_sent', 'submitted'].includes(r.status));
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Open claims" value={active.length} />
        <Kpi label="Days claimed, awaiting decision" value={num(dates?.days_pending ?? 0, 1)} unit="days" />
        <Kpi label="Days granted" value={num(dates?.days_granted ?? 0, 1)} unit="days" />
        <Kpi label="Original completion" value={date(dates?.original_completion) || '—'} />
        <Kpi label="Revised completion" value={date(dates?.revised_completion) || '—'} hint="Original completion plus granted EOT days" />
      </div>
      <Banner tone="info">Record the event and contemporaneous diary evidence promptly. Notice and particulars periods are project settings; confirm the signed GCC/SCC and applicable law. A late flag is not a legal determination.</Banner>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="Extension-of-time & delay claims" actions={canOffice(auth.profile?.role, 'createClaim') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Record delay event</button> : undefined}>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="eot-claims"
          empty={{ title: 'No delay events', body: 'Record an event when it occurs, then send notice and substantiated particulars using the contract procedure.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'title', label: 'Event / claim' },
            { key: 'cause', label: 'Cause', value: (r) => EOT_CAUSE_LABELS[r.cause], render: (r) => EOT_CAUSE_LABELS[r.cause] },
            { key: 'event_from', label: 'Event', value: (r) => r.event_from, render: (r) => `${date(r.event_from)} → ${r.event_to ? date(r.event_to) : 'continuing'}` },
            { key: 'notice_date', label: 'Notice', value: (r) => r.notice_date ?? '', render: (r) => (r.notice_date ? <span title={r.notice_ref ?? undefined}>{date(r.notice_date)}</span> : '—') },
            { key: 'days_claimed', label: 'Days claimed', align: 'right', render: (r) => num(r.days_claimed, 1) },
            { key: 'cost_claimed', label: 'Cost claimed', align: 'right', value: (r) => Number(r.cost_claimed), render: (r) => (Number(r.cost_claimed) ? money(r.cost_claimed) : '—') },
            { key: 'days_granted', label: 'Days granted', align: 'right', value: (r) => r.days_granted ?? -1, render: (r) => (r.days_granted == null ? '—' : num(r.days_granted, 1)) },
            { key: 'status', label: 'Status', render: (r) => <Badge tone={EOT_TONE[r.status]} label={EOT_STATUS_LABELS[r.status]} icon={null} /> },
          ]} />
      </Card>
      {open && <ClaimDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} claim={open === 'new' ? null : open} onClose={() => { setOpen(null); q.reload(); }} />}
    </div>
  );
}

function ClaimDrawer({ projectId, claim, onClose }: { projectId: string; claim: EotClaim | null; onClose: () => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const sq = useAsync(() => loadSettings(projectId), [projectId], { key: 'ca-settings' });
  const eq = useAsync(() => (claim ? loadEvidence(projectId, claim.event_from, claim.event_to) : Promise.resolve([])), [claim?.id, claim?.event_from, claim?.event_to], { key: 'eot-evidence' });
  const editable = !claim || (['draft', 'notice_sent'].includes(claim.status) && canOffice(role, 'createClaim'));
  const decide = canOffice(role, 'decideClaim');
  const [f, setF] = useState({
    title: claim?.title ?? '', cause: claim?.cause ?? 'other' as EotCause, description: claim?.description ?? '', event_from: claim?.event_from ?? todayEat(),
    event_to: claim?.event_to ?? '', days_claimed: String(claim?.days_claimed ?? 0), cost_claimed: String(claim?.cost_claimed ?? 0),
  });
  const [notice, setNotice] = useState({ notice_date: todayEat(), notice_ref: '' });
  const [particulars, setParticulars] = useState({ particulars_date: todayEat(), days_claimed: String(claim?.days_claimed ?? 0), cost_claimed: String(claim?.cost_claimed ?? 0) });
  const [decision, setDecision] = useState({ days_granted: String(claim?.days_claimed ?? 0), cost_granted: String(claim?.cost_claimed ?? 0), decided_on: todayEat(), consultant_ref: '', comment: '' });
  const [withdrawing, setWithdrawing] = useState(false);
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const noticeDue = sq.data && f.event_from ? addDays(f.event_from, sq.data.claim_notice_days) : null;
  const particularsDue = claim?.notice_date && sq.data ? addDays(claim.notice_date, sq.data.claim_particulars_days) : null;
  const save = () => void run(async () => {
    const r = await officeRpc('save_eot_claim', {
      id: claim?.id ?? crypto.randomUUID(), project_id: projectId, ...f, event_to: f.event_to || null,
      days_claimed: Number(f.days_claimed || 0), cost_claimed: Number(f.cost_claimed || 0),
    });
    toast.success(`${String(r.number)} saved`);
    onClose();
  });
  const act = (action: 'send_notice' | 'submit' | 'decide') => void run(async () => {
    const payload = action === 'send_notice' ? notice : action === 'submit' ? {
      particulars_date: particulars.particulars_date, days_claimed: Number(particulars.days_claimed || 0), cost_claimed: Number(particulars.cost_claimed || 0),
    } : { ...decision, days_granted: Number(decision.days_granted || 0), cost_granted: Number(decision.cost_granted || 0) };
    const r = await officeRpc('decide_eot_claim', { claim_id: claim!.id, action, ...payload });
    toast.success(action === 'send_notice' ? (r.notice_late ? 'Notice recorded — after the configured deadline' : 'Notice recorded') : action === 'submit' ? 'Detailed claim submitted' : 'Decision recorded');
    onClose();
  });
  return (
    <Drawer size="lg" onClose={onClose} title={claim ? `${claim.number} · ${claim.title}` : 'Record a delay event'}
      subtitle={claim ? <Badge tone={EOT_TONE[claim.status]} label={EOT_STATUS_LABELS[claim.status]} icon={null} /> : 'Event first; notice, particulars and decision follow'}>
      <ErrorBanner error={error ?? sq.error} />
      <fieldset disabled={!editable} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Event / claim title" required wide><input value={f.title} onChange={set('title')} placeholder="e.g. Late lift-pit drawings" /></Field>
        <Field label="Cause"><select value={f.cause} onChange={set('cause')}>{(Object.keys(EOT_CAUSE_LABELS) as EotCause[]).map((c) => <option key={c} value={c}>{EOT_CAUSE_LABELS[c]}</option>)}</select></Field>
        <Field label="Description / effect on the works" wide><textarea rows={3} value={f.description} onChange={set('description')} /></Field>
        <Field label="Event started" required hint={noticeDue ? `Configured notice deadline: ${date(noticeDue)}` : undefined}><input type="date" value={f.event_from} onChange={set('event_from')} /></Field>
        <Field label="Event ended" hint="Empty = continuing"><input type="date" min={f.event_from} value={f.event_to} onChange={set('event_to')} /></Field>
        <Field label="Days claimed"><input type="number" min={0} step="0.5" value={f.days_claimed} onChange={set('days_claimed')} /></Field>
        <Field label="Cost claimed (ETB)"><input type="number" min={0} step="0.01" value={f.cost_claimed} onChange={set('cost_claimed')} /></Field>
      </fieldset>
      {editable && <div className="row mt-2"><button className="primary" disabled={busy || !f.title.trim() || !f.event_from} onClick={save}>{busy && <span className="spinner" />}Save event</button></div>}

      {claim && (
        <>
          <h3 className="mt-4">Diary evidence in the event window</h3>
          <ErrorBanner error={eq.error} onRetry={eq.reload} />
          <DataTable rows={eq.data ?? []} rowKey={(r) => r.cause} loading={!eq.data} maxHeight="none"
            empty={{ title: 'No submitted diary delays in this window', body: 'Diary evidence supports the claim; it does not by itself prove critical-path delay or entitlement.' }}
            columns={[
              { key: 'cause', label: 'Diary cause', render: (r) => humanize(r.cause) }, { key: 'diaries', label: 'Diaries', align: 'right' },
              { key: 'hours_lost', label: 'Hours lost', align: 'right', render: (r) => num(r.hours_lost, 1) }, { key: 'days_lost', label: 'Days (8 h/day)', align: 'right', render: (r) => num(r.days_lost, 1) },
              { key: 'first_date', label: 'First', render: (r) => date(r.first_date) }, { key: 'last_date', label: 'Last', render: (r) => date(r.last_date) },
            ]} />
          {claim.status === 'draft' && decide && (
            <>
              <h3 className="mt-4">Send notice</h3>
              {noticeDue && notice.notice_date > noticeDue && <Banner tone="warn">This notice is after the project’s configured deadline ({date(noticeDue)}). Review the contract and obtain advice; the system does not decide whether the claim is time-barred.</Banner>}
              <div className="form-grid">
                <Field label="Notice date"><input type="date" value={notice.notice_date} onChange={(e) => setNotice({ ...notice, notice_date: e.target.value })} /></Field>
                <Field label="Letter / notice reference"><input value={notice.notice_ref} onChange={(e) => setNotice({ ...notice, notice_ref: e.target.value })} /></Field>
              </div>
              <div className="row mt-2"><button className="primary" disabled={busy || !notice.notice_date} onClick={() => act('send_notice')}>Record notice sent</button></div>
            </>
          )}
          {claim.status === 'notice_sent' && decide && (
            <>
              <h3 className="mt-4">Submit detailed particulars</h3>
              <p className="muted small-text">Notice recorded {date(claim.notice_date)}{claim.notice_ref ? ` · ${claim.notice_ref}` : ''}{particularsDue ? ` · configured particulars deadline ${date(particularsDue)}` : ''}.</p>
              <div className="form-grid">
                <Field label="Submission date"><input type="date" value={particulars.particulars_date} onChange={(e) => setParticulars({ ...particulars, particulars_date: e.target.value })} /></Field>
                <Field label="Days claimed" required><input type="number" min={0} step="0.5" value={particulars.days_claimed} onChange={(e) => setParticulars({ ...particulars, days_claimed: e.target.value })} /></Field>
                <Field label="Cost claimed (ETB)"><input type="number" min={0} step="0.01" value={particulars.cost_claimed} onChange={(e) => setParticulars({ ...particulars, cost_claimed: e.target.value })} /></Field>
              </div>
              <div className="row mt-2"><button className="primary" disabled={busy || Number(particulars.days_claimed || 0) <= 0 && Number(particulars.cost_claimed || 0) <= 0} onClick={() => act('submit')}>Record claim submission</button></div>
            </>
          )}
          {claim.status === 'submitted' && decide && (
            <>
              <h3 className="mt-4">Consultant's decision</h3>
              <div className="form-grid">
                <Field label="Days granted" required><input type="number" min={0} step="0.5" value={decision.days_granted} onChange={(e) => setDecision({ ...decision, days_granted: e.target.value })} /></Field>
                <Field label="Cost granted (ETB)"><input type="number" min={0} step="0.01" value={decision.cost_granted} onChange={(e) => setDecision({ ...decision, cost_granted: e.target.value })} /></Field>
                <Field label="Decided on"><input type="date" value={decision.decided_on} onChange={(e) => setDecision({ ...decision, decided_on: e.target.value })} /></Field>
                <Field label="Consultant reference"><input value={decision.consultant_ref} onChange={(e) => setDecision({ ...decision, consultant_ref: e.target.value })} /></Field>
                <Field label="Decision comment" wide><textarea rows={2} value={decision.comment} onChange={(e) => setDecision({ ...decision, comment: e.target.value })} /></Field>
              </div>
              <div className="row mt-2"><button className="primary" disabled={busy || decision.days_granted === ''} onClick={() => act('decide')}>Record decision</button></div>
            </>
          )}
          {claim.decision_comment && <Banner tone="info">Decision comment: {claim.decision_comment}</Banner>}
          {decide && !['granted', 'partly_granted', 'rejected', 'withdrawn'].includes(claim.status) && <div className="row mt-3"><button disabled={busy} onClick={() => setWithdrawing(true)}>Withdraw claim…</button></div>}
          <h3 className="mt-4">Claim documents</h3>
          <Attachments entityType="eot_claim" entityId={claim.id} />
        </>
      )}
      {withdrawing && claim && <ReasonModal title={`Withdraw ${claim.number}`} label="Reason" danger onClose={() => setWithdrawing(false)} onSubmit={async (comment) => {
        await officeRpc('decide_eot_claim', { claim_id: claim.id, action: 'withdraw', comment });
        toast.success('Claim withdrawn');
        onClose();
      }} />}
    </Drawer>
  );
}

function AdminSettings({ projectId }: { projectId: string }) {
  const q = useAsync(() => loadSettings(projectId), [projectId], { key: 'ca-settings' });
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {!q.data ? <Loading lines={6} /> : <SettingsForm key={`${projectId}-${JSON.stringify(q.data)}`} projectId={projectId} settings={q.data} onSaved={q.reload} />}
    </>
  );
}

function SettingsForm({ projectId, settings, onSaved }: { projectId: string; settings: ContractAdminSettings; onSaved: () => void }) {
  const auth = useAuth();
  const edit = canOffice(auth.profile?.role, 'settings');
  const [f, setF] = useState({
    rfi_response_days: String(settings.rfi_response_days), si_response_days: String(settings.si_response_days), submittal_response_days: String(settings.submittal_response_days),
    claim_notice_days: String(settings.claim_notice_days), claim_particulars_days: String(settings.claim_particulars_days), reminder_days: String(settings.reminder_days),
  });
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => void run(async () => {
    await officeRpc('save_contract_admin_settings', {
      project_id: projectId, rfi_response_days: Number(f.rfi_response_days), si_response_days: Number(f.si_response_days),
      submittal_response_days: Number(f.submittal_response_days), claim_notice_days: Number(f.claim_notice_days),
      claim_particulars_days: Number(f.claim_particulars_days), reminder_days: Number(f.reminder_days),
    });
    toast.success('Contract administration deadlines saved');
    onSaved();
  });
  return (
    <Card title="Response, claim & reminder deadlines" sub="Project defaults used when a register entry does not have an explicit due date.">
      <Banner tone="info">These are configurable administration settings, not assertions of Ethiopian law or of any particular contract. Copy the signed GCC/SCC and any agreed amendments; contract editions and project terms differ.</Banner>
      <ErrorBanner error={error} />
      <fieldset disabled={!edit} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="RFI response (calendar days)"><input type="number" min={1} max={90} value={f.rfi_response_days} onChange={set('rfi_response_days')} /></Field>
        <Field label="Site instruction compliance (calendar days)"><input type="number" min={1} max={90} value={f.si_response_days} onChange={set('si_response_days')} /></Field>
        <Field label="Submittal review (calendar days)"><input type="number" min={1} max={90} value={f.submittal_response_days} onChange={set('submittal_response_days')} /></Field>
        <Field label="Delay notice (calendar days)" hint="Measured in this register from the recorded event start"><input type="number" min={1} max={180} value={f.claim_notice_days} onChange={set('claim_notice_days')} /></Field>
        <Field label="Detailed particulars (calendar days)" hint="Measured in this register from the recorded notice date"><input type="number" min={1} max={365} value={f.claim_particulars_days} onChange={set('claim_particulars_days')} /></Field>
        <Field label="Action reminder lead time (days)"><input type="number" min={0} max={30} value={f.reminder_days} onChange={set('reminder_days')} /></Field>
      </fieldset>
      {edit ? <div className="row mt-2"><button className="primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save deadlines</button></div>
        : <p className="muted small-text mb-0">Coordinators and managers maintain these settings.</p>}
    </Card>
  );
}
