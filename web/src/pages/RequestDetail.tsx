import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, FilePlus2, Pencil, Printer, ShoppingCart, Truck, TriangleAlert, Undo2 } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { rpc } from '../lib/supabase';
import { useAsync, useLookups } from '../lib/hooks';
import { loadMrDetail } from '../lib/mr';
import { canFlow, type FlowMrStatus, type MrFlowAction, type RequestType } from '../lib/contract-flows';
import {
  buildTimeline, currentStep, flowRpc, isMyTurn, isPurchase, loadAti, loadFlowExtras, loadTakeoffs, loadTrace,
  type FlowMr, type FlowSettings,
} from '../lib/flows';
import { date, dateTime, dueIn, humanize, money, num, qty as fmtQty, since } from '../lib/format';
import { pushRecent } from '../lib/prefs';
import { Attachments } from '../components/Attachments';
import { FlowStatusBadge, FlowTimeline, TraceChain, YourTurnBanner } from '../components/flows/FlowTimeline';
import {
  AcceptPrModal, ConvertShortfallModal, DirectPurchaseModal, NotifyDeliveryModal, RfqFromPrsModal, StoreOrderModal,
  type PrLinePick, type ShortfallLine,
} from '../components/flows/FlowDialogs';
import { PurchaseRequestForm } from '../components/flows/PurchaseRequestForm';
import {
  Badge, Banner, Card, DataTable, Empty, ErrorBanner, Loading, Menu, Page, Popover, PrintHeader, PriorityBadge, QtyInput, ReasonModal, Signatures, toast, useBusy,
  type Column,
} from '../components/ui';

type Dialog = 'reject' | 'return' | 'cancel' | 'close' | 'accept' | 'rfq' | 'direct' | 'notify' | 'storeOrder' | 'shortfall' | 'edit' | null;
type Mode = 'review' | 'approve' | null;

const OPEN_SUR: FlowMrStatus[] = ['submitted', 'reviewed', 'approved', 'sourced', 'ordered', 'partially_issued'];
const PR_BUYING: FlowMrStatus[] = ['approved_by_management', 'approved', 'with_procurement', 'sourced', 'ordered', 'partially_received'];

/**
 * Request detail for both flows (docs/research/procurement-lookahead.md §3–§4, schedule-ux.md §9):
 * FlowTimeline + "Your turn" banner, per-role actions with the right mr_action payloads, stock panel
 * (site use), estimate (price roles), sign-offs and the document chain.
 */
