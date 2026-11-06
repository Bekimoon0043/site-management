import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import type { Lookups } from '../../lib/hooks';
import type { RfqSentVia } from '../../lib/contract-procurement';
import { nextDocNumber } from '../../lib/device-numbers';
import { procRpc } from '../../lib/procurement';
import { Drawer, ErrorBanner, Field, QtyInput, toast, useBusy } from '../ui';

export interface RfqDraftLine { id: string; material_spec_id: string; qty: string; required_date: string; remarks: string; mr_line_id?: string | null; source?: string }
export interface RfqDraft {
  id?: string; number?: string; title: string; required_by: string; delivery_store_id: string; min_quotes: string; notes: string;
  lines: RfqDraftLine[]; suppliers: { supplier_id: string; sent_via: RfqSentVia | '' }[];
}

const VIA: { value: RfqSentVia; label: string }[] = [
  { value: 'telegram', label: 'Telegram' }, { value: 'whatsapp', label: 'WhatsApp' }, { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' }, { value: 'phone', label: 'Phone' }, { value: 'in_person', label: 'In person' },
];

export const newRfqLine = (p: Partial<RfqDraftLine> = {}): RfqDraftLine => ({ id: crypto.randomUUID(), material_spec_id: '', qty: '', required_date: '', remarks: '', ...p });

/** Create / edit a draft RFQ (save_rfq); "Save & send" sends it in the same transaction. */
export function RfqEditor({ initial, L, projectId, onClose }: { initial: RfqDraft; L: Lookups; projectId: string; onClose: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState<RfqDraft>(initial);
  const [supQ, setSupQ] = useState('');
  const { busy, error, run } = useBusy();
  const set = <K extends keyof RfqDraft>(k: K, v: RfqDraft[K]) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (id: string, patch: Partial<RfqDraftLine>) => set('lines', f.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  // Suppliers serving the categories on the RFQ first.
  const cats = useMemo(() => new Set(f.lines.map((l) => L.specs.find((s) => s.id === l.material_spec_id)?.category?.toLowerCase()).filter(Boolean)), [f.lines, L.specs]);
  const suppliers = useMemo(() => {
    const term = supQ.toLowerCase();
    return L.suppliers.filter((s) => !term || s.name.toLowerCase().includes(term))
      .map((s) => ({ s, match: (s.categories ?? []).some((c) => cats.has(c.toLowerCase())) }))
      .sort((a, b) => Number(b.match) - Number(a.match) || a.s.name.localeCompare(b.s.name));
  }, [L.suppliers, supQ, cats]);
  const chosen = new Map(f.suppliers.map((s) => [s.supplier_id, s]));
  const toggleSup = (id: string) => set('suppliers', chosen.has(id) ? f.suppliers.filter((s) => s.supplier_id !== id) : [...f.suppliers, { supplier_id: id, sent_via: 'telegram' }]);

  const save = (send: boolean) => run(async () => {
    if (!f.title.trim()) throw new Error('Give the RFQ a title');
    const lines = f.lines.filter((l) => l.material_spec_id || l.qty);
    if (!lines.length) throw new Error('Add at least one line');
    lines.forEach((l, i) => {
      if (!l.material_spec_id) throw new Error(`Line ${i + 1}: choose a material`);
      if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
    });
    if (send && !f.suppliers.length) throw new Error('Choose at least one supplier to send the RFQ to');
    const id = f.id ?? crypto.randomUUID();
    const number = f.number ?? await nextDocNumber(auth.project?.code ?? '', 'RFQ');
    await procRpc('save_rfq', {
      id, project_id: projectId, number, title: f.title.trim(), required_by: f.required_by || undefined,
      delivery_store_id: f.delivery_store_id || undefined, min_quotes: Number(f.min_quotes) || undefined, notes: f.notes || undefined, send,
      lines: lines.map((l) => ({ id: l.id, material_spec_id: l.material_spec_id, qty: Number(l.qty), mr_line_id: l.mr_line_id ?? undefined,
        required_date: l.required_date || undefined, remarks: l.remarks || undefined })),
      suppliers: f.suppliers.map((s) => ({ id: crypto.randomUUID(), supplier_id: s.supplier_id, sent_via: s.sent_via || undefined })),
    });
    toast.success(`${number} ${send ? 'saved and sent' : 'saved as draft'}`);
    onClose();
    if (!f.id) nav(`/procurement/rfq/${id}`);
  });

  return (
    <Drawer size="lg" title={f.number ? `Edit ${f.number}` : 'New request for quotation'} subtitle="Lines × invited suppliers. Quotations are recorded once the RFQ is sent." onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button disabled={busy} onClick={() => void save(false)}>Save draft</button>
        <button className="primary" disabled={busy} onClick={() => void save(true)}>{busy && <span className="spinner" />}Save &amp; send</button>
      </>}>
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Title" required wide><input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Cement & rebar for Block B slab" data-autofocus /></Field>
          <Field label="Required by"><input type="date" value={f.required_by} onChange={(e) => set('required_by', e.target.value)} /></Field>
          <Field label="Delivery store" hint="Needed to create POs from the award">
            <select value={f.delivery_store_id} onChange={(e) => set('delivery_store_id', e.target.value)}>
              <option value="">Choose…</option>
              {L.stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Minimum quotations"><QtyInput value={f.min_quotes} onChange={(v) => set('min_quotes', v)} min={1} width={100} /></Field>
          <Field label="Notes to suppliers" wide><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        </div>

        <div>
          <h3 className="strong">Lines</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Material / grade</th><th className="right">Qty</th><th>Required</th><th>Remarks</th><th /></tr></thead>
            <tbody>
              {f.lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="right">{i + 1}</td>
                  <td>
                    <select value={l.material_spec_id} onChange={(e) => setLine(l.id, { material_spec_id: e.target.value })} aria-label={`Line ${i + 1} material`} disabled={!!l.mr_line_id}>
                      <option value="">Choose…</option>
                      {L.specs.filter((s) => s.is_active || s.id === l.material_spec_id).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                    {l.source && <div className="xs-text muted">{l.source}</div>}
                  </td>
                  <td className="right"><QtyInput value={l.qty} onChange={(v) => setLine(l.id, { qty: v })} unit={L.specUom(l.material_spec_id)} min={0} aria-label={`Line ${i + 1} quantity`} /></td>
                  <td><input type="date" value={l.required_date} onChange={(e) => setLine(l.id, { required_date: e.target.value })} aria-label={`Line ${i + 1} required date`} /></td>
                  <td><input value={l.remarks} onChange={(e) => setLine(l.id, { remarks: e.target.value })} aria-label={`Line ${i + 1} remarks`} /></td>
                  <td><button className="icon-btn" aria-label={`Remove line ${i + 1}`} onClick={() => set('lines', f.lines.filter((x) => x.id !== l.id))}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <button className="small mt-2" onClick={() => set('lines', [...f.lines, newRfqLine({ required_date: f.required_by })])}><Plus size={14} aria-hidden />Add line</button>
        </div>

        <div>
          <div className="row"><h3 className="strong grow">Invite suppliers <span className="muted small-text">({f.suppliers.length} chosen)</span></h3>
            <input type="search" placeholder="Find supplier…" value={supQ} onChange={(e) => setSupQ(e.target.value)} aria-label="Find supplier" style={{ width: 200 }} /></div>
          <div className="table-wrap mt-2"><table>
            <thead><tr><th /><th>Supplier</th><th>Contact</th><th>Send via</th></tr></thead>
            <tbody>
              {suppliers.slice(0, 60).map(({ s, match }) => (
                <tr key={s.id}>
                  <td><input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggleSup(s.id)} aria-label={`Invite ${s.name}`} /></td>
                  <td>{s.name}{match && <span className="xs-text ok-text"> · supplies this category</span>}</td>
                  <td className="muted small-text">{[s.contact_person, s.phone].filter(Boolean).join(' · ')}</td>
                  <td>{chosen.has(s.id) && (
                    <select value={chosen.get(s.id)!.sent_via} aria-label={`Send ${s.name} via`}
                      onChange={(e) => set('suppliers', f.suppliers.map((x) => (x.supplier_id === s.id ? { ...x, sent_via: e.target.value as RfqSentVia } : x)))}>
                      <option value="">—</option>{VIA.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                    </select>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {!L.suppliers.length && <p className="muted small-text">No suppliers yet — add them under Materials › Suppliers.</p>}
        </div>
      </div>
    </Drawer>
  );
}
