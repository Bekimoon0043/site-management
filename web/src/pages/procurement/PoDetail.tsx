import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Copy, FileDown, Pencil, Printer, Send, Share2, Truck } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { DELIVERY_STATUS_LABELS, PO_STATUS_LABELS, canProcure, type DeliveryStatus, type PoActionPayload } from '../../lib/contract-procurement';
import { OPEN_PO, PO_AMENDABLE, PO_EDITABLE, copyText, loadPoDetail, poSummary, procRpc, telegramShare, whatsappShare } from '../../lib/procurement';
import { date, dateTime, humanize, money, num, qty, today, since } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import {
  Badge, Banner, Bar, Card, DataTable, Empty, ErrorBanner, Field, Loading, Menu, Modal, Page, Popover, PrintHeader, ReasonModal, Signatures, toast, useBusy,
} from '../../components/ui';
import { DelayedBadge, DeliveryBadge, PoBadge } from '../../components/procurement/badges';
import { NotifyDeliveryModal } from '../../components/flows/FlowDialogs';
import { canFlow } from '../../lib/contract-flows';
import { Attachments } from '../../components/Attachments';

type Dialog = 'reject' | 'cancel' | 'close' | 'delivery' | 'share' | null;

export function PoDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const fromInbox = params.get('from') === 'approvals';
  const nav = useNavigate();
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const withPrices = auth.canSeePrices;
  const q = useAsync(() => loadPoDetail(id, withPrices), [id, withPrices], { key: 'po-detail' });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notify, setNotify] = useState(false);
  const { busy, error, run } = useBusy();

  useEffect(() => { if (q.data) pushRecent({ label: q.data.po.number, hint: 'Purchase order', to: `/procurement/po/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="Purchase order" breadcrumbs={[{ label: 'Procurement', to: '/procurement#pos' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const d = q.data;
  const { po } = d;
  const L = lk.data;
  const cur = d.totals?.currency ?? auth.project?.currency ?? 'ETB';
  const act = (action: PoActionPayload['action'], comment?: string) => procRpc('po_action', { po_id: po.id, action, comment }).then((r) => {
    const label = { submit: 'submitted for approval', approve: 'approved', reject: 'rejected', send: 'marked as sent to the supplier', cancel: 'cancelled', close: 'closed' }[action];
    toast.success(`${po.number} ${label}`, fromInbox ? { action: { label: 'Next in queue', onClick: () => nav('/approvals?type=po') } } : undefined);
    if (fromInbox && (action === 'approve' || action === 'reject')) nav('/approvals?type=po');
    else q.reload();
    return r;
  });

  const canCreate = canProcure(role, 'po.create') && withPrices;
  const canApprove = canProcure(role, 'po.approve') && po.status === 'submitted';
  const canSend = canProcure(role, 'po.send') && po.status === 'approved';
  const canEdit = canCreate && PO_EDITABLE.includes(po.status);
  const canAmend = canCreate && PO_AMENDABLE.includes(po.status);
  const canDelivery = canProcure(role, 'po.delivery') && OPEN_PO.includes(po.status);
  const received = d.lines.some((l) => Number(l.qty_received) > 0);
  const canCancel = canProcure(role, 'po.send') && ['draft', 'submitted', 'approved', 'rejected', 'sent'].includes(po.status) && !received;
  const canClose = canProcure(role, 'po.send') && ['approved', 'sent', 'partially_received', 'received'].includes(po.status);
  const delayed = OPEN_PO.includes(po.status) && (po.delivery_status === 'delayed' || (!!(po.eta ?? po.expected_date) && (po.eta ?? po.expected_date)! < today()));
  const pctReceived = (() => {
    const tot = d.lines.reduce((s, l) => s + Number(l.qty), 0);
    return tot ? (100 * d.lines.reduce((s, l) => s + Math.min(Number(l.qty_accepted), Number(l.qty)), 0)) / tot : 0;
  })();
  const summary = () => poSummary(d, { company: auth.companyName, projectName: auth.project?.name ?? '', specLabel: L.spec, specUom: L.specUom, storeName: L.store(po.delivery_store_id), currency: cur, withPrices });

  const overflow = [
    { label: 'Share…', icon: <Share2 size={14} />, onClick: () => setDialog('share') },
    { label: 'Print / PDF (A4)', icon: <Printer size={14} />, onClick: () => window.print() },
    canAmend ? { label: 'Amend…', icon: <Pencil size={14} />, onClick: () => nav(`/procurement/po/${po.id}/edit?amend=1`) } : null,
    canDelivery && po.status === 'approved' ? { label: 'Delivery update…', icon: <Truck size={14} />, onClick: () => setDialog('delivery') } : null,
    canFlow(role, 'delivery.notify') && OPEN_PO.includes(po.status) ? { label: 'Notify store of delivery…', icon: <Truck size={14} />, onClick: () => setNotify(true) } : null,
    canClose ? { label: po.status === 'received' ? 'Close PO' : 'Short-close…', onClick: () => (po.status === 'received' ? void run(() => act('close')) : setDialog('close')) } : null,
    canCancel ? { label: 'Cancel PO…', danger: true, onClick: () => (po.status === 'draft' ? void run(() => act('cancel')) : setDialog('cancel')) } : null,
  ].filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <Page width="dash" title={po.number}
      titleExtra={<span className="badges"><PoBadge status={po.status} />{po.revision > 0 && <Badge tone="neutral" label={`Rev ${po.revision}`} icon={null} />}{OPEN_PO.includes(po.status) && <DeliveryBadge status={po.delivery_status} />}{delayed && <DelayedBadge />}</span>}
      breadcrumbs={[{ label: 'Procurement', to: '/procurement#pos' }, { label: po.number }]}
      subtitle={<>{d.supplier?.name ?? '?'} · deliver to {L.store(po.delivery_store_id)} · ordered {date(po.order_date)}{(po.eta ?? po.expected_date) && <> · expected {date(po.eta ?? po.expected_date)}</>}</>}
      actions={<>
        {canEdit && <button disabled={busy} onClick={() => nav(`/procurement/po/${po.id}/edit`)}><Pencil size={14} aria-hidden />Edit</button>}
        {canEdit && <button className="primary" disabled={busy} onClick={() => void run(() => act('submit'))}><Send size={14} aria-hidden />Submit for approval</button>}
        {canApprove && <button disabled={busy || !!po.approved_at} title={po.approved_at ? 'Amended POs cannot be rejected after first approval — cancel or amend instead' : undefined} onClick={() => setDialog('reject')}>Reject…</button>}
        {canApprove && <button className="primary" disabled={busy} onClick={() => void run(() => act('approve'))}><Check size={14} aria-hidden />Approve</button>}
        {canSend && <button className="primary" disabled={busy} onClick={() => setDialog('share')}><Send size={14} aria-hidden />Send to supplier…</button>}
        {canDelivery && po.status !== 'approved' && <button className="primary" disabled={busy} onClick={() => setDialog('delivery')}><Truck size={14} aria-hidden />Delivery update</button>}
        <Popover align="right" trigger={(p) => <button {...p} aria-label="More actions">⋯</button>}>
          {(close) => <Menu items={overflow.map((o) => ({ ...o, onClick: () => { close(); o.onClick(); } }))} />}
        </Popover>
      </>}>
      <div className="print-doc">
        <PrintHeader title={`Purchase order ${po.number}${po.revision ? ` · Rev ${po.revision}` : ''}`} />
        <ErrorBanner error={error} />
        {po.status === 'rejected' && po.status_reason === null && d.events[0]?.comment && <Banner tone="warn">Rejected: {d.events[0].comment}</Banner>}
        {po.status_reason && ['cancelled', 'closed'].includes(po.status) && <Banner tone="info">{humanize(po.status)}: {po.status_reason}</Banner>}
        {!withPrices && <Banner tone="info">Prices are restricted for your role — quantities only.</Banner>}
        <div className="print-only">
          <dl className="kv">
            <dt>Supplier</dt><dd>{d.supplier?.name}{d.supplier?.tin ? ` · TIN ${d.supplier.tin}` : ''}{d.supplier?.address ? ` · ${d.supplier.address}` : ''}{d.supplier?.phone ? ` · ${d.supplier.phone}` : ''}</dd>
            <dt>Deliver to</dt><dd>{L.store(po.delivery_store_id)} · {auth.project?.name}{auth.project?.location ? `, ${auth.project.location}` : ''}</dd>
            <dt>Order date</dt><dd>{date(po.order_date)}{po.expected_date ? ` · Expected ${date(po.eta ?? po.expected_date)}` : ''}</dd>
            {po.payment_terms && <><dt>Payment</dt><dd>{po.payment_terms}{po.advance_pct ? ` · advance ${num(po.advance_pct)}%` : ''}</dd></>}
            {po.delivery_terms && <><dt>Delivery terms</dt><dd>{po.delivery_terms}</dd></>}
          </dl>
        </div>
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Lines" flush sub={OPEN_PO.includes(po.status) || po.status === 'received' ? `${num(pctReceived, 1)}% received` : undefined}>
              <DataTable rows={d.lines} maxHeight="none" columns={[
                { key: 'line_no', label: '#', align: 'right', width: 36 },
                { key: 'spec', label: 'Material / grade', value: (l) => L.spec(l.material_spec_id), render: (l) => <>{L.spec(l.material_spec_id)}{l.mr_line_id && <div className="xs-text muted no-print">from request</div>}</> },
                { key: 'qty', label: 'Ordered', align: 'right', render: (l) => <>{qty(l.qty, l.uom || L.specUom(l.material_spec_id))}<span className="unit">{l.uom || L.specUom(l.material_spec_id)}</span></> },
                ...(withPrices ? [
                  { key: 'unit_price', label: 'Unit price', align: 'right' as const, value: (l: typeof d.lines[number]) => d.prices.get(l.id)?.unit_price, render: (l: typeof d.lines[number]) => <>{money(d.prices.get(l.id)?.unit_price, cur)}{d.prices.get(l.id)?.vat_applicable === false && <div className="xs-text muted">no VAT</div>}</> },
                  { key: 'amount', label: 'Amount', align: 'right' as const, value: (l: typeof d.lines[number]) => Number(l.qty) * Number(d.prices.get(l.id)?.unit_price ?? 0), render: (l: typeof d.lines[number]) => money(Number(l.qty) * Number(d.prices.get(l.id)?.unit_price ?? 0), cur) },
                ] : []),
                { key: 'qty_accepted', label: 'Received', align: 'right', render: (l) => <>{qty(l.qty_accepted, l.uom)}{Number(l.qty_rejected) > 0 && <div className="xs-text danger-text">{qty(l.qty_rejected, l.uom)} rejected</div>}</> },
                { key: 'outstanding', label: 'Outstanding', align: 'right', value: (l) => d.status.get(l.id)?.outstanding_qty, render: (l) => qty(d.status.get(l.id)?.outstanding_qty, l.uom) },
                { key: 'progress', label: 'Progress', noExport: true, render: (l) => <Bar pct={Number(l.qty) ? (100 * Math.min(Number(l.qty_accepted), Number(l.qty))) / Number(l.qty) : 0} /> },
                { key: 'expected_date', label: 'Expected', render: (l) => <>{date(d.status.get(l.id)?.expected_date ?? l.expected_date)}{d.status.get(l.id)?.is_delayed && <> <DelayedBadge /></>}</> },
              ]} />
            </Card>
            {withPrices && d.totals && (
              <Card title="Totals">
                <dl className="kv">
                  <dt>Subtotal</dt><dd className="right">{money(d.totals.subtotal, cur)}</dd>
                  <dt>VAT {num(d.totals.vat_rate)}%</dt><dd className="right">{money(d.totals.vat, cur)}</dd>
                  <dt className="strong">Total</dt><dd className="right strong">{money(d.totals.total, cur)}</dd>
                  <dt>Withholding {num(d.totals.withholding_rate)}%</dt><dd className="right">−{money(d.totals.withholding, cur)}</dd>
                  <dt className="strong">Net payable</dt><dd className="right strong">{money(d.totals.net_payable, cur)}</dd>
                </dl>
              </Card>
            )}
            <Card title="Receipts (GRN)" flush className="no-print">
              <DataTable rows={d.grns} maxHeight="none" empty="Nothing received against this PO yet." onRowClick={(g) => nav(`/store?open=${g.id}#grn`)} columns={[
                { key: 'number', label: 'GRN', id: true },
                { key: 'received_at', label: 'Received', render: (g) => dateTime(g.received_at) },
                { key: 'delivery_note_no', label: 'Delivery note' },
                { key: 'lines', label: 'Lines', align: 'right', value: (g) => g.grn_lines.filter((x) => x.po_line_id).length },
                { key: 'rejected', label: 'Rejected', align: 'right', value: (g) => g.grn_lines.reduce((s, x) => s + Number(x.qty_rejected), 0), render: (g) => num(g.grn_lines.reduce((s, x) => s + Number(x.qty_rejected), 0), 3) },
                { key: 'status', label: 'Status', render: (g) => <Badge value={g.status} /> },
              ]} />
            </Card>
          </div>
          <div className="side-panel no-print">
            <Card title="Details">
              <dl className="kv">
                <dt>Supplier</dt><dd>{d.supplier?.name}{d.supplier?.phone && <div className="small-text muted">{d.supplier.phone}</div>}</dd>
                <dt>TIN</dt><dd>{d.supplier?.tin || <span className="warn-text">Not on file</span>}</dd>
                <dt>Payment</dt><dd>{po.payment_terms || '—'}{po.advance_pct ? ` · ${num(po.advance_pct)}% advance` : ''}</dd>
                <dt>Delivery terms</dt><dd>{po.delivery_terms || '—'}</dd>
                {po.rfq_id && <><dt>RFQ</dt><dd><Link to={`/procurement/rfq/${po.rfq_id}`}>Open RFQ</Link></dd></>}
                <dt>Created</dt><dd>{L.person(po.created_by)} · {dateTime(po.created_at)}</dd>
                <dt>Submitted</dt><dd>{dateTime(po.submitted_at) || '—'}</dd>
                <dt>Approved</dt><dd>{po.approved_by ? `${L.person(po.approved_by)} · ${dateTime(po.approved_at)}` : '—'}</dd>
                <dt>Sent</dt><dd>{dateTime(po.sent_at) || '—'}</dd>
                {po.remarks && <><dt>Remarks</dt><dd>{po.remarks}</dd></>}
              </dl>
            </Card>
            <Card title="Delivery" actions={canDelivery ? <button className="small" onClick={() => setDialog('delivery')}>Update</button> : undefined}>
              <dl className="kv">
                <dt>Status</dt><dd><DeliveryBadge status={po.delivery_status} /></dd>
                <dt>ETA</dt><dd>{date(po.eta) || '—'}</dd>
              </dl>
              {d.deliveries.length > 0 && (
                <ul className="timeline mt-3">
                  {d.deliveries.map((u) => (
                    <li key={u.id}>
                      <div><strong>{DELIVERY_STATUS_LABELS[u.status]}</strong>{u.eta && <> · ETA {date(u.eta)}</>}</div>
                      <div className="t-meta">{L.person(u.created_by)} · <span title={dateTime(u.created_at)}>{since(u.created_at)}</span></div>
                      {u.note && <div className="t-comment">{u.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {withPrices && d.revisions.length > 0 && (
              <Card title="Revisions">
                <ul className="timeline">
                  {d.revisions.map((r) => {
                    const t = (r.snapshot as { totals?: { total?: number } } | null)?.totals;
                    return (
                      <li key={r.id}>
                        <div><strong>Rev {r.revision} → {r.revision + 1}</strong>{t?.total !== undefined && <span className="muted"> · was {money(t.total, cur)}</span>}</div>
                        <div className="t-meta">{L.person(r.created_by)} · {dateTime(r.created_at)}</div>
                        <div className="t-comment">{r.reason}</div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
            {withPrices && (
              <Card title="Documents" className="no-print" sub="Signed PO, supplier invoice / receipt, proforma, delivery notes">
                <Attachments entityType="purchase_order" entityId={po.id} canAdd={canProcure(role, 'po.create') || ['coordinator', 'manager', 'admin', 'finance'].includes(role ?? '')}
                  kinds={['invoice', 'delivery_note', 'proforma', 'signed_certificate', 'document', 'photo']} emptyText="No documents yet." />
              </Card>
            )}
            <Card title="Activity">
              {!d.events.length ? <Empty inline>No activity yet.</Empty> : (
                <ul className="timeline">
                  {d.events.map((e) => (
                    <li key={e.id}>
                      <div><strong>{humanize(e.action)}</strong>{e.to_status && e.to_status !== e.from_status && <> → {PO_STATUS_LABELS[e.to_status] ?? e.to_status}</>}</div>
                      <div className="t-meta">{L.person(e.actor) || 'system'} · <span title={dateTime(e.created_at)}>{since(e.created_at)}</span></div>
                      {e.comment && <div className="t-comment">{e.comment}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
        <Signatures />
      </div>

      {dialog === 'reject' && <ReasonModal title={`Reject ${po.number}`} danger confirm="Reject PO" onClose={() => setDialog(null)} onSubmit={(c) => act('reject', c).then(() => undefined)} />}
      {dialog === 'cancel' && <ReasonModal title={`Cancel ${po.number}`} danger confirm="Cancel PO" onClose={() => setDialog(null)} onSubmit={(c) => act('cancel', c).then(() => undefined)} />}
      {dialog === 'close' && <ReasonModal title={`Short-close ${po.number}`} label="Reason (outstanding quantities will not be delivered)" confirm="Close PO" onClose={() => setDialog(null)} onSubmit={(c) => act('close', c).then(() => undefined)} />}
      {dialog === 'delivery' && <DeliveryModal poId={po.id} number={po.number} current={po.delivery_status} eta={po.eta ?? po.expected_date} onClose={() => { setDialog(null); q.reload(); }} />}
      {dialog === 'share' && <ShareModal text={summary()} phone={d.supplier?.phone} number={po.number} canSend={canSend}
        onSent={() => run(() => act('send')).then(() => setDialog(null))} onClose={() => setDialog(null)} />}
      {notify && <NotifyDeliveryModal poId={po.id} poNumber={po.number} L={L} onClose={() => setNotify(false)} onDone={() => q.reload()} />}
    </Page>
  );
}

function DeliveryModal({ poId, number, current, eta, onClose }: { poId: string; number: string; current: DeliveryStatus; eta: string | null; onClose: () => void }) {
  const [status, setStatus] = useState<DeliveryStatus>(current === 'pending' ? 'confirmed' : current);
  const [newEta, setEta] = useState(eta ?? '');
  const [note, setNote] = useState('');
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (status === 'delayed' && !note.trim() && !newEta) throw new Error('Give a new ETA or a note for a delay');
    await procRpc('update_po_delivery', { id: crypto.randomUUID(), po_id: poId, status, eta: newEta || undefined, note: note.trim() || undefined });
    toast.success(`${number}: ${DELIVERY_STATUS_LABELS[status]} — requester and store notified`);
    onClose();
  });
  return (
    <Modal title={`Delivery update · ${number}`} onClose={onClose} footer={<><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Save update</button></>}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value as DeliveryStatus)} data-autofocus>
            {(['pending', 'confirmed', 'dispatched', 'delayed', 'delivered'] as DeliveryStatus[]).map((s) => <option key={s} value={s}>{DELIVERY_STATUS_LABELS[s]}</option>)}
          </select>
        </Field>
        <Field label="ETA"><input type="date" value={newEta} onChange={(e) => setEta(e.target.value)} /></Field>
        <Field label="Note" required={status === 'delayed' && !newEta}><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. truck loaded, arriving tomorrow morning" /></Field>
      </div>
    </Modal>
  );
}

function ShareModal({ text, phone, number, canSend, onSent, onClose }: { text: string; phone?: string | null; number: string; canSend: boolean; onSent: () => Promise<unknown>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const copy = () => void copyText(text).then(() => toast.success('PO summary copied'));
  return (
    <Modal size="md" title={`Share ${number}`} subtitle="Send the summary by Telegram / WhatsApp and attach the printed PDF." onClose={onClose}
      footer={<>
        <button onClick={onClose}>Close</button>
        {canSend && <button className="primary" disabled={busy} onClick={() => { setBusy(true); void onSent().finally(() => setBusy(false)); }}>{busy && <span className="spinner" />}Mark as sent to supplier</button>}
      </>}>
      <div className="stack tight">
        <textarea readOnly rows={12} value={text} aria-label="PO summary" style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--fs-sm)' }} />
        <div className="row">
          <button onClick={copy}><Copy size={14} aria-hidden />Copy text</button>
          <button onClick={() => window.open(telegramShare(text), '_blank', 'noopener')}><Send size={14} aria-hidden />Telegram</button>
          <button onClick={() => window.open(whatsappShare(text, phone), '_blank', 'noopener')}><Share2 size={14} aria-hidden />WhatsApp</button>
          <button onClick={() => { onClose(); setTimeout(() => window.print(), 50); }}><FileDown size={14} aria-hidden />Download PDF</button>
        </div>
        <p className="muted small-text mb-0">"Download PDF" opens the print dialog — choose <strong>Save as PDF</strong>. The A4 layout includes the company header, totals and signature blocks.</p>
      </div>
    </Modal>
  );
}
