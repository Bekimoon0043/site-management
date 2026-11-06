import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { PlanQueueRow } from '../../lib/approvals';
import { check, supabase } from '../../lib/supabase';
import { useAsync } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import type { PettyClaim, SupplierInvoice } from '../../lib/contract-finance';
import { ErrorBanner, Loading } from '../Page';
import { Banner } from '../ui';
import { PaymentStatusBadge } from '../payments/PaymentActions';
import { etb } from '../payments/data';
import { FinanceActions } from '../finance/FinanceActions';
import { loadInvoiceLines } from '../finance/data';

export function FinanceDocPreview({ row, onDone, onActions }: {
  row: PlanQueueRow; onDone: (msg: string) => void; onActions: (a: object) => void;
}) {
  const invoice = row.entity_type === 'supplier_invoice';
  const q = useAsync(async () => {
    if (invoice) {
      const inv = check(await supabase.from('v_supplier_invoices').select('*').eq('id', row.entity_id).maybeSingle()) as SupplierInvoice | null;
      if (!inv) throw new Error('Supplier invoice not found or not visible to your role');
      return { inv, lines: await loadInvoiceLines(inv.id) };
    }
    const claim = check(await supabase.from('petty_cash_claims').select('*').eq('id', row.entity_id).maybeSingle()) as PettyClaim | null;
    if (!claim) throw new Error('Petty cash claim not found or not visible to your role');
    return { claim };
  }, [row.entity_id, invoice, row.status], { key: 'finance-doc-preview' });
  useEffect(() => { onActions({}); });
  if (!q.data) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  const done = () => onDone(`${row.number} done`);

  if (q.data.inv) {
    const inv = q.data.inv;
    return (
      <>
        <div className="inbox-preview-head">
          <h2>{inv.number} <PaymentStatusBadge status={inv.status} /></h2>
          <div className="meta">Supplier invoice · {inv.supplier_name} · PO {inv.po_number} · <Link to="/payments/invoices">Open supplier invoices</Link></div>
        </div>
        <div className="inbox-preview-body stack">
          {inv.match_status === 'variance' && <Banner tone="warn"><b>PO–receipt–invoice variance.</b> {inv.match_notes.join(' ')}</Banner>}
          <dl className="pay-summary">
            <dt>Supplier invoice</dt><dd>{inv.invoice_no} · {date(inv.invoice_date)}</dd>
            <dt>Due</dt><dd>{date(inv.due_date)}</dd>
            <dt>Subtotal</dt><dd>{etb(inv.subtotal)}</dd>
            <dt>VAT</dt><dd>+ {etb(inv.vat)}</dd>
            <dt>Withholding ({num(inv.withholding_rate, 0)} %)</dt><dd className="minus">− {etb(inv.withholding)}</dd>
            <dt className="total">Net payable</dt><dd className="total">{etb(inv.net_payable)}</dd>
          </dl>
          <FinanceActions docType="supplier_invoice" id={inv.id} number={inv.number} status={inv.status} preparedBy={inv.prepared_by}
            checkedBy={inv.checked_by} net={Number(inv.net_payable)} variance={inv.match_status === 'variance'} onDone={done} />
        </div>
      </>
    );
  }

  const claim = q.data.claim!;
  return (
    <>
      <div className="inbox-preview-head">
        <h2>{claim.number} <PaymentStatusBadge status={claim.status} /></h2>
        <div className="meta">Petty cash replenishment · {claim.entries} receipts · <Link to="/payments/petty-cash">Open petty cash</Link></div>
      </div>
      <div className="inbox-preview-body stack">
        {claim.return_comment && <Banner tone="warn">{claim.return_comment}</Banner>}
        <dl className="pay-summary"><dt>Receipts</dt><dd>{claim.entries}</dd><dt className="total">Replenishment</dt><dd className="total">{etb(claim.total)}</dd></dl>
        <FinanceActions docType="petty_cash" id={claim.id} number={claim.number} status={claim.status} preparedBy={claim.prepared_by}
          checkedBy={claim.checked_by} net={Number(claim.total)} onDone={done} />
      </div>
    </>
  );
}
