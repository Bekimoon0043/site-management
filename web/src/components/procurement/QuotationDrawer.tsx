import { useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import type { Lookups } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import { nextDocNumber } from '../../lib/device-numbers';
import { procRpc, taxFor, useTaxSettings, type RfqDetail } from '../../lib/procurement';
import type { Quotation } from '../../lib/contract-procurement';
import { money, num, today } from '../../lib/format';
import { Attachments } from '../Attachments';
import { Banner, Drawer, ErrorBanner, Field, QtyInput, toast, useBusy } from '../ui';

interface LineForm { id: string; rfq_line_id: string; available: boolean; unit_price: string; transport_cost: string; offered_spec_id: string; qty: string; remarks: string }

/**
 * Record (or correct) one supplier's quotation for an RFQ: per-line unit price + transport, VAT-inclusive toggle,
 * delivery days, validity, payment terms and the proforma photo/PDF (uploaded to storage, linked via attachment_ids).
 */
export function QuotationDrawer({ d, quotation, L, onClose }: { d: RfqDetail; quotation?: Quotation; L: Lookups; onClose: () => void }) {
  const auth = useAuth();
  const tax = useTaxSettings();
  const currency = auth.project?.currency ?? 'ETB';
  const existing = quotation ? d.qLines.filter((l) => l.quotation_id === quotation.id) : [];
  const quoted = new Set(d.quotations.filter((q) => q.status !== 'withdrawn').map((q) => q.supplier_id));
  const invited = d.suppliers.map((s) => s.supplier_id).filter((id) => !quoted.has(id));
  const [supplier, setSupplier] = useState(quotation?.supplier_id ?? invited[0] ?? '');
  const [h, setH] = useState({
    quote_ref: quotation?.quote_ref ?? '', quote_date: quotation?.quote_date ?? today(), valid_until: quotation?.valid_until ?? '',
    delivery_days: quotation?.delivery_days?.toString() ?? '', payment_terms: quotation?.payment_terms ?? '',
    prices_include_vat: quotation?.prices_include_vat ?? false, transport_included: quotation?.transport_included ?? false,
  });
  const [lines, setLines] = useState<LineForm[]>(() => d.lines.map((rl) => {
    const ql = existing.find((x) => x.rfq_line_id === rl.id);
    const p = ql ? d.prices.get(ql.id) : undefined;
    return { id: ql?.id ?? crypto.randomUUID(), rfq_line_id: rl.id, available: ql?.available ?? true, unit_price: p ? String(p.unit_price) : '',
      transport_cost: p && Number(p.transport_cost) ? String(p.transport_cost) : '', offered_spec_id: ql?.offered_spec_id ?? rl.material_spec_id,
      qty: String(ql?.qty ?? rl.qty), remarks: ql?.remarks ?? '' };
  }));
  const [files, setFiles] = useState<File[]>([]);
  const { busy, error, run } = useBusy();
  const setLine = (id: string, patch: Partial<LineForm>) => setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const vat = Number(taxFor(tax.data, h.quote_date)?.vat_rate ?? 0);
  const exVat = (p: number) => (h.prices_include_vat ? p / (1 + vat / 100) : p);
  const total = lines.reduce((s, l) => s + (l.available ? Number(l.qty) * exVat(Number(l.unit_price) || 0) + (Number(l.transport_cost) || 0) : 0), 0);

  const save = () => run(async () => {
    if (!supplier) throw new Error('Choose the supplier');
    if (!h.quote_date) throw new Error('Quotation date is required');
    lines.forEach((l, i) => {
      if (l.available && !(Number(l.unit_price) >= 0 && l.unit_price !== '')) throw new Error(`Line ${i + 1}: enter a unit price or mark it not offered`);
      if (l.available && !(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
    });
    if (!lines.some((l) => l.available)) throw new Error('At least one line must be offered');
    const id = quotation?.id ?? crypto.randomUUID();
    const number = quotation?.number ?? await nextDocNumber(auth.project?.code ?? '', 'QT');
    // Proforma photos / PDFs: storage path <project>/quotation/<quotation id>/<attachment id>.<ext>
    const attachment_ids: string[] = [];
    for (const file of files) {
      const aid = crypto.randomUUID();
      const ext = (file.name.split('.').pop() || (file.type.includes('pdf') ? 'pdf' : 'jpg')).toLowerCase();
      const path = `${d.rfq.project_id}/quotation/${id}/${aid}.${ext}`;
      const up = await supabase.storage.from('attachments').upload(path, file, { contentType: file.type || undefined });
      if (up.error) throw new Error(`Upload failed (${file.name}): ${up.error.message}`);
      const ins = await supabase.from('attachments').insert({ id: aid, project_id: d.rfq.project_id, entity_type: 'quotation', entity_id: id,
        kind: file.type.startsWith('image/') ? 'photo' : 'document', storage_path: path, mime_type: file.type || null, created_by: auth.profile?.id });
      if (ins.error) throw new Error(ins.error.message);
      attachment_ids.push(aid);
    }
    await procRpc('record_quotation', {
      id, rfq_id: d.rfq.id, supplier_id: supplier, number, quote_ref: h.quote_ref || undefined, quote_date: h.quote_date,
      valid_until: h.valid_until || undefined, prices_include_vat: h.prices_include_vat, delivery_days: h.delivery_days ? Number(h.delivery_days) : undefined,
      payment_terms: h.payment_terms || undefined, transport_included: h.transport_included, attachment_ids,
      lines: lines.map((l) => ({ id: l.id, rfq_line_id: l.rfq_line_id, available: l.available, offered_spec_id: l.offered_spec_id || undefined,
        qty: l.available ? Number(l.qty) : undefined, unit_price: l.available ? Number(l.unit_price) : undefined,
        transport_cost: l.available && l.transport_cost ? Number(l.transport_cost) : undefined, remarks: l.remarks || undefined })),
    });
    toast.success(`${number} recorded for ${L.suppliers.find((s) => s.id === supplier)?.name ?? 'supplier'}`);
    onClose();
  });

  return (
    <Drawer size="lg" title={quotation ? `Quotation ${quotation.number}` : 'Record quotation'} subtitle={`${d.rfq.number} · ${d.rfq.title}`} onClose={onClose}
      footer={<>
        <span className="grow muted small-text">Landed total ex-VAT: <strong>{money(total, currency)}</strong></span>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save quotation</button>
      </>}>
      <div className="stack">
        <ErrorBanner error={error ?? tax.error} />
        <div className="form-grid">
          <Field label="Supplier" required hint={!quotation && !invited.length ? 'Every invited supplier has quoted — any other supplier is added to the RFQ.' : undefined}>
            <select value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={!!quotation} data-autofocus>
              <option value="">Choose…</option>
              {invited.length > 0 && <optgroup label="Invited">{invited.map((id) => <option key={id} value={id}>{L.suppliers.find((s) => s.id === id)?.name ?? id}</option>)}</optgroup>}
              <optgroup label="Other suppliers">{L.suppliers.filter((s) => !invited.includes(s.id) && (!quoted.has(s.id) || s.id === quotation?.supplier_id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>
            </select>
          </Field>
          <Field label="Supplier's ref. (proforma no.)"><input value={h.quote_ref} onChange={(e) => setH({ ...h, quote_ref: e.target.value })} /></Field>
          <Field label="Quotation date" required><input type="date" value={h.quote_date} onChange={(e) => setH({ ...h, quote_date: e.target.value })} /></Field>
          <Field label="Valid until"><input type="date" value={h.valid_until} onChange={(e) => setH({ ...h, valid_until: e.target.value })} /></Field>
          <Field label="Delivery (days)"><QtyInput value={h.delivery_days} onChange={(v) => setH({ ...h, delivery_days: v })} unit="days" min={0} /></Field>
          <Field label="Payment terms"><input value={h.payment_terms} onChange={(e) => setH({ ...h, payment_terms: e.target.value })} placeholder="e.g. 30% advance, balance on delivery" /></Field>
          <Field label={`Prices include VAT (${num(vat)}%)`} check><input type="checkbox" checked={h.prices_include_vat} onChange={(e) => setH({ ...h, prices_include_vat: e.target.checked })} /></Field>
          <Field label="Transport included in price" check><input type="checkbox" checked={h.transport_included} onChange={(e) => setH({ ...h, transport_included: e.target.checked })} /></Field>
        </div>
        {h.prices_include_vat && <Banner tone="info">Unit prices are entered as quoted (incl. VAT); comparison and POs use the ex-VAT price.</Banner>}

        <div className="table-wrap"><table>
          <thead><tr><th>#</th><th>Requested</th><th>Offered</th><th className="center">Offered?</th><th className="right">Qty</th><th className="right">Unit price{h.prices_include_vat ? ' (incl. VAT)' : ''}</th><th className="right">Transport (line)</th><th className="right">Landed / unit ex-VAT</th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const rl = d.lines.find((x) => x.id === l.rfq_line_id)!;
              const landed = l.available && Number(l.qty) > 0 ? exVat(Number(l.unit_price) || 0) + (Number(l.transport_cost) || 0) / Number(l.qty) : null;
              return (
                <tr key={l.id}>
                  <td className="right">{i + 1}</td>
                  <td>{L.spec(rl.material_spec_id)}<div className="xs-text muted">{num(rl.qty, 3)} {L.specUom(rl.material_spec_id)}</div></td>
                  <td><select value={l.offered_spec_id} onChange={(e) => setLine(l.id, { offered_spec_id: e.target.value })} disabled={!l.available} aria-label={`Line ${i + 1} offered material`}>
                    {L.specs.filter((s) => s.id === rl.material_spec_id || s.category === L.specs.find((x) => x.id === rl.material_spec_id)?.category).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                  </select></td>
                  <td className="center"><input type="checkbox" checked={l.available} onChange={(e) => setLine(l.id, { available: e.target.checked })} aria-label={`Line ${i + 1} offered`} /></td>
                  <td className="right"><QtyInput value={l.qty} onChange={(v) => setLine(l.id, { qty: v })} unit={L.specUom(l.offered_spec_id)} min={0} disabled={!l.available} aria-label={`Line ${i + 1} quantity`} width={130} /></td>
                  <td className="right"><QtyInput value={l.unit_price} onChange={(v) => setLine(l.id, { unit_price: v })} unit={currency} min={0} disabled={!l.available} aria-label={`Line ${i + 1} unit price`} width={150} /></td>
                  <td className="right"><QtyInput value={l.transport_cost} onChange={(v) => setLine(l.id, { transport_cost: v })} unit={currency} min={0} disabled={!l.available || h.transport_included} aria-label={`Line ${i + 1} transport`} width={140} /></td>
                  <td className="right">{landed === null ? <span className="muted-dash">—</span> : money(landed, currency)}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>

        <Field label="Proforma (photo or PDF)" hint="Uploaded with the quotation and kept as evidence for the award.">
          <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
        </Field>
        {files.length > 0 && (
          <ul className="check-list">
            {files.map((file, i) => <li key={i} className="row"><Paperclip size={14} aria-hidden />{file.name}<button className="icon-btn" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={14} /></button></li>)}
          </ul>
        )}
        {quotation && <Attachments entityType="quotation" entityId={quotation.id} />}
      </div>
    </Drawer>
  );
}
