// Client IPC receivables ageing, contract payment timing and retention release.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { date, humanize, money, num } from '../../lib/format';
import type { ClientContract } from '../../lib/contract-billing';
import {
  BUCKET_LABELS, type Receivable, type ReceivableBucket, type RetentionRelease, type RetentionStatus,
} from '../../lib/contract-office';
import {
  Badge, Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, Kpi, Page, Tabs, toast, useBusy, useHashTab, type Tone,
} from '../../components/ui';
import { loadContract } from '../../components/billing/data';
import { canOffice, loadReceivables, officeRpc, todayEat } from '../../components/office/data';

type CompletionContract = ClientContract & {
  payment_days: number; certify_days: number; practical_completion_on: string | null; dlp_months: number; retention_pc_release_pct: number;
};
const TABS = ['ageing', 'retention'] as const;
const BUCKET_TONE: Record<ReceivableBucket, Tone> = {
  paid: 'success', not_certified: 'info', not_due: 'neutral', '1_30': 'warning', '31_60': 'warning', '61_90': 'danger', '90_plus': 'danger',
};
const LATE: ReceivableBucket[] = ['1_30', '31_60', '61_90', '90_plus'];

export function Receivables() {
  const projectId = useProjectId();
  const auth = useAuth();
  const [tab, setTab] = useHashTab<(typeof TABS)[number]>(TABS, 'ageing');
  const q = useAsync(async () => {
    const [data, contract] = await Promise.all([loadReceivables(projectId), loadContract(projectId)]);
    return { ...data, contract: contract as CompletionContract | null };
  }, [projectId], { key: 'client-receivables', enabled: auth.canSeePrices });
  if (!auth.canSeePrices) return <Page title="Client receivables"><Empty title="No access">Receivables and retention contain contract prices. Ask an administrator for price access.</Empty></Page>;
  const rows = q.data?.rows ?? [];
  const retention = q.data?.retention ?? null;
  const overdue = rows.filter((r) => LATE.includes(r.bucket));
  return (
    <Page title="Client receivables & retention" subtitle="From IPC submission and certification through payment, practical completion and retention release">
      <div className="kpis">
        <Kpi label="Outstanding on submitted / certified IPCs" value={money(rows.reduce((s, r) => s + Number(r.outstanding), 0))} />
        <Kpi label="Overdue client payments" value={money(overdue.reduce((s, r) => s + Number(r.outstanding), 0))} status={overdue.length ? 'danger' : 'ok'} hint={`${overdue.length} certificate${overdue.length === 1 ? '' : 's'} overdue`} />
        <Kpi label="With the consultant" value={money(rows.filter((r) => r.bucket === 'not_certified').reduce((s, r) => s + Number(r.outstanding), 0))} />
        <Kpi label="Retention still held" value={money(retention?.still_held ?? 0)} hint={retention?.dlp_end ? `Configured DLP ends ${date(retention.dlp_end)}` : undefined} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'ageing', label: 'Receivables ageing', count: overdue.length, hot: overdue.length > 0 }, { key: 'retention', label: 'Retention release' }]} />
      <div className="mt-3 stack">
        <ErrorBanner error={q.error} onRetry={q.reload} />
        {tab === 'ageing' ? <Ageing rows={rows} loading={!q.data} /> : (
          <Retention projectId={projectId} contract={q.data?.contract ?? null} status={retention} releases={q.data?.releases ?? []} loading={!q.data} onChanged={q.reload} />
        )}
      </div>
    </Page>
  );
}

