// Material needs this month (v_lookahead_material_summary): need-by / order-by, supply coverage, flags,
// multi-select → Raise purchase requests / Request from store.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { date, qty } from '../../lib/format';
import { roundToPack, type LookaheadPlan, type NeedStatus } from '../../lib/contract-lookahead';
import { Badge } from '../Badge';
import { DataTable } from '../DataTable';
import { confirm } from '../Dialog';
import { FilterBar, FilterToggle } from '../Form';
import { ErrorBanner } from '../Page';
import { toast } from '../toast';
import { eatToday, planRpc, tr } from '../evm/data';
import { NeedBadge } from './chips';
import { can } from './la';

export interface MatSummary {
  plan_id: string; material_spec_id: string; label: string; category: string; uom: string; store_id: string | null; items: number;
  window_need: number; ati: number; from_stock: number; open_po_by_need_date: number; open_po_late: number; in_procurement: number; pending_pr: number;
  shortfall: number; to_order: number; suggested_qty: number; pack_size: number; need_by: string; order_by: string | null; lead_time_days: number;
  raise_pr_now: boolean; late_order: boolean; arrives_late: boolean; suggest_sur: boolean; next_po_eta: string | null; late_po_eta: string | null;
  po_numbers: string[]; mr_numbers: string[]; by_item: { item_id: string; name: string; need: number; need_by: string }[];
}
export const needStatusOf = (m: MatSummary): NeedStatus =>
  m.late_order ? 'late_order' : m.raise_pr_now ? 'raise_pr_now' : Number(m.to_order) > 0 ? 'to_order' : m.arrives_late ? 'arrives_late'
    : Number(m.in_procurement) + Number(m.pending_pr) > 0 ? 'in_procurement' : 'covered';
const RANK: Record<NeedStatus, number> = { late_order: 0, raise_pr_now: 1, to_order: 2, arrives_late: 3, in_procurement: 4, covered: 5 };

export function useMaterialSummary(planId: string | undefined) {
  return useAsync(() => fetchAll<MatSummary>((a, b) => supabase.from('v_lookahead_material_summary').select('*').eq('plan_id', planId!).order('need_by').range(a, b)),
    [planId], { key: 'la-materials', enabled: !!planId });
}

