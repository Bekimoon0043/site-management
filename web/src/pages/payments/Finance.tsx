// /payments/finance — finance officer's queue: approved certificates / payrolls to pay (payment voucher), the payment
// register (all documents, filterable, exportable) and subcontractor statements.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date } from '../../lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, canPay, type PaymentRegisterRow, type PaymentStatus, type SubcontractRow } from '../../lib/contract-payments';
import { Card, DataTable, Empty, ErrorBanner, FilterBar, FilterSelect, Kpi, Page, Tabs, useHashTab } from '../../components/ui';
import { PaymentActions, PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb, loadRegister, loadSubcontracts } from '../../components/payments/data';
import '../../components/payments/payments.css';
import { CashFlow } from '../../components/finance/CashFlow';
import { TaxReport } from '../../components/finance/TaxReport';
import { canFin } from '../../components/finance/data';

const TABS = ['to-pay', 'register', 'statements', 'cash-flow', 'tax'] as const;
const docLink = (r: Pick<PaymentRegisterRow, 'doc_type' | 'id'>) => (r.doc_type === 'payroll' ? `/payments/payroll/${r.id}` : `/payments/certificates/${r.id}`);

export function Finance() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const [tab, setTab] = useHashTab(TABS, 'to-pay');
  const q = useAsync(() => loadRegister(projectId), [projectId], { key: 'payment-register' });
  const sq = useAsync(() => loadSubcontracts(projectId), [projectId], { key: 'subcontracts' });
  const [st, setSt] = useState('');
  if (!canPay(auth.profile?.role, 'payment.view')) return <Page title="Finance"><Empty title="No access" /></Page>;
  const rows = q.data ?? [];
  const toPay = rows.filter((r) => r.status === 'approved');
  const month = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
  const paidMonth = rows.filter((r) => r.status === 'paid' && (r.payment_date ?? '').startsWith(month));
  const sum = (xs: PaymentRegisterRow[]) => xs.reduce((s, r) => s + Number(r.net), 0);
  const inFlow = rows.filter((r) => r.status === 'submitted' || r.status === 'checked');
  const L = lk.data;
  const reports = canFin(auth.profile?.role, 'reports') && auth.canSeePrices;
  return (
    <Page title="Finance" subtitle="Approved payments to pay, the payment register and subcontractor statements">
      <div className="kpis">
        <Kpi label="To pay" value={etb(sum(toPay))} unit="ETB" hint={`${toPay.length} approved document${toPay.length === 1 ? '' : 's'}`} />
        <Kpi label="In approval" value={etb(sum(inFlow))} unit="ETB" hint={`${inFlow.length} being checked / approved`} />
        <Kpi label="Paid this month" value={etb(sum(paidMonth))} unit="ETB" hint={`${paidMonth.length} payment${paidMonth.length === 1 ? '' : 's'}`} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'to-pay', label: 'To pay', count: toPay.length, hot: toPay.length > 0 }, { key: 'register', label: 'Payment register' }, { key: 'statements', label: 'Subcontractor statements' },
        ...(reports ? [{ key: 'cash-flow' as const, label: 'Cash flow' }, { key: 'tax' as const, label: 'Tax report' }] : [])]} />
      <ErrorBanner error={q.error ?? sq.error} onRetry={q.reload} />
      <div className="mt-3 stack">
        {tab === 'to-pay' && <p className="small-text muted mb-0">Supplier invoices and petty cash claims are paid from <Link to="/payments/invoices">Supplier invoices</Link> and <Link to="/payments/petty-cash">Petty cash</Link> (also in your Approvals inbox).</p>}
        {tab === 'to-pay' && (!toPay.length ? <Empty title="Nothing to pay">Certificates and payrolls appear here once the manager approves them.</Empty> : toPay.map((r) => (
          <Card key={r.id} title={<Link to={docLink(r)}>{r.number}</Link>} sub={`${r.party} · ${date(r.period_from)} → ${date(r.period_to)} · approved ${date(r.approved_at)} by ${L?.person(r.approved_by) ?? ''}`}>
            <dl className="pay-summary">
              <dt>Gross</dt><dd>{etb(r.gross)}</dd>{Number(r.vat) > 0 && <><dt>VAT</dt><dd>+ {etb(r.vat)}</dd></>}
              <dt>Deductions</dt><dd className="minus">− {etb(r.deductions)}</dd><dt>Tax withheld</dt><dd className="minus">− {etb(r.tax)}</dd>
              <dt className="total">Net to pay</dt><dd className="total">{etb(r.net)}</dd>
            </dl>
            <div className="mt-2"><PaymentActions docType={r.doc_type} id={r.id} number={r.number} status={r.status} preparedBy={r.prepared_by} checkedBy={r.checked_by} net={Number(r.net)} onDone={q.reload} /></div>
          </Card>
        )))}
        {tab === 'register' && (
          <Card flush>
            <div className="pad" style={{ paddingBottom: 0 }}>
              <FilterBar><FilterSelect label="Status" value={st} onChange={setSt} options={(Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatus[]).map((k) => ({ value: k, label: PAYMENT_STATUS_LABELS[k] }))} /></FilterBar>
            </div>
            <DataTable rows={rows.filter((r) => !st || r.status === st)} rowKey={(r: PaymentRegisterRow) => r.id} loading={!q.data} exportName="payment-register"
              empty={{ title: 'No payment documents yet' }}
              columns={[
                { key: 'number', label: 'Document', id: true, render: (r) => <Link to={docLink(r)}>{r.number}</Link> },
                { key: 'type', label: 'Type', value: (r) => (r.doc_type === 'payroll' ? 'Labour payroll' : 'Subcontractor certificate') },
                { key: 'party', label: 'Payee' },
                { key: 'period', label: 'Period', value: (r) => r.period_to, render: (r) => `${date(r.period_from)} → ${date(r.period_to)}` },
                { key: 'gross', label: 'Gross', align: 'right', render: (r) => etb(r.gross) },
                { key: 'tax', label: 'Tax withheld', align: 'right', render: (r) => etb(r.tax) },
                { key: 'net', label: 'Net', align: 'right', render: (r) => <b>{etb(r.net)}</b> },
                { key: 'status', label: 'Status', render: (r) => <PaymentStatusBadge status={r.status} /> },
                { key: 'paid', label: 'Paid', value: (r) => r.payment_date ?? '', render: (r) => (r.payment_date ? `${date(r.payment_date)} · ${r.payment_method ? PAYMENT_METHOD_LABELS[r.payment_method] : ''}${r.payment_ref ? ` ${r.payment_ref}` : ''}` : '—') },
              ]} />
          </Card>
        )}
        {tab === 'statements' && <Statements rows={sq.data ?? []} loading={!sq.data} />}
        {tab === 'cash-flow' && (reports ? <CashFlow projectId={projectId} /> : <Empty title="No access">Cash flow is for finance and management.</Empty>)}
        {tab === 'tax' && (reports ? <TaxReport projectId={projectId} /> : <Empty title="No access">The tax report is for finance and management.</Empty>)}
      </div>
    </Page>
  );
}