function Ageing({ rows, loading }: { rows: Receivable[]; loading: boolean }) {
  const buckets = (Object.keys(BUCKET_LABELS) as ReceivableBucket[]).map((bucket) => ({
    bucket, count: rows.filter((r) => r.bucket === bucket).length,
    amount: rows.filter((r) => r.bucket === bucket).reduce((s, r) => s + Number(r.outstanding), 0),
  })).filter((b) => b.count > 0);
  return (
    <>
      <Banner tone="info">Due dates use the certification and payment days recorded for this project. Ageing supports collection follow-up; it does not calculate interest or decide contractual entitlement.</Banner>
      <div className="dash-grid">
        <Card flush title="Ageing summary">
          <DataTable rows={buckets} rowKey={(r) => r.bucket} loading={loading} maxHeight="none" empty="No submitted or certified IPCs."
            columns={[
              { key: 'bucket', label: 'Bucket', render: (r) => <Badge tone={BUCKET_TONE[r.bucket]} label={BUCKET_LABELS[r.bucket]} icon={null} /> },
              { key: 'count', label: 'IPCs', align: 'right' }, { key: 'amount', label: 'Outstanding', align: 'right', render: (r) => money(r.amount) },
            ]} />
        </Card>
        <Card title="Collection priority" sub="Oldest and largest unpaid certificates first">
          {loading ? <p className="muted">Loading…</p> : !overdueList(rows).length ? <p className="muted mb-0">No certified payment is past its configured due date.</p> : (
            <ul className="mb-0">{overdueList(rows).slice(0, 5).map((r) => <li key={r.id}><Link to={`/billing/ipc/${r.id}`}>IPC {r.ipc_no}</Link> — {money(r.outstanding)}, {r.days_overdue} days late</li>)}</ul>
          )}
        </Card>
      </div>
      <Card flush title="Client IPC register" sub="Click the IPC number for its valuation and payment detail.">
        <DataTable rows={rows} rowKey={(r) => r.id} loading={loading} exportName="client-receivables"
          rowClass={(r) => (LATE.includes(r.bucket) ? 'row-warn' : undefined)} empty={{ title: 'No receivables yet', body: 'Submitted, certified and paid IPCs appear here. Prepare certificates under Client billing.' }}
          columns={[
            { key: 'ipc_no', label: 'IPC', id: true, render: (r) => <Link to={`/billing/ipc/${r.id}`}>IPC {r.ipc_no}</Link> },
            { key: 'period_to', label: 'Measured to', render: (r) => date(r.period_to) },
            { key: 'submitted_on', label: 'Submitted', value: (r) => r.submitted_on ?? '', render: (r) => (r.submitted_on ? date(r.submitted_on) : '—') },
            { key: 'certified_on', label: 'Certified', value: (r) => r.certified_on ?? '', render: (r) => (r.certified_on ? date(r.certified_on) : '—') },
            { key: 'payable', label: 'Payable', align: 'right', value: (r) => Number(r.payable), render: (r) => money(r.payable) },
            { key: 'paid_amount', label: 'Received', align: 'right', value: (r) => Number(r.paid_amount), render: (r) => money(r.paid_amount) },
            { key: 'outstanding', label: 'Outstanding', align: 'right', value: (r) => Number(r.outstanding), render: (r) => <strong>{money(r.outstanding)}</strong> },
            { key: 'due_on', label: 'Configured due date', value: (r) => r.due_on ?? '', render: (r) => (r.due_on ? date(r.due_on) : '—') },
            { key: 'days_overdue', label: 'Days late', align: 'right', render: (r) => (r.days_overdue > 0 ? <span className="danger-text strong">{r.days_overdue}</span> : '—') },
            { key: 'bucket', label: 'Ageing', render: (r) => <Badge tone={BUCKET_TONE[r.bucket]} label={BUCKET_LABELS[r.bucket]} icon={null} /> },
          ]} />
      </Card>
    </>
  );
}

const overdueList = (rows: Receivable[]) => rows.filter((r) => LATE.includes(r.bucket)).sort((a, b) => b.days_overdue - a.days_overdue || Number(b.outstanding) - Number(a.outstanding));

