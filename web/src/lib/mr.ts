// Material request detail loader + approval helpers, shared by the detail page and the approvals inbox.
import type { MaterialRequest, MrEvent, MrLineElement } from './contract';
import { check, supabase } from './supabase';
import { num } from './format';

export interface LineStatus {
  mr_line_id: string; line_no: number; material_spec_id: string; label: string; uom: string; qty: number; approved_qty: number | null;
  required_date: string; issued_qty: number; remaining_qty: number;
}

/** Loads everything the MR detail and the approval inbox preview need. */
export async function loadMrDetail(id: string) {
  const mr = check(await supabase.from('material_requests').select('*').eq('id', id).maybeSingle()) as MaterialRequest | null;
  if (!mr) throw new Error('Request not found or not in your projects');
  const [lines, extra, elements, events, stock, issues] = await Promise.all([
    supabase.from('v_mr_line_status').select('*').eq('mr_id', id).order('line_no').then(check),
    supabase.from('mr_lines').select('id, remarks, exceeds_boq, over_boq_reason').eq('mr_id', id).is('deleted_at', null).then(check),
    supabase.from('mr_line_elements').select('*, mr_lines!inner(mr_id)').eq('mr_lines.mr_id', id).is('deleted_at', null).then(check),
    supabase.from('mr_events').select('*').eq('mr_id', id).order('created_at', { ascending: false }).then(check),
    supabase.from('v_stock_balance').select('material_spec_id, qty').eq('project_id', mr.project_id).eq('stock_status', 'available').then(check),
    supabase.from('mivs').select('id, number, issued_at, issued_to, acknowledged_at, status, miv_lines(mr_line_id, qty)').eq('mr_id', id).then(check),
  ]);
  const avail = new Map<string, number>();
  for (const s of stock as { material_spec_id: string; qty: number }[]) avail.set(s.material_spec_id, (avail.get(s.material_spec_id) ?? 0) + Number(s.qty));
  return {
    mr, lines: lines as LineStatus[], extra: new Map((extra as { id: string; remarks: string | null; exceeds_boq: boolean; over_boq_reason: string | null }[]).map((e) => [e.id, e])),
    elements: elements as MrLineElement[], events: events as MrEvent[], avail,
    issues: issues as { id: string; number: string; issued_at: string; issued_to: string; acknowledged_at: string | null; status: string; miv_lines: { mr_line_id: string; qty: number }[] }[],
  };
}
export type MrDetail = Awaited<ReturnType<typeof loadMrDetail>>;

/** Approve qty per line; returns only lines approved below requested (FR-WF-03). */
export function partialLines(lines: LineStatus[], qty: Record<string, string>) {
  for (const l of lines) {
    const v = Number(qty[l.mr_line_id]);
    if (!Number.isFinite(v) || v < 0 || v > Number(l.qty)) throw new Error(`Line ${l.line_no}: approved quantity must be between 0 and ${num(l.qty, 3)}`);
  }
  return lines.filter((l) => Number(qty[l.mr_line_id]) < Number(l.qty)).map((l) => ({ id: l.mr_line_id, approved_qty: Number(qty[l.mr_line_id]) }));
}

