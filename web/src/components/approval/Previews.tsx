import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, TriangleAlert } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, rpc, supabase } from '../../lib/supabase';
import { loadMrDetail, partialLines } from '../../lib/mr';
import type { AdjQueueRow, CountQueueRow, EmergencyQueueRow, MrQueueRow, ProgressQueueRow } from '../../lib/approvals';
import type { MaterialRequest } from '../../lib/contract';
import { date, dateTime, hoursSince, humanize, num } from '../../lib/format';
import { Attachments } from '../Attachments';
import { Badge, PriorityBadge } from '../Badge';
import { DataTable } from '../DataTable';
import { Banner, ErrorBanner, Loading } from '../Page';
import { Field, QtyInput, useBusy } from '../Form';

/** Keyboard hooks the inbox calls: A → approve, R → focus comment / return. */
export interface PreviewActions { approve?: () => void; reject?: () => void }
interface Common { L: Lookups; onDone: (msg: string) => void; /** Receives the keyboard handlers on every render. */ onActions: (a: PreviewActions) => void }

function Head({ title, badges, meta }: { title: ReactNode; badges?: ReactNode; meta: ReactNode }) {
  return (
    <div className="inbox-preview-head">
      <h2>{title}{badges}</h2>
      <div className="meta">{meta}</div>
    </div>
  );
}

/** Comment box + action buttons pinned at the bottom of the preview. */
function ActionBar({ comment, setComment, children, commentRef, placeholder }: {
  comment: string; setComment: (v: string) => void; children: ReactNode; commentRef: React.RefObject<HTMLTextAreaElement | null>; placeholder: string;
}) {
  return (
    <div className="action-bar">
      <textarea ref={commentRef} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={placeholder} aria-label="Comment" />
      {children}
    </div>
  );
}

function Kbd({ k }: { k: string }) { return <kbd style={{ marginLeft: 4 }}>{k}</kbd>; }

