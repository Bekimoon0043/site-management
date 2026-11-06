import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { canProcure, type MrLineProcurementRow, type PoTotals, type QuotationComparisonRow, type RfqAward, type RfqLine } from '../../lib/contract-procurement';
import { nextDocNumber } from '../../lib/device-numbers';
import {
  PO_AMENDABLE, PO_EDITABLE, computeTotals, loadPoDetail, procRpc, taxFor, toLineInput, useTaxSettings, type PoFormLine, type SupplierRow,
} from '../../lib/procurement';
import { money, num, today } from '../../lib/format';
import { Banner, Card, Empty, ErrorBanner, Field, Loading, Page, QtyInput, ReasonModal, toast, useBusy } from '../../components/ui';

interface Header {
  supplier_id: string; delivery_store_id: string; order_date: string; expected_date: string; payment_terms: string;
  advance_pct: string; delivery_terms: string; remarks: string; rfq_id: string | null;
}
interface Init { mode: 'new' | 'edit' | 'amend'; id: string; number?: string; header: Header; lines: PoFormLine[]; oldTotals?: PoTotals | null; status?: string; note?: string }

const blankLine = (p: Partial<PoFormLine> = {}): PoFormLine => ({ id: crypto.randomUUID(), material_spec_id: '', qty: '', unit_price: '', vat_applicable: true, expected_date: '', ...p });

