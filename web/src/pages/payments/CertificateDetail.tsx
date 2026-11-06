// /payments/certificates/:id (or /new?sc=<subcontract>) — subcontractor interim payment certificate: quantities claimed
// by the subcontractor vs verified by the office engineer (with the verified site progress as reference), deductions,
// the calculation, the approval chain and the printable certificate.
import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Printer, Save } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import { canPay, type ScCertificate, type ScCertificateLine } from '../../lib/contract-payments';
import { Banner, Card, ErrorBanner, Field, Loading, Page, toast, useBusy } from '../../components/ui';
import { CertificateSheet } from '../../components/billing/IpcCertificate';
import { Attachments } from '../../components/Attachments';
import { PaymentActions, PaymentHistory, PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb, loadCertificate, loadSubcontractItems, loadSubcontracts, payRpc, type CertificateDetail as Detail } from '../../components/payments/data';
import '../../components/payments/payments.css';

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function CertificateDetail() {
  const { id = '' } = useParams();
  const [sp] = useSearchParams();
  const projectId = useProjectId();
  const isNew = id === 'new';
  const scId = sp.get('sc') ?? '';
  const q = useAsync(async (): Promise<Detail | null> => {
    if (!isNew) return loadCertificate(id);
    const scs = await loadSubcontracts(projectId);
    const sc = scs.find((s) => s.id === scId);
    if (!sc) throw new Error('Subcontract not found');
    return { c: null as never, lines: [], sc, items: await loadSubcontractItems(sc.id), events: [], previous: [] };
  }, [id, scId, projectId], { key: 'sc-cert' });
  const lk = useLookups(projectId);
  if (!q.data || !lk.data) return <Page title="Payment certificate">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  return <CertificateBody key={q.data.c?.id ?? 'new'} d={q.data} isNew={isNew} reload={q.reload} />;
}