export function RequestDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const fromInbox = params.get('from') === 'approvals';
  const nav = useNavigate();
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => loadMrDetail(id), [id], { key: 'mr-detail' });
  const mr = q.data?.mr as FlowMr | undefined;
  const ex = useAsync(() => loadFlowExtras(mr!, { withPrices: auth.canSeePrices }), [id, mr?.status, mr?.version, auth.canSeePrices], { key: 'mr-flow', enabled: !!mr });
  const lineIds = (q.data?.lines ?? []).map((l) => l.mr_line_id);
  const trace = useAsync(() => loadTrace(mr!, lineIds, ex.data?.children ?? []), [id, mr?.status, lineIds.join(), ex.data?.children.length], { key: 'mr-trace', enabled: !!mr && !!ex.data });
  const type: RequestType = mr && isPurchase(mr) ? 'purchase' : 'site_use';
  const status = (mr?.status ?? 'draft') as FlowMrStatus;
  const specIds = [...new Set((q.data?.lines ?? []).map((l) => l.material_spec_id))];
  const showStock = type === 'site_use' && OPEN_SUR.includes(status);
  const ati = useAsync(() => loadAti(projectId, specIds), [projectId, specIds.join()], { key: 'mr-ati', enabled: !!mr && showStock });
  const elIds = [...new Set((q.data?.elements ?? []).map((e) => e.element_id))];
  const tko = useAsync(() => loadTakeoffs(elIds, specIds), [elIds.join(), specIds.join()], { key: 'mr-takeoff', enabled: !!mr && showStock });

  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [notifyPo, setNotifyPo] = useState<{ id: string; label: string } | null>(null);
  const [modeComment, setModeComment] = useState('');
  const { busy, error, run } = useBusy();

  useEffect(() => { if (mr) pushRecent({ label: mr.number, hint: isPurchase(mr) ? 'Purchase request' : 'Request', to: `/requests/${id}` }); }, [mr, id]);

  const L = lk.data;
  const settings = auth.settings as FlowSettings | null;
  const steps = useMemo(() => (mr && L && q.data ? buildTimeline({
    type, status, events: q.data.events, approvals: ex.data?.approvals ?? [], wf: ex.data?.wf ?? null, settings,
    requestedBy: mr.requested_by, submittedAt: mr.submitted_at, createdAt: mr.created_at, L,
  }) : []), [mr, L, q.data, ex.data, type, status, settings]);

  if (!q.data || !L || !mr) {
    return (
      <Page title="Request" breadcrumbs={[{ label: 'Requests', to: '/requests' }, { label: '…' }]}>
        {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}
      </Page>
    );
  }

  const { lines, extra, elements, events, avail, issues } = q.data;
  const fx = ex.data;
  const role = auth.profile?.role ?? null;
  const me = auth.profile?.id ?? null;
  const isOwner = mr.requested_by === me;
  const isMgmt = role === 'coordinator' || role === 'manager' || role === 'admin';
  const purchase = type === 'purchase';
  const requireCoord = settings?.pr_require_coordinator_review ?? true;
  const coordFinal = settings?.pr_coordinator_final_limit ?? null;
  const flowLine = (lid: string) => fx?.lines.get(lid);
  const reviewedOf = (l: (typeof lines)[number]) => flowLine(l.mr_line_id)?.reviewed_qty ?? null;
  const backTo = purchase ? '/requests?type=purchase' : '/requests';
  // Issues handed to me that I have not confirmed yet (the mobile app does the same in requests/[id]).
  const toConfirm = issues.filter((m) => m.status === 'pending_ack' && m.issued_to === me);
  const confirmReceived = () => void run(async () => {
    for (const m of toConfirm) await rpc('acknowledge_miv', { miv_id: m.id });
    toast.success(`${toConfirm.map((m) => m.number).join(', ')} confirmed as received`);
    q.reload(); ex.reload();
  });
  const inboxType = purchase ? 'pr' : 'mr';

  const after = (label: string) => {
    toast.success(`${mr.number} ${label}`, fromInbox ? { action: { label: 'Next in queue', onClick: () => nav(`/approvals?type=${inboxType}`) } } : undefined);
    if (fromInbox) nav(`/approvals?type=${inboxType}`);
  };
  const PAST: Record<string, string> = { approve: 'approved', review: 'reviewed', return: 'returned', reject: 'rejected', cancel: 'cancelled', close: 'closed', accept: 'accepted' };
  const act = async (action: MrFlowAction, extraP: { comment?: string; lines?: { id: string; reviewed_qty?: number; approved_qty?: number }[]; store_id?: string; issue_by?: string } = {}) => {
    const res = await flowRpc('mr_action', { mr_id: mr.id, action, ...extraP });
    setMode(null);
    q.reload(); ex.reload();
    if (res.endorsed) { toast.info(`${mr.number} endorsed — above your approval limit, sent to an approver with a higher limit`); return; }
    after(action === 'approve' && type === 'site_use' ? 'approved — store order sent to the store keeper' : action === 'review' && purchase ? 'reviewed — sent for management approval' : PAST[action] ?? action);
  };

  // --- permissions per flow / status / role (the database enforces the same rules) ---
  const anyIssued = lines.some((l) => Number(l.issued_qty) > 0);
  const can = {
    edit: purchase ? (isOwner || isMgmt) && ['draft', 'returned', 'submitted'].includes(status) : isOwner && ['draft', 'returned'].includes(status),
    review: purchase
      ? canFlow(role, 'pr.review') && status === 'submitted' && requireCoord && !isOwner
      : canFlow(role, 'sur.review') && status === 'submitted',
    approve: purchase
      ? !isOwner && ((canFlow(role, 'pr.approve') && (['reviewed_by_coordinator', 'reviewed'].includes(status) || (status === 'submitted' && !requireCoord)))
        || (role === 'coordinator' && coordFinal !== null && ['submitted', 'reviewed_by_coordinator'].includes(status)))
      : canFlow(role, 'sur.approve') && !isOwner && (status === 'reviewed' || (status === 'submitted' && role !== 'office_engineer')),
    accept: purchase && canFlow(role, 'pr.accept') && ['approved_by_management', 'approved'].includes(status),
    return: purchase
      ? (['submitted', 'reviewed_by_coordinator', 'reviewed'].includes(status) && isMgmt) || (['approved_by_management', 'approved', 'with_procurement'].includes(status) && canFlow(role, 'pr.return'))
      : canFlow(role, 'sur.review') && ['submitted', 'reviewed'].includes(status),
    reject: purchase
      ? (status === 'submitted' && isMgmt) || (['reviewed_by_coordinator', 'reviewed', 'approved_by_management', 'approved'].includes(status) && (role === 'manager' || role === 'admin'))
      : canFlow(role, 'sur.approve') && ['submitted', 'reviewed', 'approved'].includes(status) && !anyIssued,
    cancel: purchase
      ? (['draft', 'submitted', 'returned', 'reviewed_by_coordinator', 'reviewed'].includes(status) && (isOwner || isMgmt)) || (['approved_by_management', 'approved', 'with_procurement', 'sourced'].includes(status) && isMgmt)
      : (isOwner || isMgmt) && ['draft', 'submitted', 'reviewed', 'returned', 'approved'].includes(status) && !anyIssued,
    close: purchase
      ? canFlow(role, 'pr.close') && ['with_procurement', 'sourced', 'ordered', 'delivery_expected', 'partially_received', 'received'].includes(status)
      : canFlow(role, 'sur.close') && ['approved', 'partially_issued', 'issued', 'received'].includes(status),
    convert: !purchase && canFlow(role, 'sur.convertShortfall') && ['submitted', 'reviewed', 'approved', 'partially_issued'].includes(status),
    source: purchase && canFlow(role, 'rfq.fromPr') && PR_BUYING.includes(status),
    direct: purchase && canFlow(role, 'po.direct') && auth.canSeePrices && PR_BUYING.includes(status) && Number(settings?.direct_purchase_limit ?? 0) > 0,
    notify: purchase && canFlow(role, 'delivery.notify') && ['sourced', 'ordered', 'partially_received', 'delivery_expected', 'with_procurement'].includes(status),
  };
  const openPos = (trace.data ?? []).filter((d) => d.kind === 'PO' && ['approved', 'sent', 'partially_received'].includes(d.status));

  // --- stock (site use) ---
  const store = mr.store_id ?? L.stores.find((s) => s.store_type === 'main')?.id ?? null;
  const atiAt = (spec: string, st: string | null) => (ati.data ?? []).find((r) => r.material_spec_id === spec && r.store_id === st);
  const shortLines: ShortfallLine[] = lines.map((l) => {
    const need = Number(l.approved_qty ?? reviewedOf(l) ?? l.qty) - Number(l.issued_qty);
    const a = Number(atiAt(l.material_spec_id, store)?.ati ?? avail.get(l.material_spec_id) ?? 0);
    return { id: l.mr_line_id, line_no: l.line_no, label: l.label, uom: l.uom, requested: Number(l.qty), shortfall: Math.max(0, need - a) };
  });
  const anyShort = showStock && shortLines.some((l) => l.shortfall > 0.0005);

  // --- review / approve inline quantities ---
  const capOf = (l: (typeof lines)[number]) => (mode === 'review' ? Number(l.qty) : Number(reviewedOf(l) ?? l.qty));
  const startMode = (m: Mode) => {
    setQty(Object.fromEntries(lines.map((l) => [l.mr_line_id, String(m === 'review' ? (reviewedOf(l) ?? l.qty) : (l.approved_qty ?? reviewedOf(l) ?? l.qty))])));
    setMode(m);
  };
  const checkQty = () => {
    for (const l of lines) {
      const v = Number(qty[l.mr_line_id]);
      if (!Number.isFinite(v) || v < 0 || v > capOf(l) + 0.0005) throw new Error(`Line ${l.line_no}: quantity must be between 0 and ${num(capOf(l), 3)}`);
    }
  };
  const changed = mode ? lines.filter((l) => Number(qty[l.mr_line_id]) < capOf(l) - 0.0005) : [];
  const submitMode = (comment?: string) => run(async () => {
    checkQty();
    if (mode === 'review') await act('review', { comment, lines: lines.map((l) => ({ id: l.mr_line_id, reviewed_qty: Number(qty[l.mr_line_id]) })) });
    else if (purchase) await act('approve', { comment, lines: changed.map((l) => ({ id: l.mr_line_id, approved_qty: Number(qty[l.mr_line_id]) })) });
    else setDialog('storeOrder');
  });

  // --- primary action for the current step ---
  const prLines: PrLinePick[] = lines.filter((l) => (flowLine(l.mr_line_id)?.line_status ?? 'open') === 'open' && Number(l.approved_qty ?? 0) > 0).map((l) => ({
    mr_line_id: l.mr_line_id, mr_number: mr.number, line_no: l.line_no, material_spec_id: l.material_spec_id, label: l.label, uom: l.uom,
    qty: Math.max(0, Number(l.approved_qty) - Number(flowLine(l.mr_line_id)?.qty_received ?? 0)), required: l.required_date ?? mr.required_date, store_id: mr.store_id,
  })).filter((l) => l.qty > 0);

  const step = currentStep(steps);
  const myTurn = !!step && isMyTurn(step.actor, { id: me, role }, mr.requested_by);
  let primary: { label: string; icon?: ReactNode; onClick: () => void } | null = null;
  if (can.approve) primary = { label: purchase ? 'Approve…' : 'Approve as store order…', icon: <Check size={14} aria-hidden />, onClick: () => startMode('approve') };
  if (can.review && (!can.approve || role === 'office_engineer' || (purchase && role === 'coordinator'))) primary = { label: 'Review…', icon: <Check size={14} aria-hidden />, onClick: () => startMode('review') };
  if (can.accept) primary = { label: 'Accept', icon: <Check size={14} aria-hidden />, onClick: () => setDialog('accept') };
  else if (can.source && ['with_procurement', 'sourced'].includes(status) && prLines.length) primary = { label: 'Create RFQ…', icon: <FilePlus2 size={14} aria-hidden />, onClick: () => setDialog('rfq') };
  else if (can.notify && openPos.length && ['ordered', 'partially_received'].includes(status)) primary = { label: 'Notify store…', icon: <Truck size={14} aria-hidden />, onClick: () => { setNotifyPo({ id: openPos[0].id, label: openPos[0].label }); setDialog('notify'); } };
  else if (purchase && status === 'delivery_expected' && canFlow(role, 'delivery.acknowledge')) primary = { label: 'Delivery notices', icon: <Truck size={14} aria-hidden />, onClick: () => nav('/deliveries') };
  if (!primary && can.edit && ['draft', 'returned'].includes(status) && isOwner) primary = { label: status === 'returned' ? 'Fix & resubmit…' : 'Edit & submit…', icon: <Pencil size={14} aria-hidden />, onClick: () => setDialog('edit') };

  const overflow = [
    can.edit && primary?.label.startsWith('Edit') !== true && primary?.label.startsWith('Fix') !== true ? { label: 'Edit request…', onClick: () => setDialog('edit') } : null,
    can.source && prLines.length && primary?.label !== 'Create RFQ…' ? { label: 'Create RFQ…', onClick: () => setDialog('rfq') } : null,
    can.direct && prLines.length ? { label: 'Record direct purchase…', onClick: () => setDialog('direct') } : null,
    ...(can.notify ? openPos.map((p) => ({ label: `Notify store: ${p.label}…`, onClick: () => { setNotifyPo({ id: p.id, label: p.label }); setDialog('notify'); } })) : []),
    can.convert ? { label: 'Convert shortfall to purchase request…', onClick: () => setDialog('shortfall') } : null,
    can.reject ? { label: 'Reject…', danger: true, onClick: () => setDialog('reject') } : null,
    can.cancel ? { label: 'Cancel request…', onClick: () => setDialog('cancel') } : null,
    can.close ? { label: purchase && status !== 'received' ? 'Short-close…' : 'Close request…', onClick: () => setDialog('close') } : null,
    { label: 'Print (A4)', icon: <Printer size={14} />, onClick: () => window.print() },
  ].filter((x): x is NonNullable<typeof x> => !!x);

  const overBoq = lines.filter((l) => extra.get(l.mr_line_id)?.exceeds_boq);
  const due = dueIn(mr.required_date);
  const openStatus = !['draft', 'closed', 'rejected', 'cancelled', 'received'].includes(status);

  const columns: Column<(typeof lines)[number]>[] = [
    { key: 'line_no', label: '#', align: 'right', width: 36 },
    { key: 'label', label: 'Material / grade', render: (r) => <>{extra.get(r.mr_line_id)?.exceeds_boq && <span className="warn-line" title="Over BoQ"><TriangleAlert size={14} /></span>} {r.label}{extra.get(r.mr_line_id)?.remarks && <div className="xs-text muted">{extra.get(r.mr_line_id)?.remarks}</div>}</> },
    { key: 'elements', label: 'Elements', value: (r) => elements.filter((e) => e.mr_line_id === r.mr_line_id).map((e) => `${L.element(e.element_id)}: ${num(e.qty)}`).join('; ') },
    { key: 'qty', label: 'Requested', align: 'right', render: (r) => <>{fmtQty(r.qty, r.uom)}<span className="unit">{r.uom}</span></> },
    { key: 'reviewed', label: 'Reviewed', align: 'right', value: (r) => reviewedOf(r), render: (r) => mode === 'review'
      ? <QtyInput width={130} value={qty[r.mr_line_id] ?? ''} unit={r.uom} min={0} max={Number(r.qty)} aria-label={`Reviewed quantity line ${r.line_no}`} onChange={(v) => setQty({ ...qty, [r.mr_line_id]: v })} />
      : reviewedOf(r) === null ? <span className="muted-dash">—</span> : <span className={Number(reviewedOf(r)) < Number(r.qty) ? 'strong' : ''}>{fmtQty(reviewedOf(r), r.uom)}</span> },
    { key: 'approved_qty', label: 'Approved', align: 'right', render: (r) => mode === 'approve'
      ? <QtyInput width={130} value={qty[r.mr_line_id] ?? ''} unit={r.uom} min={0} max={capOf(r)} aria-label={`Approve line ${r.line_no}`} onChange={(v) => setQty({ ...qty, [r.mr_line_id]: v })} />
      : r.approved_qty === null ? <span className="muted-dash">—</span> : fmtQty(r.approved_qty, r.uom) },
    ...(purchase ? [
      { key: 'received', label: 'Received', align: 'right' as const, value: (r: (typeof lines)[number]) => flowLine(r.mr_line_id)?.qty_received ?? 0, render: (r: (typeof lines)[number]) => fmtQty(flowLine(r.mr_line_id)?.qty_received ?? 0, r.uom) },
      { key: 'line_status', label: 'Line', value: (r: (typeof lines)[number]) => flowLine(r.mr_line_id)?.line_status ?? 'open',
        render: (r: (typeof lines)[number]) => (flowLine(r.mr_line_id)?.line_status ?? 'open') === 'open' ? null : <Badge tone="neutral" label={humanize(flowLine(r.mr_line_id)?.line_status)} icon={null} /> },
    ] : [
      { key: 'stock', label: showStock ? 'Available to issue' : 'On site', align: 'right' as const, value: (r: (typeof lines)[number]) => (showStock ? atiAt(r.material_spec_id, store)?.ati : avail.get(r.material_spec_id)) ?? 0,
        render: (r: (typeof lines)[number]) => {
          const s = Number((showStock ? atiAt(r.material_spec_id, store)?.ati : avail.get(r.material_spec_id)) ?? 0);
          const need = Number(r.approved_qty ?? reviewedOf(r) ?? r.qty) - Number(r.issued_qty);
          return <span className={s >= need ? 'ok-text' : s > 0 ? '' : 'danger-text'}>{fmtQty(s, r.uom)}</span>;
        } },
      { key: 'issued_qty', label: 'Issued', align: 'right' as const, render: (r: (typeof lines)[number]) => fmtQty(r.issued_qty, r.uom) },
      { key: 'remaining_qty', label: 'Balance', align: 'right' as const, render: (r: (typeof lines)[number]) => fmtQty(r.remaining_qty, r.uom) },
    ]),
  ];

  const prInitial = {
    id: mr.id, number: mr.number, priority: mr.priority, required_date: mr.required_date, store_id: mr.store_id, block_id: mr.block_id,
    delivery_location: mr.delivery_location, purpose: mr.purpose, drawing_ref: mr.drawing_ref, lookahead_plan_id: mr.lookahead_plan_id ?? null,
    lines: lines.map((l) => {
      const el = elements.find((e) => e.mr_line_id === l.mr_line_id);
      return { id: l.mr_line_id, material_spec_id: l.material_spec_id, qty: Number(l.qty), required_date: l.required_date, remarks: extra.get(l.mr_line_id)?.remarks ?? null, element_id: el?.element_id ?? null, split_id: el?.id ?? null };
    }),
  };

  return (
    <Page width="form" title={mr.number} breadcrumbs={[{ label: purchase ? 'Purchase requests' : 'Site-use requests', to: backTo }, { label: mr.number }]}
      titleExtra={<span className="badges"><FlowStatusBadge status={status} type={type} /><PriorityBadge value={mr.priority} />{purchase && <Badge tone="violet" label="Purchase" icon={null} outline />}</span>}
      subtitle={<>Raised {dateTime(mr.created_at)} by {L.person(mr.requested_by)}{mr.block_id && <> · Block {L.block(mr.block_id)}</>} · required {date(mr.required_date)}{due.text && openStatus && <span className={due.late ? 'danger-text' : ''}> ({due.text})</span>}</>}
      actions={mode ? null : <>
        {can.return && <button disabled={busy} onClick={() => setDialog('return')}><Undo2 size={14} aria-hidden />Return…</button>}
        {can.review && can.approve && primary?.label !== 'Review…' && <button disabled={busy} onClick={() => startMode('review')}>Review…</button>}
        {primary && <button className="primary" disabled={busy} onClick={primary.onClick}>{primary.icon}{primary.label}</button>}
        <Popover align="right" trigger={(p) => <button {...p} aria-label="More actions">⋯</button>}>
          {(close) => <Menu items={overflow.map((o) => ({ ...o, onClick: () => { close(); o.onClick(); } }))} />}
        </Popover>
      </>}>
      <div className="print-doc">
        <PrintHeader title={`${purchase ? 'Purchase request' : 'Material request'} ${mr.number}`} />
        <div className="stack">
          {myTurn && !mode && <YourTurnBanner step={step} type={type} action={primary ? <button className="primary small" onClick={primary.onClick}>{primary.label}</button> : undefined} />}
          <Card><FlowTimeline steps={steps} /></Card>
          <ErrorBanner error={error ?? ex.error} />
          {mr.status_reason && ['returned', 'rejected', 'cancelled', 'closed'].includes(status) && <Banner tone={status === 'returned' ? 'warn' : 'info'}>{humanize(status)}: “{mr.status_reason}”</Banner>}
          {fx?.source && <Banner tone="info">Raised for the shortfall of site-use request <Link to={`/requests/${fx.source.id}`}>{fx.source.number}</Link> — the requester is informed at each step.</Banner>}
          {!purchase && ['approved', 'sourced', 'ordered', 'partially_issued'].includes(status) && (
            <Banner tone="info" action={canFlow(role, 'sur.issue') ? <Link to="/store#miv">Issues (MIV)</Link> : undefined}>
              Store order{mr.issue_by ? <> — issue by <strong>{date(mr.issue_by)}</strong></> : ''} from {L.store(mr.store_id) || 'the main store'}. The store keeper issues against it (MIV) from the store app; the site engineer confirms receipt here or in the app.
            </Banner>
          )}
          {toConfirm.length > 0 && (
            <Banner tone="attention" action={<button className="small primary" disabled={busy} onClick={confirmReceived}>{busy && <span className="spinner" />}<Check size={14} aria-hidden />Confirm received</button>}>
              {toConfirm.length === 1 ? `${toConfirm[0].number} was issued to you` : `${toConfirm.length} issues were issued to you`} — confirm you received the material on site.
            </Banner>
          )}
          {overBoq.length > 0 && (
            <Banner tone="warn">
              {overBoq.map((l) => <div key={l.mr_line_id}>Line {l.line_no} ({l.label}) exceeds BoQ{extra.get(l.mr_line_id)?.over_boq_reason ? ` — reason: “${extra.get(l.mr_line_id)?.over_boq_reason}”` : ''}</div>)}
            </Banner>
          )}
        </div>
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Lines" flush sub={mode === 'review' ? (purchase ? 'Trim quantities the coordinator recommends (≤ requested).' : 'Set the quantity you recommend per line (≤ requested) — check stock and BoQ below.')
              : mode === 'approve' ? 'Reduce a quantity to approve it partially; 0 removes the line.' : undefined}>
              <DataTable rows={lines} rowKey={(r) => r.mr_line_id} maxHeight="none" columns={columns} />
              {mode && (
                <div className="action-bar">
                  <textarea rows={1} value={modeComment} onChange={(e) => setModeComment(e.target.value)} placeholder="Comment (optional)" aria-label="Comment" />
                  <span className="muted small-text">{changed.length ? `${changed.length} line${changed.length === 1 ? '' : 's'} reduced` : 'All lines in full'}</span>
                  <button onClick={() => setMode(null)} disabled={busy}>Cancel</button>
                  <button className="primary" disabled={busy} onClick={() => void submitMode(modeComment.trim() || undefined)}>{busy && <span className="spinner" />}
                    {mode === 'review' ? (purchase ? 'Review & send to management' : 'Review & forward to coordinator') : purchase ? (changed.length ? `Approve (${changed.length} partial)` : 'Approve') : 'Continue…'}</button>
                </div>
              )}
            </Card>
            {showStock && (
              <Card title="Stock available to issue" flush className="stock-panel" sub={`Store: ${L.store(store) || '—'} · available − already reserved by approved requests`}
                actions={can.convert ? <button className="small" onClick={() => setDialog('shortfall')}><ShoppingCart size={14} aria-hidden />Convert shortfall…</button> : undefined}>
                <ErrorBanner error={ati.error} onRetry={ati.reload} />
                <DataTable rows={lines} rowKey={(r) => r.mr_line_id} maxHeight="none" loading={!ati.data && !ati.error} columns={[
                  { key: 'line_no', label: '#', align: 'right', width: 36 },
                  { key: 'label', label: 'Material' },
                  { key: 'need', label: 'Needed', align: 'right', value: (r) => Number(r.approved_qty ?? reviewedOf(r) ?? r.qty) - Number(r.issued_qty), render: (r) => fmtQty(Number(r.approved_qty ?? reviewedOf(r) ?? r.qty) - Number(r.issued_qty), r.uom) },
                  { key: 'ati', label: 'Available to issue', align: 'right', value: (r) => atiAt(r.material_spec_id, store)?.ati ?? 0, render: (r) => {
                    const sl = shortLines.find((x) => x.id === r.mr_line_id);
                    return <span className={sl && sl.shortfall > 0 ? 'danger-text strong' : 'ok-text'}>{fmtQty(atiAt(r.material_spec_id, store)?.ati ?? 0, r.uom)}</span>;
                  } },
                  { key: 'reserved', label: 'Reserved', align: 'right', value: (r) => atiAt(r.material_spec_id, store)?.reserved ?? 0, render: (r) => fmtQty(atiAt(r.material_spec_id, store)?.reserved ?? 0, r.uom) },
                  { key: 'short', label: 'Shortfall', align: 'right', value: (r) => shortLines.find((x) => x.id === r.mr_line_id)?.shortfall ?? 0,
                    render: (r) => { const s = shortLines.find((x) => x.id === r.mr_line_id)?.shortfall ?? 0; return s > 0 ? <span className="danger-text strong">{fmtQty(s, r.uom)}</span> : <span className="muted-dash">—</span>; } },
                  { key: 'other', label: 'Other stores', value: (r) => (ati.data ?? []).filter((x) => x.material_spec_id === r.material_spec_id && x.store_id !== store && Number(x.ati) > 0).map((x) => `${x.store_name}: ${num(x.ati, 3)}`).join('; ') },
                  { key: 'boq', label: 'Take-off (BoQ)', align: 'right', value: (r) => {
                    const els = elements.filter((e) => e.mr_line_id === r.mr_line_id).map((e) => e.element_id);
                    const t = (tko.data ?? []).filter((x) => x.material_spec_id === r.material_spec_id && els.includes(x.element_id));
                    return t.length ? t.reduce((s, x) => s + Number(x.planned_qty), 0) : null;
                  } },
                ]} />
                {anyShort && <div className="muted small-text" style={{ padding: 'var(--sp-2) var(--sp-3)' }}>Not enough stock for some lines — convert the shortfall to a purchase request (enters the purchase flow at the coordinator).</div>}
              </Card>
            )}
            <Card title="Document chain" sub={purchase ? 'Purchase request → RFQ → PO → delivery notice → GRN → issue' : 'Site-use request → purchase requests for shortfalls → issues (MIV)'}>
              {trace.loading && !trace.data ? <Loading lines={1} /> : (
                <TraceChain docs={[
                  ...(fx?.source ? [{ kind: 'SUR' as const, id: fx.source.id, label: fx.source.number, status: fx.source.status, to: `/requests/${fx.source.id}` }] : []),
                  { kind: purchase ? 'PR' as const : 'SUR' as const, id: mr.id, label: mr.number, status },
                  ...(trace.data ?? []),
                ]} />
              )}
            </Card>
            {!purchase && (
              <Card title="Issues against this request" flush>
                <DataTable rows={issues} maxHeight="none" empty="Nothing issued yet" onRowClick={(r) => nav(`/store?open=${r.id}#miv`)} columns={[
                  { key: 'number', label: 'MIV', id: true },
                  { key: 'issued_at', label: 'Issued', render: (r) => dateTime(r.issued_at) },
                  { key: 'qty', label: 'Lines', align: 'right', value: (r) => r.miv_lines.length },
                  { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} label={r.status === 'pending_ack' ? 'Awaiting receipt' : r.status === 'acknowledged' ? 'Received' : undefined} /> },
                  { key: 'acknowledged_at', label: 'Received', render: (r) => (r.acknowledged_at ? dateTime(r.acknowledged_at) : '—') },
                ]} />
              </Card>
            )}
          </div>
          <div className="side-panel">
            <Card title="Details">
              <dl className="kv">
                <dt>Type</dt><dd>{purchase ? 'Purchase request (buy from supplier)' : 'Site-use request (issue from store)'}</dd>
                <dt>Purpose</dt><dd>{mr.purpose ?? '—'}</dd>
                <dt>{purchase ? 'Deliver to' : 'Store'}</dt><dd>{L.store(mr.store_id) || mr.delivery_location || '—'}</dd>
                {!purchase && <><dt>Issue by</dt><dd>{mr.issue_by ? date(mr.issue_by) : '—'}</dd></>}
                <dt>Drawing</dt><dd>{mr.drawing_ref ?? '—'}</dd>
                <dt>Look-ahead</dt><dd>{mr.is_lookahead ? 'Yes' : 'No'}</dd>
                <dt>Requester</dt><dd>{L.person(mr.requested_by)} <span className="muted">({humanize(mr.requester_role)})</span></dd>
                <dt>Submitted</dt><dd>{dateTime(mr.submitted_at) || '—'}</dd>
                {purchase && mr.procurement_owner && <><dt>Buyer</dt><dd>{L.person(mr.procurement_owner)}{mr.procurement_accepted_at && <span className="muted"> · {dateTime(mr.procurement_accepted_at)}</span>}</dd></>}
                {fx?.wf?.sla_due && openStatus && <><dt>SLA due</dt><dd className={fx.wf.is_overdue ? 'danger-text strong' : ''}>{dateTime(fx.wf.sla_due)}{fx.wf.is_overdue ? ' (overdue)' : ''}</dd></>}
                {(fx?.children.length ?? 0) > 0 && <><dt>Purchase requests</dt><dd>{fx!.children.map((c, i) => <span key={c.id}>{i > 0 && ', '}<Link to={`/requests/${c.id}`}>{c.number}</Link></span>)}</dd></>}
                <dt>Version</dt><dd>{mr.version}</dd>
              </dl>
            </Card>
            {auth.canSeePrices && purchase && (
              <Card title="Estimate">
                {!fx?.estimate ? <Empty inline>Estimated when submitted.</Empty> : (
                  <dl className="kv">
                    <dt>Value</dt><dd className="strong">{money(fx.estimate.est_value, auth.project?.currency)}</dd>
                    <dt>Priced lines</dt><dd>{fx.estimate.priced_lines}{fx.estimate.unpriced_lines ? <span className="warning-text"> · {fx.estimate.unpriced_lines} unpriced</span> : ''}</dd>
                    <dt>Computed</dt><dd>{dateTime(fx.estimate.computed_at)}</dd>
                  </dl>
                )}
              </Card>
            )}
            <Card title="Sign-offs">
              {!fx?.approvals.length ? <Empty inline>No sign-offs yet.</Empty> : (
                <ul className="timeline">
                  {fx.approvals.map((a) => (
                    <li key={a.id} style={a.superseded ? { opacity: 0.55 } : undefined}>
                      <div><strong>{humanize(a.step)}</strong>{a.superseded && <span className="muted"> (superseded)</span>}</div>
                      <div className="t-meta">{L.person(a.actor)} ({humanize(a.actor_role)}){a.delegated_from && <> for {L.person(a.delegated_from)}</>} · {dateTime(a.created_at)}</div>
                      {a.comment && <div className="t-comment">{a.comment}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Activity">
              {!events.length ? <Empty inline>No activity yet.</Empty> : (
                <ul className="timeline">
                  {events.map((e) => (
                    <li key={e.id}>
                      <div><strong>{humanize(e.action)}</strong>{e.to_status && e.to_status !== e.from_status && <> → <FlowStatusBadge status={e.to_status} type={type} /></>}</div>
                      <div className="t-meta">{L.person(e.actor) || 'system'} · <span title={dateTime(e.created_at)}>{since(e.created_at)}</span></div>
                      {e.comment && <div className="t-comment">{e.comment}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Attachments"><Attachments entityType="material_request" entityId={mr.id} canAdd kinds={['photo', 'document', 'drawing', 'proforma']} /></Card>
          </div>
        </div>
        <Signatures />
      </div>

      {dialog === 'reject' && <ReasonModal title={`Reject ${mr.number}`} danger confirm="Reject request" onClose={() => setDialog(null)} onSubmit={(c) => act('reject', { comment: c })} />}
      {dialog === 'return' && <ReasonModal title="Return for clarification" label="What needs clarification?" confirm="Return request" onClose={() => setDialog(null)} onSubmit={(c) => act('return', { comment: c })} />}
      {dialog === 'cancel' && <ReasonModal title={`Cancel ${mr.number}`} required={purchase && PR_BUYING.includes(status)} label={purchase && PR_BUYING.includes(status) ? 'Reason' : 'Reason (optional)'} danger confirm="Cancel request" onClose={() => setDialog(null)} onSubmit={(c) => act('cancel', { comment: c || undefined })} />}
      {dialog === 'close' && <ReasonModal title={purchase && status !== 'received' ? `Short-close ${mr.number}` : `Close ${mr.number}`} required={purchase && status !== 'received'} label={purchase && status !== 'received' ? 'Why is the rest no longer needed?' : 'Comment (optional)'} confirm="Close request" onClose={() => setDialog(null)} onSubmit={(c) => act('close', { comment: c || undefined })} />}
      {dialog === 'accept' && <AcceptPrModal mr={mr} L={L} onClose={() => setDialog(null)} onDone={() => { q.reload(); if (fromInbox) nav('/approvals?type=pr'); }} />}
      {dialog === 'rfq' && <RfqFromPrsModal lines={prLines} L={L} onClose={() => setDialog(null)} onDone={(rid) => nav(`/procurement/rfq/${rid}`)} />}
      {dialog === 'direct' && <DirectPurchaseModal lines={prLines} L={L} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
      {dialog === 'notify' && notifyPo && <NotifyDeliveryModal poId={notifyPo.id} poNumber={notifyPo.label} L={L} onClose={() => setDialog(null)} onDone={() => q.reload()} />}
      {dialog === 'shortfall' && <ConvertShortfallModal mr={mr} lines={shortLines} onClose={() => setDialog(null)} onDone={(prId) => nav(`/requests/${prId}`)} />}
      {dialog === 'storeOrder' && <StoreOrderModal L={L} storeId={mr.store_id} requiredDate={mr.required_date} partial={changed.length} onClose={() => setDialog(null)}
        onSubmit={(v) => act('approve', { comment: v.comment ?? (modeComment.trim() || undefined), store_id: v.store_id, issue_by: v.issue_by,
          lines: changed.map((l) => ({ id: l.mr_line_id, approved_qty: Number(qty[l.mr_line_id]) })) })} />}
      {dialog === 'edit' && <PurchaseRequestForm type={type} projectId={projectId} L={L} initial={prInitial} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); q.reload(); }} />}
      <Link to={backTo} className="sr-only">Back to all requests</Link>
    </Page>
  );
}