function Statements({ rows, loading }: { rows: SubcontractRow[]; loading: boolean }) {
  const totals = useMemo(() => rows.reduce((s, r) => ({ v: s.v + Number(r.contract_value), c: s.c + Number(r.certified_to_date), p: s.p + Number(r.paid_to_date), ret: s.ret + Number(r.retention_held) }), { v: 0, c: 0, p: 0, ret: 0 }), [rows]);
  return (
    <Card flush title="Subcontractor statements" sub={`Contracts ${etb(totals.v)} · certified ${etb(totals.c)} · paid ${etb(totals.p)} · retention held ${etb(totals.ret)} ETB`}>
      <DataTable rows={rows} rowKey={(r: SubcontractRow) => r.id} loading={loading} exportName="subcontractor-statements" empty={{ title: 'No subcontracts' }}
        columns={[
          { key: 'number', label: 'Subcontract', id: true }, { key: 'subcontractor_name', label: 'Subcontractor' }, { key: 'subcontractor_tin', label: 'TIN' },
          { key: 'contract_value', label: 'Contract', align: 'right', render: (r) => etb(r.contract_value) },
          { key: 'certified_to_date', label: 'Certified to date', align: 'right', render: (r) => etb(r.certified_to_date) },
          { key: 'paid_to_date', label: 'Paid (net)', align: 'right', render: (r) => etb(r.paid_to_date) },
          { key: 'advance', label: 'Advance outstanding', align: 'right', value: (r) => Number(r.advance_amount) - Number(r.advance_recovered), render: (r) => etb(Number(r.advance_amount) - Number(r.advance_recovered)) },
          { key: 'retention_held', label: 'Retention held', align: 'right', render: (r) => etb(r.retention_held) },
        ]} />
    </Card>
  );
}
