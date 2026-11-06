import { check, supabase } from '../../lib/supabase';
import { cellNum, cellStr, pick } from '../../lib/format';
import { invalidate } from '../../lib/hooks';
import { ImportWizard, type ImportRow } from '../ImportWizard';

interface BoqImport { item_no: string; description: string; unit: string; quantity: number; rate: number | null }

async function inChunks<T>(rows: T[], fn: (chunk: T[]) => Promise<void>, size = 500) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/** BoQ items from an Excel sheet (Item no, Description, Unit, Quantity, Rate). Same item no. = update. */
export function BoqExcelImport({ projectId, canSeePrices }: { projectId: string; canSeePrices: boolean }) {
  const headers = ['Item no', 'Description', 'Unit', 'Quantity', ...(canSeePrices ? ['Rate'] : [])];
  const validate = async (rows: Record<string, unknown>[]): Promise<ImportRow<BoqImport>[]> => rows.map((r, i) => {
    const rec: BoqImport = {
      item_no: cellStr(pick(r, 'Item no', 'Item', 'No')), description: cellStr(pick(r, 'Description')), unit: cellStr(pick(r, 'Unit')),
      quantity: cellNum(pick(r, 'Quantity', 'Qty')) ?? NaN, rate: canSeePrices ? cellNum(pick(r, 'Rate', 'Unit rate')) : null,
    };
    const errors: string[] = [];
    if (!rec.item_no) errors.push('Item no missing');
    if (!rec.description) errors.push('Description missing');
    if (!rec.unit) errors.push('Unit missing');
    if (!Number.isFinite(rec.quantity)) errors.push('Invalid quantity');
    return {
      rowNo: i + 2, errors, record: errors.length ? null : rec,
      display: { 'Item no': rec.item_no, Description: rec.description, Unit: rec.unit, Quantity: Number.isFinite(rec.quantity) ? String(rec.quantity) : '', Rate: rec.rate === null ? '' : String(rec.rate) },
    };
  });
  const commit = async (recs: BoqImport[]) => {
    let rated = 0;
    await inChunks(recs, async (c) => {
      const ins = check(await supabase.from('boq_items').upsert(
        c.map((r) => ({ project_id: projectId, item_no: r.item_no, description: r.description, unit: r.unit, quantity: r.quantity, deleted_at: null })),
        { onConflict: 'project_id,item_no' }).select('id, item_no')) as { id: string; item_no: string }[];
      if (canSeePrices) {
        const ids = new Map(ins.map((x) => [x.item_no, x.id]));
        const rates = c.flatMap((r) => { const id = ids.get(r.item_no); return r.rate !== null && id ? [{ boq_item_id: id, rate: r.rate }] : []; });
        if (rates.length) { check(await supabase.from('boq_rates').upsert(rates)); rated += rates.length; }
      }
    });
    invalidate('boq-items');
    return `Imported ${recs.length} BoQ items${canSeePrices ? ` (${rated} with rates)` : ''}.`;
  };
  return (
    <ImportWizard key="boq" title="Import BoQ items from Excel" templateFile="boq-template.xlsx" headers={headers} required={['Item no', 'Description', 'Unit', 'Quantity']}
      aliases={{ 'Item no': ['Item', 'No'], Quantity: ['Qty'], Rate: ['Unit rate'] }}
      example={['3.1.2', 'C-25/30 concrete in columns', 'm3', 120, ...(canSeePrices ? [7800] : [])]}
      validate={validate} commit={commit} note="Existing items with the same item no. are updated. Link the items to schedule tasks by putting the item no. in a task column (e.g. Text2) and picking it on Import schedule › Preview." />
  );
}
