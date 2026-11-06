-- =============================================================================
-- Site-use / store workflow fixes found in the end-to-end run on the real 2B+G+15 schedule.
-- 1. app.la_material_calc: an element linked to several tasks (drill, rebar, pour of one pile group) put its
--    whole take-off on every one of them, so the look-ahead tripled the rebar need and gave the stock to the
--    drilling task. A take-off tagged with a BoQ item now only counts for tasks delivering that item (or tasks
--    without BoQ links).
-- 2. create_sur_from_lookahead: "Block is required" for schedule items without an element — the block now falls
--    back to the task's linked elements, the task's block, or the project's only block.
-- =============================================================================

create or replace function app.la_material_calc(p_plan uuid) returns setof app.la_material_row
language plpgsql stable set search_path = public as $$
declare
  v_today date := app.la_today();
  v_project uuid; v_start date; v_end date; v_hor date;
  v_items uuid[];
  d record;
  r app.la_material_row;
  v_spec uuid := null;
  v_ati numeric; v_proc numeric; v_pend numeric; v_mrs text[];
  v_po_eta date[]; v_po_qty numeric[]; v_po_no text[];
  v_rem numeric; v_take numeric; v_share numeric; k int; v_pos text[];
begin
  select project_id, period_start, period_end, horizon_end into v_project, v_start, v_end, v_hor
    from public.lookahead_plans where id = p_plan;
  if v_project is null then return; end if;
  select coalesce(array_agg(id), '{}') into v_items from public.lookahead_items where plan_id = p_plan;

  for d in
    with it as materialized (
      select i.id, i.schedule_task_id, i.sort_key, x.s, x.f, x.pct,
             app.la_wd(v_project, greatest(x.s, v_today), x.f) as den,
             app.la_wd(v_project, greatest(x.s, v_today, v_start), least(x.f, v_hor)) as num,
             coalesce((select jsonb_object_agg(w.week_start::text,
                         app.la_wd(v_project, greatest(x.s, v_today, w.week_start), least(x.f, w.week_end)))
                       from public.lookahead_weeks w where w.plan_id = p_plan), '{}'::jsonb) as wk,
             (select min(w.week_start) from public.lookahead_weeks w where w.plan_id = p_plan and w.week_end >= greatest(x.s, v_start)) as first_ws
      from public.lookahead_items i
      cross join lateral (select coalesce(i.planned_start, v_start) as s,
                                 greatest(coalesce(i.planned_finish, i.planned_start, v_start), coalesce(i.planned_start, v_start)) as f,
                                 least(greatest(coalesce(i.pct_complete, 0), 0), 100) as pct) x
      where i.plan_id = p_plan and i.status = 'active' and i.schedule_task_id is not null and not i.is_milestone
    ),
    links as (
      select it.id as item_id, it.schedule_task_id as task_id, l.element_id
      from it join public.task_element_links l on l.task_id = it.schedule_task_id
      where (to_jsonb(l) ->> 'deleted_at') is null
    ),
    rows_direct as (
      select lk.item_id, t.element_id, t.material_spec_id, t.planned_qty * (1 + ms.wastage_pct / 100) as need, 1::numeric as share
      from links lk
      join public.element_takeoffs t on t.element_id = lk.element_id and t.deleted_at is null
        -- a take-off tagged with a BoQ item belongs to the tasks delivering that item, not to every task on the element
        -- (drilling / rebar / concrete tasks of one pile group must not each carry its whole rebar take-off)
        and (t.boq_item_id is null
             or not exists (select 1 from public.task_boq_links b0 where b0.task_id = lk.task_id and (to_jsonb(b0) ->> 'deleted_at') is null)
             or exists (select 1 from public.task_boq_links b1 where b1.task_id = lk.task_id and b1.boq_item_id = t.boq_item_id
                          and (to_jsonb(b1) ->> 'deleted_at') is null))
      join public.material_specs ms on ms.id = t.material_spec_id
    ),
    rows_boq as (
      select it.id as item_id, t.element_id, t.material_spec_id, t.planned_qty * (1 + ms.wastage_pct / 100) as need, sh.share
      from it
      join public.task_boq_links b on b.task_id = it.schedule_task_id and (to_jsonb(b) ->> 'deleted_at') is null
      join public.boq_items bq on bq.id = b.boq_item_id
      -- qty_share = BoQ quantity (item unit) delivered by this task → share of the item's take-off.
      cross join lateral (select coalesce((to_jsonb(b) ->> 'qty_share')::numeric, (to_jsonb(b) ->> 'planned_qty')::numeric) as raw) r0
      cross join lateral (select case when r0.raw is null or bq.quantity <= 0 then 1
                                      else least(greatest(r0.raw, 0) / bq.quantity, 1) end as share) sh
      join public.element_takeoffs t on t.boq_item_id = b.boq_item_id and t.deleted_at is null and t.project_id = v_project
      join public.material_specs ms on ms.id = t.material_spec_id
      where not exists (select 1 from links lk where lk.item_id = it.id and lk.element_id = t.element_id)
    ),
    rws as (select * from rows_direct union all select * from rows_boq),
    agg as (
      select rw.item_id, rw.material_spec_id, array_agg(distinct rw.element_id) as els,
             sum(rw.need * rw.share) as total_need,
             sum(greatest(rw.need * rw.share - greatest(rw.need * rw.share * it.pct / 100, coalesce(iss.qty, 0) * rw.share), 0)) as remaining
      from rws rw
      join it on it.id = rw.item_id
      left join lateral (select -sum(sl.qty) as qty from public.stock_ledger sl
                         where sl.element_id = rw.element_id and sl.material_spec_id = rw.material_spec_id
                           and sl.doc_type in ('miv','mrn')) iss on true
      group by rw.item_id, rw.material_spec_id
    )
    select a.item_id, a.material_spec_id, a.els, a.total_need, a.remaining, it.s, it.f, it.den, it.num, it.wk, it.first_ws,
           it.sort_key, ms.lead_time_days, ms.safety_days, ms.pack_size
    from agg a join it on it.id = a.item_id join public.material_specs ms on ms.id = a.material_spec_id
    where a.remaining > 0.0005
    order by a.material_spec_id, greatest(it.s, v_start), it.sort_key, a.item_id
  loop
    v_share := case when d.den > 0 then least(d.num / d.den, 1) else 1 end;
    if round(d.remaining * v_share, 3) <= 0.0005 then continue; end if;

    if v_spec is distinct from d.material_spec_id then
      v_spec := d.material_spec_id;
      select coalesce(sum(sl.qty), 0) into v_ati from public.stock_ledger sl
        where sl.project_id = v_project and sl.material_spec_id = v_spec and sl.stock_status = 'available';
      v_ati := greatest(v_ati - coalesce((
        select sum(greatest(coalesce(ml.approved_qty, 0) - coalesce(x.issued, 0), 0))
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        left join lateral (select sum(vl.qty) as issued from public.miv_lines vl
                           join public.mivs mv on mv.id = vl.miv_id and mv.status <> 'reversed' where vl.mr_line_id = ml.id) x on true
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'site_use' and mr.status::text in ('approved','sourced','ordered','partially_issued')
          and (ml.lookahead_item_id is null or not (ml.lookahead_item_id = any (v_items)))), 0), 0);
      select coalesce(array_agg(ps.expected_date order by ps.expected_date nulls last, ps.po_number), '{}'),
             coalesce(array_agg(ps.outstanding_qty order by ps.expected_date nulls last, ps.po_number), '{}'),
             coalesce(array_agg(ps.po_number::text order by ps.expected_date nulls last, ps.po_number), '{}')
        into v_po_eta, v_po_qty, v_po_no
        from public.v_po_line_status ps
        where ps.project_id = v_project and ps.material_spec_id = v_spec
          and ps.po_status in ('approved','sent','partially_received') and ps.outstanding_qty > 0;
      select coalesce(sum(greatest(coalesce(ml.approved_qty, ml.qty) - coalesce(pp.ordered_qty, 0), 0)), 0) into v_proc
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        left join public.v_mr_line_procurement pp on pp.mr_line_id = ml.id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('approved','approved_by_management','with_procurement','sourced');
      select coalesce(sum(ml.qty), 0) into v_pend
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('draft','submitted','reviewed','reviewed_by_coordinator','returned')
          and (mr.status::text <> 'draft' or mr.lookahead_plan_id = p_plan or ml.lookahead_item_id = any (v_items));
      select coalesce(array_agg(distinct mr.number), '{}') into v_mrs
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('draft','submitted','reviewed','reviewed_by_coordinator','returned',
                                  'approved','approved_by_management','with_procurement','sourced')
          and (mr.status::text <> 'draft' or mr.lookahead_plan_id = p_plan or ml.lookahead_item_id = any (v_items));
    end if;

    r := null;
    r.plan_id := p_plan; r.project_id := v_project; r.item_id := d.item_id; r.material_spec_id := d.material_spec_id;
    r.element_ids := d.els;
    r.total_need := round(d.total_need, 3);
    r.remaining := round(d.remaining, 3);
    r.window_need := round(d.remaining * v_share, 3);
    r.lead_time_days := d.lead_time_days; r.safety_days := d.safety_days; r.pack_size := d.pack_size;
    r.need_by := app.la_shift(v_project, greatest(d.s, v_start), -d.safety_days);
    r.order_by := app.la_shift(v_project, r.need_by, -d.lead_time_days);
    if d.den > 0 then
      select coalesce(jsonb_object_agg(e.key, round(d.remaining * e.value::numeric / d.den, 3)) filter (where e.value::numeric > 0), '{}'::jsonb)
        into r.weekly_need from jsonb_each_text(d.wk) e;
    else
      r.weekly_need := case when d.first_ws is not null then jsonb_build_object(d.first_ws::text, r.window_need) else '{}'::jsonb end;
    end if;

    -- allocation
    v_rem := r.window_need;
    r.ati_before := round(v_ati, 3);
    r.from_stock := least(v_rem, v_ati); v_ati := v_ati - r.from_stock; v_rem := v_rem - r.from_stock;
    r.from_po := 0; r.from_po_late := 0; v_pos := '{}';
    for k in 1 .. coalesce(array_length(v_po_eta, 1), 0) loop
      exit when v_rem <= 0.0005;
      if v_po_qty[k] > 0.0005 and v_po_eta[k] is not null and v_po_eta[k] <= r.need_by then
        v_take := least(v_rem, v_po_qty[k]);
        v_po_qty[k] := v_po_qty[k] - v_take; v_rem := v_rem - v_take; r.from_po := r.from_po + v_take;
        v_pos := v_pos || v_po_no[k];
        r.next_po_eta := coalesce(r.next_po_eta, v_po_eta[k]);
      end if;
    end loop;
    r.short_firm := round(greatest(v_rem, 0), 3);
    for k in 1 .. coalesce(array_length(v_po_eta, 1), 0) loop
      exit when v_rem <= 0.0005;
      if v_po_qty[k] > 0.0005 then
        v_take := least(v_rem, v_po_qty[k]);
        v_po_qty[k] := v_po_qty[k] - v_take; v_rem := v_rem - v_take; r.from_po_late := r.from_po_late + v_take;
        v_pos := v_pos || v_po_no[k];
        r.late_po_eta := coalesce(r.late_po_eta, v_po_eta[k]);
      end if;
    end loop;
    r.from_procurement := least(greatest(v_rem, 0), v_proc); v_proc := v_proc - r.from_procurement; v_rem := v_rem - r.from_procurement;
    r.from_pending_pr := least(greatest(v_rem, 0), v_pend); v_pend := v_pend - r.from_pending_pr; v_rem := v_rem - r.from_pending_pr;
    r.from_stock := round(r.from_stock, 3); r.from_po := round(r.from_po, 3); r.from_po_late := round(r.from_po_late, 3);
    r.from_procurement := round(r.from_procurement, 3); r.from_pending_pr := round(r.from_pending_pr, 3);
    r.to_order := round(greatest(v_rem, 0), 3);
    r.suggested_qty := case when r.to_order > 0.0005 then ceil(r.to_order / r.pack_size) * r.pack_size else 0 end;
    r.raise_pr_now := r.to_order > 0.0005 and r.order_by <= v_today + 7;
    r.late_order := r.to_order > 0.0005 and r.order_by < v_today;
    r.arrives_late := r.from_po_late > 0.0005;
    r.suggest_sur := r.from_stock > 0.0005 and r.need_by <= v_today + 14;
    r.po_numbers := (select coalesce(array_agg(distinct x), '{}') from unnest(v_pos) x);
    r.mr_numbers := case when r.from_procurement + r.from_pending_pr > 0 then v_mrs else '{}' end;
    return next r;
  end loop;