export function MaterialNeeds({ plan }: { plan: LookaheadPlan }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const today = eatToday();
  const q = useMaterialSummary(plan.id);
  const [onlyAction, setOnlyAction] = useState(false);
  const rows = (q.data ?? []).filter((m) => !onlyAction || needStatusOf(m) !== 'covered').sort((a, b) => RANK[needStatusOf(a)] - RANK[needStatusOf(b)] || a.need_by.localeCompare(b.need_by));
  const editable = plan.status !== 'closed';
  const canPr = editable && can(role, 'lookahead.raise_pr');
  const canSur = editable && can(role, 'lookahead.raise_sur');

  const raisePr = async (sel: MatSummary[], clear: () => void) => {
    const lines = sel.filter((m) => Number(m.to_order) > 0).map((m) => ({
      material_spec_id: m.material_spec_id, qty: Number(m.suggested_qty) || roundToPack(Number(m.to_order), Number(m.pack_size)), need_by: m.need_by, item_ids: m.by_item.map((b) => b.item_id),
    }));
    if (!lines.length) { toast.info('Nothing to order: the selected materials are covered by stock or open orders.'); return; }
    if (!(await confirm({ title: `Raise a purchase request for ${lines.length} material${lines.length === 1 ? '' : 's'}?`,
      body: <p className="muted mb-0">Quantities are rounded up to the pack size. The request is submitted for approval.</p>, confirm: 'Raise purchase request' }))) return;
    try {
      const r = await planRpc('create_prs_from_lookahead', { plan_id: plan.id, lines, submit: true });
      toast.success(`Purchase request ${String(r.number ?? '')} raised (${lines.length} line${lines.length === 1 ? '' : 's'})`);
      clear();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const requestStore = async (sel: MatSummary[], clear: () => void) => {
    const byItem = new Map<string, { material_spec_id: string; qty: number }[]>();
    for (const m of sel) {
      if (Number(m.from_stock) <= 0) continue;
      let left = Number(m.from_stock);
      for (const b of m.by_item) {
        const q2 = Math.min(left, Number(b.need));
        if (q2 <= 0) continue;
        left -= q2;
        byItem.set(b.item_id, [...(byItem.get(b.item_id) ?? []), { material_spec_id: m.material_spec_id, qty: q2 }]);
      }
    }
    if (!byItem.size) { toast.info('None of the selected materials are in stock.'); return; }
    if (!(await confirm({ title: `Request ${sel.length} material${sel.length === 1 ? '' : 's'} from the store?`,
      body: <p className="muted mb-0">One site-use request per task ({byItem.size}), split to elements by take-off, for the quantity covered by stock.</p>, confirm: 'Request from store' }))) return;
    let ok = 0;
    for (const [item_id, lines] of byItem) {
      try { await planRpc('create_sur_from_lookahead', { item_id, lines, submit: true }); ok++; } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    }
    if (ok) { toast.success(`${ok} site-use request${ok === 1 ? '' : 's'} created`); clear(); }
  };

  return (
    <div className="stack">
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <FilterBar active={onlyAction ? 1 : 0} onClear={() => setOnlyAction(false)}>
        <FilterToggle label={tr('Needs action only', 'እርምጃ የሚያስፈልጋቸው')} checked={onlyAction} onChange={setOnlyAction} />
        <span className="muted small-text">{tr('From take-off quantities of tasks active in the window, minus stock, open orders and requests already raised.', 'በዚህ ወር ከሚሰሩ ሥራዎች መጠን የተሰላ።')}</span>
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} rowKey={(m) => m.material_spec_id} exportName={`material-needs-${plan.period_label}`} stickyFirst
        selectable={canPr || canSur} filtered={onlyAction} onClearFilters={() => setOnlyAction(false)}
        empty={{ title: tr('No material needs', 'የግብዓት ፍላጎት የለም'), body: 'Link schedule tasks to BoQ items or elements with take-off quantities to get material needs.' }}
        bulkActions={(sel, clear) => <>
          {canPr && <button className="small primary" onClick={() => void raisePr(sel, clear)}>{tr('Raise purchase requests', 'የግዥ ጥያቄ አቅርብ')}</button>}
          {canSur && <button className="small" onClick={() => void requestStore(sel, clear)}>{tr('Request from store', 'ከመጋዘን ጠይቅ')}</button>}
        </>}
        columns={[
          { key: 'label', label: tr('Material', 'ግብዓት'), render: (m) => <>{m.label}<div className="xs-text muted">{m.items} task{m.items === 1 ? '' : 's'}</div></> },
          { key: 'window_need', label: tr('Need', 'ፍላጎት'), align: 'right', render: (m) => `${qty(m.window_need, m.uom)} ${m.uom}` },
          { key: 'ati', label: tr('In stock', 'በመጋዘን'), align: 'right', render: (m) => qty(m.ati, m.uom) },
          { key: 'open_po_by_need_date', label: tr('On order (on time)', 'የታዘዘ (በጊዜ)'), align: 'right', render: (m) => <>{qty(m.open_po_by_need_date, m.uom)}{m.po_numbers.length ? <div className="xs-text muted">{m.po_numbers.join(', ')}{m.next_po_eta ? ` · ${date(m.next_po_eta)}` : ''}</div> : null}</> },
          { key: 'open_po_late', label: tr('On order (late)', 'የታዘዘ (የዘገየ)'), align: 'right', render: (m) => (Number(m.open_po_late) ? <span className="warn-text">{qty(m.open_po_late, m.uom)}{m.late_po_eta ? ` · ${date(m.late_po_eta)}` : ''}</span> : '0') },
          { key: 'in_procurement', label: tr('Requested', 'የተጠየቀ'), align: 'right', render: (m) => <>{qty(Number(m.in_procurement) + Number(m.pending_pr), m.uom)}{m.mr_numbers.length ? <div className="xs-text muted">{m.mr_numbers.join(', ')}</div> : null}</>, value: (m) => Number(m.in_procurement) + Number(m.pending_pr) },
          { key: 'to_order', label: tr('Short', 'እጥረት'), align: 'right', render: (m) => (Number(m.to_order) > 0 ? <strong className="danger-text">{qty(m.to_order, m.uom)}</strong> : '0') },
          { key: 'suggested_qty', label: tr('Suggested order', 'የሚመከር ትዕዛዝ'), align: 'right', render: (m) => (Number(m.suggested_qty) > 0 ? `${qty(m.suggested_qty, m.uom)}${Number(m.pack_size) > 1 ? ` (pack ${qty(m.pack_size, m.uom)})` : ''}` : '') },
          { key: 'need_by', label: tr('Needed by', 'የሚያስፈልግበት'), render: (m) => date(m.need_by) },
          { key: 'order_by', label: tr('Order by', 'የሚታዘዝበት'), render: (m) => (m.order_by ? <span className={m.order_by < today ? 'danger-text strong' : ''}>{date(m.order_by)}</span> : '') },
          { key: 'status', label: tr('Status', 'ሁኔታ'), value: (m) => RANK[needStatusOf(m)], render: (m) => <span className="row nowrap"><NeedBadge status={needStatusOf(m)} />
            {m.arrives_late && needStatusOf(m) !== 'arrives_late' && <Badge tone="warning" label={tr('Arrives late', 'ዘግይቶ ይደርሳል')} icon={null} outline />}
            {m.suggest_sur && <Badge tone="info" label={tr('Request from store', 'ከመጋዘን ይጠይቁ')} icon={null} outline />}</span> },
          { key: 'chase', label: '', sortable: false, noExport: true, render: (m) => (m.arrives_late && m.po_numbers.length ? <Link to={`/procurement#pos`}>{tr('Chase PO', 'ትዕዛዙን ተከታተል')}</Link> : null) },
        ]} />
    </div>
  );
}