// ---------------------------------------------------------------------------
export function MrPreview({ row, L, onDone, onActions }: Common & { row: MrQueueRow }) {
  const auth = useAuth();
  const q = useAsync(() => loadMrDetail(row.id), [row.id], { key: 'mr-detail' });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { if (q.data) setQty(Object.fromEntries(q.data.lines.map((l) => [l.mr_line_id, String(l.approved_qty ?? l.qty)]))); }, [q.data]);

  const canApprove = auth.can('mr.approve');
  const canReview = auth.can('mr.review') && row.status === 'submitted';
  const act = (action: 'approve' | 'review' | 'return' | 'reject', lines?: { id: string; approved_qty: number }[]) => run(async () => {
    if ((action === 'return' || action === 'reject') && !comment.trim()) { commentRef.current?.focus(); throw new Error('A comment is required to return or reject.'); }
    await rpc('mr_action', { mr_id: row.id, action, comment: comment.trim() || undefined, lines });
    onDone(`${row.number} ${action === 'approve' ? 'approved' : action === 'review' ? 'reviewed' : action === 'return' ? 'returned' : 'rejected'}`);
  });
  const approve = () => { if (!q.data) return; void run(async () => { const l = partialLines(q.data!.lines, qty); await rpc('mr_action', { mr_id: row.id, action: 'approve', comment: comment.trim() || undefined, lines: l }); onDone(`${row.number} approved`); }); };
  useEffect(() => {
    onActions({
      approve: canApprove ? approve : canReview ? () => void act('review') : undefined,
      reject: () => { if (comment.trim()) void act('return'); else commentRef.current?.focus(); },
    });
  });

  const d = q.data;
  const partial = d ? d.lines.filter((l) => Number(qty[l.mr_line_id]) < Number(l.qty)).length : 0;
  const waiting = hoursSince(row.submitted_at);
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={<Link to={`/requests/${row.id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link>}
          badges={<><Badge value={row.status} /><PriorityBadge value={row.priority} /></>}
          meta={<>{L.person(row.requested_by)} · Block {L.block(row.block_id) || '—'} · required {date(row.required_date)} · <span className={waiting > 48 ? 'danger-text' : ''}>waiting {num(waiting, 0)} h</span></>} />
        {row.purpose && <div><span className="muted">Purpose:</span> {row.purpose}</div>}
        <ErrorBanner error={q.error ?? error} />
        {!d ? <Loading lines={5} /> : (
          <>
            {d.lines.some((l) => d.extra.get(l.mr_line_id)?.exceeds_boq) && (
              <Banner tone="warn">{d.lines.filter((l) => d.extra.get(l.mr_line_id)?.exceeds_boq).map((l) => <div key={l.mr_line_id}>Line {l.line_no} over BoQ{d.extra.get(l.mr_line_id)?.over_boq_reason ? ` — “${d.extra.get(l.mr_line_id)?.over_boq_reason}”` : ''}</div>)}</Banner>
            )}
            <DataTable rows={d.lines} rowKey={(r) => r.mr_line_id} maxHeight="none" columns={[
              { key: 'line_no', label: '#', align: 'right', width: 32 },
              { key: 'label', label: 'Material', render: (r) => <>{d.extra.get(r.mr_line_id)?.exceeds_boq && <span className="warn-line"><TriangleAlert size={14} /></span>} {r.label}</> },
              { key: 'el', label: 'Elements', value: (r) => d.elements.filter((e) => e.mr_line_id === r.mr_line_id).map((e) => L.element(e.element_id)).join(', ') },
              { key: 'qty', label: 'Requested', align: 'right', render: (r) => <>{num(r.qty, 3)}<span className="unit">{r.uom}</span></> },
              { key: 'stock', label: 'On site', align: 'right', value: (r) => d.avail.get(r.material_spec_id) ?? 0, render: (r) => {
                const s = d.avail.get(r.material_spec_id) ?? 0;
                return <span className={s >= Number(r.qty) ? 'ok-text' : s > 0 ? '' : 'danger-text'}>{num(s, 3)}</span>;
              } },
              ...(canApprove ? [{ key: 'approve', label: 'Approve', align: 'right' as const, render: (r: (typeof d.lines)[number]) => (
                <QtyInput width={130} value={qty[r.mr_line_id] ?? ''} unit={r.uom} min={0} max={r.qty} aria-label={`Approve line ${r.line_no}`} onChange={(v) => setQty({ ...qty, [r.mr_line_id]: v })} />
              ) }] : []),
            ]} />
            {d.events[0]?.comment && <div className="muted small-text">Last comment: “{d.events[0].comment}” — {L.person(d.events[0].actor)}</div>}
          </>
        )}
      </div>
      <ActionBar comment={comment} setComment={setComment} commentRef={commentRef} placeholder="Comment (required to return or reject)">
        <button disabled={busy} onClick={() => void act('return')}>Return<Kbd k="R" /></button>
        {canApprove && <button disabled={busy} onClick={() => void act('reject')}>Reject</button>}
        {canReview && <button disabled={busy} className={canApprove ? '' : 'primary'} onClick={() => void act('review')}>Mark reviewed{!canApprove && <Kbd k="A" />}</button>}
        {canApprove && <button className="primary" disabled={busy || !d} onClick={approve}>{busy && <span className="spinner" />}{partial ? `Approve (${partial} partial)` : 'Approve'}<Kbd k="A" /></button>}
      </ActionBar>
    </>
  );
}

// ---------------------------------------------------------------------------
function DecideBar({ busy, comment, setComment, commentRef, onApprove, onReject, approveLabel }: {
  busy: boolean; comment: string; setComment: (v: string) => void; commentRef: React.RefObject<HTMLTextAreaElement | null>;
  onApprove: () => void; onReject: () => void; approveLabel: string;
}) {
  return (
    <ActionBar comment={comment} setComment={setComment} commentRef={commentRef} placeholder="Comment (required to reject)">
      <button disabled={busy} onClick={onReject}>Reject<Kbd k="R" /></button>
      <button className="primary" disabled={busy} onClick={onApprove}>{busy && <span className="spinner" />}{approveLabel}<Kbd k="A" /></button>
    </ActionBar>
  );
}

function useDecision(onDone: (m: string) => void, onActions: (a: PreviewActions) => void, fn: (approve: boolean, comment?: string) => Promise<unknown>, label: string) {
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const decide = (approve: boolean) => {
    if (!approve && !comment.trim()) { commentRef.current?.focus(); return; }
    void run(async () => { await fn(approve, comment.trim() || undefined); onDone(`${label} ${approve ? 'approved' : 'rejected'}`); });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });
  return { comment, setComment, commentRef, busy, error, decide };
}

export function AdjustmentPreview({ row, L, onDone, onActions }: Common & { row: AdjQueueRow }) {
  const d = useDecision(onDone, onActions, (approve, comment) => rpc('decide_adjustment', { adjustment_id: row.id, approve, comment }), row.number);
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={row.number} badges={<Badge value="pending" />} meta={<>{humanize(row.adj_type)} · {row.reason_code ?? '—'} · {L.store(row.store_id)} · raised by {L.person(row.requested_by)} · {dateTime(row.created_at)}</>} />
        {row.remarks && <div><span className="muted">Remarks:</span> {row.remarks}</div>}
        <ErrorBanner error={d.error} />
        <DataTable rows={row.adjustment_lines} maxHeight="none" columns={[
          { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
          { key: 'element', label: 'Element', value: (l) => L.element(l.element_id) },
          { key: 'stock_status', label: 'Stock', render: (l) => <Badge value={l.stock_status} /> },
          { key: 'qty_delta', label: 'Change', align: 'right', render: (l) => <span className={Number(l.qty_delta) < 0 ? 'danger-text' : ''}>{num(l.qty_delta, 3)}<span className="unit">{L.specUom(l.material_spec_id)}</span></span> },
        ]} />
        <Attachments entityType="adjustment" entityId={row.id} />
      </div>
      <DecideBar {...d} onApprove={() => d.decide(true)} onReject={() => d.decide(false)} approveLabel="Approve & post" />
    </>
  );
}

export function CountPreview({ row, L, onDone, onActions }: Common & { row: CountQueueRow }) {
  const d = useDecision(onDone, onActions, (approve, comment) => rpc('decide_stock_count', { count_id: row.id, approve, comment }), row.number);
  const withVar = row.stock_count_lines.filter((l) => Number(l.variance) !== 0);
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={row.number} badges={<Badge value="pending" label="Awaiting approval" />}
          meta={<>{humanize(row.count_type)} count · {L.store(row.store_id)} · {L.person(row.counted_by)} · {dateTime(row.counted_at)} · {withVar.length} of {row.stock_count_lines.length} items with variance</>} />
        <ErrorBanner error={d.error} />
        <DataTable rows={[...row.stock_count_lines].sort((a, b) => Math.abs(Number(b.variance)) - Math.abs(Number(a.variance)))} maxHeight="none"
          rowClass={(l) => (Number(l.variance) !== 0 ? 'row-warn' : undefined)} columns={[
          { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
          { key: 'system_qty', label: 'System', align: 'right', render: (l) => num(l.system_qty, 3) },
          { key: 'counted_qty', label: 'Counted', align: 'right', render: (l) => num(l.counted_qty, 3) },
          { key: 'variance', label: 'Variance', align: 'right', render: (l) => <span className={Number(l.variance) < 0 ? 'danger-text strong' : Number(l.variance) > 0 ? 'strong' : ''}>{num(l.variance, 3)}</span> },
        ]} />
      </div>
      <DecideBar {...d} onApprove={() => d.decide(true)} onReject={() => d.decide(false)} approveLabel="Approve & adjust stock" />
    </>
  );
}

export function ProgressPreview({ row, L, onDone, onActions, readOnly }: Common & { row: ProgressQueueRow; readOnly?: boolean }) {
  const auth = useAuth();
  const [pct, setPct] = useState(String(row.pct_complete));
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const adjusted = Number(pct) !== Number(row.pct_complete);
  const canVerify = !readOnly && auth.can('progress.verify') && row.status === 'reported';
  const decide = (approve: boolean) => {
    if ((!approve || adjusted) && !comment.trim()) { commentRef.current?.focus(); return; }
    const p = Number(pct);
    if (approve && (!Number.isFinite(p) || p < 0 || p > 100)) return;
    void run(async () => {
      await rpc('verify_progress', { progress_id: row.id, approve, verified_pct: approve ? p : undefined, comment: comment.trim() || undefined });
      onDone(`${L.element(row.element_id)} ${approve ? 'verified' : 'rejected'}`);
    });
  };
  useEffect(() => { onActions(canVerify ? { approve: () => decide(true), reject: () => decide(false) } : {}); });
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={<>{L.element(row.element_id)} · {row.element_activities?.name ?? 'Activity'}</>}
          badges={<><Badge value={row.status} />{row.element_activities?.is_hold_point && <Badge value="hold_point" />}</>}
          meta={<>Reported {date(row.report_date)} by {L.person(row.reported_by)} · {dateTime(row.created_at)}</>} />
        <ErrorBanner error={error} />
        <dl className="kv">
          <dt>Reported</dt><dd className="strong">{num(row.pct_complete, 1)} %</dd>
          <dt>Quantity</dt><dd>{row.qty_achieved === null ? '—' : `${num(row.qty_achieved)} ${row.uom ?? ''}`}</dd>
          <dt>Remarks</dt><dd>{row.remarks ?? '—'}</dd>
          {row.verified_by && <><dt>Verified</dt><dd>{L.person(row.verified_by)} · {num(row.verified_pct, 1)} % · {row.verify_comment}</dd></>}
        </dl>
        {row.element_activities?.is_hold_point && <Banner tone="warn">Inspection hold point — verify on site before approving.</Banner>}
        {canVerify && (
          <Field label="Verified %" hint={adjusted ? 'Different from reported — a comment is required.' : 'Change to verify with an adjustment.'}>
            <QtyInput value={pct} onChange={setPct} unit="%" min={0} max={100} width={140} aria-label="Verified percent" />
          </Field>
        )}
        <div><h3>Photos</h3><Attachments entityType="progress_update" entityId={row.id} /></div>
      </div>
      {canVerify && (
        <ActionBar comment={comment} setComment={setComment} commentRef={commentRef} placeholder={adjusted ? 'Comment (required when adjusting)' : 'Comment (required to reject)'}>
          <button disabled={busy} onClick={() => decide(false)}>Reject<Kbd k="R" /></button>
          <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}{adjusted ? 'Verify with adjustment' : 'Verify'}<Kbd k="A" /></button>
        </ActionBar>
      )}
    </>
  );
}

export function EmergencyPreview({ row, L, onDone, onActions, projectId }: Common & { row: EmergencyQueueRow; projectId: string }) {
  const q = useAsync(async () => check(await supabase.from('material_requests').select('id, number, requested_by, required_date, status').eq('project_id', projectId)
    .in('status', ['approved', 'partially_issued', 'issued']).order('created_at', { ascending: false }).limit(200)) as Pick<MaterialRequest, 'id' | 'number' | 'requested_by' | 'required_date' | 'status'>[],
  [projectId], { key: 'mr-approved-list' });
  const [mr, setMr] = useState('');
  const { busy, error, run } = useBusy();
  const go = () => { if (!mr) return; void run(async () => { await rpc('regularise_miv', { miv_id: row.id, mr_id: mr }); onDone(`${row.number} regularised`); }); };
  useEffect(() => { onActions({ approve: go }); });
  const h = hoursSince(row.issued_at);
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={row.number} badges={<Badge value="critical" label={h > 24 ? 'Overdue > 24 h' : 'Not regularised'} />}
          meta={<>Emergency issue · {L.store(row.store_id)} · to {L.person(row.issued_to)} · {dateTime(row.issued_at)} ({num(h, 0)} h ago)</>} />
        <Banner tone={h > 24 ? 'error' : 'warn'}>Emergency issues must be linked to an approved request within 24 hours (BR-01). Reason given: {row.emergency_reason ?? '—'}</Banner>
        <ErrorBanner error={error ?? q.error} />
        <DataTable rows={row.miv_lines} maxHeight="none" columns={[
          { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
          { key: 'element', label: 'Element', value: (l) => L.element(l.element_id) },
          { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{num(l.qty, 3)}<span className="unit">{L.specUom(l.material_spec_id)}</span></> },
        ]} />
        <Field label="Approved request covering these materials" required>
          <select value={mr} onChange={(e) => setMr(e.target.value)}>
            <option value="">Choose…</option>
            {(q.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.number} — {L.person(r.requested_by)} — {date(r.required_date)}</option>)}
          </select>
        </Field>
      </div>
      <div className="action-bar">
        <span className="grow" />
        <button className="primary" disabled={!mr || busy} onClick={go}>{busy && <span className="spinner" />}Link to request<Kbd k="A" /></button>
      </div>
    </>
  );
}
