import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, PackageCheck } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { loadMrDetail } from '../../lib/mr';
import type { FlowQueueRow } from '../../lib/approvals';
import type { DeliveryNotice, FlowMrStatus } from '../../lib/contract-flows';
import { buildTimeline, flowRpc, loadAti, loadFlowExtras, type FlowMr, type FlowSettings } from '../../lib/flows';
import { date, dateTime, money, num, qty as fmtQty } from '../../lib/format';
import { Badge, PriorityBadge } from '../Badge';
import { DataTable } from '../DataTable';
import { Banner, ErrorBanner, Loading } from '../Page';
import { Field, QtyInput, useBusy } from '../Form';
import { FlowStatusBadge, FlowTimeline } from './FlowTimeline';
import { GrnFromNoticeDrawer } from './FlowDialogs';
import './flows.css';

interface PreviewActions { approve?: () => void; reject?: () => void }
interface Common { row: FlowQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: PreviewActions) => void }
const Kbd = ({ k }: { k: string }) => <kbd style={{ marginLeft: 4 }}>{k}</kbd>;

function Head({ title, badges, meta }: { title: React.ReactNode; badges?: React.ReactNode; meta: React.ReactNode }) {
  return <div className="inbox-preview-head"><h2>{title}{badges}</h2><div className="meta">{meta}</div></div>;
}

