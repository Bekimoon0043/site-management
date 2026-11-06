-- v_lookahead_material_needs filtered on c.plan_id (an output of app.la_material_calc), so `where plan_id = …`
-- could not be pushed down and the calculation ran for EVERY look-ahead plan before filtering — minutes per
-- request once a few plans exist. Taking plan_id / project_id from lookahead_plans lets Postgres restrict the
-- lateral call to the requested plan. Same columns, same order.
create or replace view public.v_lookahead_material_needs with (security_invoker = true) as
select pl.id as plan_id, pl.project_id, pl.period_label, c.item_id, i.name as item_name, i.window_role, i.planned_start, i.planned_finish,
       i.responsible_id, c.material_spec_id, sp.label, sp.category, sp.uom, c.element_ids,
       c.total_need, c.remaining, c.window_need, c.weekly_need, c.need_by, c.lead_time_days, c.safety_days, c.order_by, c.pack_size,
       c.ati_before, c.from_stock, c.from_po, c.from_po_late, c.from_procurement, c.from_pending_pr,
       c.short_firm, c.to_order, c.suggested_qty, c.raise_pr_now, c.late_order, c.arrives_late, c.suggest_sur,
       c.next_po_eta, c.late_po_eta, c.po_numbers, c.mr_numbers,
       case when c.late_order then 'late_order' when c.raise_pr_now then 'raise_pr_now' when c.to_order > 0 then 'to_order'
            when c.arrives_late then 'arrives_late' when c.from_procurement + c.from_pending_pr > 0 then 'in_procurement'
            else 'covered' end as need_status
from public.lookahead_plans pl
cross join lateral app.la_material_calc(pl.id) c
join public.lookahead_items i on i.id = c.item_id
join public.v_specs sp on sp.id = c.material_spec_id;