async function loadInit(newId: string, id: string | undefined, amend: boolean, mrLineIds: string[], rfqId: string | null, supplier: string | null, defStore: string): Promise<Init> {
  const header: Header = { supplier_id: supplier ?? '', delivery_store_id: defStore, order_date: today(), expected_date: '', payment_terms: '', advance_pct: '', delivery_terms: '', remarks: '', rfq_id: null };
  if (id) {
    const d = await loadPoDetail(id, true);
    const { po } = d;
    const mode = amend ? 'amend' : 'edit';
    if (mode === 'edit' && !PO_EDITABLE.includes(po.status)) throw new Error(`${po.number} is ${po.status} — use an amendment instead`);
    if (mode === 'amend' && !PO_AMENDABLE.includes(po.status)) throw new Error(`${po.number} cannot be amended (status: ${po.status})`);
    return {
      mode, id, number: po.number, status: po.status, oldTotals: d.totals,
      header: { supplier_id: po.supplier_id, delivery_store_id: po.delivery_store_id, order_date: po.order_date, expected_date: po.expected_date ?? '',
        payment_terms: po.payment_terms ?? '', advance_pct: po.advance_pct?.toString() ?? '', delivery_terms: po.delivery_terms ?? '', remarks: po.remarks ?? '', rfq_id: po.rfq_id },
      lines: d.lines.map((l) => {
        const p = d.prices.get(l.id);
        return { id: l.id, material_spec_id: l.material_spec_id, qty: String(l.qty), unit_price: p ? String(p.unit_price) : '', vat_applicable: p?.vat_applicable ?? true,
          expected_date: l.expected_date ?? '', mr_line_id: l.mr_line_id, quotation_line_id: l.quotation_line_id, uom: l.uom, remarks: l.remarks, accepted: Number(l.qty_accepted) };
      }),
    };
  }
  const init: Init = { mode: 'new', id: newId, header, lines: [] };
  if (mrLineIds.length) {
    type MrLineRow = { id: string; line_no: number; material_spec_id: string; approved_qty: number | null; required_date: string | null; material_requests: { number: string; store_id: string | null; required_date: string } | null };
    const [lines, proc] = await Promise.all([
      supabase.from('mr_lines').select('id, line_no, material_spec_id, approved_qty, required_date, material_requests(number, store_id, required_date)').in('id', mrLineIds).then(check),
      supabase.from('v_mr_line_procurement').select('*').in('mr_line_id', mrLineIds).then(check),
    ]);
    const ordered = new Map((proc as MrLineProcurementRow[]).map((p) => [p.mr_line_id, Number(p.ordered_qty)]));
    const rows = lines as unknown as MrLineRow[];
    const specs = [...new Set(rows.map((r) => r.material_spec_id))];
    const prices = specs.length ? await supabase.from('spec_prices').select('material_spec_id, unit_price').in('material_spec_id', specs) : { data: [] };
    const price = new Map(((prices.data ?? []) as { material_spec_id: string; unit_price: number }[]).map((p) => [p.material_spec_id, p.unit_price]));
    init.lines = rows.map((r) => blankLine({
      material_spec_id: r.material_spec_id, mr_line_id: r.id, qty: String(Math.max(0, Number(r.approved_qty ?? 0) - (ordered.get(r.id) ?? 0))),
      unit_price: price.has(r.material_spec_id) ? String(price.get(r.material_spec_id)) : '', expected_date: r.required_date ?? r.material_requests?.required_date ?? '',
      label: `${r.material_requests?.number ?? ''} line ${r.line_no}`,
    }));
    const store = rows.find((r) => r.material_requests?.store_id)?.material_requests?.store_id;
    if (store) header.delivery_store_id = store;
    header.expected_date = rows.map((r) => r.required_date ?? r.material_requests?.required_date ?? '').filter(Boolean).sort()[0] ?? '';
    header.remarks = `For ${[...new Set(rows.map((r) => r.material_requests?.number).filter(Boolean))].join(', ')}`;
  } else if (rfqId) {
    const [rfq, awards, cmp, rls] = await Promise.all([
      supabase.from('rfqs').select('id, number, delivery_store_id, required_by').eq('id', rfqId).maybeSingle().then(check),
      supabase.from('rfq_awards').select('*').eq('rfq_id', rfqId).then(check),
      supabase.from('v_quotation_comparison').select('*').eq('rfq_id', rfqId).then(check),
      supabase.from('rfq_lines').select('*').eq('rfq_id', rfqId).then(check),
    ]);
    const r = rfq as { id: string; number: string; delivery_store_id: string | null; required_by: string | null } | null;
    if (!r) throw new Error('RFQ not found');
    let aw = awards as RfqAward[];
    const sup = supplier ?? aw[0]?.supplier_id ?? '';
    aw = aw.filter((a) => a.supplier_id === sup);
    const byQl = new Map((cmp as QuotationComparisonRow[]).map((c) => [c.quotation_line_id, c]));
    const byRl = new Map((rls as RfqLine[]).map((l) => [l.id, l]));
    header.supplier_id = sup; header.rfq_id = r.id; header.delivery_store_id = r.delivery_store_id ?? defStore;
    header.payment_terms = (cmp as QuotationComparisonRow[]).find((c) => c.supplier_id === sup)?.payment_terms ?? '';
    header.expected_date = r.required_by ?? '';
    init.lines = aw.map((a) => {
      const c = byQl.get(a.quotation_line_id);
      return blankLine({ material_spec_id: c?.offered_spec_id ?? byRl.get(a.rfq_line_id)?.material_spec_id ?? '', qty: String(a.qty), quotation_line_id: a.quotation_line_id,
        mr_line_id: byRl.get(a.rfq_line_id)?.mr_line_id ?? null, unit_price: c ? String(c.unit_price_ex_vat) : '', expected_date: byRl.get(a.rfq_line_id)?.required_date ?? '', label: `${r.number} line ${byRl.get(a.rfq_line_id)?.line_no ?? ''}` });
    });
    init.note = `Lines from the award of ${r.number}${aw.length ? '' : ' (no award for this supplier)'}.`;
  }
  if (!init.lines.length) init.lines = [blankLine()];
  return init;
}

