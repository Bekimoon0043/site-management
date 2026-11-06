-- =============================================================================
-- Supplier performance scorecard (procurement): quality, delivery dependability and price, the three criteria
-- construction buyers weigh most, combined as a weighted score (quality 50 %, on-time delivery 35 %, price 15 %;
-- without price access the score uses quality and delivery only, re-weighted).
--   quality   = accepted ÷ delivered quantity on goods receipts against purchase orders
--   on time   = receipts on or before the promised date of the order (expected date, else ETA)
--   price     = supplier's ordered / quoted unit prices vs the company 90-day average for the same spec
--   service   = 1–5 rating the store keeper / buyer gives per order (paperwork, responsiveness, packaging …)
-- Grade A ≥ 90, B ≥ 80, C ≥ 70, D below. Views are security-invoker: users only count what they can see.
-- Re-runnable.
-- =============================================================================

create table if not exists public.supplier_ratings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id),
  supplier_id  uuid not null references public.suppliers (id),
  po_id        uuid not null references public.purchase_orders (id),
  score        int not null check (score between 1 and 5),
  comment      text,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (po_id, created_by)
);
alter table public.supplier_ratings enable row level security;
drop policy if exists member_read on public.supplier_ratings;
create policy member_read on public.supplier_ratings for select to authenticated using (app.is_member(project_id));
drop trigger if exists touch_updated_at on public.supplier_ratings;
create trigger touch_updated_at before update on public.supplier_ratings for each row execute function app.touch_updated_at();

-- {po_id, score 1–5, comment?} — one rating per order and person (re-rating replaces it).
create or replace function public.rate_supplier(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); po public.purchase_orders; v_score int := (p ->> 'score')::int;
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  perform app.require_role_txt('store_keeper', 'procurement', 'coordinator', 'manager', 'admin');
  if v_score is null or v_score not between 1 and 5 then raise exception 'Give a score from 1 to 5'; end if;
  if po.status not in ('sent','partially_received','received','closed') then
    raise exception 'Rate the supplier once % has been sent', po.number;
  end if;
  if v_score <= 2 and nullif(trim(p ->> 'comment'), '') is null then raise exception 'Say what went wrong'; end if;
  insert into public.supplier_ratings (project_id, supplier_id, po_id, score, comment, created_by)
  values (po.project_id, po.supplier_id, po.id, v_score, nullif(trim(p ->> 'comment'), ''), auth.uid())
  on conflict (po_id, created_by) do update set score = excluded.score, comment = excluded.comment;
  return app.op_done(p, 'rate_supplier', jsonb_build_object('ok', true, 'po_id', po.id, 'score', v_score));
end $$;

-- One row per receipt against an order: promised date, received date, quantities.
create or replace view public.v_supplier_deliveries with (security_invoker = true) as
select g.id as grn_id, g.number as grn_number, g.project_id, po.id as po_id, po.number as po_number, po.supplier_id,
       coalesce(po.expected_date, po.eta) as promised_on, app.local_date(g.received_at) as received_on,
       case when coalesce(po.expected_date, po.eta) is null then null
            else app.local_date(g.received_at) - coalesce(po.expected_date, po.eta) end as days_late,
       coalesce(sum(l.qty_delivered), 0) as qty_delivered, coalesce(sum(l.qty_accepted), 0) as qty_accepted,
       coalesce(sum(l.qty_rejected), 0) as qty_rejected,
       count(*) filter (where l.inspection_result = 'reject' or l.qty_rejected > 0) as rejected_lines
from public.grns g
join public.purchase_orders po on po.id = g.po_id
left join public.grn_lines l on l.grn_id = g.id
where g.status = 'posted'
group by g.id, g.number, g.project_id, po.id, po.number, po.supplier_id, po.expected_date, po.eta, g.received_at;
grant select on public.v_supplier_deliveries to authenticated;

create or replace view public.v_supplier_performance with (security_invoker = true) as
with d as (
  select supplier_id, count(*) as deliveries,
         count(*) filter (where days_late is not null and days_late <= 0) as on_time,
         count(*) filter (where days_late is not null) as dated,
         round(avg(greatest(days_late, 0)) filter (where days_late is not null), 1) as avg_days_late,
         sum(qty_delivered) as qty_delivered, sum(qty_accepted) as qty_accepted, sum(rejected_lines) as rejected_lines,
         max(received_on) as last_delivery
  from public.v_supplier_deliveries group by supplier_id),
o as (
  select supplier_id, count(*) as orders,
         count(*) filter (where status in ('sent','partially_received') and coalesce(expected_date, eta) < app.local_date(now())) as overdue_orders
  from public.purchase_orders where status not in ('draft','submitted','rejected','cancelled') group by supplier_id),
p as (
  select supplier_id, round(avg(unit_price / avg_90d), 3) as price_index
  from public.price_observations
  where supplier_id is not null and avg_90d > 0 and source in ('po','quotation') and app.can_see_prices()
  group by supplier_id),
r as (select supplier_id, round(avg(score), 1) as service_rating, count(*) as ratings from public.supplier_ratings group by supplier_id),
s as (
  select su.id as supplier_id, su.name, su.phone, su.categories,
         coalesce(o.orders, 0) as orders, coalesce(o.overdue_orders, 0) as overdue_orders,
         coalesce(d.deliveries, 0) as deliveries, d.on_time, d.dated, d.avg_days_late, d.rejected_lines, d.last_delivery,
         case when d.dated > 0 then round(d.on_time * 100.0 / d.dated, 1) end as on_time_pct,
         case when d.qty_delivered > 0 then round(d.qty_accepted * 100.0 / d.qty_delivered, 1) end as quality_pct,
         p.price_index,
         case when p.price_index is not null then greatest(0, least(100, round(100 - (p.price_index - 1) * 200, 1))) end as price_score,
         r.service_rating, coalesce(r.ratings, 0) as ratings
  from public.suppliers su
  left join d on d.supplier_id = su.id left join o on o.supplier_id = su.id
  left join p on p.supplier_id = su.id left join r on r.supplier_id = su.id
  where su.deleted_at is null and (o.orders is not null or d.deliveries is not null))
select s.*, x.score,
       case when x.score is null then null when x.score >= 90 then 'A' when x.score >= 80 then 'B' when x.score >= 70 then 'C' else 'D' end as grade
from s cross join lateral (
  select case
    when s.quality_pct is null and s.on_time_pct is null then null
    when s.price_score is not null then round((coalesce(s.quality_pct, s.on_time_pct) * 50 + coalesce(s.on_time_pct, s.quality_pct) * 35 + s.price_score * 15) / 100, 1)
    else round((coalesce(s.quality_pct, s.on_time_pct) * 50 + coalesce(s.on_time_pct, s.quality_pct) * 35) / 85, 1) end as score) x;
grant select on public.v_supplier_performance to authenticated;
