-- =============================================================================
-- Purchase-flow fixes found in the end-to-end run (project TWR)
--
-- RFQ award had no owner: procurement records the quotations, but awarding is a management
-- step (rfq.award = coordinator / manager / admin with price access) and nothing told management
-- an RFQ was ready — it sat unawarded. Now:
--   * inbox item 'rfq_award' (v_my_approvals) once the RFQ has its minimum quotations or was
--     closed for quotes with at least one, until it is awarded or cancelled;
--   * management is notified when the minimum is reached and when the RFQ is closed for quotes.
-- =============================================================================

-- (guarded so the upgrade script can be run again)
do $$
begin
  if to_regprocedure('app.approvals_for_pre_purchase(uuid)') is null then
    alter function app.approvals_for(uuid) rename to approvals_for_pre_purchase;
  end if;
end $$;

create or replace function app.approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text; v_prices boolean;
begin
  return query select * from app.approvals_for_pre_purchase(p_user);   -- also checks the caller may read p_user's inbox
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null or v_role not in ('coordinator','manager','admin') then return; end if;
  v_prices := v_role = 'admin' or v_role = any (coalesce((select s.price_roles::text[] from public.app_settings s where s.id = 1), '{}'));
  if not v_prices then return; end if;
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin'),
  rq as (
    select q.*, (select count(*) from public.quotations qt where qt.rfq_id = q.id and qt.status <> 'withdrawn') as n_quotes
    from public.rfqs q
    where q.project_id in (select pid from mem) and q.status in ('sent','closed')
      and not exists (select 1 from public.rfq_awards aw where aw.rfq_id = q.id))
  select 'rfq_award'::text, 'rfq'::text, rq.id, rq.project_id, rq.number,
         'Award ' || rq.title || ' (' || rq.n_quotes || ' of ' || rq.min_quotes || ' quotations)',
         rq.status, rq.created_by, coalesce(rq.closed_at, rq.sent_at, rq.created_at),
         rq.required_by is not null and rq.required_by <= app.local_date(now()), array['open'],
         round((extract(epoch from now() - coalesce(rq.closed_at, rq.sent_at, rq.created_at)) / 3600)::numeric, 1)
  from rq
  where rq.n_quotes >= rq.min_quotes or (rq.status = 'closed' and rq.n_quotes > 0);
end $$;

-- v_my_approvals is a union with the look-ahead items (20261030000004); re-create it so it calls the new function.
do $$
begin
  execute 'create or replace view public.v_my_approvals as
           select * from app.approvals_for(auth.uid())
           union all
           select * from app.lookahead_approvals_for(auth.uid())';
exception when undefined_function then
  execute 'create or replace view public.v_my_approvals as select * from app.approvals_for(auth.uid())';
end $$;
grant select on public.v_my_approvals to authenticated;

create or replace function app.notify_rfq_ready(p_rfq uuid, p_why text) returns void
language plpgsql security definer set search_path = public as $$
declare q public.rfqs; v_n int;
begin
  select * into q from public.rfqs where id = p_rfq;
  if not found or exists (select 1 from public.rfq_awards where rfq_id = q.id) then return; end if;
  select count(*) into v_n from public.quotations where rfq_id = q.id and status <> 'withdrawn';
  perform app.notify_roles(q.project_id, '{coordinator,manager}', 'RFQ ' || q.number || ' ready to award',
    q.title || ' — ' || v_n || ' quotation' || case when v_n = 1 then '' else 's' end || ' ' || p_why, 'rfq', q.id);
end $$;

create or replace function app.trg_quotation_ready() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_min int; v_n int;
begin
  select min_quotes into v_min from public.rfqs where id = new.rfq_id;
  select count(*) into v_n from public.quotations where rfq_id = new.rfq_id and status <> 'withdrawn';
  if v_n = v_min then perform app.notify_rfq_ready(new.rfq_id, 'received (minimum reached)'); end if;
  return null;
end $$;
drop trigger if exists notify_ready on public.quotations;
create trigger notify_ready after insert on public.quotations
  for each row execute function app.trg_quotation_ready();

