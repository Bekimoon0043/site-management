// Finance → Cash flow: 13-week forecast (client receipts vs payments due), the movements behind it and the finance
// overview (receivable ageing, retention receivable / payable, approved and overdue payables, petty cash in hand).
import { useState } from 'react';
import { date } from '../../lib/format';
import type { CashFlowItem, CashFlowWeek } from '../../lib/contract-finance';
import { Banner, Card, DataTable, ErrorBanner, Field, Kpi, Loading } from '../ui';
import { useAsync } from '../../lib/hooks';
import { etb } from '../payments/data';
import { loadCashFlow, loadCashItems, loadOverview } from './data';
import './finance.css';

const BUCKET: Record<string, string> = {
  client: 'Client certificate', suppliers: 'Supplier invoice', committed: 'Ordered, not invoiced', subcontractors: 'Subcontractor certificate',
  labour: 'Labour payroll', petty_cash: 'Petty cash claim',
};

export function CashFlow({ projectId }: { projectId: string }) {
  const [weeks, setWeeks] = useState(13);
  const fq = useAsync(() => loadCashFlow(projectId, weeks), [projectId, weeks], { key: 'cash-flow' });
  const iq = useAsync(() => loadCashItems(projectId), [projectId], { key: 'cash-flow-items' });
  const oq = useAsync(() => loadOverview(projectId), [projectId], { key: 'finance-overview' });
  const rows = fq.data ?? [];
  const o = oq.data;
  const max = Math.max(1, ...rows.map((r) => Math.max(Number(r.client_in), outOf(r))));
  const firstNeg = rows.find((r) => Number(r.cumulative) < 0);
  return (
    <div className="stack">
      <ErrorBanner error={fq.error ?? oq.error ?? iq.error} onRetry={() => { fq.reload(); oq.reload(); iq.reload(); }} />
      {o && (
        <div className="kpis">
          <Kpi label="Owed by the client" value={etb(o.receivable)} unit="ETB"
            hint={`> 60 days ${etb(Number(o.receivable_ageing.d61_90) + Number(o.receivable_ageing.d90_plus))}`} />
          <Kpi label="Retention still held by the client" value={etb(o.retention_receivable)} unit="ETB" hint="After recorded releases" />
          <Kpi label="Approved, to pay" value={etb(o.payable_approved)} unit="ETB" hint={Number(o.payable_overdue) ? `${etb(o.payable_overdue)} past due` : undefined} />
          <Kpi label="Retention we hold (subcontractors)" value={etb(o.retention_payable)} unit="ETB" />
          <Kpi label="Petty cash in hand" value={etb(o.petty_cash_in_hand)} unit="ETB" />
        </div>
      )}
      {o && (
        <Card title="Client receivable ageing" sub="Certified, not yet received — days since certification">
          <dl className="pay-summary">
            <dt>0–30 days</dt><dd>{etb(o.receivable_ageing.d0_30)}</dd>
            <dt>31–60 days</dt><dd>{etb(o.receivable_ageing.d31_60)}</dd>
            <dt>61–90 days</dt><dd>{etb(o.receivable_ageing.d61_90)}</dd>
            <dt>Over 90 days</dt><dd className={Number(o.receivable_ageing.d90_plus) ? 'minus' : undefined}>{etb(o.receivable_ageing.d90_plus)}</dd>
          </dl>
        </Card>
      )}
      {firstNeg && <Banner tone="warn">Cash goes negative in the week of {date(firstNeg.week_start)} ({etb(firstNeg.cumulative)} ETB) — chase receipts or reschedule payments.</Banner>}
      <Card flush title="Cash-flow forecast" sub="Week by week: client receipts and committed payments within the selected horizon. Overdue items fall in this week; later movements remain in the drill-down below."
        actions={<Field label="Weeks"><select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{[8, 13, 26].map((w) => <option key={w} value={w}>{w}</option>)}</select></Field>}>
        {!fq.data ? <Loading lines={6} /> : (
          <DataTable rows={rows} rowKey={(r) => r.week_start} exportName="cash-flow-forecast"
            columns={[
              { key: 'week_start', label: 'Week of', id: true, render: (r) => date(r.week_start) },
              { key: 'client_in', label: 'In (client)', align: 'right', render: (r) => etb(r.client_in) },
              { key: 'suppliers_out', label: 'Suppliers', align: 'right', render: (r) => etb(r.suppliers_out) },
              { key: 'committed_out', label: 'Open POs', align: 'right', render: (r) => etb(r.committed_out) },
              { key: 'subcontractors_out', label: 'Subcontractors', align: 'right', render: (r) => etb(r.subcontractors_out) },
              { key: 'labour_out', label: 'Labour', align: 'right', render: (r) => etb(r.labour_out) },
              { key: 'petty_cash_out', label: 'Petty cash', align: 'right', render: (r) => etb(r.petty_cash_out) },
              { key: 'bar', label: 'In / out', value: (r) => Number(r.net), render: (r) => (
                <span className="cf-bar" aria-hidden><span className="in" style={{ width: `${(Number(r.client_in) / max) * 60}px` }} /><span className="out" style={{ width: `${(outOf(r) / max) * 60}px` }} /></span>) },
              { key: 'net', label: 'Net', align: 'right', render: (r) => <span className={Number(r.net) < 0 ? 'cf-neg' : undefined}>{etb(r.net)}</span> },
              { key: 'cumulative', label: 'Cumulative', align: 'right', render: (r) => <b className={Number(r.cumulative) < 0 ? 'cf-neg' : undefined}>{etb(r.cumulative)}</b> },
            ]} />
        )}
      </Card>
      <Card flush title="Movements behind the forecast">
        <DataTable rows={iq.data ?? []} rowKey={(r: CashFlowItem) => `${r.bucket}:${r.ref}`} loading={!iq.data} exportName="cash-flow-items" maxHeight="50vh"
          empty={{ title: 'Nothing expected' }}
          columns={[
            { key: 'due', label: 'Expected', render: (r) => date(r.due) },
            { key: 'direction', label: 'In / out', value: (r) => (r.direction === 'in' ? 'In' : 'Out') },
            { key: 'bucket', label: 'Type', value: (r) => BUCKET[r.bucket] ?? r.bucket },
            { key: 'ref', label: 'Document', id: true },
            { key: 'party', label: 'Party' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => <span className={r.direction === 'out' ? 'minus' : undefined}>{etb(r.amount)}</span> },
          ]} />
      </Card>
    </div>
  );
}

const outOf = (r: CashFlowWeek) => Number(r.suppliers_out) + Number(r.subcontractors_out) + Number(r.labour_out) + Number(r.petty_cash_out) + Number(r.committed_out);