function Retention({ projectId, contract, status, releases, loading, onChanged }: {
  projectId: string; contract: CompletionContract | null; status: RetentionStatus | null; releases: RetentionRelease[]; loading: boolean; onChanged: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const [terms, setTerms] = useState(false);
  const [release, setRelease] = useState<RetentionRelease | { stage: RetentionRelease['stage'] } | null>(null);
  if (loading) return <Card title="Retention"><p className="muted">Loading…</p></Card>;
  if (!contract) return <Empty title="Enter the client contract terms first" action={<Link className="primary" to="/billing#terms">Contract terms</Link>}>Retention and payment timing need a client contract.</Empty>;
  const canRequest = canOffice(role, 'requestRetention');
  return (
    <>
      <Banner tone="info">Release percentages, practical completion and the defects liability period are configurable contract data. Verify them against the signed contract; the common half-at-completion arrangement is not assumed to be a universal legal rule.</Banner>
      <Card title="Contract completion & payment timing" sub="These values drive receivable due dates and retention reminders."
        actions={<button className="small" onClick={() => setTerms(true)}>{canOffice(role, 'completion') ? 'Edit terms' : 'View terms'}</button>}>
        <div className="form-grid">
          <div><div className="muted small-text">Consultant certification</div><strong>{contract.certify_days} calendar days after submission</strong></div>
          <div><div className="muted small-text">Client payment</div><strong>{contract.payment_days} calendar days after certification</strong></div>
          <div><div className="muted small-text">Practical completion</div><strong>{date(status?.practical_completion_on) || 'Not recorded'}</strong></div>
          <div><div className="muted small-text">Defects liability period</div><strong>{status?.dlp_months ?? contract.dlp_months} months{status?.dlp_end ? ` · ends ${date(status.dlp_end)}` : ''}</strong></div>
          <div><div className="muted small-text">Release at practical completion</div><strong>{num(status?.retention_pc_release_pct ?? contract.retention_pc_release_pct, 2)} % of retention held</strong></div>
        </div>
      </Card>
      {status && (
        <div className="kpis">
          <Kpi label="Retention certified to date" value={money(status.held)} />
          <Kpi label="Practical-completion release" value={money(status.pc_release_amount)} hint={status.pc_status ? humanize(status.pc_status) : status.pc_release_due ? 'Ready to request' : 'Not yet requested'} />
          <Kpi label="Final release balance" value={money(status.final_release_amount)} hint={status.final_status ? humanize(status.final_status) : status.final_release_due ? 'Ready to request' : status.dlp_end ? `DLP ends ${date(status.dlp_end)}` : undefined} />
          <Kpi label="Received / still held" value={`${money(status.received)} / ${money(status.still_held)}`} />
        </div>
      )}
      {status?.pc_release_due && <Banner tone="attention" action={canRequest ? <button className="small" onClick={() => setRelease({ stage: 'practical_completion' })}>Request release</button> : undefined}>Practical completion is recorded and the configured first retention release can be requested.</Banner>}
      {status?.final_release_due && <Banner tone="attention" action={canRequest ? <button className="small" onClick={() => setRelease({ stage: 'final' })}>Request release</button> : undefined}>The configured defects liability period has ended and the final retention balance can be requested.</Banner>}
      <Card flush title="Retention release register" sub="Requested → certified → received. Receipts are recorded by finance or management."
        actions={canRequest && status && status.practical_completion_on && !releases.some((r) => r.stage === 'practical_completion') ? <button className="primary small" onClick={() => setRelease({ stage: 'practical_completion' })}><Plus size={14} aria-hidden />Request first release</button> : undefined}>
        <DataTable rows={releases} rowKey={(r) => r.id} onRowClick={(r) => setRelease(r)} exportName="retention-releases"
          empty={{ title: 'No release requests', body: 'Record practical completion and the DLP in contract completion terms, then request each release when its contract milestone is reached.' }}
          columns={[
            { key: 'stage', label: 'Stage', render: (r) => humanize(r.stage) },
            { key: 'amount', label: 'Release amount', align: 'right', value: (r) => Number(r.amount), render: (r) => money(r.amount) },
            { key: 'requested_on', label: 'Requested', render: (r) => date(r.requested_on) },
            { key: 'certified_on', label: 'Certified', value: (r) => r.certified_on ?? '', render: (r) => (r.certified_on ? date(r.certified_on) : '—') },
            { key: 'received_amount', label: 'Received', align: 'right', value: (r) => Number(r.received_amount), render: (r) => money(r.received_amount) },
            { key: 'received_on', label: 'Received on', value: (r) => r.received_on ?? '', render: (r) => (r.received_on ? date(r.received_on) : '—') },
            { key: 'ref', label: 'Reference', render: (r) => r.ref ?? '—' },
            { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> },
          ]} />
      </Card>
      {terms && <CompletionDrawer projectId={projectId} contract={contract} onClose={() => { setTerms(false); onChanged(); }} />}
      {release && status && <ReleaseDrawer projectId={projectId} status={status} release={'id' in release ? release : null} stage={release.stage} onClose={() => { setRelease(null); onChanged(); }} />}
    </>
  );
}

function CompletionDrawer({ projectId, contract, onClose }: { projectId: string; contract: CompletionContract; onClose: () => void }) {
  const auth = useAuth();
  const edit = canOffice(auth.profile?.role, 'completion');
  const [f, setF] = useState({
    payment_days: String(contract.payment_days ?? 28), certify_days: String(contract.certify_days ?? 28), practical_completion_on: contract.practical_completion_on ?? '',
    dlp_months: String(contract.dlp_months ?? 12), retention_pc_release_pct: String(contract.retention_pc_release_pct ?? 50),
  });
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => void run(async () => {
    await officeRpc('save_contract_completion', {
      project_id: projectId, payment_days: Number(f.payment_days), certify_days: Number(f.certify_days), practical_completion_on: f.practical_completion_on || null,
      dlp_months: Number(f.dlp_months), retention_pc_release_pct: Number(f.retention_pc_release_pct),
    });
    toast.success('Completion and payment timing saved');
    onClose();
  });
  return (
    <Drawer onClose={onClose} title="Contract completion & payment timing" subtitle="Project-specific settings, not statutory defaults">
      <ErrorBanner error={error} />
      <fieldset disabled={!edit} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Certification (calendar days)"><input type="number" min={0} max={365} value={f.certify_days} onChange={set('certify_days')} /></Field>
        <Field label="Client payment (calendar days)"><input type="number" min={0} max={365} value={f.payment_days} onChange={set('payment_days')} /></Field>
        <Field label="Practical completion"><input type="date" value={f.practical_completion_on} onChange={set('practical_completion_on')} /></Field>
        <Field label="Defects liability (months)"><input type="number" min={0} max={60} value={f.dlp_months} onChange={set('dlp_months')} /></Field>
        <Field label="Retention released at practical completion (%)"><input type="number" min={0} max={100} step="0.01" value={f.retention_pc_release_pct} onChange={set('retention_pc_release_pct')} /></Field>
      </fieldset>
      {edit && <div className="row mt-2"><button className="primary" disabled={busy} onClick={save}>{busy && <span className="spinner" />}Save terms</button></div>}
    </Drawer>
  );
}

function ReleaseDrawer({ projectId, status, release, stage, onClose }: {
  projectId: string; status: RetentionStatus; release: RetentionRelease | null; stage: RetentionRelease['stage']; onClose: () => void;
}) {
  const auth = useAuth();
  const request = canOffice(auth.profile?.role, 'requestRetention');
  const receive = canOffice(auth.profile?.role, 'receiveMoney');
  const [f, setF] = useState({
    amount: String(release?.amount ?? (stage === 'practical_completion' ? status.pc_release_amount : status.final_release_amount)),
    requested_on: release?.requested_on ?? todayEat(), certified_on: release?.certified_on ?? '', received_on: todayEat(), received_amount: '', ref: release?.ref ?? '',
  });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await officeRpc('save_retention_release', {
      id: release?.id ?? crypto.randomUUID(), project_id: projectId, stage, amount: Number(f.amount), requested_on: f.requested_on,
      certified_on: request ? f.certified_on || undefined : undefined, ref: f.ref || undefined,
      received_on: receive && f.received_amount ? f.received_on : undefined,
      received_amount: receive && f.received_amount ? Number(f.received_amount) : undefined,
    });
    toast.success(release ? 'Retention release updated' : 'Retention release requested');
    onClose();
  });
  const remaining = release ? Math.max(0, Number(release.amount) - Number(release.received_amount)) : Number(f.amount);
  return (
    <Drawer onClose={onClose} title={`${release ? 'Update' : 'Request'} ${humanize(stage).toLowerCase()} retention release`} subtitle={release ? `${money(release.received_amount)} received of ${money(release.amount)}` : undefined}>
      <ErrorBanner error={error} />
      <fieldset disabled={!release && !request} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Release amount (ETB)"><input type="number" min={0} step="0.01" disabled={!!release} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Requested on"><input type="date" disabled={!!release} value={f.requested_on} onChange={(e) => setF({ ...f, requested_on: e.target.value })} /></Field>
        <Field label="Certified on"><input type="date" disabled={!request} value={f.certified_on} onChange={(e) => setF({ ...f, certified_on: e.target.value })} /></Field>
        <Field label="Letter / certificate reference"><input disabled={!request && !receive} value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></Field>
      </fieldset>
      {release && receive && (
        <>
          <h3 className="mt-4">Record money received</h3>
          <div className="form-grid">
            <Field label="Amount received now (ETB)" hint={`Added to previous receipts · ${money(remaining)} remaining`}><input type="number" min={0} max={remaining} step="0.01" value={f.received_amount} onChange={(e) => setF({ ...f, received_amount: e.target.value })} /></Field>
            <Field label="Received on"><input type="date" value={f.received_on} onChange={(e) => setF({ ...f, received_on: e.target.value })} /></Field>
          </div>
        </>
      )}
      {(request || release && receive) && <div className="row mt-2"><button className="primary" disabled={busy || !Number(f.amount) || receive && !!f.received_amount && (Number(f.received_amount) <= 0 || Number(f.received_amount) > remaining)} onClick={save}>{busy && <span className="spinner" />}{release ? 'Save update' : 'Request release'}</button></div>}
    </Drawer>
  );
}
