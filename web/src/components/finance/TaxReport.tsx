// Finance → Tax: monthly working papers and exports for withholding, payroll tax, VAT and withholding suffered.
import { useState } from 'react';
import { date } from '../../lib/format';
import { useAuth } from '../../lib/auth';
import { TAX_SECTION_LABELS, type TaxRow, type TaxSection } from '../../lib/contract-finance';
import { Card, DataTable, ErrorBanner, Field, Kpi, Loading } from '../ui';
import { useAsync } from '../../lib/hooks';
import { etb } from '../payments/data';
import { loadTaxReport } from './data';

const thisMonth = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 7);
const SECTIONS = Object.keys(TAX_SECTION_LABELS) as TaxSection[];

export function TaxReport({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const [month, setMonth] = useState(thisMonth());
  const [all, setAll] = useState(false);
  const q = useAsync(() => loadTaxReport(all ? null : projectId, month), [projectId, month, all], { key: 'tax-report' });
  const rows = q.data ?? [];
  const total = (s: TaxSection) => rows.filter((r) => r.section === s).reduce((a, r) => a + Number(r.amount), 0);
  const project = (id: string) => auth.projects.find((p) => p.id === id)?.code ?? '';
  return (
    <div className="stack">
      <Card>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Month"><input type="month" value={month} max={thisMonth()} onChange={(e) => setMonth(e.target.value || thisMonth())} /></Field>
          <Field label="All my projects" check><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /></Field>
          <span className="muted small-text">Internal working papers by Gregorian calendar month. Confirm Ethiopian tax periods, filing deadlines and input-VAT eligibility with the Ministry of Revenues before filing.</span>
        </div>
      </Card>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="kpis">
        <Kpi label="Withholding to remit" value={etb(total('wht_payable'))} unit="ETB" />
        <Kpi label="Payroll tax to remit" value={etb(total('payroll_tax'))} unit="ETB" />
        <Kpi label="VAT payable (output − input)" value={etb(total('vat_output') - total('vat_input'))} unit="ETB" />
        <Kpi label="Withholding credit" value={etb(total('wht_credit'))} unit="ETB" hint="Deducted by the client — claim against income tax" />
      </div>
      {!q.data ? <Loading lines={6} /> : SECTIONS.map((s) => {
        const xs = rows.filter((r) => r.section === s);
        return (
          <Card key={s} flush title={TAX_SECTION_LABELS[s]} sub={`${xs.length} document${xs.length === 1 ? '' : 's'} · ${etb(total(s))} ETB`}>
            <DataTable rows={xs} rowKey={(r: TaxRow) => `${r.section}:${r.doc_id}`} exportName={`tax-${s}-${month}`}
              empty={{ title: 'Nothing this month' }}
              columns={[
                ...(all ? [{ key: 'project', label: 'Project', value: (r: TaxRow) => project(r.project_id) }] : []),
                { key: 'doc_date', label: 'Date', render: (r: TaxRow) => date(r.doc_date) },
                { key: 'number', label: 'Document', id: true },
                { key: 'party', label: 'Party' },
                { key: 'tin', label: 'TIN', value: (r: TaxRow) => r.tin ?? '' },
                { key: 'base', label: 'Taxable amount', align: 'right', render: (r: TaxRow) => etb(r.base) },
                { key: 'rate', label: 'Rate %', align: 'right', value: (r: TaxRow) => Number(r.rate ?? 0) },
                { key: 'amount', label: 'Tax', align: 'right', render: (r: TaxRow) => <b>{etb(r.amount)}</b> },
              ]} />
          </Card>
        );
      })}
    </div>
  );
}