// ---------------------------------------------------------------------------
// Purchase request: coordinator review (trim qty) · management approve (endorse-up) · procurement accept
// ---------------------------------------------------------------------------
export function PrPreview({ row, L, onDone, onActions }: Common) {
  const auth = useAuth();
  const settings = auth.settings as FlowSettings | null;
  const q = useAsync(async () => {
    const d = await loadMrDetail(row.entity_id);
    const x = await loadFlowExtras(d.mr as FlowMr, { withPrices: auth.canSeePrices });
    return { ...d, x };
  }, [row.entity_id, row.status], { key: 'pr-preview' });
  const kind = row.kind;
  const [qty, setQty] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const d = q.data;
  const rev = (id: string) => d?.x.lines.get(id)?.reviewed_qty ?? null;
  useEffect(() => {
    if (d) setQty(Object.fromEntries(d.lines.map((l) => [l.mr_line_id, String(kind === 'pr_review' ? (rev(l.mr_line_id) ?? l.qty) : (l.approved_qty ?? rev(l.mr_line_id) ?? l.qty))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, kind]);
  const cap = (l: { mr_line_id: string; qty: number }) => (kind === 'pr_review' ? Number(l.qty) : Number(rev(l.mr_line_id) ?? l.qty));
  const reduced = d ? d.lines.filter((l) => Number(qty[l.mr_line_id]) < cap(l) - 0.0005) : [];

  const act = (action: 'review' | 'approve' | 'accept' | 'return' | 'reject') => run(async () => {
    if ((action === 'return' || action === 'reject') && !comment.trim()) { commentRef.current?.focus(); throw new Error('A comment is required to return or reject.'); }
    if (!d) return;
    for (const l of d.lines) {
      const v = Number(qty[l.mr_line_id]);
      if ((action === 'review' || action === 'approve') && (!Number.isFinite(v) || v < 0 || v > cap(l) + 0.0005)) throw new Error(`Line ${l.line_no}: quantity must be between 0 and ${num(cap(l), 3)}`);
    }
    const lines = action === 'review' ? d.lines.map((l) => ({ id: l.mr_line_id, reviewed_qty: Number(qty[l.mr_line_id]) }))
      : action === 'approve' ? reduced.map((l) => ({ id: l.mr_line_id, approved_qty: Number(qty[l.mr_line_id]) })) : undefined;
    const res = await flowRpc('mr_action', { mr_id: row.entity_id, action, comment: comment.trim() || undefined, lines, assign_to: action === 'accept' ? auth.profile?.id : undefined });
    onDone(res.endorsed ? `${row.number} endorsed — sent to a higher approver` : `${row.number} ${{ review: 'reviewed', approve: 'approved', accept: 'accepted', return: 'returned', reject: 'rejected' }[action]}`);
  });
  const main: 'review' | 'approve' | 'accept' = kind === 'pr_review' ? 'review' : kind === 'pr_approve' ? 'approve' : 'accept';
  useEffect(() => { onActions({ approve: () => void act(main), reject: () => { if (comment.trim()) void act('return'); else commentRef.current?.focus(); } }); });

  const steps = d && L ? buildTimeline({ type: 'purchase', status: d.mr.status as FlowMrStatus, events: d.events, approvals: d.x.approvals, wf: d.x.wf, settings,
    requestedBy: d.mr.requested_by, submittedAt: d.mr.submitted_at, createdAt: d.mr.created_at, L }) : [];
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={<Link to={`/requests/${row.entity_id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link>}
          badges={<><FlowStatusBadge status={row.status} type="purchase" />{d && <PriorityBadge value={d.mr.priority} />}</>}
          meta={<>{L.person(row.requested_by)} · {d ? <>deliver to {L.store(d.mr.store_id) || '—'} · need by {date(d.mr.required_date)}</> : '…'} · waiting {num(row.age_hours, 0)} h</>} />
        <ErrorBanner error={q.error ?? error} />
        {!d ? <Loading lines={5} /> : (
          <>
            {d.mr.purpose && <div><span className="muted">Purpose:</span> {d.mr.purpose}</div>}
            <FlowTimeline steps={steps} />
            {auth.canSeePrices && d.x.estimate && <div className="small-text"><span className="muted">Estimate:</span> <strong>{money(d.x.estimate.est_value, auth.project?.currency)}</strong>{d.x.estimate.unpriced_lines ? <span className="muted"> · {d.x.estimate.unpriced_lines} unpriced line(s)</span> : null}</div>}
            {d.x.approvals.some((a) => a.step === 'endorse' && !a.superseded) && <Banner tone="info">Endorsed by {d.x.approvals.filter((a) => a.step === 'endorse' && !a.superseded).map((a) => L.person(a.actor)).join(', ')} — above their approval limit.</Banner>}
            <DataTable rows={d.lines} rowKey={(r) => r.mr_line_id} maxHeight="none" columns={[
              { key: 'line_no', label: '#', align: 'right', width: 32 },
              { key: 'label', label: 'Material' },
              { key: 'qty', label: 'Requested', align: 'right', render: (r) => <>{fmtQty(r.qty, r.uom)}<span className="unit">{r.uom}</span></> },
              ...(kind !== 'pr_review' ? [{ key: 'rev', label: 'Reviewed', align: 'right' as const, render: (r: (typeof d.lines)[number]) => (rev(r.mr_line_id) === null ? <span className="muted-dash">—</span> : fmtQty(rev(r.mr_line_id), r.uom)) }] : []),
              ...(kind === 'pr_accept' ? [{ key: 'ap', label: 'Approved', align: 'right' as const, render: (r: (typeof d.lines)[number]) => fmtQty(r.approved_qty, r.uom) }]
                : [{ key: 'in', label: kind === 'pr_review' ? 'Recommend' : 'Approve', align: 'right' as const, render: (r: (typeof d.lines)[number]) => (
                  <QtyInput width={130} value={qty[r.mr_line_id] ?? ''} unit={r.uom} min={0} max={cap(r)} aria-label={`Line ${r.line_no}`} onChange={(v) => setQty({ ...qty, [r.mr_line_id]: v })} />) }]),
            ]} />
            {d.events[0]?.comment && <div className="muted small-text">Last comment: “{d.events[0].comment}” — {L.person(d.events[0].actor)}</div>}
          </>
        )}
      </div>
      <div className="action-bar">
        <textarea ref={commentRef} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (required to return or reject)" aria-label="Comment" />
        <button disabled={busy} onClick={() => void act('return')}>Return<Kbd k="R" /></button>
        {kind !== 'pr_accept' && <button disabled={busy} onClick={() => void act('reject')}>Reject</button>}
        <button className="primary" disabled={busy || !d} onClick={() => void act(main)}>{busy && <span className="spinner" />}
          {main === 'review' ? `Review${reduced.length ? ` (${reduced.length} trimmed)` : ''}` : main === 'approve' ? (reduced.length ? `Approve (${reduced.length} partial)` : 'Approve') : 'Accept'}<Kbd k="A" /></button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Store keeper: approved store order to issue (MIV is posted from the store app)
// ---------------------------------------------------------------------------
export function IssuePreview({ row, L, onActions }: Common) {
  const q = useAsync(() => loadMrDetail(row.entity_id), [row.entity_id, row.status], { key: 'mr-detail' });
  const d = q.data;
  const store = d?.mr.store_id ?? L.stores.find((s) => s.store_type === 'main')?.id ?? null;
  // No `d!` here: the React Compiler treats a non-null assertion as "always set" and reads d.mr while still loading.
  const ati = useAsync(() => (d ? loadAti(d.mr.project_id, [...new Set(d.lines.map((l) => l.material_spec_id))]) : Promise.resolve(null)),
    [row.entity_id, d?.lines.length], { key: 'mr-ati', enabled: !!d });
  useEffect(() => { onActions({}); });
  const mr = d?.mr as FlowMr | undefined;
  return (
    <div className="inbox-preview-body">
      <Head title={<Link to={`/requests/${row.entity_id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link>}
        badges={<FlowStatusBadge status={row.status} type="site_use" />}
        meta={<>Issue to {L.person(row.requested_by)} · from {L.store(store) || '—'}{mr?.issue_by ? <> · issue by <strong>{date(mr.issue_by)}</strong></> : ''} · approved {num(row.age_hours, 0)} h ago</>} />
      <ErrorBanner error={q.error ?? ati.error} />
      {!d ? <Loading lines={4} /> : (
        <DataTable rows={d.lines} rowKey={(r) => r.mr_line_id} maxHeight="none" columns={[
          { key: 'line_no', label: '#', align: 'right', width: 32 },
          { key: 'label', label: 'Material' },
          { key: 'approved', label: 'Approved', align: 'right', render: (r) => fmtQty(r.approved_qty, r.uom) },
          { key: 'issued', label: 'Issued', align: 'right', render: (r) => fmtQty(r.issued_qty, r.uom) },
          { key: 'bal', label: 'To issue', align: 'right', render: (r) => <strong>{fmtQty(r.remaining_qty, r.uom)}<span className="unit">{r.uom}</span></strong> },
          { key: 'ati', label: 'In store', align: 'right', render: (r) => {
            const a = Number((ati.data ?? []).find((x) => x.material_spec_id === r.material_spec_id && x.store_id === store)?.available ?? 0);
            return <span className={a >= Number(r.remaining_qty) ? 'ok-text' : 'danger-text'}>{fmtQty(a, r.uom)}</span>;
          } },
        ]} />
      )}
      <Banner tone="info">Issue against this store order from the store app (Issue queue → MIV). The site engineer then acknowledges receipt.</Banner>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Store keeper: accept / reschedule an announced delivery, then receive it (GRN)
// ---------------------------------------------------------------------------
type NoticeRow = DeliveryNotice & { purchase_orders?: { number: string; supplier_id: string } | null };
export function DeliveryPreview({ row, L, onDone, onActions }: Common) {
  const q = useAsync(async () => check(await supabase.from('delivery_notices').select('*, purchase_orders(number, supplier_id)').eq('id', row.entity_id).maybeSingle()) as NoticeRow | null,
    [row.entity_id, row.status], { key: 'dn-detail' });
  const [note, setNote] = useState('');
  const [date_, setDate] = useState('');
  const [grn, setGrn] = useState(false);
  const { busy, error, run } = useBusy();
  const n = q.data;
  const decide = (decision: 'accept' | 'reschedule') => run(async () => {
    if (decision === 'reschedule' && !date_) throw new Error('Propose another delivery date');
    await flowRpc('acknowledge_delivery_notice', { id: row.entity_id, decision, note: note.trim() || undefined, proposed_date: decision === 'reschedule' ? date_ : undefined });
    onDone(decision === 'accept' ? `Delivery of PO ${row.number} accepted` : `Reschedule requested for PO ${row.number}`);
  });
  useEffect(() => { onActions({ approve: () => void decide('accept') }); });
  return (
    <>
      <div className="inbox-preview-body">
        <Head title={<>PO {row.number}</>} badges={<Badge tone={row.is_urgent ? 'warning' : 'info'} label={row.is_urgent ? 'Due within a day' : 'Delivery notice'} icon={null} />}
          meta={n ? <>{L.suppliers.find((s) => s.id === n.purchase_orders?.supplier_id)?.name ?? 'Supplier'} → {L.store(n.store_id)} · expected <strong>{date(n.expected_date)}</strong>{n.expected_window && <> · {n.expected_window}</>} · notified by {L.person(n.created_by)} {dateTime(n.created_at)}</> : '…'} />
        <ErrorBanner error={q.error ?? error} />
        {!n ? <Loading lines={4} /> : (
          <>
            <dl className="kv">
              <dt>Vehicle</dt><dd>{n.vehicle_plate ?? '—'}{n.driver_name && <> · {n.driver_name}</>}{n.driver_phone && <> · <a href={`tel:${n.driver_phone}`}>{n.driver_phone}</a></>}</dd>
              {n.note && <><dt>Note</dt><dd>{n.note}</dd></>}
            </dl>
            <DataTable rows={n.lines} rowKey={(l) => l.po_line_id} maxHeight="none" columns={[
              { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
              { key: 'qty', label: 'Expected', align: 'right', render: (l) => <>{fmtQty(l.qty, L.specUom(l.material_spec_id))}<span className="unit">{L.specUom(l.material_spec_id)}</span></> },
            ]} />
            <div className="form-grid">
              <Field label="Note to procurement"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Space / labour ready…" /></Field>
              <Field label="Or propose another date"><input type="date" value={date_} onChange={(e) => setDate(e.target.value)} /></Field>
            </div>
          </>
        )}
      </div>
      <div className="action-bar">
        <span className="grow" />
        <button disabled={busy || !n} onClick={() => setGrn(true)}><PackageCheck size={14} aria-hidden />Receive (GRN)…</button>
        <button disabled={busy || !date_} onClick={() => void decide('reschedule')}>Request new date</button>
        <button className="primary" disabled={busy} onClick={() => void decide('accept')}>{busy && <span className="spinner" />}Accept delivery<Kbd k="A" /></button>
      </div>
      {grn && n && <GrnFromNoticeDrawer notice={n} L={L} onClose={() => setGrn(false)} onDone={() => onDone(`PO ${row.number} received`)} />}
    </>
  );
}
