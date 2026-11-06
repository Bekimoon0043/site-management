// /approvals previews for schedule items: task progress to verify (verify_task_progress) and baselines to approve (approve_baseline).
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Flame } from 'lucide-react';
import type { Lookups } from '../../lib/hooks';
import type { BaselineQueueRow, TaskProgressQueueRow } from '../../lib/approvals';
import { EV_METHOD_LABELS } from '../../lib/contract-schedule';
import { date, dateTime, num } from '../../lib/format';
import { Attachments } from '../Attachments';
import type { PreviewActions } from '../approval/Previews';
import { Badge, Banner, ErrorBanner, Field, QtyInput, useBusy } from '../ui';
import { d2, schedRpc } from './data';
import { VerifyQtyFields, initQtyDraft, qtyAdjusted, qtyInvalid, verifiedQty } from './VerifyQty';

interface Common { L: Lookups; onDone: (msg: string) => void; onActions: (a: PreviewActions) => void }

/** Daily reports are cumulative: measure the jump from the previous pending report of the task, else from the verified %. */
export function withPrevPct(rows: TaskProgressQueueRow[]): TaskProgressQueueRow[] {
  const prev = new Map<string, number>();
  return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((r) => {
    const base = prev.get(r.task_id) ?? Number(r.schedule_tasks?.pct_complete ?? 0);
    prev.set(r.task_id, Number(r.pct_complete ?? 0));
    return { ...r, prev_pct: base };
  });
}

/** Rule-clean = safe for bulk verify: jump ≤ 25 points, not a late (rolled) report, not a finish claim. */
export function taskProgressClean(r: TaskProgressQueueRow): boolean {
  const was = r.prev_pct ?? Number(r.schedule_tasks?.pct_complete ?? 0);
  return Number(r.pct_complete ?? 0) - was <= 25 && !r.original_status_date && !r.actual_finish;
}

