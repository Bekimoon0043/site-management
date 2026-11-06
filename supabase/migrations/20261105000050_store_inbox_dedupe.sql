-- =============================================================================
-- Store keeper inbox: one item per incoming order, not two.
-- When procurement announces a delivery (delivery notice, status 'notified') the store keeper already gets
-- "Confirm delivery of PO …" (app.approvals_for, kind delivery_ack). The PO-level "Receive PO …" item
-- (app.purchase_store_approvals_for, kind po_receive) showed up for the same order as well. It is now held
-- back while a notice is waiting for the store keeper's confirmation; once confirmed (or for orders
-- without a notice) "Receive …" is the single item. Re-runnable.
-- =============================================================================

create or replace function app.purchase_store_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  if v_role in ('procurement', 'admin') then
    return query
    select 'po_send'::text, 'purchase_order'::text, po.id, po.project_id, po.number,
           'Send ' || po.number || ' to ' || s.name, po.status::text, po.created_by, coalesce(po.approved_at, po.created_at),
           coalesce(coalesce(po.expected_date, po.eta) <= app.local_date(now()) + 3, false), array['open'],
           round((extract(epoch from now() - coalesce(po.approved_at, po.created_at)) / 3600)::numeric, 1)
    from public.purchase_orders po join public.suppliers s on s.id = po.supplier_id
    where po.status = 'approved' and po.sent_at is null
      and po.project_id in (select pm.project_id from public.project_members pm where pm.user_id = p_user
                            union select pj.id from public.projects pj where v_role = 'admin');
  end if;
  if v_role in ('store_keeper', 'admin') then
    return query
    select 'po_receive'::text, 'purchase_order'::text, po.id, po.project_id, po.number,
           'Receive ' || po.number || ' from ' || s.name, po.status::text, po.created_by,
           coalesce(po.eta, po.expected_date)::timestamptz,
           coalesce(coalesce(po.eta, po.expected_date) < app.local_date(now()), false), array['open'],
           round((extract(epoch from now() - coalesce(po.eta, po.expected_date)::timestamptz) / 3600)::numeric, 1)
    from public.purchase_orders po join public.suppliers s on s.id = po.supplier_id
    where po.status in ('sent', 'partially_received')
      and coalesce(po.eta, po.expected_date, app.local_date(now())) <= app.local_date(now()) + 2
      and exists (select 1 from public.po_lines pl where pl.po_id = po.id and pl.deleted_at is null and not pl.closed
                    and pl.qty - pl.qty_accepted > 0.0005)
      and not exists (select 1 from public.delivery_notices dn where dn.po_id = po.id and dn.status = 'notified')
      and po.project_id in (select pm.project_id from public.project_members pm where pm.user_id = p_user
                            union select pj.id from public.projects pj where v_role = 'admin');
  end if;
end $$;
revoke execute on function app.purchase_store_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.purchase_store_approvals_for') on conflict do nothing;
