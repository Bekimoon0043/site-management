// Material costing views (20261103000020): materials are cost when USED (issued to work, wastage, count
// variances), valued at moving average cost; purchases are commitments and stock on hand is inventory.
// Price roles only — callers render these only when auth.canSeePrices.
import { useMemo, useState } from 'react';
import { useAsync } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { money, num } from '../../lib/format';
import type { InventoryValueRow, MaterialCostRow } from '../../lib/contract-costing';
import { Badge, Card, DataTable, Kpi, Tabs } from '../ui';

export const loadInventoryValue = (projectId: string) =>
  fetchAll<InventoryValueRow>((a, b) => supabase.from('v_inventory_value').select('*').eq('project_id', projectId).order('label').range(a, b));

interface SpecAgg {
  key: string; label: string; category: string; uom: string; committed: number; received_qty: number; received_value: number;
  issued_qty: number; used_value: number; wastage_qty: number; wastage_value: number; allowance: number | null; wastage_pct: number | null;
}

/** Material actuals per material (or BoQ item): committed / received into stock / used (= actual cost) / wastage vs allowance. */
export function MaterialActuals({ projectId, cur }: { projectId: string; cur: string }) {
  const [by, setBy] = useState<'spec' | 'boq' | 'category'>('spec');
  const q = useAsync(() => fetchAll<MaterialCostRow>((a, b) => supabase.from('v_material_cost').select('*').eq('project_id', projectId).range(a, b)),
    [projectId], { key: 'material-cost' });
  const rows = useMemo(() => {
    const m = new Map<string, SpecAgg>();
    for (const r of q.data ?? []) {
      const key = by === 'spec' ? r.material_spec_id : by === 'category' ? r.category : (r.boq_item_id ?? '—');
      const label = by === 'spec' ? r.label : by === 'category' ? r.category : r.boq_item_id ? `${r.boq_item_no ?? ''} ${r.boq_description ?? ''}`.trim() : 'Not linked to a BoQ item';
      const a = m.get(key) ?? { key, label, category: r.category, uom: by === 'spec' ? r.uom : '', committed: 0, received_qty: 0, received_value: 0,
        issued_qty: 0, used_value: 0, wastage_qty: 0, wastage_value: 0, allowance: by === 'spec' ? Number(r.allowance_pct ?? 0) : null, wastage_pct: null };
      a.committed += Number(r.committed); a.received_qty += Number(r.received_qty); a.received_value += Number(r.received_value);
      a.issued_qty += Number(r.issued_qty); a.used_value += Number(r.used_value); a.wastage_qty += Number(r.wastage_qty); a.wastage_value += Number(r.wastage_value);
      m.set(key, a);
    }
    for (const a of m.values()) a.wastage_pct = by === 'spec' && a.issued_qty + a.wastage_qty > 0 ? (100 * a.wastage_qty) / (a.issued_qty + a.wastage_qty) : null;
    return [...m.values()].sort((x, y) => y.used_value - x.used_value);
  }, [q.data, by]);
  const tot = rows.reduce((s, r) => ({ c: s.c + r.committed, r: s.r + r.received_value, u: s.u + r.used_value, w: s.w + r.wastage_value }), { c: 0, r: 0, u: 0, w: 0 });
  const over = (r: SpecAgg) => r.allowance !== null && r.wastage_pct !== null && r.wastage_pct > r.allowance + 0.05;

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Committed (open POs)" value={money(tot.c, cur)} loading={!q.data} />
        <Kpi label="Received into stock" value={money(tot.r, cur)} loading={!q.data} hint="inventory, not yet cost" />
        <Kpi label="Used — actual cost" value={money(tot.u, cur)} loading={!q.data} hint="issued − returned + wastage ± counts" />
        <Kpi label="Wastage & losses" value={money(tot.w, cur)} loading={!q.data} status={rows.some(over) ? 'warning' : undefined} />
      </div>
      <Card flush title="Material actuals" sub="Ex-VAT at moving average cost. Shown even without budget lines."
        actions={<Tabs variant="segmented" label="Group by" value={by} onChange={setBy} tabs={[{ key: 'spec', label: 'Material' }, { key: 'boq', label: 'BoQ item' }, { key: 'category', label: 'Category' }]} />}>
        <DataTable rows={rows} rowKey={(r) => r.key} loading={!q.data} error={q.error} onRetry={q.reload} exportName={`material-actuals-${by}`} stickyFirst maxHeight="none"
          rowClass={(r) => (over(r) ? 'row-warn' : undefined)}
          empty={{ title: 'No material movements yet', body: 'Values appear once material is received, issued or written off.' }}
          columns={[
            { key: 'label', label: by === 'spec' ? 'Material' : by === 'boq' ? 'BoQ item' : 'Category', id: true },
            ...(by !== 'category' ? [{ key: 'category', label: 'Category' } as const] : []),
            { key: 'committed', label: 'Committed', align: 'right', render: (r) => money(r.committed, cur) },
            { key: 'received_value', label: 'Received', align: 'right', render: (r) => money(r.received_value, cur) },
            ...(by === 'spec' ? [{ key: 'issued_qty', label: 'Net issued', align: 'right' as const, render: (r: SpecAgg) => `${num(r.issued_qty, 2)} ${r.uom}` }] : []),
            { key: 'used_value', label: 'Used (actual)', align: 'right', render: (r) => <strong>{money(r.used_value, cur)}</strong> },
            { key: 'wastage_value', label: 'Wastage', align: 'right', render: (r) => (r.wastage_value ? money(r.wastage_value, cur) : '—') },
            ...(by === 'spec' ? [{ key: 'wastage_pct', label: 'Wastage % / allowed', align: 'right' as const,
              value: (r: SpecAgg) => r.wastage_pct ?? -1,
              render: (r: SpecAgg) => (r.wastage_pct === null ? '—' : <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                {num(r.wastage_pct, 1)} % / {num(r.allowance, 1)} %{over(r) && <Badge tone="warning" label="over allowance" icon={null} />}</span>) }] : []),
          ]} />
      </Card>
    </div>
  );
}

