-- =============================================================================
-- Material costing: materials are a cost when USED, not when bought.
--
-- Practice (construction cost accounting / EVM):
--   * Material received into a site store is inventory (an asset), not cost. Purchase orders are commitments.
--   * Cost is recognised when material is issued to the work (MIV), at the store's carrying cost; returns (MRN)
--     credit it back; wastage, damage, loss, write-off and stock-count variances are cost (or gain) when
--     approved. EVM actual cost (AC) for materials = consumption at cost.
--   * Valuation method: perpetual MOVING WEIGHTED AVERAGE per project × material spec (all stores of a site
--     share one cost pool, so transfers between its stores are cost-neutral). Chosen over FIFO because site
--     stock of bulk materials (cement, rebar, aggregate) is physically mixed, average cost is what Ethiopian
--     contractors' stock ledgers and the IFRS/IAS 2 "weighted average" option use, and it is stable for EVM.
--   * Receipts are valued at the PO line unit price ex-VAT (input VAT is recoverable); no PO → standard
--     price (spec_prices); opening stock → standard price. Rejected / quarantined material is not valued.
--   * Reversals carry exactly the cost of the row they reverse. Cross-project transfers carry the cost of the
--     sending project.
--
-- Money lives in price-restricted tables (stock_ledger_costs, stock_cost_pool); the stock ledger itself stays
-- quantity-only so non-price roles never see values.
-- =============================================================================

create table if not exists public.stock_cost_pool (
  project_id        uuid not null references public.projects (id),
  material_spec_id  uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null default 0,
  value             numeric(18,2) not null default 0,
  avg_cost          numeric(18,4),
  updated_at        timestamptz not null default now(),
  primary key (project_id, material_spec_id)
);

