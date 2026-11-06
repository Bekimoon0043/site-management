// Verified quantity per BoQ item when verifying a 'units' progress report (verify_task_progress verified_qty):
// the office engineer can take the reported to-date quantity or enter the measured one (= "adjusted").
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { num } from '../../lib/format';
import { Field } from '../ui';

type Qty = { boq_item_id: string; qty_to_date: number }[] | null | undefined;
export type QtyDraft = Record<string, string>;

export const initQtyDraft = (qty: Qty): QtyDraft => Object.fromEntries((qty ?? []).map((x) => [x.boq_item_id, String(Number(x.qty_to_date))]));
export const qtyAdjusted = (qty: Qty, d: QtyDraft) => (qty ?? []).some((x) => d[x.boq_item_id] !== undefined && Number(d[x.boq_item_id]) !== Number(x.qty_to_date));
export const qtyInvalid = (qty: Qty, d: QtyDraft) => (qty ?? []).some((x) => { const v = Number(d[x.boq_item_id] ?? x.qty_to_date); return !Number.isFinite(v) || v < 0; });
export const verifiedQty = (qty: Qty, d: QtyDraft) => (qty ?? []).map((x) => ({ boq_item_id: x.boq_item_id, qty_to_date: Number(d[x.boq_item_id] ?? x.qty_to_date) }));

interface LinkRow { boq_item_id: string; qty_share: number; verified_qty: number; boq_items: { item_no: string; description: string; unit: string } | null }

export function VerifyQtyFields({ taskId, qty, draft, setDraft }: { taskId: string; qty: Qty; draft: QtyDraft; setDraft: (d: QtyDraft) => void }) {
  const links = useAsync(async () => check(await supabase.from('task_boq_links').select('boq_item_id, qty_share, verified_qty, boq_items(item_no, description, unit)' as '*')
    .eq('task_id', taskId).is('deleted_at', null)) as LinkRow[], [taskId], { key: 'task-boq-labels', staleTime: 60_000 });
  if (!qty?.length) return null;
  const byId = new Map((links.data ?? []).map((l) => [l.boq_item_id, l]));
  return (
    <>
      {qty.map((x) => {
        const l = byId.get(x.boq_item_id);
        return (
          <Field key={x.boq_item_id} label={`Verified to date — ${l?.boq_items?.item_no ?? 'BoQ item'}${l?.boq_items?.unit ? ` (${l.boq_items.unit})` : ''}`}
            hint={l ? `Reported ${num(x.qty_to_date, 2)} · verified before ${num(l.verified_qty, 2)} · planned ${num(l.qty_share, 2)}` : `Reported ${num(x.qty_to_date, 2)}`}>
            <input type="number" min={0} step="any" inputMode="decimal" value={draft[x.boq_item_id] ?? ''} style={{ width: 150 }}
              onChange={(e) => setDraft({ ...draft, [x.boq_item_id]: e.target.value })} aria-label={`Verified quantity ${l?.boq_items?.item_no ?? ''}`} />
          </Field>
        );
      })}
    </>
  );
}
