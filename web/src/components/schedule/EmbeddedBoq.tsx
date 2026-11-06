// "The schedule IS the BoQ" parts of Import BoQ (pages/boq/BoqImport.tsx): column picker card, BoQ item preview,
// result of create_boq_from_schedule and the "Set baseline from current plan" offer.
// Server side: migration 20261030000005 (create_boq_from_schedule).
import { useMemo, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { num } from '../../lib/format';
import {
  detectEmbeddedBoq, embeddedBoqRows, type BoqDescriptionMode, type BoqItemNoFrom, type EmbeddedBoqDetection, type EmbeddedBoqFields,
  type BoqSource, type EmbeddedBoqRow,
} from '../../lib/msp';
import type { CreateBoqFromSchedulePayload, CreateBoqFromScheduleResult } from '../../lib/contract-schedule';
import { useAsync } from '../../lib/hooks';
import { Badge, Banner, Card, DataTable, ErrorBanner, Field, Loading, useBusy } from '../ui';
import { loadBoqItems, schedRpc } from './data';

export interface EmbeddedBoqCfg extends EmbeddedBoqFields {
  enabled: boolean;
  itemNoFrom: BoqItemNoFrom;
  descriptionMode: BoqDescriptionMode;
  vatIncluded: boolean;
  vatPct: number;
  setBudget: boolean;
}
export interface EmbeddedBoqState { for: BoqSource; det: EmbeddedBoqDetection; cfg: EmbeddedBoqCfg }

export function initEmbeddedBoq(s: BoqSource): EmbeddedBoqState {
  const det = detectEmbeddedBoq(s);
  return {
    for: s, det,
    cfg: {
      enabled: det.confidence === 'high' || det.confidence === 'medium',
      unitField: det.unitField, qtyField: det.qtyField, rateField: det.rateField, amountField: det.amountField,
      itemNoFrom: 'wbs', descriptionMode: 'auto', vatIncluded: det.vatIncluded, vatPct: det.vatPct ?? 15, setBudget: true,
    },
  };
}

/** create_boq_from_schedule payload (custom Cost values are already ÷ currency scale by the parser → amount_scale 1). */
export const boqPayload = (scheduleId: string, c: EmbeddedBoqCfg, canSeePrices: boolean): Omit<CreateBoqFromSchedulePayload, 'op_id'> => ({
  schedule_id: scheduleId, qty_field: c.qtyField!, unit_field: c.unitField, rate_field: c.rateField, amount_field: c.amountField,
  amount_scale: 1, vat_included: c.vatIncluded, vat_pct: c.vatPct, item_no_from: c.itemNoFrom, description_mode: c.descriptionMode,
  set_budget: canSeePrices && c.setBudget, set_ev_method: true,
});

const vatText = (c: EmbeddedBoqCfg) =>
  !c.amountField ? 'no Amount column' : c.vatIncluded ? `Amount includes ${num(c.vatPct, 0)} % VAT` : 'Amount excludes VAT';

// ---------------------------------------------------------------------------
// Column picker card with options
// ---------------------------------------------------------------------------
export function EmbeddedBoqCard({ s, state, setCfg, canSeePrices, standalone = false }: {
  s: BoqSource; state: EmbeddedBoqState; setCfg: (c: EmbeddedBoqCfg) => void; canSeePrices: boolean;
  /** Import BoQ page: no on/off switch, the column pickers are always shown. */
  standalone?: boolean;
}) {
  const c = state.cfg;
  const det = useMemo(() => detectEmbeddedBoq(s, { unitField: c.unitField, qtyField: c.qtyField, rateField: c.rateField, amountField: c.amountField }),
    [s, c.unitField, c.qtyField, c.rateField, c.amountField]);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of s.tasks) for (const [k, v] of Object.entries(t.custom)) if (v) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [s]);
  const fields = [...new Set([...s.custom_fields.map((f) => f.field_name), ...used.keys()])];
  const label = (k: string) => { const f = s.custom_fields.find((x) => x.field_name === k); return `${k}${f?.alias ? ` “${f.alias}”` : ''} · ${num(used.get(k) ?? 0, 0)} tasks`; };
  const set = (patch: Partial<EmbeddedBoqCfg>) => setCfg({ ...c, ...patch });
  const pick = (key: keyof EmbeddedBoqFields, lbl: string, required = false) => (
    <Field label={lbl} required={required}>
      <select value={c[key] ?? ''} onChange={(e) => set({ [key]: e.target.value || null } as Partial<EmbeddedBoqCfg>)}>
        {!required && <option value="">None</option>}
        {required && !c[key] && <option value="">Choose…</option>}
        {fields.map((k) => <option key={k} value={k}>{label(k)}</option>)}
      </select>
    </Field>
  );
  const detected = state.det.confidence !== 'none';
  return (
    <Card title={<><ListChecks size={16} aria-hidden /> {detected ? 'This schedule contains BoQ quantities and rates' : 'BoQ quantities in the schedule'}</>}
      sub={det.qtyField ? `${num(det.leafWithQty, 0)} items, ${vatText(c)}${det.subItems ? ` · ${num(det.subItems, 0)} a)/b) sub-items` : ''}` : 'Pick the column that holds the quantity'}>
      <div className="stack">
        {standalone ? (
          <p className="small-text muted mb-0">Each work task with a quantity becomes a BoQ item, linked to its task.</p>
        ) : (
          <Field label="Create the BoQ from this schedule (each work task with a quantity becomes a BoQ item, linked to its task)" check wide>
            <input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          </Field>
        )}
        {(standalone || c.enabled) && (
          <>
            <div className="form-grid">
              {pick('unitField', 'Unit')}{pick('qtyField', 'Quantity', true)}{pick('rateField', 'Rate (ex-VAT unit rate)')}{pick('amountField', 'Amount')}
            </div>
            {det.vatFactor != null && (
              <p className="small-text muted mb-0">
                Amount ÷ (Qty × Rate) = <b>{num(det.vatFactor, 4)}</b> on {det.consistency != null ? `${Math.round(det.consistency * 100)} %` : '—'} of the items
                {det.vatIncluded ? ` → VAT ${num(det.vatPct, 2)} % included.` : ' → no VAT in the amount.'}
                {det.consistency != null && det.consistency < 0.8 && <span className="warn-text"> Amounts don't match Qty × Rate on many items — check the columns.</span>}
              </p>
            )}
            <div className="form-grid">
              <Field label="Item numbers from">
                <select value={c.itemNoFrom} onChange={(e) => set({ itemNoFrom: e.target.value as BoqItemNoFrom })}>
                  <option value="wbs">WBS (e.g. 1.2.1.3)</option><option value="outline_number">Outline number</option>
                </select>
              </Field>
              <Field label="Descriptions" hint="Sub-items like “a) In Flat Mat slab” only make sense with their parent's name">
                <select value={c.descriptionMode} onChange={(e) => set({ descriptionMode: e.target.value as BoqDescriptionMode })}>
                  <option value="auto">Parent + name for a) / b) items</option><option value="name">Task name only</option>
                  <option value="parent_and_name">Parent + name for every item</option>
                </select>
              </Field>
              <Field label="Amount includes VAT" check><input type="checkbox" checked={c.vatIncluded} disabled={!c.amountField} onChange={(e) => set({ vatIncluded: e.target.checked })} /></Field>
              <Field label="VAT %"><input type="number" min={0} max={100} step="0.01" value={c.vatPct} onChange={(e) => set({ vatPct: Number(e.target.value) || 0 })} /></Field>
              <Field label="Set task budgets from the amounts (ex-VAT: Qty × Rate)" check wide
                hint={canSeePrices ? 'Budgets and BoQ rates are price data — only price roles see them.' : 'Your role cannot see prices: items, quantities and links are created; a coordinator or manager adds rates and budgets by running the import again.'}>
                <input type="checkbox" checked={canSeePrices && c.setBudget} disabled={!canSeePrices} onChange={(e) => set({ setBudget: e.target.checked })} />
              </Field>
            </div>
            <p className="small-text muted mb-0">Earned value for these tasks is measured by BoQ quantity done.</p>
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Preview of the items to create
// ---------------------------------------------------------------------------
export function EmbeddedBoqStep({ s, cfg, projectId, canSeePrices, onBack, onNext, nextLabel = 'Next: Confirm ›', busy = false }: {
  s: BoqSource; cfg: EmbeddedBoqCfg; projectId: string; canSeePrices: boolean; onBack: () => void; onNext: () => void;
  nextLabel?: string; busy?: boolean;
}) {
  const boq = useAsync(() => loadBoqItems(projectId), [projectId], { key: 'boq-items', staleTime: 5 * 60_000 });
  const rows = useMemo(() => embeddedBoqRows(s, cfg, { itemNoFrom: cfg.itemNoFrom, descriptionMode: cfg.descriptionMode, vatIncluded: cfg.vatIncluded, vatPct: cfg.vatPct }), [s, cfg]);
  const leaves = s.tasks.filter((t) => !t.is_summary).length;
  const existing = useMemo(() => new Set((boq.data ?? []).map((b) => b.item_no.toLowerCase())), [boq.data]);
  const overlap = rows.filter((r) => existing.has(r.item_no.toLowerCase())).length;
  const noUnit = rows.filter((r) => !r.unit).length;
  const noRate = rows.filter((r) => r.rate_ex_vat == null).length;
  const tot = rows.reduce((a, r) => ({ ex: a.ex + (r.amount_ex_vat ?? 0), inc: a.inc + (r.amount_incl_vat ?? 0) }), { ex: 0, inc: 0 });
  if (!boq.data && !boq.error) return <Loading lines={6} />;
  return (
    <>
      <Card title={`${num(rows.length, 0)} BoQ items will be created from the schedule`}
        sub={`${num(s.tasks.length - leaves, 0)} summary tasks and ${num(leaves - rows.length, 0)} tasks without a quantity are skipped`}>
        <div className="imp-summary">
          <span><b>{num(rows.length, 0)}</b> items</span>
          <span><b>{num(rows.filter((r) => r.sub_item).length, 0)}</b> a)/b) sub-items</span>
          {canSeePrices && <><span>Total ex VAT <b>{num(tot.ex, 2)}</b></span><span>incl. {num(cfg.vatPct, 0)} % VAT <b>{num(tot.inc, 2)}</b></span></>}
        </div>
        <div className="stack mt-2">
          {overlap > 0 && <Banner tone="warn">{num(overlap, 0)} item number(s) already exist in the project BoQ — they will be updated from the schedule (description, unit, quantity{canSeePrices ? ', rate' : ''}).</Banner>}
          {noUnit > 0 && <Banner tone="warn">{num(noUnit, 0)} item(s) have no unit — saved as “item”.</Banner>}
          {noRate > 0 && <Banner tone="warn">{num(noRate, 0)} item(s) have no rate or amount.</Banner>}
          {!canSeePrices && <Banner tone="info">Rates and budgets are not saved with your role. Quantities, links and the EV method are.</Banner>}
          <ErrorBanner error={boq.error} />
        </div>
      </Card>
      <Card flush>
        <DataTable rows={rows} rowKey={(r: EmbeddedBoqRow) => String(r.uid)} maxHeight="55vh" stickyFirst
          columns={[
            { key: 'item_no', label: 'Item', id: true },
            { key: 'description', label: 'Description', render: (r) => <span>{r.description}{existing.has(r.item_no.toLowerCase()) && <> <Badge tone="info" label="update" icon={null} /></>}</span> },
            { key: 'unit', label: 'Unit', render: (r) => r.unit ?? <span className="warn-text">—</span> },
            { key: 'qty', label: 'Qty', align: 'right', render: (r) => num(r.qty, 3) },
            ...(canSeePrices ? [
              { key: 'rate_ex_vat', label: 'Rate ex VAT', align: 'right' as const, render: (r: EmbeddedBoqRow) => num(r.rate_ex_vat, 2) },
              { key: 'amount_ex_vat', label: 'Amount ex VAT', align: 'right' as const, render: (r: EmbeddedBoqRow) => num(r.amount_ex_vat, 2) },
              { key: 'amount_incl_vat', label: 'incl. VAT', align: 'right' as const, render: (r: EmbeddedBoqRow) => num(r.amount_incl_vat, 2) },
            ] : []),
          ]} />
      </Card>
      <div className="imp-actions">
        <button onClick={onBack} disabled={busy}>‹ Back</button>
        <button className="primary" disabled={!rows.length || busy} onClick={onNext}>{busy && <span className="spinner" />}{nextLabel}</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Result: create_boq_from_schedule outcome + baseline offer
// ---------------------------------------------------------------------------
export interface BoqRunState { payload: Omit<CreateBoqFromSchedulePayload, 'op_id'>; res?: CreateBoqFromScheduleResult; error?: string }

export function BoqResult({ st, onRetry }: { st: BoqRunState; onRetry: () => void }) {
  const r = st.res;
  if (st.error) return <Banner tone="error" action={<button className="small" onClick={onRetry}>Try again</button>}>Creating the BoQ failed: {st.error}</Banner>;
  if (!r) return <Banner tone="info"><span className="spinner" /> Creating the BoQ from the schedule…</Banner>;
  return (
    <Card title="BoQ created from the schedule" sub={`Fields: ${[r.fields.unit, r.fields.qty, r.fields.rate, r.fields.amount].filter(Boolean).join(' · ')}${r.vat_included ? ` · Amount incl. ${num(r.vat_pct, 0)} % VAT` : ''}`}>
      <div className="imp-summary">
        <span><b>{num(r.items_created, 0)}</b> new items</span><span><b>{num(r.items_updated, 0)}</b> updated</span>
        <span><b>{num(r.items_unchanged, 0)}</b> unchanged</span><span><b>{num(r.links, 0)}</b> task links</span>
        <span><b>{num(r.ev_methods_set, 0)}</b> tasks now earn by quantity</span>
        <span>Skipped: <b>{num(r.skipped.summaries, 0)}</b> summaries, <b>{num(r.skipped.no_qty, 0)}</b> without qty</span>
        {r.total_amount_ex_vat != null && <span>Total ex VAT <b>{num(r.total_amount_ex_vat, 2)}</b> · incl. VAT <b>{num(r.total_amount_incl_vat, 2)}</b></span>}
        {r.budgets_saved > 0 && <span><b>{num(r.budgets_saved, 0)}</b> task budgets</span>}
      </div>
      {r.warnings.length > 0 && (
        <details className="mt-2"><summary className="small-text">{r.warnings.length} note(s)</summary>
          <ul className="small-text">{r.warnings.slice(0, 80).map((w, i) => <li key={i}>{w}</li>)}</ul></details>
      )}
    </Card>
  );
}

/** Offered when the schedule has no approved baseline: the imported dates become the baseline. */
export function BaselineOffer({ scheduleId, canSeePrices, hasBoq }: { scheduleId: string; canSeePrices: boolean; hasBoq: boolean }) {
  const { busy, error, run } = useBusy();
  const [done, setDone] = useState<Record<string, unknown> | null>(null);
  const go = () => void run(async () => {
    setDone(await schedRpc('set_baseline', { id: crypto.randomUUID(), schedule_id: scheduleId, source: 'current_plan',
      ...(canSeePrices ? { cost_source: 'value' as const } : {}), name: 'Contract baseline' }));
  });
  if (done) {
    return (
      <Banner tone="ok">Baseline #{String(done.baseline_no)} proposed from the current plan ({num(done.tasks, 0)} tasks
        {done.bac_value != null ? `, budget ${num(done.bac_value, 2)} ex VAT` : ''}) — a coordinator or manager approves it under Schedule › Baselines.</Banner>
    );
  }
  return (
    <Card title="No approved baseline yet" sub="Earned value needs an approved baseline. The imported dates can become the baseline.">
      <ErrorBanner error={error} />
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="primary" disabled={busy} onClick={go}>{busy && <span className="spinner" />}Set baseline from current plan</button>
        <span className="small-text muted">{hasBoq ? 'Task budgets = BoQ quantity × ex-VAT rate (the amounts without VAT).' : 'Task budgets come from the BoQ links (quantity × rate).'}</span>
      </div>
    </Card>
  );
}

export async function runCreateBoq(payload: BoqRunState['payload']): Promise<CreateBoqFromScheduleResult> {
  return (await schedRpc('create_boq_from_schedule', { ...payload, op_id: crypto.randomUUID() })) as unknown as CreateBoqFromScheduleResult;
}
