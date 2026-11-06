import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PoQueueRow } from '../../lib/approvals';
import { loadPoDetail, procRpc } from '../../lib/procurement';
import { date, dateTime, hoursSince, money, num } from '../../lib/format';
import { Badge, Banner, DataTable, ErrorBanner, Loading, useBusy } from '../ui';
import { PoBadge } from './badges';

interface Props { row: PoQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }

/** Approvals inbox panel for a submitted purchase order (po_action approve / reject). */
export function PoPreview({ row, L, onDone, onActions }: Props) {
  const auth = useAuth();
  const q = useAsync(() => loadPoDetail(row.id, auth.canSeePrices), [row.id, auth.canSeePrices], { key: 'po-detail' });
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const amended = !!row.approved_at;
  const decide = (approve: boolean) => {
    if (!approve && (amended || !comment.trim())) { commentRef.current?.focus(); return; }
    void run(async () => {
      await procRpc('po_action', { po_id: row.id, action: approve ? 'approve' : 'reject', comment: comment.trim() || undefined });
      onDone(`${row.number} ${approve ? 'approved' : 'rejected'}`);
    });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });

  const d = q.data;
  const cur = d?.totals?.currency ?? auth.project?.currency ?? 'ETB';
  const waiting = hoursSince(row.submitted_at ?? row.created_at);
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/procurement/po/${row.id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link><PoBadge status={row.status} />{row.revision > 0 && <Badge tone="neutral" label={`Rev ${row.revision}`} icon={null} />}</h2>
          <div className="meta">{row.suppliers?.name ?? '?'} · deliver to {L.store(row.delivery_store_id)} · ordered {date(row.order_date)}{row.expected_date ? ` · expected ${date(row.expected_date)}` : ''} · by {L.person(row.created_by)} · <span className={waiting > 48 ? 'danger-text' : ''}>waiting {num(waiting, 0)} h</span></div>
        </div>
        <ErrorBanner error={q.error ?? error} />
        {amended && <Banner tone="attention">Amended after approval (revision {row.revision}) — the value increased. It can be approved, or cancelled/amended again from the PO page.</Banner>}
        {!d ? <Loading lines={5} /> : (
          <>
            {auth.canSeePrices && d.totals && (
              <div className="summary-strip">
                <span className="s">Subtotal <strong>{money(d.totals.subtotal, cur)}</strong></span>
                <span className="s">VAT {num(d.totals.vat_rate)}% <strong>{money(d.totals.vat, cur)}</strong></span>
                <span className="s">Total <strong>{money(d.totals.total, cur)}</strong></span>
                <span className="s">Net payable <strong>{money(d.totals.net_payable, cur)}</strong></span>
              </div>
            )}
            <DataTable rows={d.lines} maxHeight="none" columns={[
              { key: 'line_no', label: '#', align: 'right', width: 32 },
              { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
              { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{num(l.qty, 3)}<span className="unit">{l.uom || L.specUom(l.material_spec_id)}</span></> },
              ...(auth.canSeePrices ? [
                { key: 'price', label: 'Unit price', align: 'right' as const, render: (l: typeof d.lines[number]) => money(d.prices.get(l.id)?.unit_price, cur) },
                { key: 'amount', label: 'Amount', align: 'right' as const, render: (l: typeof d.lines[number]) => money(Number(l.qty) * Number(d.prices.get(l.id)?.unit_price ?? 0), cur) },
              ] : []),
              { key: 'mr', label: 'Request', value: (l) => (l.mr_line_id ? 'Linked' : '') },
            ]} />
            <dl className="kv">
              <dt>Supplier TIN</dt><dd>{d.supplier?.tin || <span className="warn-text">Not on file (higher withholding)</span>}</dd>
              <dt>Payment</dt><dd>{d.po.payment_terms || '—'}{d.po.advance_pct ? ` · ${num(d.po.advance_pct)}% advance` : ''}</dd>
              {d.po.remarks && <><dt>Remarks</dt><dd>{d.po.remarks}</dd></>}
              {d.po.rfq_id && <><dt>RFQ</dt><dd><Link to={`/procurement/rfq/${d.po.rfq_id}`}>Comparison & award</Link></dd></>}
              <dt>Submitted</dt><dd>{dateTime(row.submitted_at)}</dd>
            </dl>
          </>
        )}
      </div>
      <div className="action-bar">
        <textarea ref={commentRef} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={amended ? 'Comment (optional)' : 'Comment (required to reject)'} aria-label="Comment" />
        <button disabled={busy || amended} title={amended ? 'Amended POs cannot be rejected after first approval' : undefined} onClick={() => decide(false)}>Reject<kbd style={{ marginLeft: 4 }}>R</kbd></button>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}Approve<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}