create table if not exists public.stock_ledger_costs (
  ledger_id         uuid primary key references public.stock_ledger (id),
  project_id        uuid not null references public.projects (id),
  material_spec_id  uuid not null references public.material_specs (id),
  cost_kind         text not null check (cost_kind in
                      ('receipt','opening','issue','return','wastage','loss','count','transfer','gate','quarantine','other')),
  is_consumption    boolean not null default false,   -- counts as actual material cost (AC)
  unit_cost         numeric(18,4),                     -- null = could not be valued (no PO price, no standard price, empty pool)
  value             numeric(18,2) not null default 0,  -- signed like qty: + into stock, − out of stock
  pool_qty_after    numeric(16,3),
  pool_avg_after    numeric(18,4),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists stock_ledger_costs_project_idx on public.stock_ledger_costs (project_id, material_spec_id);
create index if not exists stock_ledger_costs_updated_at_idx on public.stock_ledger_costs (updated_at);

alter table public.stock_cost_pool enable row level security;
alter table public.stock_ledger_costs enable row level security;
drop policy if exists price_read on public.stock_cost_pool;
create policy price_read on public.stock_cost_pool for select to authenticated using (app.can_see_prices() and app.is_member(project_id));
drop policy if exists price_read on public.stock_ledger_costs;
create policy price_read on public.stock_ledger_costs for select to authenticated using (app.can_see_prices() and app.is_member(project_id));

-- -----------------------------------------------------------------------------
-- Value one ledger row (moving average). Called by the insert trigger and by the back-fill.
-- -----------------------------------------------------------------------------
create or replace function app.cost_ledger_row(l public.stock_ledger) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_kind text; v_cons boolean := false; v_unit numeric; v_val numeric; v_std numeric;
  o public.stock_ledger_costs; p public.stock_cost_pool; v_adj text;
begin
  if exists (select 1 from public.stock_ledger_costs where ledger_id = l.id) then return; end if;

  if l.txn_type = 'reversal' then
    select * into o from public.stock_ledger_costs where ledger_id = l.reversal_of;
    v_kind := coalesce(o.cost_kind, 'other'); v_cons := coalesce(o.is_consumption, false);
  elsif l.stock_status = 'quarantine' then v_kind := 'quarantine';
  elsif l.txn_type = 'grn' then v_kind := 'receipt';
  elsif l.txn_type = 'opening' then v_kind := 'opening';
  elsif l.txn_type = 'miv' then v_kind := 'issue'; v_cons := true;
  elsif l.txn_type = 'mrn' then v_kind := 'return'; v_cons := true;
  elsif l.txn_type in ('transfer_in','transfer_out') then v_kind := 'transfer';
  elsif l.txn_type in ('gate_in','gate_out') then v_kind := 'gate';
  elsif l.txn_type = 'adjustment' then
    select a.adj_type into v_adj from public.adjustments a where a.id = l.doc_id;
    v_kind := case v_adj when 'wastage' then 'wastage' when 'count_variance' then 'count' else 'loss' end;
    v_cons := true;
  else v_kind := 'other';
  end if;

  if v_kind = 'quarantine' or (l.txn_type = 'reversal' and o.cost_kind = 'quarantine') then
    insert into public.stock_ledger_costs (ledger_id, project_id, material_spec_id, cost_kind, is_consumption, unit_cost, value)
    values (l.id, l.project_id, l.material_spec_id, 'quarantine', false, null, 0);
    return;
  end if;

  insert into public.stock_cost_pool (project_id, material_spec_id) values (l.project_id, l.material_spec_id)
  on conflict do nothing;
  select * into p from public.stock_cost_pool
   where project_id = l.project_id and material_spec_id = l.material_spec_id for update;
  select sp.unit_price into v_std from public.spec_prices sp where sp.material_spec_id = l.material_spec_id;

  if l.txn_type = 'reversal' and o.ledger_id is not null then
    v_unit := o.unit_cost;
  elsif v_kind = 'receipt' then
    select pr.unit_price into v_unit from public.grn_lines gl join public.po_line_prices pr on pr.po_line_id = gl.po_line_id
     where gl.id = l.doc_line_id;
    v_unit := coalesce(v_unit, v_std, p.avg_cost);
  elsif v_kind = 'opening' then
    v_unit := coalesce(v_std, p.avg_cost);
  elsif l.txn_type = 'transfer_in' then
    select c.unit_cost into v_unit from public.stock_ledger x join public.stock_ledger_costs c on c.ledger_id = x.id
     where x.doc_id = l.doc_id and x.txn_type = 'transfer_out' and x.material_spec_id = l.material_spec_id
     order by x.created_at desc limit 1;
    v_unit := coalesce(v_unit, p.avg_cost, v_std);
  else
    v_unit := coalesce(p.avg_cost, v_std);
  end if;

  v_val := round(l.qty * coalesce(v_unit, 0), 2);
  update public.stock_cost_pool
     set qty = qty + l.qty,
         value = case when qty + l.qty <= 0 then 0 else value + v_val end,
         avg_cost = case when qty + l.qty > 0 then round((value + v_val) / (qty + l.qty), 4) else avg_cost end,
         updated_at = now()
   where project_id = l.project_id and material_spec_id = l.material_spec_id
  returning * into p;

  insert into public.stock_ledger_costs (ledger_id, project_id, material_spec_id, cost_kind, is_consumption, unit_cost, value,
    pool_qty_after, pool_avg_after)
  values (l.id, l.project_id, l.material_spec_id, v_kind, v_cons, round(v_unit, 4), v_val, p.qty, p.avg_cost);
end $$;
revoke execute on function app.cost_ledger_row(public.stock_ledger) from public;

create or replace function app.trg_stock_cost() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.cost_ledger_row(new);
  return null;
end $$;
drop trigger if exists stock_cost on public.stock_ledger;
create trigger stock_cost after insert on public.stock_ledger
  for each row execute function app.trg_stock_cost();

-- Back-fill existing ledgers in posting order.
do $$
declare l public.stock_ledger;
begin
  for l in select * from public.stock_ledger s
           where not exists (select 1 from public.stock_ledger_costs c where c.ledger_id = s.id)
           order by s.txn_at, s.created_at, s.id loop
    perform app.cost_ledger_row(l);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- EVM actual cost: material consumption at cost (issues − returns + wastage/loss/count), allocated to tasks
-- exactly as before (element ∧ BoQ → element → BoQ item → unallocated).
-- -----------------------------------------------------------------------------
create or replace function app.material_alloc(p_project uuid)
returns table (project_id uuid, ledger_id uuid, txn_date date, element_id uuid, material_spec_id uuid,
               boq_item_id uuid, task_id uuid, share numeric, qty numeric, amount numeric)
language sql stable security definer set search_path = public as $$
  with led as (
    select l.id, l.project_id, app.eat_date(l.txn_at) as txn_date, l.element_id, l.material_spec_id,
           coalesce(ml.boq_item_id, et.boq_item_id) as boq_item_id, -l.qty as qty, -c.value as amount
    from public.stock_ledger l
    join public.stock_ledger_costs c on c.ledger_id = l.id and c.is_consumption
    left join public.mr_lines ml on ml.id = l.mr_line_id
    left join public.element_takeoffs et on et.element_id = l.element_id and et.material_spec_id = l.material_spec_id
      and et.deleted_at is null
    where l.project_id = p_project),
  tk as (
    select t.id from public.schedule_tasks t join public.schedules s on s.id = t.schedule_id and s.status = 'active'
    where t.project_id = p_project and t.deleted_at is null and not t.is_summary),
  el as (select x.task_id, x.element_id, coalesce(x.weight, 1) as w from public.task_element_links x
         join tk on tk.id = x.task_id where x.deleted_at is null),
  bl as (select x.task_id, x.boq_item_id, coalesce(nullif(x.qty_share, 0), 1) as w from public.task_boq_links x
         join tk on tk.id = x.task_id where x.deleted_at is null),
  cand as (
    select led.id as ledger_id, 1 as lvl, el.task_id, bl.w from led
      join el on el.element_id = led.element_id
      join bl on bl.task_id = el.task_id and bl.boq_item_id = led.boq_item_id
    union all
    select led.id, 2, el.task_id, el.w from led join el on el.element_id = led.element_id
    union all
    select led.id, 3, bl.task_id, bl.w from led join bl on bl.boq_item_id = led.boq_item_id),
  best as (select ledger_id, min(lvl) as lvl from cand group by ledger_id),
  pick as (
    select c.ledger_id, c.task_id, c.w / sum(c.w) over (partition by c.ledger_id) as share
    from cand c join best b on b.ledger_id = c.ledger_id and b.lvl = c.lvl)
  select led.project_id, led.id, led.txn_date, led.element_id, led.material_spec_id, led.boq_item_id,
         pick.task_id, coalesce(pick.share, 1), round(led.qty * coalesce(pick.share, 1), 3),
         round(led.amount * coalesce(pick.share, 1), 2)
  from led left join pick on pick.ledger_id = led.id
$$;

-- -----------------------------------------------------------------------------
-- Cost control: budget vs committed (open POs) vs received into stock vs USED (actual cost).
-- Same columns as before (issued = used); remaining = budget − used; pct_used = used / budget.
-- Appended: used, remaining_uncommitted = budget − max(received, used) − committed (what is still free to buy).
-- -----------------------------------------------------------------------------
create or replace view public.v_cost_control with (security_invoker = true) as
with facts as (
  select c.project_id, c.material_spec_id, c.boq_item_id, c.committed_value as committed, 0::numeric as received, 0::numeric as used
  from public.v_committed_cost c
  union all
  select l.project_id, l.material_spec_id, ml.boq_item_id, 0, c.value, 0
  from public.stock_ledger l join public.stock_ledger_costs c on c.ledger_id = l.id and c.cost_kind = 'receipt'
  left join public.mr_lines ml on ml.id = l.mr_line_id
  union all
  select l.project_id, l.material_spec_id, coalesce(ml.boq_item_id, et.boq_item_id), 0, 0, -c.value
  from public.stock_ledger l join public.stock_ledger_costs c on c.ledger_id = l.id and c.is_consumption
  left join public.mr_lines ml on ml.id = l.mr_line_id
  left join public.element_takeoffs et on et.element_id = l.element_id and et.material_spec_id = l.material_spec_id and et.deleted_at is null
),
f as (select facts.*, sp.category from facts join public.v_specs sp on sp.id = facts.material_spec_id),
g as (
  select b.id as budget_line_id, b.project_id,
         case when b.boq_item_id is not null then 'boq_item' when b.material_spec_id is not null then 'material' else 'category' end as scope,
         b.boq_item_id, bi.item_no as boq_item_no, b.material_spec_id, sp.label, coalesce(b.category, sp.category) as category,
         coalesce(b.description, bi.description, sp.label, b.category) as description,
         b.budget_qty, b.budget_rate, b.budget_amount,
         coalesce(sum(f.committed), 0) as committed, coalesce(sum(f.received), 0) as received, coalesce(sum(f.used), 0) as used
  from public.budget_lines b
  left join public.boq_items bi on bi.id = b.boq_item_id
  left join public.v_specs sp on sp.id = b.material_spec_id
  left join f on f.project_id = b.project_id and (
         (b.boq_item_id is not null and f.boq_item_id = b.boq_item_id
            and (b.material_spec_id is null or f.material_spec_id = b.material_spec_id))
      or (b.boq_item_id is null and b.material_spec_id is not null and f.material_spec_id = b.material_spec_id)
      or (b.boq_item_id is null and b.material_spec_id is null and f.category = b.category))
  where b.deleted_at is null
  group by b.id, bi.item_no, bi.description, sp.label, sp.category)
select budget_line_id, project_id, scope, boq_item_id, boq_item_no, material_spec_id, label, category, description,
       budget_qty, budget_rate, budget_amount,
       round(committed, 2) as committed, round(received, 2) as received, round(used, 2) as issued,
       round(budget_amount - used, 2) as remaining,
       round(100 * used / nullif(budget_amount, 0), 1) as pct_used,
       round(used, 2) as used,
       round(budget_amount - greatest(received, used) - committed, 2) as remaining_uncommitted
from g;

-- -----------------------------------------------------------------------------
-- Material actuals without budget lines: per project × spec × BoQ item (price roles).
-- -----------------------------------------------------------------------------
create or replace view public.v_material_cost with (security_invoker = true) as
with x as (
  select c.project_id, c.material_spec_id, c.boq_item_id, c.committed_value as committed,
         0::numeric as received_qty, 0::numeric as received_value, 0::numeric as issued_qty, 0::numeric as used_value,
         0::numeric as wastage_qty, 0::numeric as wastage_value
  from public.v_committed_cost c
  union all
  select l.project_id, l.material_spec_id,
         case when k.cost_kind = 'receipt' then ml.boq_item_id else coalesce(ml.boq_item_id, et.boq_item_id) end,
         0,
         case when k.cost_kind = 'receipt' then l.qty else 0 end,
         case when k.cost_kind = 'receipt' then k.value else 0 end,
         case when k.cost_kind in ('issue','return') then -l.qty else 0 end,
         case when k.is_consumption then -k.value else 0 end,
         case when k.cost_kind in ('wastage','loss') then -l.qty else 0 end,
         case when k.cost_kind in ('wastage','loss') then -k.value else 0 end
  from public.stock_ledger l
  join public.stock_ledger_costs k on k.ledger_id = l.id and (k.cost_kind = 'receipt' or k.is_consumption)
  left join public.mr_lines ml on ml.id = l.mr_line_id
  left join public.element_takeoffs et on et.element_id = l.element_id and et.material_spec_id = l.material_spec_id and et.deleted_at is null
)
select x.project_id, x.material_spec_id, sp.label, sp.category, sp.uom, x.boq_item_id, bi.item_no as boq_item_no,
       bi.description as boq_description, ms.wastage_pct as allowance_pct,
       round(sum(x.committed), 2) as committed, round(sum(x.received_qty), 3) as received_qty, round(sum(x.received_value), 2) as received_value,
       round(sum(x.issued_qty), 3) as issued_qty, round(sum(x.used_value), 2) as used_value,
       round(sum(x.wastage_qty), 3) as wastage_qty, round(sum(x.wastage_value), 2) as wastage_value
from x
join public.v_specs sp on sp.id = x.material_spec_id
join public.material_specs ms on ms.id = x.material_spec_id
left join public.boq_items bi on bi.id = x.boq_item_id
where app.can_see_prices() and app.is_member(x.project_id)
group by x.project_id, x.material_spec_id, sp.label, sp.category, sp.uom, x.boq_item_id, bi.item_no, bi.description, ms.wastage_pct;

-- Inventory on hand at average cost, per store (price roles). Quarantined stock is not valued.
create or replace view public.v_inventory_value with (security_invoker = true) as
select l.project_id, l.store_id, s.name as store_name, l.material_spec_id, sp.label, sp.category, sp.uom,
       round(sum(l.qty), 3) as qty, p.avg_cost, round(sum(l.qty) * coalesce(p.avg_cost, 0), 2) as value
from public.stock_ledger l
join public.stores s on s.id = l.store_id
join public.v_specs sp on sp.id = l.material_spec_id
left join public.stock_cost_pool p on p.project_id = l.project_id and p.material_spec_id = l.material_spec_id
where l.stock_status in ('available','on_loan') and app.can_see_prices() and app.is_member(l.project_id)
group by l.project_id, l.store_id, s.name, l.material_spec_id, sp.label, sp.category, sp.uom, p.avg_cost
having abs(sum(l.qty)) > 0.0005;

-- Ledger with cost per movement (bin card with values), price roles.
create or replace view public.v_stock_ledger_value with (security_invoker = true) as
select l.id, l.project_id, l.store_id, l.material_spec_id, l.qty, l.stock_status, l.txn_type, l.doc_type, l.doc_id, l.doc_number,
       l.element_id, l.txn_at, c.cost_kind, c.is_consumption, c.unit_cost, c.value, c.pool_qty_after, c.pool_avg_after
from public.stock_ledger l
join public.stock_ledger_costs c on c.ledger_id = l.id
where app.can_see_prices() and app.is_member(l.project_id);

grant select on public.v_cost_control, public.v_material_cost, public.v_inventory_value, public.v_stock_ledger_value to authenticated;
grant select on public.stock_cost_pool, public.stock_ledger_costs to authenticated;