end $$;

create or replace function public.create_sur_from_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  i public.lookahead_items;
  pl public.lookahead_plans;
  w public.lookahead_weeks;
  v_today date := app.la_today();
  v_store uuid;
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_number text;
  v_mr_lines jsonb := '[]'::jsonb;
  v_els jsonb;
  l record;
  e record;
  v_qty numeric; v_left numeric; v_part numeric; v_tot numeric; v_n int; v_k int;
  v_req date;
  v_block uuid;
  v_res jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into i from public.lookahead_items where id = (p ->> 'item_id')::uuid;
  if not found then raise exception 'Look-ahead item not found'; end if;
  select * into pl from public.lookahead_plans where id = i.plan_id;
  perform app.require_member(i.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  if app.has_role('site_engineer') and i.responsible_id is not null and i.responsible_id <> auth.uid() then
    raise exception 'Only the responsible site engineer can request materials for "%"', i.name;
  end if;
  if p ->> 'week_id' is not null then
    select * into w from public.lookahead_weeks where id = (p ->> 'week_id')::uuid and plan_id = pl.id;
    if not found then raise exception 'Week not found in this look-ahead'; end if;
  end if;
  v_store := coalesce((p ->> 'store_id')::uuid,
    (select id from public.stores where project_id = i.project_id and deleted_at is null order by (store_type = 'main') desc, created_at limit 1));
  perform app.require_store(i.project_id, v_store);

  for l in
    select c.material_spec_id as spec, c.need_by, c.element_ids, c.from_stock,
           case when w.id is not null then coalesce((c.weekly_need ->> w.week_start::text)::numeric, 0) else c.window_need end as need,
           (x ->> 'qty')::numeric as asked
    from app.la_material_calc(pl.id) c
    left join jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x on (x ->> 'material_spec_id')::uuid = c.material_spec_id
    where c.item_id = i.id
      and (jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 or x is not null)
  loop
    v_qty := round(coalesce(l.asked, least(l.need, l.from_stock)), 3);
    if v_qty <= 0 then continue; end if;
    v_req := least(coalesce(v_req, l.need_by), l.need_by);
    -- element split proportional to the elements' take-off of this spec
    select coalesce(sum(t.planned_qty), 0), count(*) into v_tot, v_n from public.element_takeoffs t
      where t.element_id = any (l.element_ids) and t.material_spec_id = l.spec and t.deleted_at is null;
    v_els := '[]'::jsonb; v_left := v_qty; v_k := 0;
    for e in select t.element_id, t.planned_qty from public.element_takeoffs t
             where t.element_id = any (l.element_ids) and t.material_spec_id = l.spec and t.deleted_at is null
             order by t.planned_qty desc, t.element_id loop
      v_k := v_k + 1;
      v_part := case when v_k = v_n then v_left else round(v_qty * e.planned_qty / nullif(v_tot, 0), 3) end;
      if v_part > 0 then
        v_els := v_els || jsonb_build_object('id', gen_random_uuid(), 'element_id', e.element_id, 'qty', v_part);
        v_left := v_left - v_part;
      end if;
    end loop;
    v_mr_lines := v_mr_lines || jsonb_build_object('id', gen_random_uuid(), 'material_spec_id', l.spec, 'qty', v_qty,
      'required_date', greatest(l.need_by, v_today), 'lookahead_item_id', i.id, 'elements', v_els,
      'remarks', 'Look-ahead ' || pl.period_label || ': ' || i.name);
  end loop;
  if jsonb_array_length(v_mr_lines) = 0 then
    raise exception 'Nothing in stock to request for "%" (order it with a purchase request first)', i.name;
  end if;

  -- block: the item's element, else an element linked to the task or used on the lines, else the task's block,
  -- else the project's only block (site-use requests need one; schedule-driven items often carry none)
  v_block := coalesce(
    (select el.block_id from public.elements el where el.id = i.element_id),
    (select el.block_id from public.task_element_links tl join public.elements el on el.id = tl.element_id
      where tl.task_id = i.schedule_task_id and (to_jsonb(tl) ->> 'deleted_at') is null and el.block_id is not null
      order by el.block_id limit 1),
    (select el.block_id from jsonb_array_elements(v_mr_lines) ln, jsonb_array_elements(ln -> 'elements') x
      join public.elements el on el.id = (x ->> 'element_id')::uuid where el.block_id is not null limit 1),
    (select t.block_id from public.schedule_tasks t where t.id = i.schedule_task_id),
    (select min(b.id::text)::uuid from public.blocks b where b.project_id = i.project_id
      and (to_jsonb(b) ->> 'deleted_at') is null having count(*) = 1));
  v_number := coalesce(nullif(p ->> 'number', ''), app.la_doc_number(i.project_id, 'SR', pl.period_start));
  v_res := public.save_mr(jsonb_build_object('id', v_id, 'project_id', i.project_id, 'number', v_number,
    'request_type', 'site_use', 'block_id', coalesce((p ->> 'block_id')::uuid, v_block), 'priority', 'normal',
    'required_date', coalesce((p ->> 'required_date')::date, greatest(coalesce(v_req, v_today), v_today)),
    'delivery_location', (select name from public.stores where id = v_store), 'store_id', v_store,
    'purpose', 'Look-ahead site use: ' || i.name, 'is_lookahead', true, 'lookahead_plan_id', pl.id,
    'submit', coalesce((p ->> 'submit')::boolean, false), 'lines', v_mr_lines));
  update public.material_requests set lookahead_plan_id = pl.id, is_lookahead = true where id = v_id and lookahead_plan_id is distinct from pl.id;
  update public.mr_lines set lookahead_item_id = i.id where mr_id = v_id and lookahead_item_id is distinct from i.id;
  return app.op_done(p, 'create_sur_from_lookahead', jsonb_build_object('ok', true, 'id', v_id, 'number', v_number,
    'status', v_res ->> 'status', 'lines', v_mr_lines));
end $$;