function CertificateBody({ d, isNew, reload }: { d: Detail; isNew: boolean; reload: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const L = lk.data!;
  const c = isNew ? null : d.c;
  const role = auth.profile?.role;
  const editable = canPay(role, 'payment.prepare') && (!c || c.status === 'draft' || c.status === 'returned');
  const lineBy = useMemo(() => new Map(d.lines.map((l) => [l.subcontract_item_id, l])), [d.lines]);
  const [h, setH] = useState({
    period_from: c?.period_from ?? '', period_to: c?.period_to ?? today(), is_final: c?.is_final ?? false,
    retention_release: String(c?.retention_release ?? 0), material_deduction: String(c?.material_deduction ?? 0), penalty: String(c?.penalty ?? 0),
    other_deduction: String(c?.other_deduction ?? 0), other_deduction_note: c?.other_deduction_note ?? '', remarks: c?.remarks ?? '',
  });
  const [qty, setQty] = useState<Record<string, { c: string; v: string; r: string }>>(() => Object.fromEntries(d.items.map((i) => {
    const l = lineBy.get(i.id);
    return [i.id, { c: l ? String(Number(l.qty_claimed_to_date)) : '', v: l ? String(Number(l.qty_verified_to_date)) : '', r: l?.remark ?? '' }];
  })));
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const certId = c?.id ?? crypto.randomUUID();
    const r = await payRpc('save_sc_certificate', {
      id: certId, subcontract_id: d.sc.id, period_from: h.period_from, period_to: h.period_to, is_final: h.is_final,
      retention_release: Number(h.retention_release) || 0, material_deduction: Number(h.material_deduction) || 0, penalty: Number(h.penalty) || 0,
      other_deduction: Number(h.other_deduction) || 0, other_deduction_note: h.other_deduction_note || undefined, remarks: h.remarks || undefined,
      lines: d.items.map((i) => ({ subcontract_item_id: i.id, qty_claimed_to_date: Number(qty[i.id]?.c || 0), qty_verified_to_date: Number(qty[i.id]?.v || 0), remark: qty[i.id]?.r || undefined })),
    });
    toast.success(`${String(r.number)} saved · net ${etb(Number(r.net_payable))} ETB`);
    if (isNew) nav(`/payments/certificates/${certId}`, { replace: true }); else reload();
  });
  const prevLine = (iid: string): Pick<ScCertificateLine, 'qty_previous' | 'site_qty_to_date'> | undefined => lineBy.get(iid);
  const title = c ? c.number : `New certificate · ${d.sc.number}`;

  return (
    <Page width="form" title={title} titleExtra={c ? <PaymentStatusBadge status={c.status} /> : undefined}
      breadcrumbs={[{ label: 'Subcontractor payments', to: '/payments/subcontracts' }, { label: title }]}
      subtitle={<>{d.sc.subcontractor_name}{d.sc.subcontractor_tin ? ` · TIN ${d.sc.subcontractor_tin}` : ''} · {d.sc.number} {d.sc.title}</>}
      actions={c ? <button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button> : undefined}>
      <div className="print-doc stack">
        <ErrorBanner error={error} />
        {c?.return_comment && <Banner tone={c.status === 'rejected' ? 'error' : 'warn'}>{c.status === 'rejected' ? 'Rejected' : 'Returned for correction'}: “{c.return_comment}”</Banner>}
        {c && (
          <ScSheet c={c} d={d} projectName={auth.project?.name ?? ''} companyName={auth.companyName} companyLogo={auth.companyLogo}
            names={{ requested: L.person(c.prepared_by) || undefined, checked: L.person(c.checked_by) || undefined, approved: L.person(c.approved_by) || undefined }} />
        )}
        {c && (
          <Card className="no-print" title="Approval & payment">
            {c.status === 'paid' && <p className="mt-0">Paid {date(c.payment_date)} by {c.payment_method?.replace('_', ' ')}{c.payment_ref ? ` · ref ${c.payment_ref}` : ''} · {L.person(c.paid_by)}</p>}
            <PaymentActions docType="sc_certificate" id={c.id} number={c.number} status={c.status} preparedBy={c.prepared_by} checkedBy={c.checked_by} net={Number(c.net_payable)} onDone={reload} />
          </Card>
        )}
        <Card className="no-print" title="Measurement period">
          <div className="form-grid">
            <Field label="From" required><input type="date" value={h.period_from} disabled={!editable} onChange={(e) => setH({ ...h, period_from: e.target.value })} /></Field>
            <Field label="To" required><input type="date" value={h.period_to} max={today()} disabled={!editable} onChange={(e) => setH({ ...h, period_to: e.target.value })} /></Field>
            <Field label="Final certificate (releases retention, recovers the rest of the advance)" check wide>
              <input type="checkbox" checked={h.is_final} disabled={!editable} onChange={(e) => setH({ ...h, is_final: e.target.checked })} /></Field>
          </div>
        </Card>
        <Card className="ipc-statement" title={`Attached statement — measured work${c ? `, ${c.number}` : ''} (${d.sc.subcontractor_name})`} sub="Quantities to date. The office engineer verifies against the site; site progress = verified progress on the linked task / BoQ item." flush>
          <div className="table-wrap pay-table"><div className="table-scroll">
            <table>
              <thead><tr><th>Item</th><th>Unit</th><th className="right">Contract qty</th><th className="right">Rate</th><th className="right">Previous</th>
                <th className="right">Site progress</th><th className="right">Claimed to date</th><th className="right">Verified to date</th><th className="right">This period</th>
                <th className="right">Amount this period</th><th>Remark</th></tr></thead>
              <tbody>
                {d.items.map((i) => {
                  const pl = prevLine(i.id);
                  const prev = Number(pl?.qty_previous ?? 0);
                  const v = Number(qty[i.id]?.v || 0);
                  const site = pl?.site_qty_to_date;
                  const warn = site != null && v > Number(site) + 0.0005;
                  return (
                    <tr key={i.id}>
                      <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{i.description}</td>
                      <td>{i.unit}</td>
                      <td className="right">{num(i.qty, 2)}</td>
                      <td className="right">{etb(i.rate)}</td>
                      <td className="right">{num(prev, 2)}</td>
                      <td className="right">{site == null ? <span className="muted">—</span> : num(site, 2)}</td>
                      <td className="right"><input type="number" min={0} step="any" style={{ width: 100 }} disabled={!editable} value={qty[i.id]?.c ?? ''}
                        onChange={(e) => setQty({ ...qty, [i.id]: { ...qty[i.id], c: e.target.value } })} /></td>
                      <td className="right"><input type="number" min={0} step="any" style={{ width: 100 }} disabled={!editable} value={qty[i.id]?.v ?? ''}
                        className={warn ? 'warn-input' : undefined} title={warn ? 'More than the verified site progress' : undefined}
                        onChange={(e) => setQty({ ...qty, [i.id]: { ...qty[i.id], v: e.target.value } })} />{warn && <span className="warn-text small-text"> &gt; site</span>}</td>
                      <td className="right">{num(v - prev, 2)}</td>
                      <td className="right">{etb((v - prev) * Number(i.rate))}</td>
                      <td><input value={qty[i.id]?.r ?? ''} disabled={!editable} placeholder={v < prev || v > Number(i.qty) ? 'Required' : ''} style={{ width: 160 }}
                        onChange={(e) => setQty({ ...qty, [i.id]: { ...qty[i.id], r: e.target.value } })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div></div>
        </Card>
        <Card className="no-print" title="Deductions">
          <div className="form-grid">
            <Field label="Materials supplied by us (ETB)"><input type="number" min={0} value={h.material_deduction} disabled={!editable} onChange={(e) => setH({ ...h, material_deduction: e.target.value })} /></Field>
            <Field label="Penalty / liquidated damages (ETB)"><input type="number" min={0} value={h.penalty} disabled={!editable} onChange={(e) => setH({ ...h, penalty: e.target.value })} /></Field>
            <Field label="Other deduction (ETB)"><input type="number" min={0} value={h.other_deduction} disabled={!editable} onChange={(e) => setH({ ...h, other_deduction: e.target.value })} /></Field>
            <Field label="Other deduction — reason"><input value={h.other_deduction_note} disabled={!editable} onChange={(e) => setH({ ...h, other_deduction_note: e.target.value })} /></Field>
            {!h.is_final && <Field label="Retention released now (ETB)" hint={`Held so far ${etb(d.sc.retention_held)}`}><input type="number" min={0} value={h.retention_release} disabled={!editable} onChange={(e) => setH({ ...h, retention_release: e.target.value })} /></Field>}
            <Field label="Remarks" wide><input value={h.remarks} disabled={!editable} onChange={(e) => setH({ ...h, remarks: e.target.value })} /></Field>
          </div>
          {editable && (
            <div className="row mt-2 no-print">
              <button className="primary" disabled={busy || !h.period_from || !h.period_to} onClick={save}>{busy ? <span className="spinner" /> : <Save size={14} aria-hidden />}{isNew ? 'Create certificate' : 'Save & recalculate'}</button>
              <span className="small-text muted">The amounts below are recalculated by the server on save.</span>
            </div>
          )}
        </Card>
        {c && (
          <Card className="no-print" title="Measurement evidence & documents" sub="Measurement sheets signed on site, photos of the work measured, the subcontractor's invoice and the signed certificate.">
            <Attachments entityType="sc_certificate" entityId={c.id} canAdd={canPay(role, 'payment.prepare') || canPay(role, 'payment.view')}
              kinds={['measurement', 'photo', 'invoice', 'signed_certificate', 'document']} emptyText="No evidence attached yet." />
          </Card>
        )}
        {c && <Card className="no-print" title="History"><PaymentHistory events={d.events} L={L} /></Card>}
      </div>
    </Page>
  );
}

/** Subcontractor certificate in the company template; figures as calculated by app.sc_recalc. */
function ScSheet({ c, d, projectName, companyName, companyLogo, names }: {
  c: ScCertificate; d: Detail; projectName: string; companyName: string; companyLogo: string | null;
  names: { requested?: string; checked?: string; approved?: string };
}) {
  const n = (v: number | null | undefined) => Number(v ?? 0);
  const retention = n(c.retention_this) - n(c.retention_release);
  const other = n(c.other_deduction);
  const totalDed = n(c.gross_previous) + retention + n(c.penalty) + n(c.material_deduction) + other;
  const before = n(c.gross_to_date) - totalDed;
  return (
    <CertificateSheet no={c.number} isFinal={c.is_final} companyName={companyName} companyLogo={companyLogo} payee="Subcontractor" names={names}
      info={[
        ['Project', projectName], ['Client', companyName], ['Subcontractor', d.sc.subcontractor_name],
        ['TIN', d.sc.subcontractor_tin ?? ''], ['Subcontract No.', `${d.sc.number} · ${d.sc.title}`],
        ['Date of certificate', date(c.approved_at ?? c.submitted_at ?? c.period_to)],
        ['Period', `${date(c.period_from)} – ${date(c.period_to)}`],
      ]}
      summary={{ main: n(d.sc.contract_value), supp: 0, vo: 0, voCount: 0, rebatePct: 0, vatPct: n(d.sc.vat_pct) }}
      previous={d.previous.map((p) => ({ date: p.payment_date ?? p.approved_at, net: n(p.gross_this), vat: n(p.vat_this) }))}
      t={{
        value_cum: n(c.gross_to_date), previous_value: n(c.gross_previous), rebate: 0, rebate_pct: 0,
        retention, retention_pct: n(c.retention_pct), penalty: n(c.penalty), material: n(c.material_deduction),
        other: { label: `Other deduction${c.other_deduction_note ? ` (${c.other_deduction_note})` : ''}`, amount: other },
        total_deduction: totalDed, net_before_advance: before, advance: n(c.advance_recovery_this),
        net_after_advance: before - n(c.advance_recovery_this), wht: n(c.wht_this), wht_pct: n(c.wht_pct),
        vat: n(c.vat_this), vat_pct: n(c.vat_pct), payable: n(c.net_payable),
      }} />
  );
}