/** Create / edit (draft, rejected) / amend (approved, sent, part-received) a purchase order with live tax totals. */
export function PoEdit() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const auth = useAuth();
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const amend = params.get('amend') === '1';
  const mrLines = (params.get('mr_lines') ?? '').split(',').filter(Boolean);
  const rfq = params.get('rfq');
  const supplier = params.get('supplier');
  const allowed = canProcure(auth.profile?.role, 'po.create') && auth.canSeePrices;
  const [newId] = useState(() => crypto.randomUUID());
  const q = useAsync(() => loadInit(newId, id, amend, mrLines, rfq, supplier, lk.data?.stores[0]?.id ?? ''),
    [projectId, id, amend, mrLines.join(), rfq, supplier, !!lk.data], { key: 'po-form', enabled: allowed && !!lk.data, staleTime: Infinity });
  const crumbs = [{ label: 'Procurement', to: '/procurement#pos' }, { label: id ? (amend ? 'Amend' : 'Edit') : 'New purchase order' }];
  if (!allowed) return <Page title="Purchase order" breadcrumbs={crumbs}><Empty title="No access">Creating purchase orders needs the procurement or management role with price access.</Empty></Page>;
  if (!q.data || !lk.data) return <Page title="Purchase order" breadcrumbs={crumbs}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  return <PoForm key={q.data.id + q.data.mode} init={q.data} L={lk.data} projectId={projectId} />;
}

