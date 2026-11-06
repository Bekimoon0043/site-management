// Approvals inbox: a subcontractor certificate or labour payroll waiting for this user (v_my_approvals kind 'payment').
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, type Lookups } from '../../lib/hooks';
import { date, dateTime, num } from '../../lib/format';
import type { PlanQueueRow } from '../../lib/approvals';
import { ErrorBanner, Loading } from '../Page';
import { PaymentActions, PaymentHistory, PaymentStatusBadge } from './PaymentActions';
import { etb, loadCertificate, loadPayroll } from './data';
import './payments.css';

export function PaymentPreview({ row, L, onDone, onActions }: { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: object) => void }) {
  const isPayroll = row.entity_type === 'payroll';
  const q = useAsync(async () => (isPayroll ? { p: await loadPayroll(row.entity_id) } : { c: await loadCertificate(row.entity_id) }), [row.entity_id, isPayroll], { key: 'payment-preview' });
  useEffect(() => { onActions({}); });
  if (!q.data) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  const link = isPayroll ? `/payments/payroll/${row.entity_id}` : `/payments/certificates/${row.entity_id}`;
  const done = () => onDone(`${row.number} done`);
  if (q.data.p) {
    const { pr, piece, events } = q.data.p;
    return (
      <>
        <div className="inbox-preview-head">
          <h2>{pr.number} <PaymentStatusBadge status={pr.status} /></h2>
          <div className="meta">Labour payroll · {date(pr.period_from)} → {date(pr.period_to)} · by {L.person(pr.prepared_by)} · {dateTime(row.requested_at)} · <Link to={link}>Open payroll</Link></div>
        </div>
        <div className="inbox-preview-body stack">
          <dl className="pay-summary">
            <dt>Workers</dt><dd>{pr.workers}</dd><dt>Man-days</dt><dd>{num(pr.days, 1)}</dd>
            {piece.length > 0 && <><dt>Piece-work lines (verified)</dt><dd>{piece.filter((x) => x.qty_verified != null).length} / {piece.length}</dd></>}
            <dt>Gross</dt><dd>{etb(pr.gross)}</dd><dt>Tax ({num(pr.tax_pct, 0)} %)</dt><dd className="minus">− {etb(pr.tax)}</dd>
            <dt>Deductions</dt><dd className="minus">− {etb(pr.deductions)}</dd><dt className="total">Net pay</dt><dd className="total">{etb(pr.net)}</dd>
          </dl>
          <PaymentActions docType="payroll" id={pr.id} number={pr.number} status={pr.status} preparedBy={pr.prepared_by} checkedBy={pr.checked_by} net={Number(pr.net)} onDone={done} />
          <PaymentHistory events={events} L={L} />
        </div>
      </>
    );
  }
  const { c, sc, events } = q.data.c!;
  return (
    <>
      <div className="inbox-preview-head">
        <h2>{c.number} <PaymentStatusBadge status={c.status} /></h2>
        <div className="meta">{sc.subcontractor_name} · {date(c.period_from)} → {date(c.period_to)}{c.is_final ? ' · final' : ''} · by {L.person(c.prepared_by)} · <Link to={link}>Open certificate</Link></div>
      </div>
      <div className="inbox-preview-body stack">
        <dl className="pay-summary">
          <dt>Work this period</dt><dd>{etb(c.gross_this)}</dd><dt>VAT</dt><dd>+ {etb(c.vat_this)}</dd>
          <dt>Retention</dt><dd className="minus">− {etb(c.retention_this)}</dd>
          {Number(c.retention_release) > 0 && <><dt>Retention released</dt><dd>+ {etb(c.retention_release)}</dd></>}
          {Number(c.advance_recovery_this) > 0 && <><dt>Advance recovery</dt><dd className="minus">− {etb(c.advance_recovery_this)}</dd></>}
          {Number(c.material_deduction) + Number(c.penalty) + Number(c.other_deduction) > 0 && <><dt>Other deductions</dt><dd className="minus">− {etb(Number(c.material_deduction) + Number(c.penalty) + Number(c.other_deduction))}</dd></>}
          <dt>WHT {num(c.wht_pct, 0)} %</dt><dd className="minus">− {etb(c.wht_this)}</dd>
          <dt className="total">Net payable</dt><dd className="total">{etb(c.net_payable)}</dd>
        </dl>
        <p className="small-text muted mb-0">Certified to date {etb(c.gross_to_date)} of contract {etb(sc.contract_value)}.</p>
        <PaymentActions docType="sc_certificate" id={c.id} number={c.number} status={c.status} preparedBy={c.prepared_by} checkedBy={c.checked_by} net={Number(c.net_payable)} onDone={done} />
        <PaymentHistory events={events} L={L} />
      </div>
    </>
  );
}
