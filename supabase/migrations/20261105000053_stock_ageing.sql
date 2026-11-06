-- =============================================================================
-- Shelf life & stock ageing (store keeper): cement and site chemicals lose strength / expire in storage.
-- Site practice: first-in-first-out, label stacks with arrival dates, unsealed cement within ~3 months,
-- older or damp-stored cement re-tested before structural use.
--   material_specs.shelf_life_days   null = does not expire. Cement specs default to 90 days (only where unset).
--   lot_expiry                       optional date printed on the pack (admixtures, sealants, paints …) per receipt
--                                    line (receipt lines themselves are immutable, BR-07)
--   v_stock_lots                     what is on the shelf now, lot by lot, by consuming the oldest receipts first
--                                    (FIFO), with age, expiry date and status expired / expiring (≤ 14 days) / ok
--   set_lot_expiry                   store keeper records / corrects the expiry date of a received lot
-- Expired and expiring lots appear in the store keeper's inbox (use first or have them re-tested). Re-runnable.
-- =============================================================================

alter table public.material_specs add column if not exists shelf_life_days int check (shelf_life_days is null or shelf_life_days > 0);
create table if not exists public.lot_expiry (
  grn_line_id  uuid primary key references public.grn_lines (id),
  project_id   uuid not null references public.projects (id),
  expiry_date  date not null,
  set_by       uuid not null references public.profiles (id),
  updated_at   timestamptz not null default now()
);
alter table public.lot_expiry enable row level security;
drop policy if exists member_read on public.lot_expiry;
create policy member_read on public.lot_expiry for select to authenticated using (app.is_member(project_id));

update public.material_specs s set shelf_life_days = 90
  from public.materials m
 where m.id = s.material_id and s.shelf_life_days is null and m.category ilike '%cement%' and m.name !~* 'pipe|board|sheet';

create index if not exists stock_ledger_reversal_idx on public.stock_ledger (reversal_of) where reversal_of is not null;

create or replace view public.v_stock_lots with (security_invoker = true) as
with active as (
  select l.* from public.stock_ledger l
  where l.reversal_of is null
    and not exists (select 1 from public.stock_ledger r where r.reversal_of = l.id)),
inbound as (
  select l.id as ledger_id, l.project_id, l.store_id, l.material_spec_id, l.qty, l.txn_at, l.txn_type, l.doc_number, l.batch_no, l.doc_line_id,
         sum(l.qty) over (partition by l.project_id, l.store_id, l.material_spec_id order by l.txn_at, l.created_at, l.id) as cum_in
  from active l
  where l.stock_status = 'available' and l.qty > 0),
outbound as (
  select l.project_id, l.store_id, l.material_spec_id, -sum(l.qty) as qty_out
  from active l where l.stock_status = 'available' and l.qty < 0
  group by l.project_id, l.store_id, l.material_spec_id),
lots as (
  select i.*, least(i.qty, greatest(i.cum_in - coalesce(o.qty_out, 0), 0)) as remaining_qty
  from inbound i left join outbound o on o.project_id = i.project_id and o.store_id = i.store_id and o.material_spec_id = i.material_spec_id)
select x.ledger_id, x.project_id, x.store_id, st.name as store_name, x.material_spec_id, sp.label, sp.category, sp.uom,
       x.txn_type, x.doc_number, x.batch_no, case when x.txn_type = 'grn' then x.doc_line_id end as grn_line_id,
       app.local_date(x.txn_at) as received_on, x.remaining_qty,
       app.local_date(now()) - app.local_date(x.txn_at) as age_days,
       ms.shelf_life_days, e.expiry_date,
       e.expiry_date - app.local_date(now()) as days_to_expiry,
       case when e.expiry_date is null then 'no_expiry'
            when e.expiry_date < app.local_date(now()) then 'expired'
            when e.expiry_date <= app.local_date(now()) + 14 then 'expiring'
            else 'ok' end as expiry_status
from lots x
join public.stores st on st.id = x.store_id
join public.v_specs sp on sp.id = x.material_spec_id
join public.material_specs ms on ms.id = x.material_spec_id
left join public.lot_expiry le on x.txn_type = 'grn' and le.grn_line_id = x.doc_line_id
cross join lateral (select coalesce(le.expiry_date,
  case when ms.shelf_life_days is not null then app.local_date(x.txn_at) + ms.shelf_life_days end) as expiry_date) e
where x.remaining_qty > 0.0005;
grant select on public.v_stock_lots to authenticated;

-- {grn_line_id, expiry_date|null}
create or replace function public.set_lot_expiry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); gl public.grn_lines; v_date date := nullif(p ->> 'expiry_date', '')::date;
begin
  if v_seen is not null then return v_seen; end if;
  select * into gl from public.grn_lines where id = (p ->> 'grn_line_id')::uuid;
  if not found then raise exception 'Receipt line not found'; end if;
  perform app.require_member(gl.project_id);
  perform app.require_role_txt('store_keeper', 'coordinator', 'manager', 'admin');
  if v_date is not null and v_date < (select app.local_date(received_at) from public.grns where id = gl.grn_id) - 3650 then
    raise exception 'Check the expiry date';
  end if;
  if v_date is null then
    delete from public.lot_expiry where grn_line_id = gl.id;
  else
    insert into public.lot_expiry (grn_line_id, project_id, expiry_date, set_by) values (gl.id, gl.project_id, v_date, auth.uid())
    on conflict (grn_line_id) do update set expiry_date = excluded.expiry_date, set_by = excluded.set_by, updated_at = now();
  end if;
  return app.op_done(p, 'set_lot_expiry', jsonb_build_object('ok', true, 'grn_line_id', gl.id, 'expiry_date', v_date));
end $$;

-- Inbox: one item per store + material with expired or soon-expiring stock.
create or replace function app.stock_expiry_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text; v_pid uuid;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null or v_role not in ('store_keeper', 'admin') then return; end if;
  -- per project so the project filter reaches the FIFO window (an IN-subquery would not)
  for v_pid in select pm.project_id from public.project_members pm where pm.user_id = p_user
               union select pj.id from public.projects pj where v_role = 'admin' loop
  return query
  with bad as (
    select l.project_id, l.store_id, l.store_name, l.material_spec_id, l.label, l.uom,
           sum(l.remaining_qty) as qty, min(l.expiry_date) as first_expiry, bool_or(l.expiry_status = 'expired') as any_expired
    from public.v_stock_lots l
    where l.project_id = v_pid and l.expiry_status in ('expired','expiring')
    group by l.project_id, l.store_id, l.store_name, l.material_spec_id, l.label, l.uom)
  select 'stock_expiry'::text, 'material_spec'::text, b.material_spec_id, b.project_id, b.store_name,
         case when b.any_expired then 'Expired: ' else 'Use first: ' end || b.label || ' — '
           || trim(to_char(b.qty, 'FM999G999G990D###')) || ' ' || b.uom || ' in ' || b.store_name
           || case when b.any_expired then ' (re-test or write off)' else ' expires ' || to_char(b.first_expiry, 'DD Mon') end,
         case when b.any_expired then 'expired' else 'expiring' end, null::uuid, b.first_expiry::timestamptz, b.any_expired,
         array['open'], round((extract(epoch from now() - b.first_expiry::timestamptz) / 3600)::numeric, 1)
  from bad b;
  end loop;
end $$;
revoke execute on function app.stock_expiry_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.stock_expiry_approvals_for') on conflict do nothing;