function PoForm({ init, L, projectId }: { init: Init; L: Lookups; projectId: string }) {
  const auth = useAuth();
  const nav = useNavigate();
  const tax = useTaxSettings();
  const currency = auth.project?.currency ?? 'ETB';
  const [h, setH] = useState<Header>(init.header);
  const [lines, setLines] = useState<PoFormLine[]>(init.lines);
  const [reasonOpen, setReasonOpen] = useState(false);
  const { busy, error, run, setError } = useBusy();
  const amend = init.mode === 'amend';
  const sup = L.suppliers.find((s) => s.id === h.supplier_id) as SupplierRow | undefined;
  const t = taxFor(tax.data, h.order_date);
  const totals = useMemo(() => computeTotals(lines.map((l) => ({ qty: Number(l.qty), unit_price: Number(l.unit_price), vat_applicable: l.vat_applicable })), t, sup?.tin), [lines, t, sup?.tin]);
  const setLine = (id: string, patch: Partial<PoFormLine>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const set = <K extends keyof Header>(k: K, v: Header[K]) => setH((x) => ({ ...x, [k]: v }));
  const increases = amend && init.oldTotals ? totals.total > Number(init.oldTotals.total) + 0.005 : false;

  const validate = () => {
    if (!h.supplier_id) throw new Error('Choose a supplier');
    if (!h.delivery_store_id) throw new Error('Choose the delivery store');
    const ls = lines.filter((l) => l.material_spec_id || l.qty || l.unit_price);
    if (!ls.length) throw new Error('Add at least one line');
    ls.forEach((l, i) => {
      if (!l.material_spec_id) throw new Error(`Line ${i + 1}: choose a material`);
      if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
      if (l.accepted && Number(l.qty) < l.accepted - 0.0005) throw new Error(`Line ${i + 1}: quantity is below the ${num(l.accepted, 3)} already received`);
      if (l.unit_price === '' || !(Number(l.unit_price) >= 0)) throw new Error(`Line ${i + 1}: enter the unit price (ex-VAT)`);
    });
    const removed = init.lines.filter((o) => o.accepted && !ls.some((l) => l.id === o.id));
    if (removed.length) throw new Error('Lines that have already been received cannot be removed');
    return ls;
  };

  const save = (submit: boolean) => run(async () => {
    const ls = validate();
    const number = init.number ?? await nextDocNumber(auth.project?.code ?? '', 'PO');
    const res = await procRpc('save_po', {
      id: init.id, project_id: projectId, number, supplier_id: h.supplier_id, rfq_id: h.rfq_id ?? undefined, delivery_store_id: h.delivery_store_id,
      order_date: h.order_date || undefined, expected_date: h.expected_date || undefined, payment_terms: h.payment_terms || undefined,
      advance_pct: h.advance_pct ? Number(h.advance_pct) : undefined, delivery_terms: h.delivery_terms || undefined, remarks: h.remarks || undefined,
      submit, lines: ls.map(toLineInput),
    });
    const server = res.totals as { total?: number } | undefined;
    if (server?.total !== undefined && Math.abs(Number(server.total) - totals.total) > 0.01) toast.info(`Server total ${money(server.total, currency)} (tax settings changed?)`);
    toast.success(`${number} ${submit ? 'submitted for approval' : 'saved as draft'}`);
    nav(`/procurement/po/${init.id}`, { replace: true });
  });

  const submitAmend = async (reason: string) => {
    const ls = validate();
    const res = await procRpc('amend_po', {
      po_id: init.id, reason, expected_date: h.expected_date || undefined, payment_terms: h.payment_terms || undefined,
      delivery_terms: h.delivery_terms || undefined, remarks: h.remarks || undefined, lines: ls.map(toLineInput),
    });
    toast.success(`${init.number} amended to revision ${String(res.revision ?? '')}${res.status === 'submitted' ? ' — sent for re-approval' : ''}`);
    nav(`/procurement/po/${init.id}`, { replace: true });
  };

  const title = init.mode === 'new' ? 'New purchase order' : amend ? `Amend ${init.number}` : `Edit ${init.number}`;
  return (
    <Page width="dash" title={title} breadcrumbs={[{ label: 'Procurement', to: '/procurement#pos' }, ...(init.number ? [{ label: init.number, to: `/procurement/po/${init.id}` }] : []), { label: amend ? 'Amend' : init.mode === 'new' ? 'New' : 'Edit' }]}
      subtitle={amend ? 'Amendments create a new revision; a higher total sends the PO back for approval.' : 'Prices are ex-VAT per unit. VAT and withholding follow the tax settings in force on the order date.'}
      actions={<>
        <button onClick={() => nav(-1)} disabled={busy}>Cancel</button>
        {amend
          ? <button className="primary" disabled={busy} onClick={() => { setError(null); try { validate(); setReasonOpen(true); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }}>Save amendment…</button>
          : <>
            <button disabled={busy} onClick={() => void save(false)}>Save draft</button>
            <button className="primary" disabled={busy} onClick={() => void save(true)}>{busy && <span className="spinner" />}Save &amp; submit</button>
          </>}
      </>}>
      <div className="stack">
        <ErrorBanner error={error ?? tax.error} />
        {init.note && <Banner tone="info">{init.note}</Banner>}
        {init.status === 'rejected' && <Banner tone="warn">This PO was rejected — saving moves it back to draft.</Banner>}
        <div className="detail-layout">
          <div className="stack">
            <Card title="Order">
              <div className="form-grid">
                <Field label="Supplier" required hint={sup ? [sup.tin ? `TIN ${sup.tin}` : 'No TIN on file', sup.vat_registered === false ? 'not VAT-registered' : null, sup.payment_terms].filter(Boolean).join(' · ') : undefined}>
                  <select value={h.supplier_id} disabled={amend} data-autofocus
                    onChange={(e) => { const s = L.suppliers.find((x) => x.id === e.target.value) as SupplierRow | undefined; setH({ ...h, supplier_id: e.target.value, payment_terms: h.payment_terms || s?.payment_terms || '' }); }}>
                    <option value="">Choose…</option>
                    {L.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Delivery store" required>
                  <select value={h.delivery_store_id} disabled={amend} onChange={(e) => set('delivery_store_id', e.target.value)}>
                    <option value="">Choose…</option>{L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Order date"><input type="date" value={h.order_date} disabled={amend} onChange={(e) => set('order_date', e.target.value)} /></Field>
                <Field label="Expected delivery"><input type="date" value={h.expected_date} onChange={(e) => set('expected_date', e.target.value)} /></Field>
                <Field label="Payment terms"><input value={h.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></Field>
                <Field label="Advance"><QtyInput value={h.advance_pct} onChange={(v) => set('advance_pct', v)} unit="%" min={0} max={100} disabled={amend} /></Field>
                <Field label="Delivery terms"><input value={h.delivery_terms} onChange={(e) => set('delivery_terms', e.target.value)} placeholder="e.g. delivered to site, offloading by supplier" /></Field>
                <Field label="Remarks" wide><textarea rows={2} value={h.remarks} onChange={(e) => set('remarks', e.target.value)} /></Field>
              </div>
            </Card>
            <Card title="Lines" flush>
              <div className="table-scroll" style={{ maxHeight: 'none' }}><table>
                <thead><tr><th>#</th><th>Material / grade</th><th className="right">Qty</th><th className="right">Unit price ex-VAT</th><th className="center">VAT</th><th>Expected</th><th className="right">Line total</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const uom = l.uom || L.specUom(l.material_spec_id);
                    const lt = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
                    return (
                      <tr key={l.id}>
                        <td className="right">{i + 1}</td>
                        <td>
                          <select value={l.material_spec_id} onChange={(e) => setLine(l.id, { material_spec_id: e.target.value })} disabled={!!l.accepted || !!l.mr_line_id || !!l.quotation_line_id} aria-label={`Line ${i + 1} material`}>
                            <option value="">Choose…</option>
                            {L.specs.filter((s) => s.is_active || s.id === l.material_spec_id).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                          </select>
                          {(l.label || l.accepted) ? <div className="xs-text muted">{[l.label, l.accepted ? `${num(l.accepted, 3)} ${uom} received` : null].filter(Boolean).join(' · ')}</div> : null}
                        </td>
                        <td className="right"><QtyInput value={l.qty} onChange={(v) => setLine(l.id, { qty: v })} unit={uom} min={l.accepted ?? 0} aria-label={`Line ${i + 1} quantity`} width={140} /></td>
                        <td className="right"><QtyInput value={l.unit_price} onChange={(v) => setLine(l.id, { unit_price: v })} unit={currency} min={0} aria-label={`Line ${i + 1} unit price`} width={160} /></td>
                        <td className="center"><input type="checkbox" checked={l.vat_applicable} onChange={(e) => setLine(l.id, { vat_applicable: e.target.checked })} aria-label={`Line ${i + 1} VAT applicable`} /></td>
                        <td><input type="date" value={l.expected_date} onChange={(e) => setLine(l.id, { expected_date: e.target.value })} aria-label={`Line ${i + 1} expected date`} /></td>
                        <td className="right">{money(lt, currency)}</td>
                        <td><button className="icon-btn" disabled={!!l.accepted} title={l.accepted ? 'Received lines cannot be removed' : undefined} aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((x) => x.id !== l.id))}><Trash2 size={14} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
              <div className="pad" style={{ paddingTop: 'var(--sp-3)', paddingBottom: 'var(--sp-3)' }}>
                <button className="small" onClick={() => setLines([...lines, blankLine({ expected_date: h.expected_date })])}><Plus size={14} aria-hidden />Add line</button>
              </div>
            </Card>
          </div>
          <div className="side-panel">
            <Card title="Totals" sub={t ? `Tax settings from ${t.effective_from}` : 'Loading tax settings…'}>
              <dl className="kv">
                <dt>Subtotal</dt><dd className="right">{money(totals.subtotal, currency)}</dd>
                <dt>VAT {num(totals.vat_rate)}%</dt><dd className="right">{money(totals.vat, currency)}</dd>
                <dt className="strong">Total</dt><dd className="right strong">{money(totals.total, currency)}</dd>
                <dt>Withholding {num(totals.withholding_rate)}%</dt><dd className="right">−{money(totals.withholding, currency)}</dd>
                <dt className="strong">Net payable</dt><dd className="right strong">{money(totals.net_payable, currency)}</dd>
              </dl>
              {t && totals.withholding_rate === 0 && <p className="muted small-text mt-2 mb-0">No withholding below {money(t.wht_goods_threshold, currency)}.</p>}
              {sup && totals.noTin && totals.withholding_rate > 0 && <Banner tone="warn"><TriangleAlert size={14} aria-hidden /> Supplier has no TIN — {num(totals.withholding_rate)}% withholding applies.</Banner>}
              {amend && init.oldTotals && (
                <p className="small-text mt-2 mb-0">Current revision: {money(init.oldTotals.total, currency)}. {increases ? <strong className="warn-text">Higher total → re-approval required.</strong> : 'No re-approval needed.'}</p>
              )}
            </Card>
          </div>
        </div>
      </div>
      {reasonOpen && <ReasonModal title={`Amend ${init.number}`} label="Reason for amendment" confirm={increases ? 'Amend & send for re-approval' : 'Save amendment'} onClose={() => setReasonOpen(false)} onSubmit={submitAmend} />}
    </Page>
  );
}
