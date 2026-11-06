import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import type { MrPriority } from '../../lib/contract';
import type { RequestType } from '../../lib/contract-flows';
import { nextDocNumber } from '../../lib/device-numbers';
import { flowRpc, safeRows } from '../../lib/flows';
import { money, num, today } from '../../lib/format';
import { Drawer } from '../Dialog';
import { ErrorBanner, Banner } from '../Page';
import { Field, QtyInput, useBusy } from '../Form';
import { toast } from '../toast';
import './flows.css';

interface Line { id: string; material_spec_id: string; qty: string; required_date: string; remarks: string; element_id: string; elementSplitId: string }
export interface PrFormInitial {
  id: string; number: string; priority: MrPriority; required_date: string; store_id: string | null; block_id: string | null;
  delivery_location: string | null; purpose: string | null; drawing_ref: string | null; lookahead_plan_id?: string | null;
  lines: { id: string; material_spec_id: string; qty: number; required_date: string | null; remarks?: string | null; element_id?: string | null; split_id?: string | null }[];
}

const newLine = (date: string): Line => ({ id: crypto.randomUUID(), material_spec_id: '', qty: '', required_date: date, remarks: '', element_id: '', elementSplitId: crypto.randomUUID() });

/**
 * New / edit material request. type 'purchase' (Flow A, <PROJ>-PR-…: coordinator → management → procurement) or
 * 'site_use' (Flow B, <PROJ>-MR-…: office engineer review → coordinator store order → store issue). Numbers use this
 * browser's device prefix. Element links are optional (BoQ traceability) unless the project requires them for purchases.
 */
