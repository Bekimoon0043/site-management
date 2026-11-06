// Approval chain buttons for a payment document (certificate / payroll) + its history and status badge.
import { useState } from 'react';
import { Check, CircleDollarSign, Send, Undo2, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import type { Lookups } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import {
  PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, canPay, type PaymentDocType, type PaymentEvent, type PaymentMethod, type PaymentStatus,
} from '../../lib/contract-payments';
import { Badge } from '../Badge';
import { Modal, ReasonModal } from '../Dialog';
import { ErrorBanner } from '../Page';
import { Field, useBusy } from '../Form';
import { toast } from '../toast';
import { etb, payRpc } from './data';

const TONE: Record<PaymentStatus, 'neutral' | 'info' | 'primary' | 'violet' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral', submitted: 'info', checked: 'primary', approved: 'violet', paid: 'success', returned: 'warning', rejected: 'danger',
};
export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={TONE[status]} label={PAYMENT_STATUS_LABELS[status]} icon={null} />;
}

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function PaymentActions({ docType, id, number, status, preparedBy, checkedBy, net, blocked, onDone }: {
  docType: PaymentDocType; id: string; number: string; status: PaymentStatus; preparedBy: string | null; checkedBy: string | null; net: number;
  /** Why the submit button is disabled (e.g. piece-work not verified). */
  blocked?: string | null; onDone?: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const me = auth.profile?.id;
  const admin = role === 'admin';
  const { busy, error, run } = useBusy();
  const [dlg, setDlg] = useState<'return' | 'reject' | 'pay' | null>(null);
  const act = (action: 'submit' | 'check' | 'approve', msg: string) => void run(async () => {
    await payRpc('payment_action', { doc_type: docType, id, action });
    toast.success(`${number} ${msg}`);
    onDone?.();
  });
  const canSubmit = (status === 'draft' || status === 'returned') && canPay(role, 'payment.prepare');
  const canCheck = status === 'submitted' && canPay(role, 'payment.check') && (preparedBy !== me || admin);
  const canApprove = status === 'checked' && canPay(role, 'payment.approve') && ((preparedBy !== me && checkedBy !== me) || admin);
  const canPayIt = status === 'approved' && canPay(role, 'payment.pay');
  const canReturn = (status === 'submitted' && canPay(role, 'payment.check')) || (status === 'checked' && canPay(role, 'payment.approve'))
    || (status === 'submitted' && role === 'manager');
  if (!canSubmit && !canCheck && !canApprove && !canPayIt && !canReturn) {
    return status === 'submitted' && preparedBy === me && role === 'coordinator'
      ? <p className="small-text muted mb-0">You prepared {number}; another coordinator (or the admin) checks it.</p> : null;
  }
  return (
    <div className="stack tight no-print">
      <ErrorBanner error={error} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {canSubmit && <button className="primary" disabled={busy || !!blocked} title={blocked ?? undefined} onClick={() => act('submit', 'submitted for checking')}><Send size={14} aria-hidden />Submit for checking</button>}
        {canCheck && <button className="primary" disabled={busy} onClick={() => act('check', 'checked — sent to the manager')}><Check size={14} aria-hidden />Checked — send for approval</button>}
        {canApprove && <button className="primary" disabled={busy} onClick={() => act('approve', 'approved — sent to finance')}><Check size={14} aria-hidden />Approve for payment</button>}
        {canPayIt && <button className="primary" disabled={busy} onClick={() => setDlg('pay')}><CircleDollarSign size={14} aria-hidden />Record payment ({etb(net)} ETB)</button>}
        {canReturn && <button disabled={busy} onClick={() => setDlg('return')}><Undo2 size={14} aria-hidden />Return for correction</button>}
        {canReturn && <button className="danger" disabled={busy} onClick={() => setDlg('reject')}><X size={14} aria-hidden />Reject</button>}
        {blocked && canSubmit && <span className="small-text warn-text">{blocked}</span>}
      </div>
      {(dlg === 'return' || dlg === 'reject') && (
        <ReasonModal title={`${dlg === 'return' ? 'Return' : 'Reject'} ${number}`} label={dlg === 'return' ? 'What must be corrected?' : 'Why is it rejected?'}
          confirm={dlg === 'return' ? 'Return' : 'Reject'} danger={dlg === 'reject'} onClose={() => setDlg(null)}
          onSubmit={async (comment) => { await payRpc('payment_action', { doc_type: docType, id, action: dlg, comment }); toast.success(`${number} ${dlg === 'return' ? 'returned' : 'rejected'}`); onDone?.(); }} />
      )}
      {dlg === 'pay' && <PayModal docType={docType} id={id} number={number} net={net} onClose={() => setDlg(null)} onDone={onDone} />}
    </div>
  );
}

function PayModal({ docType, id, number, net, onClose, onDone }: { docType: PaymentDocType; id: string; number: string; net: number; onClose: () => void; onDone?: () => void }) {
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(today());
  const { busy, error, run } = useBusy();
  const go = () => void run(async () => {
    await payRpc('payment_action', { doc_type: docType, id, action: 'pay', payment_method: method, payment_ref: ref.trim() || undefined, payment_date: date });
    toast.success(`${number} paid`);
    onClose(); onDone?.();
  });
  return (
    <Modal title={`Payment voucher — ${number}`} subtitle={`Net payable ${etb(net)} ETB`} onClose={onClose} footer={
      <><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !date || (method !== 'cash' && !ref.trim())} onClick={go}>{busy && <span className="spinner" />}Record payment</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Paid by"><select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {Object.entries(PAYMENT_METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Payment date" required><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={method === 'cheque' ? 'Cheque number' : method === 'cash' ? 'Receipt / voucher no. (optional)' : 'Transfer reference'} required={method !== 'cash'} wide>
          <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder={method === 'cheque' ? 'CHQ 004512' : 'CBE-TRF-…'} />
        </Field>
      </div>
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  prepare: 'Prepared', submit: 'Submitted', check: 'Checked', approve: 'Approved', pay: 'Paid', return: 'Returned', reject: 'Rejected', verify_quantities: 'Quantities verified',
};
export function PaymentHistory({ events, L }: { events: PaymentEvent[]; L: Lookups }) {
  if (!events.length) return <p className="muted small-text mb-0">No history yet.</p>;
  return (
    <ul className="hist">
      {events.map((e) => (
        <li key={e.id}><b>{ACTION_LABEL[e.action] ?? e.action}</b> · {L.person(e.actor)} · <span className="muted">{dateTime(e.created_at)}</span>
          {e.comment && <div className="small-text">“{e.comment}”</div>}</li>
      ))}
    </ul>
  );
}
