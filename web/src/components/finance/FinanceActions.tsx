// Approval chain buttons for a supplier invoice or petty cash claim (finance_doc_action).
import { useState } from 'react';
import { Check, CircleDollarSign, Send, Undo2, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import type { FinanceDocStatus, FinanceDocType } from '../../lib/contract-finance';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../../lib/contract-payments';
import { Field, Modal, ReasonModal, ErrorBanner, toast, useBusy } from '../ui';
import { etb } from '../payments/data';
import { canFin, finRpc } from './data';

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function FinanceActions({ docType, id, number, status, preparedBy, checkedBy, net, variance, onDone }: {
  docType: FinanceDocType; id: string; number: string; status: FinanceDocStatus; preparedBy: string | null; checkedBy: string | null;
  net: number; variance?: boolean; onDone?: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const me = auth.profile?.id;
  const admin = role === 'admin';
  const { busy, error, run } = useBusy();
  const [dlg, setDlg] = useState<'return' | 'reject' | 'pay' | 'override' | null>(null);
  const act = (action: 'submit' | 'check' | 'approve', msg: string, comment?: string) => run(async () => {
    await finRpc('finance_doc_action', { doc_type: docType, id, action, comment });
    toast.success(`${number} ${msg}`);
    onDone?.();
  });
  const priceOk = docType === 'petty_cash' || auth.canSeePrices;
  const canSubmit = docType === 'supplier_invoice' && priceOk && (status === 'draft' || status === 'returned') && canFin(role, 'invoicePrepare');
  const canCheck = priceOk && status === 'submitted' && canFin(role, 'check') && (preparedBy !== me || admin);
  const canApprove = priceOk && status === 'checked' && canFin(role, 'approve') && ((preparedBy !== me && checkedBy !== me) || admin);
  const canPayIt = priceOk && status === 'approved' && canFin(role, 'pay');
  const canReturn = priceOk && ((status === 'submitted' && (canFin(role, 'check') || role === 'manager')) || (status === 'checked' && canFin(role, 'approve')));
  if (!canSubmit && !canCheck && !canApprove && !canPayIt && !canReturn) return null;
  return (
    <div className="stack tight no-print">
      <ErrorBanner error={error} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {canSubmit && <button className="primary" disabled={busy} onClick={() => void act('submit', 'submitted for checking')}><Send size={14} aria-hidden />Submit for checking</button>}
        {canCheck && <button className="primary" disabled={busy} onClick={() => void act('check', 'checked — sent to the manager')}><Check size={14} aria-hidden />Checked — send for approval</button>}
        {canApprove && <button className="primary" disabled={busy} onClick={() => (variance ? setDlg('override') : void act('approve', 'approved — sent to finance'))}>
          <Check size={14} aria-hidden />{variance ? 'Approve despite variance…' : 'Approve for payment'}</button>}
        {canPayIt && <button className="primary" disabled={busy} onClick={() => setDlg('pay')}><CircleDollarSign size={14} aria-hidden />Record payment ({etb(net)} ETB)</button>}
        {canReturn && <button disabled={busy} onClick={() => setDlg('return')}><Undo2 size={14} aria-hidden />Return for correction</button>}
        {canReturn && <button className="danger" disabled={busy} onClick={() => setDlg('reject')}><X size={14} aria-hidden />Reject</button>}
      </div>
      {(dlg === 'return' || dlg === 'reject') && (
        <ReasonModal title={`${dlg === 'return' ? 'Return' : 'Reject'} ${number}`} label={dlg === 'return' ? 'What must be corrected?' : 'Why is it rejected?'}
          confirm={dlg === 'return' ? 'Return' : 'Reject'} danger={dlg === 'reject'} onClose={() => setDlg(null)}
          onSubmit={async (comment) => { await finRpc('finance_doc_action', { doc_type: docType, id, action: dlg, comment }); toast.success(`${number} ${dlg === 'return' ? 'returned' : 'rejected'}`); onDone?.(); }} />
      )}
      {dlg === 'override' && (
        <ReasonModal title={`Approve ${number} despite the 3-way match variance`} label="Why is it approved anyway? (kept on the invoice)" confirm="Approve"
          onClose={() => setDlg(null)} onSubmit={async (comment) => { await finRpc('finance_doc_action', { doc_type: docType, id, action: 'approve', comment }); toast.success(`${number} approved — sent to finance`); onDone?.(); }} />
      )}
      {dlg === 'pay' && <PayModal docType={docType} id={id} number={number} net={net} onClose={() => setDlg(null)} onDone={onDone} />}
    </div>
  );
}

function PayModal({ docType, id, number, net, onClose, onDone }: { docType: FinanceDocType; id: string; number: string; net: number; onClose: () => void; onDone?: () => void }) {
  const [method, setMethod] = useState<PaymentMethod>(docType === 'petty_cash' ? 'cash' : 'bank_transfer');
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(today());
  const { busy, error, run } = useBusy();
  const go = () => void run(async () => {
    await finRpc('finance_doc_action', { doc_type: docType, id, action: 'pay', payment_method: method, payment_ref: ref.trim() || undefined, payment_date: date });
    toast.success(`${number} paid`);
    onClose();
    onDone?.();
  });
  return (
    <Modal title={`Payment voucher — ${number}`} subtitle={`Net payable ${etb(net)} ETB`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || (method !== 'cash' && !ref.trim())} onClick={go}>{busy && <span className="spinner" />}Record payment</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Paid by"><select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</select></Field>
        <Field label={method === 'cash' ? 'Reference (optional)' : 'Transfer / cheque no.'} required={method !== 'cash'}><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label="Payment date"><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
