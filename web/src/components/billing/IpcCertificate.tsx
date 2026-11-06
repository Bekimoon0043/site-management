// Payment certificate sheet in the company's layout (template "CCECC 2nd payment"): header, contract summary,
// previous payments, deductions 1–12, amount in words and the three signatures. Used for the client IPC
// (figures from app.ipc_totals) and for subcontractor certificates (app.sc_recalc).
import type { ClientContract, ClientIpc, IpcTotals } from '../../lib/contract-billing';
import { date } from '../../lib/format';
import './billing.css';

const fmt = (v: number | null | undefined) => {
  const x = Number(v ?? 0);
  if (Math.abs(x) < 0.005) return '-';
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? `(${s})` : s;
};
const ded = (v: number | null | undefined) => fmt(-Number(v ?? 0));
const pct = (v: number | null | undefined) => `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];
const hundreds = (n: number) => {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : '');
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
};
/** 6857475.91 → "Six Million Eight Hundred Fifty-Seven Thousand Four Hundred Seventy-Five & 91/100" */
export function amountInWords(v: number) {
  const cents = Math.round(Math.abs(v) * 100);
  let whole = Math.floor(cents / 100);
  const parts: string[] = [];
  for (let i = 0; whole > 0; i++, whole = Math.floor(whole / 1000)) {
    const c = whole % 1000;
    if (c) parts.unshift(`${hundreds(c)}${SCALES[i] ? ` ${SCALES[i]}` : ''}`);
  }
  return `${v < 0 ? 'Minus ' : ''}${parts.join(' ') || 'Zero'} & ${String(cents % 100).padStart(2, '0')}/100`;
}

export interface CertificateSheetProps {
  no: string | number; isFinal: boolean; companyName: string; companyLogo: string | null;
  info: [string, string][];
  summary: { main: number; supp: number; vo: number; voCount: number; rebatePct: number; vatPct: number };
  previous: { date: string | null; net: number; vat: number }[];
  t: {
    value_cum: number; previous_value: number; rebate: number; rebate_pct: number; retention: number; retention_pct: number;
    penalty: number; material: number; other?: { label: string; amount: number }; total_deduction: number; net_before_advance: number;
    advance: number; net_after_advance: number; wht: number; wht_pct: number; vat: number; vat_pct: number; payable: number;
  };
  payee: string; names: { requested?: string; checked?: string; approved?: string };
}

export function CertificateSheet({ no, isFinal, companyName, companyLogo, info, summary: s, previous, t, payee, names }: CertificateSheetProps) {
  const gross = s.main + s.supp + s.vo;
  const rebate = Math.round(gross * s.rebatePct) / 100;
  const afterRebate = gross - rebate;
  const vatSum = Math.round(afterRebate * s.vatPct) / 100;
  const rows = Math.max(previous.length, 12);
  const hasOther = !!t.other && Math.abs(t.other.amount) >= 0.005;
  const blankRows = 6 + (hasOther ? 1 : 0) + 1;

  return (
    <section className="ipc-cert" aria-label={`Payment certificate ${no}`}>
      <header className="ipc-cert-top">
        <div className="ipc-cert-logo">{companyLogo ? <img src={companyLogo} alt={companyName} /> : <span>{companyName}</span>}</div>
        <h2>PAYMENT CERTIFICATE</h2>
        <div className="ipc-cert-no">No. {no}{isFinal ? ' (Final)' : ''}</div>
      </header>

      <div className="ipc-cert-head">
        <dl className="ipc-cert-info">
          {info.map(([k, v]) => <div key={k}><dt>{k}:</dt><dd>{v}</dd></div>)}
        </dl>
        <table className="ipc-cert-sum">
          <thead><tr><th /><th className="box">Amount in Birr</th></tr></thead>
          <tbody>
            <tr><td>Main Contract</td><td className="box dotted">{fmt(s.main)}</td></tr>
            <tr><td>Supplementary Contract</td><td className="box dotted">{fmt(s.supp)}</td></tr>
            <tr><td>Variation Orders{s.voCount ? ` (${s.voCount})` : ''}</td><td className="box dotted">{fmt(s.vo)}</td></tr>
            <tr><td>Amount of Rebate ({pct(s.rebatePct)})</td><td className="box dotted">{fmt(-rebate)}</td></tr>
            <tr className="gap"><td>SUM After Rebate</td><td className="box ruled">{fmt(afterRebate)}</td></tr>
            <tr><td>{pct(s.vatPct)} VAT</td><td className="box">{fmt(vatSum)}</td></tr>
            <tr className="strong"><td>Total Sum</td><td className="box ruled">{fmt(afterRebate + vatSum)}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="ipc-cert-body">
        <div>
          <div className="ipc-cert-caption">PREVIOUS PAYMENTS</div>
          <table className="ipc-cert-grid ipc-cert-prev">
            <thead><tr><th>No.</th><th>Date</th><th>Net sum</th><th>VAT ({pct(s.vatPct)})</th></tr></thead>
            <tbody>
              {Array.from({ length: rows }, (_, k) => {
                const p = previous[k];
                return (
                  <tr key={k}><td className="c">{k + 1}</td><td className="c">{p?.date ? date(p.date) : ''}</td>
                    <td className="n">{p ? fmt(p.net) : ''}</td><td className="n">{p ? fmt(p.vat) : ''}</td></tr>
                );
              })}
            </tbody>
            <tfoot><tr><td colSpan={2} className="r strong">Total Sum</td>
              <td className="n">{fmt(previous.reduce((a, p) => a + p.net, 0))}</td><td className="n">{fmt(previous.reduce((a, p) => a + p.vat, 0))}</td></tr></tfoot>
          </table>
        </div>

        <table className="ipc-cert-grid ipc-cert-calc">
          <colgroup><col /><col className="mid" /><col className="amt" /></colgroup>
          <tbody>
            <tr><td colSpan={2}>1-As per the attached statement the value of work executed and/or materials supplied by the {payee.toLowerCase()} to date is……………….</td>
              <td className="n strong">{fmt(t.value_cum)}</td></tr>
            <tr className="head"><td className="c">DEDUCTION</td><td className="c">AMOUNT (BIRR)</td><td className="blank" rowSpan={blankRows} /></tr>
            <tr><td>2. Total Previous Payment</td><td className="n">{ded(t.previous_value)}</td></tr>
            <tr><td>3. Rebate ({pct(t.rebate_pct)} × (1 − 2))</td><td className="n">{ded(t.rebate)}</td></tr>
            <tr><td>4. Retention{t.retention < 0 ? ' released' : ` (${pct(t.retention_pct)} × (1 − 2))`}</td><td className="n">{ded(t.retention)}</td></tr>
            <tr><td>5. Penalty</td><td className="n">{ded(t.penalty)}</td></tr>
            <tr><td>6. Material Delivered</td><td className="n">{ded(t.material)}</td></tr>
            {hasOther && <tr><td>{t.other!.label}</td><td className="n">{ded(t.other!.amount)}</td></tr>}
            <tr><td>7. Total Deduction</td><td className="n">{ded(t.total_deduction)}</td></tr>
            <tr><td colSpan={2}>8. Net Sum Before Advance Repayment &amp; VAT</td><td className="n">{fmt(t.net_before_advance)}</td></tr>
            <tr><td colSpan={2}>9. Advance Repayment</td><td className="n">{ded(t.advance)}</td></tr>
            <tr><td colSpan={2}>10. Net Sum After Advance Repayment</td><td className="n">{fmt(t.net_after_advance)}</td></tr>
            <tr><td colSpan={2}>11. Withhold ({pct(t.wht_pct)} × (1 − 2))</td><td className="n">{ded(t.wht)}</td></tr>
            <tr><td colSpan={2}>12. VAT for net sum ({pct(t.vat_pct)} × (1 − 2))</td><td className="n">{fmt(t.vat)}</td></tr>
            <tr className="total"><td colSpan={2}>Total sum to the {payee}</td><td className="n">{fmt(t.payable)}</td></tr>
          </tbody>
        </table>
      </div>

      <p className="ipc-cert-words">
        We certify that the {payee} is now entitled to the sum of Birr {amountInWords(t.payable)} ({fmt(t.payable)})
      </p>

      <div className="ipc-cert-signs">
        {([['Requested by', names.requested], ['Checked by', names.checked], ['Approved by', names.approved]] as const).map(([label, who]) => (
          <div key={label}><span>{label}</span><span className="line">{who ?? ''}</span></div>
        ))}
      </div>
    </section>
  );
}

export interface IpcCertificateProps {
  ipc: ClientIpc; t: Partial<IpcTotals>; contract: ClientContract | null; previous: ClientIpc[];
  projectName: string; clientFallback?: string | null; companyName: string; companyLogo: string | null;
  voTotal: number; voCount: number; names: { requested?: string; checked?: string; approved?: string };
}

/** Client interim payment certificate (contractor = our company). */
export function IpcCertificate({ ipc, t, contract: c, previous, projectName, clientFallback, companyName, companyLogo, voTotal, voCount, names }: IpcCertificateProps) {
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const prevOf = (p: ClientIpc) => (p.certified ?? p.claimed ?? {}) as Partial<IpcTotals>;
  return (
    <CertificateSheet no={ipc.ipc_no} isFinal={ipc.is_final} companyName={companyName} companyLogo={companyLogo} payee="Contractor" names={names}
      info={[
        ['Project', projectName], ['Client', c?.client_name ?? clientFallback ?? ''], ['Consultant', c?.consultant_name ?? ''],
        ['Contractor', companyName], ['Contract No.', c?.contract_no ?? ''], ['Date of Contract Signing', c?.signed_on ? date(c.signed_on) : ''],
        ['Date of certificate', date(ipc.certified_on ?? ipc.submitted_at ?? ipc.period_to)],
        ['Period', `${ipc.period_from ? `${date(ipc.period_from)} – ` : 'to '}${date(ipc.period_to)}`],
      ]}
      summary={{ main: n(c?.contract_sum) - voTotal, supp: n(c?.supplementary_sum), vo: voTotal, voCount, rebatePct: n(c?.rebate_pct), vatPct: n(c?.vat_pct ?? 15) }}
      previous={previous.map((p) => ({ date: p.paid_on ?? p.certified_on ?? p.period_to, net: n(prevOf(p).this_value ?? prevOf(p).this_net), vat: n(prevOf(p).vat) }))}
      t={{
        value_cum: n(t.value_cum), previous_value: n(t.previous_value), rebate: n(t.rebate), rebate_pct: n(t.rebate_pct),
        retention: n(t.retention_this), retention_pct: n(t.retention_pct), penalty: n(t.penalty), material: n(t.material_delivered),
        total_deduction: n(t.total_deduction), net_before_advance: n(t.net_before_advance), advance: n(t.advance_this),
        net_after_advance: n(t.net_after_advance), wht: n(t.wht), wht_pct: n(t.wht_pct), vat: n(t.vat), vat_pct: n(t.vat_pct ?? 15), payable: n(t.payable),
      }} />
  );
}
