-- =============================================================================
-- Reporting views (security_invoker so the caller's RLS applies)
-- =============================================================================

create or replace view public.v_specs with (security_invoker = true) as
select s.id, s.material_id, m.category, m.name as material_name, s.grade,
       trim(m.name || ' ' || s.grade) as label, s.uom, s.wastage_pct, s.min_level, s.reorder_level,
       s.lead_time_days, s.is_active
from public.material_specs s join public.materials m on m.id = s.material_id
where s.deleted_at is null and m.deleted_at is null;

-- Stock balance per store / spec / status (FR-ST-01).
create or replace view public.v_stock_balance with (security_invoker = true) as
select l.project_id, l.store_id, st.name as store_name, l.material_spec_id, sp.label, sp.category, sp.uom,
       l.stock_status, sum(l.qty) as qty, max(l.txn_at) as last_txn_at,
       sp.min_level, sp.reorder_level,
       (l.stock_status = 'available' and sum(l.qty) <= sp.reorder_level) as below_reorder
from public.stock_ledger l
join public.stores st on st.id = l.store_id
join public.v_specs sp on sp.id = l.material_spec_id
group by l.project_id, l.store_id, st.name, l.material_spec_id, sp.label, sp.category, sp.uom, l.stock_status,
         sp.min_level, sp.reorder_level;

-- Bin card with running balance (FR-ST-01).
create or replace view public.v_bin_card with (security_invoker = true) as
select l.*, sp.label, sp.uom, e.code as element_code,
       sum(l.qty) over (partition by l.store_id, l.material_spec_id, l.stock_status
                        order by l.txn_at, l.created_at, l.id) as running_balance
from public.stock_ledger l
join public.v_specs sp on sp.id = l.material_spec_id
left join public.elements e on e.id = l.element_id;

-- Request line balances (FR-ST-04).
create or replace view public.v_mr_line_status with (security_invoker = true) as
select l.id as mr_line_id, l.mr_id, r.number, r.project_id, r.status, r.priority, l.line_no,
       l.material_spec_id, sp.label, sp.uom, l.qty, l.approved_qty, coalesce(l.required_date, r.required_date) as required_date,
       coalesce(x.issued, 0) as issued_qty,
       greatest(coalesce(l.approved_qty, 0) - coalesce(x.issued, 0), 0) as remaining_qty
from public.mr_lines l
join public.material_requests r on r.id = l.mr_id
join public.v_specs sp on sp.id = l.material_spec_id
left join lateral (
  select sum(ml.qty) issued from public.miv_lines ml
  join public.mivs m on m.id = ml.miv_id and m.status <> 'reversed'
  where ml.mr_line_id = l.id) x on true
where l.deleted_at is null;

-- Planned vs requested vs issued per element and spec (FR-PG-07, FR-CC-01).
create or replace view public.v_element_consumption with (security_invoker = true) as
with keys as (
  select project_id, element_id, material_spec_id from public.element_takeoffs where deleted_at is null
  union
  select project_id, element_id, material_spec_id from public.stock_ledger
  where element_id is not null and doc_type in ('miv','mrn')
),
issued as (
  select element_id, material_spec_id, -sum(qty) as net_issued
  from public.stock_ledger where element_id is not null and doc_type in ('miv','mrn')
  group by element_id, material_spec_id
),
wasted as (
  select element_id, material_spec_id, -sum(qty) as wasted
  from public.stock_ledger where element_id is not null and doc_type = 'adjustment'
  group by element_id, material_spec_id
)
select k.project_id, k.element_id, e.code as element_code, e.element_type, e.block_id, e.level_id,
       e.progress_pct, k.material_spec_id, sp.label, sp.category, sp.uom,
       t.planned_qty, t.planned_qty * (1 + sp.wastage_pct / 100) as allowed_qty,
       coalesce(i.net_issued, 0) as issued_qty, coalesce(w.wasted, 0) as wasted_qty,
       -- theoretical requirement for work done so far
       t.planned_qty * e.progress_pct / 100 as earned_qty,
       case when t.planned_qty > 0 and e.progress_pct > 0
            then round((coalesce(i.net_issued, 0) / (t.planned_qty * e.progress_pct / 100) - 1) * 100, 2) end as variance_pct
from keys k
join public.elements e on e.id = k.element_id
join public.v_specs sp on sp.id = k.material_spec_id
left join public.element_takeoffs t on t.element_id = k.element_id and t.material_spec_id = k.material_spec_id and t.deleted_at is null
left join issued i on i.element_id = k.element_id and i.material_spec_id = k.material_spec_id
left join wasted w on w.element_id = k.element_id and w.material_spec_id = k.material_spec_id;

-- Approval ageing (FR-RP-01).
create or replace view public.v_request_ageing with (security_invoker = true) as
select r.id, r.project_id, r.number, r.status, r.priority, r.required_date, r.submitted_at,
       p.full_name as requested_by_name,
       extract(epoch from now() - coalesce(r.reviewed_at, r.submitted_at)) / 3600 as hours_waiting
from public.material_requests r join public.profiles p on p.id = r.requested_by
where r.status in ('submitted','reviewed');

-- Progress roll-up by block / level, weighted by planned take-off quantity (FR-PG-06).
create or replace view public.v_progress_rollup with (security_invoker = true) as
select e.project_id, e.block_id, b.code as block_code, e.level_id, lv.code as level_code,
       count(*) as elements,
       count(*) filter (where e.status = 'completed') as completed,
       round(avg(e.progress_pct), 2) as avg_progress_pct,
       count(*) filter (where e.planned_finish < current_date and e.status <> 'completed') as delayed
from public.elements e
left join public.blocks b on b.id = e.block_id
left join public.levels lv on lv.id = e.level_id
where e.deleted_at is null
group by e.project_id, e.block_id, b.code, e.level_id, lv.code;

-- Issued cost per element (FR-CC-03) — joins prices, so empty for roles that cannot see prices.
create or replace view public.v_element_cost with (security_invoker = true) as
select c.project_id, c.element_id, c.element_code, c.material_spec_id, c.label,
       c.issued_qty, pr.unit_price, c.issued_qty * pr.unit_price as issued_cost,
       c.planned_qty * pr.unit_price as planned_cost
from public.v_element_consumption c
join public.spec_prices pr on pr.material_spec_id = c.material_spec_id;

-- BR-01: emergency issues not regularised within 24 hours.
create or replace view public.v_overdue_emergency_issues with (security_invoker = true) as
select m.id, m.project_id, m.number, m.issued_at, m.emergency_reason, p.full_name as issued_to_name
from public.mivs m join public.profiles p on p.id = m.issued_to
where m.is_emergency and m.mr_id is null and m.status <> 'reversed' and m.issued_at < now() - interval '24 hours';

grant select on public.v_specs, public.v_stock_balance, public.v_bin_card, public.v_mr_line_status,
  public.v_element_consumption, public.v_request_ageing, public.v_progress_rollup, public.v_element_cost,
  public.v_overdue_emergency_issues to authenticated;
