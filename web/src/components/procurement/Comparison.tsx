import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, Trophy } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import type { Lookups } from '../../lib/hooks';
import type { QuotationComparisonRow } from '../../lib/contract-procurement';
import { nextDocNumbers } from '../../lib/device-numbers';
import { procRpc, type RfqDetail } from '../../lib/procurement';
import { date, money, num } from '../../lib/format';
import { Badge, Banner, Card, Empty, ErrorBanner, Field, Modal, toast, useBusy } from '../ui';

interface Col { quotation_id: string; supplier_id: string; supplier_name: string; rating: number | null; number: string; delivery_days: number | null; valid_until: string | null; payment_terms: string | null; prices_include_vat: boolean }

const pct = (a: number, b: number | null) => (b && b > 0 ? ((a / b - 1) * 100) : null);

/**
 * Lines × suppliers grid from v_quotation_comparison: landed unit cost (ex-VAT price + transport per unit),
 * lowest per line highlighted, last PO price Δ, supplier terms. Award mode picks one quotation line per RFQ line.
 */
export function Comparison({ d, L, canAward }: { d: RfqDetail; L: Lookups; canAward: boolean }) {
  const auth = useAuth();
  const currency = auth.project?.currency ?? 'ETB';
  const rows = d.comparison;
  const cols = useMemo<Col[]>(() => {
    const m = new Map<string, Col>();
    for (const r of rows) if (!m.has(r.quotation_id)) m.set(r.quotation_id, { quotation_id: r.quotation_id, supplier_id: r.supplier_id, supplier_name: r.supplier_name, rating: r.rating, number: r.quotation_number, delivery_days: r.delivery_days, valid_until: r.valid_until, payment_terms: r.payment_terms, prices_include_vat: r.prices_include_vat });
    return [...m.values()].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name));
  }, [rows]);
  const cell = useMemo(() => new Map(rows.map((r) => [`${r.rfq_line_id}:${r.quotation_id}`, r])), [rows]);
  const lowest = useMemo(() => {
    const m = new Map<string, QuotationComparisonRow>();
    for (const r of rows) { const cur = m.get(r.rfq_line_id); if (!cur || Number(r.landed_unit_cost) < Number(cur.landed_unit_cost)) m.set(r.rfq_line_id, r); }
    return m;
  }, [rows]);
  const quotes = d.quotations.filter((q) => q.status !== 'withdrawn').length;
  const belowMin = quotes < d.rfq.min_quotes;
  const awardable = canAward && ['sent', 'closed'].includes(d.rfq.status) && rows.length > 0;
  const [awarding, setAwarding] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const startAward = () => {
    setChoice(Object.fromEntries(d.lines.map((l) => [l.id, lowest.get(l.id)?.quotation_line_id ?? ''])));
    setAwarding(true);
  };
  const total = (qid: string) => d.lines.reduce((s, l) => s + Number(cell.get(`${l.id}:${qid}`)?.landed_total ?? 0), 0);
  const coverage = (qid: string) => d.lines.filter((l) => cell.has(`${l.id}:${qid}`)).length;

  if (!rows.length) {
    return <Card title="Quotation comparison"><Empty inline>{d.quotations.length ? 'No priced lines yet.' : 'Record quotations to compare suppliers side by side.'}</Empty></Card>;
  }
  return (
    <Card title="Quotation comparison" flush sub={`Landed unit cost = ex-VAT price + transport per unit · ${quotes} of ${d.rfq.min_quotes} required quotations`}
      actions={awardable && !awarding ? <button className="small primary" onClick={startAward}><Trophy size={14} aria-hidden />Award…</button> : undefined}>
      {belowMin && ['sent', 'closed'].includes(d.rfq.status) && <div className="pad" style={{ paddingBottom: 0 }}><Banner tone="warn">Only {quotes} of the {d.rfq.min_quotes} required quotations received — awarding needs an override reason.</Banner></div>}
      <div className="table-scroll" style={{ maxHeight: 'none' }}><table>
        <thead>
          <tr>
            <th>#</th><th>Material</th><th className="right">Qty</th><th className="right">Last PO price</th>
            {cols.map((c) => <th key={c.quotation_id} className="right">{c.supplier_name}{c.rating ? <span className="muted"> <Star size={11} aria-hidden />{num(c.rating, 1)}</span> : null}<div className="xs-text muted">{c.number}</div></th>)}
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l) => {
            const uom = L.specUom(l.material_spec_id);
            const last = rows.find((r) => r.rfq_line_id === l.id)?.last_po_price ?? null;
            return (
              <tr key={l.id}>
                <td className="right">{l.line_no}</td>
                <td>{L.spec(l.material_spec_id)}</td>
                <td className="right">{num(l.qty, 3)}<span className="unit">{uom}</span></td>
                <td className="right">{last === null ? <span className="muted-dash">—</span> : money(last, currency)}</td>
                {cols.map((c) => {
                  const r = cell.get(`${l.id}:${c.quotation_id}`);
                  if (!r) return <td key={c.quotation_id} className="right muted small-text">not offered</td>;
                  const isLow = lowest.get(l.id)?.quotation_line_id === r.quotation_line_id || r.is_lowest;
                  const delta = pct(Number(r.landed_unit_cost), last);
                  return (
                    <td key={c.quotation_id} className="right">
                      {awarding && (
                        <input type="radio" name={`award-${l.id}`} checked={choice[l.id] === r.quotation_line_id} onChange={() => setChoice({ ...choice, [l.id]: r.quotation_line_id })}
                          aria-label={`Award line ${l.line_no} to ${c.supplier_name}`} style={{ marginRight: 6 }} />
                      )}
                      <span className={isLow ? 'ok-text strong' : ''}>{money(r.landed_unit_cost, currency)}</span>
                      <div className="xs-text muted">
                        {r.prices_include_vat ? `${money(r.quoted_unit_price, currency)} incl. VAT` : `${money(r.unit_price_ex_vat, currency)} ex-VAT`}
                        {Number(r.transport_cost) > 0 && ` + ${money(r.transport_cost, currency)} transport`}
                        {r.offered_spec_id !== l.material_spec_id && ` · offers ${L.spec(r.offered_spec_id)}`}
                      </div>
                      <div className="xs-text">
                        {isLow && <Badge tone="success" label="Lowest" icon={null} />}
                        {r.is_awarded && <Badge tone="primary" icon={Trophy} label="Awarded" />}
                        {delta !== null && <span className={delta > 0 ? 'danger-text' : 'ok-text'}> {delta > 0 ? '+' : ''}{num(delta, 1)}% vs last PO</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr><th colSpan={4}>Landed total ({d.lines.length} lines)</th>{cols.map((c) => <th key={c.quotation_id} className="right">{money(total(c.quotation_id), currency)}<div className="xs-text muted">{coverage(c.quotation_id)} / {d.lines.length} lines</div></th>)}</tr>
          <tr><td colSpan={4} className="muted">Delivery</td>{cols.map((c) => <td key={c.quotation_id} className="right">{c.delivery_days === null ? '—' : `${c.delivery_days} d`}</td>)}</tr>
          <tr><td colSpan={4} className="muted">Valid until</td>{cols.map((c) => <td key={c.quotation_id} className={`right${c.valid_until && c.valid_until < today ? ' danger-text' : ''}`}>{date(c.valid_until) || '—'}</td>)}</tr>
          <tr><td colSpan={4} className="muted">Payment terms</td>{cols.map((c) => <td key={c.quotation_id} className="right small-text">{c.payment_terms || '—'}</td>)}</tr>
        </tfoot>
      </table></div>
      {awarding && (
        <div className="action-bar">
          <span className="grow muted">{Object.values(choice).filter(Boolean).length} of {d.lines.length} lines chosen · lowest pre-selected</span>
          <button onClick={() => setAwarding(false)}>Cancel</button>
          <button className="primary" disabled={!Object.values(choice).some(Boolean)} onClick={() => setConfirming(true)}>Review award…</button>
        </div>
      )}
      {confirming && <AwardModal d={d} L={L} choice={choice} lowest={lowest} rows={rows} belowMin={belowMin} quotes={quotes}
        onClose={() => setConfirming(false)} onDone={() => { setConfirming(false); setAwarding(false); }} />}
    </Card>
  );
}

function AwardModal({ d, L, choice, lowest, rows, belowMin, quotes, onClose, onDone }: {
  d: RfqDetail; L: Lookups; choice: Record<string, string>; lowest: Map<string, QuotationComparisonRow>; rows: QuotationComparisonRow[];
  belowMin: boolean; quotes: number; onClose: () => void; onDone: () => void;
}) {
  const auth = useAuth();
  const nav = useNavigate();
  const currency = auth.project?.currency ?? 'ETB';
  const picks = d.lines.filter((l) => choice[l.id]).map((l) => {
    const r = rows.find((x) => x.quotation_line_id === choice[l.id])!;
    const low = lowest.get(l.id)!;
    return { line: l, r, isLowest: Number(r.landed_unit_cost) <= Number(low.landed_unit_cost) + 0.005, low };
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [override, setOverride] = useState('');
  const [createPo, setCreatePo] = useState(!!d.rfq.delivery_store_id);
  const { busy, error, run } = useBusy();
  const suppliers = [...new Set(picks.map((p) => p.r.supplier_id))];

  const go = () => run(async () => {
    for (const p of picks) if (!p.isLowest && !reasons[p.line.id]?.trim()) throw new Error(`Line ${p.line.line_no}: give a reason for not awarding the lowest landed cost`);
    if (belowMin && !override.trim()) throw new Error('Give an override reason for awarding with fewer quotations than required');
    const numbers = createPo ? await nextDocNumbers(auth.project?.code ?? '', 'PO', suppliers.length) : [];
    const res = await procRpc('award_rfq', {
      rfq_id: d.rfq.id, override_reason: belowMin ? override.trim() : undefined,
      awards: picks.map((p) => ({ id: crypto.randomUUID(), rfq_line_id: p.line.id, quotation_line_id: p.r.quotation_line_id, reason: p.isLowest ? reasons[p.line.id]?.trim() || undefined : reasons[p.line.id].trim() })),
      create_po: createPo,
      pos: createPo ? suppliers.map((s, i) => ({ id: crypto.randomUUID(), number: numbers[i], supplier_id: s })) : undefined,
    });
    const poIds = (res.po_ids as string[] | undefined) ?? [];
    const pos = (res.pos as { number: string; status: string }[] | undefined) ?? [];
    const approved = pos.filter((p) => p.status === 'approved').map((p) => p.number);
    const waiting = pos.filter((p) => p.status === 'submitted').map((p) => p.number);
    toast.success(`${d.rfq.number} awarded${approved.length ? ` · ${approved.join(', ')} approved — procurement sends ${approved.length === 1 ? 'it' : 'them'} to the supplier` : ''}${waiting.length ? ` · ${waiting.join(', ')} above your limit, sent for approval` : ''}${!pos.length && poIds.length ? ` · ${poIds.length} PO(s) created` : ''}. The store sees ${pos.length === 1 ? 'it' : 'them'} under Incoming orders.`);
    onDone();
    if (poIds.length === 1) nav(`/procurement/po/${poIds[0]}`);
    else if (poIds.length > 1) nav('/procurement#pos');
  });

  return (
    <Modal size="lg" title={`Award ${d.rfq.number}`} onClose={onClose}
      footer={<><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}{createPo ? 'Award & create POs' : 'Award'}</button></>}>
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Material</th><th>Supplier</th><th className="right">Landed / unit</th><th className="right">Lowest</th><th>Reason</th></tr></thead>
          <tbody>
            {picks.map((p) => (
              <tr key={p.line.id} className={p.isLowest ? undefined : 'row-warn'}>
                <td className="right">{p.line.line_no}</td>
                <td>{L.spec(p.line.material_spec_id)}</td>
                <td>{p.r.supplier_name}</td>
                <td className="right">{money(p.r.landed_unit_cost, currency)}</td>
                <td className="right">{p.isLowest ? <Badge tone="success" label="Lowest" icon={null} /> : <span className="small-text">{money(p.low.landed_unit_cost, currency)} ({p.low.supplier_name})</span>}</td>
                <td><input value={reasons[p.line.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [p.line.id]: e.target.value })} placeholder={p.isLowest ? 'Optional' : 'Required — e.g. faster delivery, quality'}
                  aria-label={`Reason for line ${p.line.line_no}`} style={{ width: '100%' }} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {picks.length < d.lines.length && <Banner tone="info">{d.lines.length - picks.length} line(s) are not awarded and stay unsourced.</Banner>}
        {belowMin && (
          <Field label={`Override: only ${quotes} of ${d.rfq.min_quotes} quotations received`} required wide>
            <textarea rows={2} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="e.g. single-source item, urgent pour" />
          </Field>
        )}
        <Field label={`Create ${suppliers.length} purchase order${suppliers.length === 1 ? '' : 's'} (one per supplier), approved with this award within your PO limit`} check
          hint={!d.rfq.delivery_store_id ? 'Set the RFQ delivery store first (edit the RFQ while draft, or create POs manually).' : undefined}>
          <input type="checkbox" checked={createPo} disabled={!d.rfq.delivery_store_id} onChange={(e) => setCreatePo(e.target.checked)} />
        </Field>
      </div>
    </Modal>
  );
}
