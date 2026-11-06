-- =============================================================================
-- Award → purchase order → store: the awarded order must reach the store.
--
-- Before: award_rfq (management) with create_po made DRAFT purchase orders and stopped there. Procurement had to
-- find them, submit, get them approved and send them; until then nothing showed on the store side, and the
-- store keeper could only receive against a delivery notice. Users saw "awarded, confirmed … nothing in the store".
--
-- Now (common practice: the award decision by the approving manager IS the purchase approval):
--   * POs created by the award are approved with the award when their value is within the awarder's PO limit
--     (app.approval_limit_for 'po'); above it they are submitted for a higher approver (inbox 'po').
--   * procurement gets an inbox item to send each approved PO to the supplier ('po_send');
--   * the store keeper is told an order is coming and gets an inbox item when it is due ('po_receive'),
--     and can receive against the PO itself (post_grn with po_id — no delivery notice needed).
-- Safe to run again.
-- =============================================================================

do $$
begin
  if to_regprocedure('app.award_rfq_core(jsonb)') is null then
    alter function public.award_rfq(jsonb) set schema app;
    alter function app.award_rfq(jsonb) rename to award_rfq_core;
  end if;
end $$;
revoke execute on function app.award_rfq_core(jsonb) from public, anon, authenticated;

create or replace function public.award_rfq(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_res jsonb;
  v_po uuid; po public.purchase_orders; v_total numeric; v_lim record; v_out jsonb := '[]'::jsonb; v_to text;
  v_sup text; v_rfq text;
begin
  if v_seen is not null then return v_seen; end if;
  v_res := app.award_rfq_core(p);
  select number into v_rfq from public.rfqs where id = (p ->> 'rfq_id')::uuid;
  for v_po in select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(v_res -> 'po_ids', '[]'::jsonb)) x loop
    select * into po from public.purchase_orders where id = v_po for update;
    continue when not found or po.status <> 'draft';
    select total into v_total from public.po_totals where po_id = po.id;
    select * into v_lim from app.approval_limit_for(auth.uid(), po.project_id, 'po');
    select name into v_sup from public.suppliers where id = po.supplier_id;
    if v_lim.unlimited or coalesce(v_total, 0) <= v_lim.max_value then
      v_to := 'approved';
      update public.purchase_orders set status = 'approved', submitted_at = now(), approved_by = auth.uid(), approved_at = now()
       where id = po.id;
      perform app.po_event(po.id, 'approve_at_award', 'draft', 'approved', 'Approved with the award of ' || coalesce(v_rfq, 'the RFQ'));
      perform app.notify_user(po.created_by, po.project_id, 'PO ' || po.number || ' approved with the award — send it to ' || v_sup,
        'Awarded by ' || coalesce((select full_name from public.profiles where id = auth.uid()), 'management'), 'purchase_order', po.id);
    else
      v_to := 'submitted';
      update public.purchase_orders set status = 'submitted', submitted_at = now() where id = po.id;
      perform app.po_event(po.id, 'submit_at_award', 'draft', 'submitted',
        'Above the awarder''s PO limit (' || round(v_lim.max_value, 2) || '): needs a higher approver');
      perform app.notify_roles(po.project_id, '{coordinator,manager}', 'PO ' || po.number || ' awaiting approval', v_sup, 'purchase_order', po.id);
    end if;
    perform app.notify_roles(po.project_id, '{store_keeper}', 'Incoming order: PO ' || po.number || ' from ' || v_sup,
      'Expected ' || coalesce(to_char(coalesce(po.eta, po.expected_date), 'DD Mon YYYY'), 'date not set')
        || case when v_to = 'approved' then ' · being sent to the supplier' else ' · awaiting approval' end, 'purchase_order', po.id);
    perform app.refresh_mrs_for_po(po.id);
    v_out := v_out || jsonb_build_object('id', po.id, 'number', po.number, 'status', v_to);
  end loop;
  return app.op_done(p, 'award_rfq', v_res || jsonb_build_object('pos', v_out));
end $$;

-- -----------------------------------------------------------------------------
-- Inbox: procurement sends approved POs; the store keeper receives orders that are due.
-- -----------------------------------------------------------------------------
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
      and po.project_id in (select pm.project_id from public.project_members pm where pm.user_id = p_user
                            union select pj.id from public.projects pj where v_role = 'admin');
  end if;
end $$;
revoke execute on function app.purchase_store_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.purchase_store_approvals_for') on conflict do nothing;
