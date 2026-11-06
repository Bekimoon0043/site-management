// Baselines (performance measurement baseline): propose (set_baseline) → approve / reject (approve_baseline), with history.
import { useState } from 'react';
import { Flag, Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { date, dateTime, money, num } from '../../lib/format';
import type { BaselineCostSource } from '../../lib/contract-schedule';
import { Badge, Banner, Card, DataTable, ErrorBanner, Field, Modal, ReasonModal, toast, useBusy } from '../ui';
import { BASELINE_APPROVE_ROLES, SCHEDULE_EDIT_ROLES, loadBaselines, schedRpc, todayStr, type BaselineRow, type SchedHeader } from './data';

const COST_SOURCES: { value: BaselineCostSource; label: string; hint: string }[] = [
  { value: 'value', label: 'Contract value (BoQ × rate)', hint: 'Budget = linked BoQ quantity × rate' },
  { value: 'value_less_margin', label: 'Contract value less margin', hint: 'Uses the project margin setting' },
  { value: 'budget_lines', label: 'Cost budget lines', hint: 'Spreads the cost budget over linked tasks' },
  { value: 'msp_baseline_cost', label: 'MS Project baseline cost', hint: 'Cost stored in the MS Project baseline' },
];

export function BaselinePanel({ schedule, L, hasFileBaseline }: { schedule: SchedHeader; L: Lookups; hasFileBaseline: boolean }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const me = auth.session?.user.id;
  const canPropose = !!role && SCHEDULE_EDIT_ROLES.includes(role);
  const canApprove = !!role && BASELINE_APPROVE_ROLES.includes(role);
  const q = useAsync(() => loadBaselines(schedule.id), [schedule.id], { key: 'sched-baselines' });
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<BaselineRow | null>(null);
  const { busy, error, run } = useBusy();
  const rows = q.data ?? [];
  const pending = rows.find((b) => b.status === 'proposed');
  const approved = rows.find((b) => b.status === 'approved');

  const approve = (b: BaselineRow) => void run(async () => {
    await schedRpc('approve_baseline', { baseline_id: b.id, approve: true });
    toast.success(`Baseline ${b.baseline_no} “${b.name}” approved — earned value now measures against it`);
  });

  return (
    <div className="stack">
      <Banner tone="info">
        The baseline is the plan progress is measured against (planned value, “days behind”). An office engineer proposes it; a coordinator or manager approves it.
        {approved ? <> In force: <b>#{approved.baseline_no} {approved.name}</b> since {date(approved.effective_from)}.</> : <> No baseline is approved yet — the file's own baseline dates are shown until then.</>}
      </Banner>
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      {pending && (
        <Card title={<><Flag size={16} aria-hidden /> Waiting for approval: #{pending.baseline_no} {pending.name}</>}
          sub={`${pending.task_count} tasks · proposed by ${L.person(pending.proposed_by)} ${dateTime(pending.proposed_at)}${pending.reason ? ` · “${pending.reason}”` : ''}`}
          actions={canApprove && (pending.proposed_by !== me || role === 'admin') ? <>
            <button disabled={busy} onClick={() => setRejecting(pending)}>Reject…</button>
            <button className="primary" disabled={busy} onClick={() => approve(pending)}>{busy && <span className="spinner" />}Approve baseline</button>
          </> : undefined}>
          <p className="muted mb-0">{canApprove ? (pending.proposed_by === me && role !== 'admin' ? 'You proposed this baseline — another coordinator or manager must approve it.' : 'Approving replaces the baseline in force for every task.') : 'A coordinator or manager approves it from the Approvals inbox.'}</p>
        </Card>
      )}
      <Card title="Baseline history" flush actions={canPropose && <button onClick={() => setAdding(true)} disabled={!!pending} title={pending ? 'A proposed baseline is still waiting for approval' : undefined}><Plus size={14} />Propose baseline</button>}>
        <DataTable rows={rows} loading={!q.data} maxHeight="none" rowKey={(b) => b.id}
          empty={{ title: 'No baselines yet', body: hasFileBaseline ? 'Propose one from the baseline saved in the MS Project file.' : 'Propose one from the current plan to start measuring progress.' }}
          columns={[
            { key: 'baseline_no', label: '#', id: true, render: (b) => `BL-${b.baseline_no}` },
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', render: (b) => <Badge value={b.status === 'proposed' ? 'pending' : b.status} label={b.status === 'proposed' ? 'Proposed' : undefined} /> },
            { key: 'source', label: 'From', render: (b) => (b.source === 'msp_baseline' ? `MS Project baseline ${b.msp_baseline_number ?? 0}` : 'Current plan') },
            { key: 'effective_from', label: 'Effective', render: (b) => date(b.effective_from) },
            { key: 'task_count', label: 'Tasks', align: 'right', render: (b) => num(b.task_count, 0) },
            { key: 'reason', label: 'Reason', render: (b) => b.reason ?? '' },
            { key: 'proposed_by', label: 'Proposed', value: (b) => `${L.person(b.proposed_by)} ${b.proposed_at}`, render: (b) => <>{L.person(b.proposed_by)}<div className="muted xs-text">{dateTime(b.proposed_at)}</div></> },
            { key: 'approved_by', label: 'Decided', value: (b) => (b.approved_by ? `${L.person(b.approved_by)} ${b.approved_at}` : ''),
              render: (b) => (b.approved_by ? <>{L.person(b.approved_by)}<div className="muted xs-text">{dateTime(b.approved_at)}{b.decision_comment ? ` · ${b.decision_comment}` : ''}</div></> : '') },
          ]} />
      </Card>
      {adding && <ProposeModal schedule={schedule} first={!rows.some((b) => b.status === 'approved' || b.status === 'superseded')} hasFileBaseline={hasFileBaseline} onClose={() => setAdding(false)} />}
      {rejecting && (
        <ReasonModal title={`Reject baseline #${rejecting.baseline_no}`} label="Why is it rejected?" confirm="Reject baseline" danger onClose={() => setRejecting(null)}
          onSubmit={async (text) => {
            await schedRpc('approve_baseline', { baseline_id: rejecting.id, approve: false, comment: text });
            toast.success(`Baseline ${rejecting.baseline_no} rejected`);
            setRejecting(null);
          }} />
      )}
    </div>
  );
}

function ProposeModal({ schedule, first, hasFileBaseline, onClose }: { schedule: SchedHeader; first: boolean; hasFileBaseline: boolean; onClose: () => void }) {
  const auth = useAuth();
  const [name, setName] = useState(first ? 'Contract baseline' : '');
  const [source, setSource] = useState<'msp_baseline' | 'current_plan'>(hasFileBaseline ? 'msp_baseline' : 'current_plan');
  const [bn, setBn] = useState('0');
  const [eff, setEff] = useState(schedule.status_date ?? (first ? schedule.planned_start ?? todayStr() : todayStr()));
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState<BaselineCostSource>('value');
  const { busy, error, setError, run } = useBusy();
  const submit = () => {
    if (!first && !reason.trim()) { setError('A re-baseline needs a reason (e.g. approved change order or recovery programme).'); return; }
    void run(async () => {
      const r = await schedRpc('set_baseline', {
        id: crypto.randomUUID(), schedule_id: schedule.id, name: name.trim() || undefined, source,
        msp_baseline_number: source === 'msp_baseline' ? Number(bn) : undefined, effective_from: eff || undefined,
        reason: reason.trim() || undefined, cost_source: auth.canSeePrices ? cost : undefined,
      });
      const nofile = Number(r.without_file_baseline ?? 0);
      toast.success(`Baseline ${r.baseline_no} proposed for ${num(r.tasks, 0)} tasks${nofile ? ` (${nofile} without a file baseline used their current dates)` : ''}${r.bac_value != null ? ` · budget ${money(r.bac_value, schedule.currency_code)}` : ''} — waiting for approval`);
      onClose();
    });
  };
  return (
    <Modal title={first ? 'Propose the first baseline' : 'Propose a re-baseline'} onClose={onClose} size="md"
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={submit}>{busy && <span className="spinner" />}Propose baseline</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Name" wide><input value={name} onChange={(e) => setName(e.target.value)} placeholder={first ? 'Contract baseline' : 'Re-baseline after change order 3'} data-autofocus /></Field>
        <Field label="Take the dates from" wide>
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="msp_baseline" disabled={!hasFileBaseline}>The baseline saved in the MS Project file{hasFileBaseline ? '' : ' (none in this file)'}</option>
            <option value="current_plan">The current plan dates</option>
          </select>
        </Field>
        {source === 'msp_baseline' && (
          <Field label="MS Project baseline">
            <select value={bn} onChange={(e) => setBn(e.target.value)}>{Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i === 0 ? 'Baseline' : `Baseline ${i}`}</option>)}</select>
          </Field>
        )}
        <Field label="Effective from"><input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field>
        {auth.canSeePrices && (
          <Field label="Budget basis" wide hint={COST_SOURCES.find((c) => c.value === cost)?.hint}>
            <select value={cost} onChange={(e) => setCost(e.target.value as BaselineCostSource)}>{COST_SOURCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          </Field>
        )}
        <Field label="Reason" wide required={!first} hint={first ? 'Optional for the first baseline' : 'Required: approved change order, recovery programme…'}>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