/** Stock on hand at average cost per store × material, with totals (price roles). */
export function InventoryValue({ projectId, cur, compact = false }: { projectId: string; cur: string; compact?: boolean }) {
  const q = useAsync(() => loadInventoryValue(projectId), [projectId], { key: 'inventory-value' });
  const byStore = useMemo(() => {
    const m = new Map<string, { name: string; value: number }>();
    for (const r of q.data ?? []) { const s = m.get(r.store_id) ?? { name: r.store_name, value: 0 }; s.value += Number(r.value); m.set(r.store_id, s); }
    return [...m.values()];
  }, [q.data]);
  const total = byStore.reduce((s, x) => s + x.value, 0);
  if (compact) {
    return (
      <div className="kpis">
        <Kpi label="Inventory value" value={money(total, cur)} loading={!q.data} hint="on hand at average cost, ex-VAT" />
        {byStore.slice(0, 3).map((s) => <Kpi key={s.name} label={s.name} value={money(s.value, cur)} />)}
      </div>
    );
  }
  return (
    <Card flush title="Inventory on hand" sub={`${money(total, cur)} at moving average cost (ex-VAT) · quarantined stock not valued`}>
      <DataTable rows={q.data ?? []} rowKey={(r) => `${r.store_id}:${r.material_spec_id}`} loading={!q.data} error={q.error} onRetry={q.reload}
        exportName="inventory-value" stickyFirst maxHeight="none" empty="No stock on hand."
        columns={[
          { key: 'label', label: 'Material', id: true },
          { key: 'store_name', label: 'Store' },
          { key: 'category', label: 'Category' },
          { key: 'qty', label: 'On hand', align: 'right', render: (r) => `${num(r.qty, 3)} ${r.uom}` },
          { key: 'avg_cost', label: 'Average cost', align: 'right', render: (r) => (r.avg_cost == null ? '—' : money(r.avg_cost, cur)) },
          { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value, cur) },
        ]} />
    </Card>
  );
}