export function PurchaseRequestForm({ projectId, L, initial, onClose, onSaved, type = 'purchase' }: {
  projectId: string; L: Lookups; initial?: PrFormInitial; onClose: () => void; onSaved: (id: string, submitted: boolean) => void; type?: RequestType;
}) {
  const site = type === 'site_use';
  const auth = useAuth();
  const s = auth.settings as { pr_requires_elements?: boolean } | null;
  // site-use lines always name the element they are for (BoQ traceability, enforced on submit)
  const reqEl = site || !!s?.pr_requires_elements;
  const defStore = L.stores.find((x) => x.store_type === 'main')?.id ?? L.stores[0]?.id ?? '';
  const [h, setH] = useState({
    priority: (initial?.priority ?? 'normal') as MrPriority, required_date: initial?.required_date ?? '', store_id: initial?.store_id ?? defStore,
    block_id: initial?.block_id ?? (site && L.blocks.length === 1 ? L.blocks[0].id : ''), delivery_location: initial?.delivery_location ?? '', purpose: initial?.purpose ?? '',
    drawing_ref: initial?.drawing_ref ?? '', lookahead_plan_id: initial?.lookahead_plan_id ?? '',
  });
  const [lines, setLines] = useState<Line[]>(initial?.lines.length ? initial.lines.map((l) => ({
    id: l.id, material_spec_id: l.material_spec_id, qty: String(l.qty), required_date: l.required_date ?? '', remarks: l.remarks ?? '',
    element_id: l.element_id ?? '', elementSplitId: l.split_id ?? crypto.randomUUID(),
  })) : [newLine('')]);
  const { busy, error, run } = useBusy();

  const plans = useAsync(() => safeRows<{ id: string; period_label: string; status: string }>(supabase.from('lookahead_plans')
    .select('id, period_label, status').eq('project_id', projectId).order('period_start', { ascending: false }).limit(12)), [projectId], { key: 'la-plans-min', staleTime: 5 * 60_000 });
  const specIds = [...new Set(lines.map((l) => l.material_spec_id).filter(Boolean))];
  const prices = useAsync(() => safeRows<{ material_spec_id: string; unit_price: number }>(supabase.from('spec_prices').select('material_spec_id, unit_price').in('material_spec_id', specIds)),
    [specIds.join()], { key: 'spec-prices-min', enabled: auth.canSeePrices && specIds.length > 0 });
  const price = (spec: string) => prices.data?.find((p) => p.material_spec_id === spec)?.unit_price ?? null;
  const est = lines.reduce((t, l) => t + (Number(l.qty) || 0) * (price(l.material_spec_id) ?? 0), 0);
  const unpriced = lines.filter((l) => l.material_spec_id && price(l.material_spec_id) === null).length;

  const upd = (i: number, patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = (submit: boolean) => run(async () => {
    if (!h.required_date) throw new Error('Required date is required');
    if (!h.store_id && !h.delivery_location.trim()) throw new Error(site ? 'Choose the store to issue from' : 'Choose the delivery store');
    if (site && !h.block_id) throw new Error('Choose the block the material is for');
    const ls = lines.filter((l) => l.material_spec_id || l.qty);
    if (!ls.length) throw new Error('Add at least one line');
    ls.forEach((l, i) => {
      if (!l.material_spec_id) throw new Error(`Line ${i + 1}: choose the material / grade`);
      if (!(Number(l.qty) > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
      if (reqEl && submit && !l.element_id) throw new Error(site ? `Line ${i + 1}: choose the structural element the material is for` : `Line ${i + 1}: this project requires a structural element (BoQ link)`);
    });
    const number = initial?.number ?? await nextDocNumber(auth.project?.code ?? '', site ? 'MR' : 'PR');
    if (!site && !/(^|-)PR-/.test(number)) throw new Error('Purchase request numbers must contain -PR-');
    const id = initial?.id ?? crypto.randomUUID();
    await flowRpc('save_mr', {
      id, project_id: projectId, number, request_type: type, priority: h.priority, required_date: h.required_date,
      block_id: h.block_id || null, store_id: h.store_id || undefined, delivery_location: h.delivery_location || undefined,
      purpose: h.purpose || undefined, drawing_ref: h.drawing_ref || undefined, lookahead_plan_id: h.lookahead_plan_id || undefined,
      is_lookahead: !!h.lookahead_plan_id, device_created_at: initial ? undefined : new Date().toISOString(), submit,
      lines: ls.map((l) => ({
        id: l.id, material_spec_id: l.material_spec_id, qty: Number(l.qty), required_date: l.required_date || undefined, remarks: l.remarks || undefined,
        elements: l.element_id ? [{ id: l.elementSplitId, element_id: l.element_id, qty: Number(l.qty) }] : [],
      })),
    });
    toast.success(`${number} ${submit ? (site ? 'submitted to the office engineer' : 'submitted to the coordinator') : 'saved as draft'}`);
    onSaved(id, submit);
  });

  return (
    <Drawer size="lg" title={initial ? `Edit ${initial.number}` : site ? 'New site-use request' : 'New purchase request'}
      subtitle={site ? 'Materials from the store for site work — Office engineer review → Coordinator store order → Store keeper issues'
        : 'Materials to buy from a supplier — Coordinator review → Management approval → Procurement'}
      onClose={onClose} footer={<>
        <span className="grow muted small-text">{auth.canSeePrices && est > 0 ? <>Estimate {money(est, auth.project?.currency)}{unpriced ? ` · ${unpriced} line${unpriced === 1 ? '' : 's'} unpriced` : ''}</> : null}</span>
        <button onClick={onClose} disabled={busy}>Cancel</button>
        <button disabled={busy} onClick={() => void save(false)}>Save draft</button>
        <button className="primary" disabled={busy} onClick={() => void save(true)}>{busy && <span className="spinner" />}Submit</button>
      </>}>
      <div className="stack">
        <ErrorBanner error={error} />
        <div className="form-grid">
          <Field label="Required on site by" required><input type="date" min={today()} value={h.required_date} onChange={(e) => setH({ ...h, required_date: e.target.value })} /></Field>
          <Field label="Priority">
            <select value={h.priority} onChange={(e) => setH({ ...h, priority: e.target.value as MrPriority })}>
              <option value="normal">Normal</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
            </select>
          </Field>
          <Field label={site ? 'Issue from store' : 'Deliver to store'} required>
            <select value={h.store_id} onChange={(e) => setH({ ...h, store_id: e.target.value })}>
              <option value="">Choose…</option>
              {L.stores.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
            </select>
          </Field>
          <Field label={site ? 'Block' : 'Block (optional)'} required={site}>
            <select value={h.block_id} onChange={(e) => setH({ ...h, block_id: e.target.value })}>
              <option value="">{site ? 'Choose…' : 'Whole site / stock'}</option>
              {L.blocks.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </select>
          </Field>
          <Field label="Look-ahead plan (optional)" hint={`Link to the monthly look-ahead this ${site ? 'request' : 'purchase'} serves`}>
            <select value={h.lookahead_plan_id} onChange={(e) => setH({ ...h, lookahead_plan_id: e.target.value })}>
              <option value="">None</option>
              {(plans.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.period_label} ({p.status})</option>)}
            </select>
          </Field>
          <Field label="Drawing / spec reference"><input value={h.drawing_ref} onChange={(e) => setH({ ...h, drawing_ref: e.target.value })} /></Field>
          <Field label="Purpose" wide><textarea rows={2} value={h.purpose} placeholder="e.g. Slab L3 pour, week 46" onChange={(e) => setH({ ...h, purpose: e.target.value })} /></Field>
        </div>
        <h3 className="mb-0">Lines</h3>
        {reqEl && <Banner tone="info">{site ? 'Choose the structural element each material is for (BoQ traceability).' : 'This project requires a structural element (BoQ link) on every purchase line.'}</Banner>}
        <div className="flow-form-lines">
          {lines.map((l, i) => {
            const uom = L.specUom(l.material_spec_id);
            const p = price(l.material_spec_id);
            return (
              <div className="flow-form-line" key={l.id}>
                <Field label={`${i + 1}. Material / grade`} required>
                  <select value={l.material_spec_id} onChange={(e) => upd(i, { material_spec_id: e.target.value })}>
                    <option value="">Choose…</option>
                    {L.specs.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                </Field>
                <Field label="Quantity" required><QtyInput width={110} value={l.qty} unit={uom} min={0} onChange={(v) => upd(i, { qty: v })} aria-label={`Line ${i + 1} quantity`} /></Field>
                <Field label="Required date"><input type="date" value={l.required_date} onChange={(e) => upd(i, { required_date: e.target.value })} /></Field>
                <Field label={auth.canSeePrices ? 'Estimate' : 'BoQ element'} required={!auth.canSeePrices && reqEl}>
                  {auth.canSeePrices
                    ? <span className="muted small-text" style={{ lineHeight: 'var(--control-h)' }}>{p === null ? (l.material_spec_id ? 'No price' : '—') : `${num(p)} × ${num(Number(l.qty) || 0, 3)} = ${money(p * (Number(l.qty) || 0), auth.project?.currency)}`}</span>
                    : <ElementSelect L={L} value={l.element_id} onChange={(v) => upd(i, { element_id: v })} />}
                </Field>
                <button className="icon-btn sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
                <div className="wide2 form-grid">
                  <Field label="Purpose / remarks"><input value={l.remarks} onChange={(e) => upd(i, { remarks: e.target.value })} /></Field>
                  {auth.canSeePrices && <Field label={`BoQ element${reqEl ? ' *' : ' (optional)'}`}><ElementSelect L={L} value={l.element_id} onChange={(v) => upd(i, { element_id: v })} /></Field>}
                </div>
              </div>
            );
          })}
        </div>
        <div><button className="small" onClick={() => setLines([...lines, newLine(h.required_date)])}><Plus size={14} aria-hidden />Add line</button></div>
      </div>
    </Drawer>
  );
}

function ElementSelect({ L, value, onChange }: { L: Lookups; value: string; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not linked</option>
      {L.elements.map((e) => <option key={e.id} value={e.id}>{L.element(e.id)}</option>)}
    </select>
  );
}