export function TaskProgressPreview({ row, L, onDone, onActions }: Common & { row: TaskProgressQueueRow }) {
  const t = row.schedule_tasks;
  const editable = ['pct', '0_100', '50_50', 'milestone'].includes(row.method);
  const units = row.method === 'units' && !!row.qty?.length;
  const [pct, setPct] = useState(String(row.pct_complete ?? ''));
  const [qd, setQd] = useState(() => initQtyDraft(row.qty));
  const [comment, setComment] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const adjusted = editable ? Number(pct) !== Number(row.pct_complete) : units && qtyAdjusted(row.qty, qd);
  const was = row.prev_pct ?? Number(t?.pct_complete ?? 0);
  const jump = Number(row.pct_complete ?? 0) - was;
  const decide = (approve: boolean) => {
    if ((!approve || adjusted) && !comment.trim()) { ref.current?.focus(); return; }
    const p = Number(pct);
    if (approve && editable && (!Number.isFinite(p) || p < 0 || p > 100)) return;
    if (approve && units && qtyInvalid(row.qty, qd)) return;
    void run(async () => {
      await schedRpc('verify_task_progress', { progress_id: row.id, approve, verified_pct: approve && editable ? p : undefined,
        verified_qty: approve && units && adjusted ? verifiedQty(row.qty, qd) : undefined, comment: comment.trim() || undefined });
      onDone(`${t?.name ?? 'Task'} ${approve ? (adjusted ? 'adjusted' : 'verified') : 'rejected'}`);
    });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/schedule?peek=${row.task_id}`}>{t?.wbs ? `${t.wbs} ` : ''}{t?.name ?? 'Task'} <ExternalLink size={14} aria-hidden /></Link>
            <Badge value={row.status} />{t?.is_critical && <Badge tone="danger" icon={Flame} label="Critical" />}</h2>
          <div className="meta">Reported by {L.person(row.reported_by)} · {dateTime(row.created_at)} · progress as of {date(row.status_date)}</div>
        </div>
        <ErrorBanner error={error} />
        <dl className="kv">
          <dt>Reported</dt><dd className="strong">{num(row.pct_complete, 1)} %</dd>
          <dt>Was → now</dt><dd>{num(was, 1)} % → {num(row.pct_complete, 1)} % <span className={jump > 25 ? 'warn-text strong' : 'muted'}>({jump >= 0 ? '+' : ''}{num(jump, 1)} pts)</span></dd>
          <dt>Measured by</dt><dd>{EV_METHOD_LABELS[row.method]?.en ?? row.method}</dd>
          {row.qty_done != null && <><dt>Quantity to date</dt><dd>{num(row.qty_done, 3)}</dd></>}
          {t?.planned_finish && <><dt>Planned finish</dt><dd>{d2(t.planned_finish)}</dd></>}
          {(row.actual_start || row.actual_finish) && <><dt>Actual</dt><dd>{row.actual_start ? `started ${d2(row.actual_start)}` : ''}{row.actual_finish ? ` · finished ${d2(row.actual_finish)}` : ''}</dd></>}
          {row.remaining_days != null && <><dt>Remaining</dt><dd>{num(row.remaining_days, 1)} working days</dd></>}
          {row.delay_cause && <><dt>Delay cause</dt><dd>{row.delay_cause}</dd></>}
          <dt>Remarks</dt><dd>{row.remarks ?? '—'}</dd>
        </dl>
        {jump > 25 && <Banner tone="warn">Big jump (+{num(jump, 0)} points) — check on site or ask for photos before verifying.</Banner>}
        {row.original_status_date && <Banner tone="info">Late report for {d2(row.original_status_date)} — it counts in the next open period.</Banner>}
        {editable && (
          <Field label="Verified %" hint={adjusted ? 'Different from reported — a comment is required.' : 'Change to verify with an adjustment.'}>
            <QtyInput value={pct} onChange={setPct} unit="%" min={0} max={100} width={140} aria-label="Verified percent" />
          </Field>
        )}
        {units && <VerifyQtyFields taskId={row.task_id} qty={row.qty} draft={qd} setDraft={setQd} />}
        {units && adjusted && <p className="small-text muted mb-0">Different from the reported quantity — a comment is required.</p>}
        <div><h3>Photos</h3><Attachments entityType="task_progress" entityId={row.id} /></div>
      </div>
      <div className="action-bar">
        <textarea ref={ref} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment"
          placeholder={adjusted ? 'Comment (required when adjusting)' : 'Comment (required to reject)'} />
        <button disabled={busy} onClick={() => decide(false)}>Reject<kbd style={{ marginLeft: 4 }}>R</kbd></button>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}{adjusted ? 'Verify with adjustment' : 'Verify'}<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}

export function BaselinePreview({ row, L, onDone, onActions }: Common & { row: BaselineQueueRow }) {
  const [comment, setComment] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const decide = (approve: boolean) => {
    if (!approve && !comment.trim()) { ref.current?.focus(); return; }
    void run(async () => {
      await schedRpc('approve_baseline', { baseline_id: row.id, approve, comment: comment.trim() || undefined });
      onDone(`Baseline BL-${row.baseline_no} ${approve ? 'approved' : 'rejected'}`);
    });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to="/schedule#baselines">BL-{row.baseline_no} · {row.name} <ExternalLink size={14} aria-hidden /></Link><Badge value="pending" label="Proposed" /></h2>
          <div className="meta">Proposed by {L.person(row.proposed_by)} · {dateTime(row.proposed_at)}{row.schedules ? ` · ${row.schedules.code} ${row.schedules.name}` : ''}</div>
        </div>
        <ErrorBanner error={error} />
        <dl className="kv">
          <dt>Dates from</dt><dd>{row.source === 'msp_baseline' ? `MS Project baseline ${row.msp_baseline_number ?? 0}` : 'The current plan'}</dd>
          <dt>Effective from</dt><dd>{date(row.effective_from)}</dd>
          <dt>Tasks</dt><dd>{num(row.task_count, 0)}</dd>
          <dt>Reason</dt><dd>{row.reason ?? '—'}</dd>
        </dl>
        <Banner tone="info">Approving makes this the plan that progress and earned value are measured against. The baseline in force (if any) is superseded.</Banner>
      </div>
      <div className="action-bar">
        <textarea ref={ref} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" placeholder="Comment (required to reject)" />
        <button disabled={busy} onClick={() => decide(false)}>Reject<kbd style={{ marginLeft: 4 }}>R</kbd></button>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}Approve baseline<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}