create or replace function app.trg_rfq_closed_ready() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then perform app.notify_rfq_ready(new.id, '— closed for quotes'); end if;
  return null;
end $$;
drop trigger if exists notify_ready on public.rfqs;
create trigger notify_ready after update of status on public.rfqs
  for each row execute function app.trg_rfq_closed_ready();

revoke execute on function app.notify_rfq_ready(uuid, text) from public;

-- -----------------------------------------------------------------------------
-- Draft POs created by the award (award_rfq, run by management) were authored by the awarder, so the buyer
-- who ran the RFQ could not complete or submit them ("Only the author can edit this purchase order") and the
-- awarder could not approve them ("your own purchase order"). The buyer (RFQ author, procurement) is the PO
-- author; who awarded stays on rfq_awards / po_events.
-- -----------------------------------------------------------------------------
create or replace function app.trg_po_author_from_rfq() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_buyer uuid;
begin
  if new.rfq_id is null or app.has_role('procurement') then return new; end if;
  select q.created_by into v_buyer from public.rfqs q join public.profiles pr on pr.id = q.created_by
   where q.id = new.rfq_id and pr.role = 'procurement' and pr.is_active;
  if v_buyer is not null then new.created_by := v_buyer; end if;
  return new;
end $$;
drop trigger if exists author_from_rfq on public.purchase_orders;
create trigger author_from_rfq before insert on public.purchase_orders
  for each row execute function app.trg_po_author_from_rfq();

update public.purchase_orders po set created_by = q.created_by
  from public.rfqs q join public.profiles pr on pr.id = q.created_by and pr.role = 'procurement' and pr.is_active
 where po.rfq_id = q.id and po.status in ('draft','rejected') and po.created_by <> q.created_by
   and exists (select 1 from public.profiles c where c.id = po.created_by and c.role in ('coordinator','manager','admin'));

-- -----------------------------------------------------------------------------
-- PR tracker after a PO short-close: ordered_qty counted the closed PO line at its full quantity, so the
-- undelivered balance (e.g. 600 kg of 24 t) never showed as "to source" again and the PR stayed partially
-- received with nobody prompted. A closed PO / PO line now counts what was accepted on it.
-- -----------------------------------------------------------------------------
create or replace view public.v_pr_tracker with (security_invoker = true) as
select ml.id as mr_line_id, ml.mr_id, r.number, r.project_id, r.status, r.priority, r.source_mr_id, ml.source_mr_line_id,
       ml.line_no, ml.material_spec_id, sp.label, sp.uom, ml.qty as requested_qty, ml.reviewed_qty, ml.approved_qty, ml.line_status,
       coalesce((select sum(rl.qty) from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
                  where rl.mr_line_id = ml.id and rl.deleted_at is null and q.status <> 'cancelled'), 0) as on_rfq_qty,
       coalesce((select sum(case when po.status = 'closed' or pl.closed then pl.qty_accepted else pl.qty end)
                  from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                  where pl.mr_line_id = ml.id and pl.deleted_at is null
                    and po.status in ('sent','partially_received','received','closed')), 0) as ordered_qty,
       (select min(coalesce(po.eta, pl.expected_date, po.expected_date)) from public.po_lines pl
          join public.purchase_orders po on po.id = pl.po_id
         where pl.mr_line_id = ml.id and pl.deleted_at is null and not pl.closed
           and po.status in ('approved','sent','partially_received')) as eta,
       (select min(dn.expected_date) from public.delivery_notices dn
          where dn.status in ('notified','acknowledged','reschedule_requested','arrived')
            and dn.po_id in (select pl.po_id from public.po_lines pl where pl.mr_line_id = ml.id and pl.deleted_at is null)) as notice_date,
       ml.qty_received as received_qty,
       case when ml.line_status = 'open' then greatest(coalesce(ml.approved_qty, 0) - ml.qty_received, 0) else 0 end as outstanding_qty
from public.mr_lines ml
join public.material_requests r on r.id = ml.mr_id and r.request_type = 'purchase'
join public.v_specs sp on sp.id = ml.material_spec_id
where ml.deleted_at is null;
grant select on public.v_pr_tracker to authenticated;
