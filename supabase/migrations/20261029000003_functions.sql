-- =============================================================================
-- Business transactions as RPC functions.
-- Every public RPC takes a single jsonb argument `p` with an `op_id` (uuid) so
-- the mobile outbox can retry safely: a replayed op returns its first result.
-- Errors are raised with readable messages that the apps show to the user.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------

create or replace function app.op_seen(p jsonb) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  if p ->> 'op_id' is null then
    return null;
  end if;
  select result into v from app.processed_ops where op_id = (p ->> 'op_id')::uuid;
  return v;
end $$;

create or replace function app.op_done(p jsonb, p_fn text, p_result jsonb) returns jsonb
language plpgsql as $$
begin
  if p ->> 'op_id' is not null then
    insert into app.processed_ops (op_id, fn, user_id, result)
    values ((p ->> 'op_id')::uuid, p_fn, auth.uid(), p_result)
    on conflict (op_id) do nothing;
  end if;
  return p_result;
end $$;

create or replace function app.spec_label(p_spec uuid) returns text
language sql stable as $$
  select trim(m.name || ' ' || s.grade) || ' (' || s.uom || ')'
  from public.material_specs s join public.materials m on m.id = s.material_id
  where s.id = p_spec
$$;

-- Serialises stock movements per store+spec so concurrent issues cannot overdraw.
create or replace function app.lock_stock(p_store uuid, p_spec uuid) returns void
language sql as $$
  select pg_advisory_xact_lock(hashtextextended(p_store::text || p_spec::text, 0))
$$;

create or replace function app.stock_qty(p_store uuid, p_spec uuid, p_status text default 'available') returns numeric
language sql stable as $$
  select coalesce(sum(qty), 0) from public.stock_ledger
  where store_id = p_store and material_spec_id = p_spec and stock_status = p_status
$$;

create or replace function app.require_stock(p_store uuid, p_spec uuid, p_qty numeric, p_status text default 'available')
returns void language plpgsql as $$
declare v_avail numeric;
begin
  perform app.lock_stock(p_store, p_spec);
  v_avail := app.stock_qty(p_store, p_spec, p_status);
  if v_avail < p_qty then
    raise exception 'Insufficient % stock of %: available %, requested %',
      p_status, app.spec_label(p_spec), v_avail, p_qty using errcode = 'P0001';
  end if;
end $$;

create or replace function app.post_ledger(
  p_project uuid, p_store uuid, p_spec uuid, p_qty numeric, p_status text, p_txn text,
  p_doc_type text, p_doc_id uuid, p_doc_number text, p_line uuid, p_element uuid,
  p_mr_line uuid, p_batch text, p_at timestamptz, p_reversal_of uuid default null
) returns void language sql as $$
  insert into public.stock_ledger (project_id, store_id, material_spec_id, qty, stock_status, txn_type,
    doc_type, doc_id, doc_number, doc_line_id, element_id, mr_line_id, batch_no, txn_at, created_by,
    device_id, reversal_of)
  values (p_project, p_store, p_spec, p_qty, p_status, p_txn, p_doc_type, p_doc_id, p_doc_number, p_line,
    p_element, p_mr_line, p_batch, coalesce(p_at, now()), auth.uid(), app.device_id(), p_reversal_of)
$$;

create or replace function app.require_store(p_project uuid, p_store uuid) returns void
language plpgsql stable as $$
begin
  if not exists (select 1 from public.stores where id = p_store and project_id = p_project and deleted_at is null) then
    raise exception 'Store does not belong to this project';
  end if;
end $$;

create or replace function app.notify_user(p_user uuid, p_project uuid, p_title text, p_body text,
  p_entity_type text, p_entity uuid, p_critical boolean default false) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, project_id, title, body, entity_type, entity_id, is_critical)
  select p_user, p_project, p_title, p_body, p_entity_type, p_entity, p_critical
  where p_user is not null and p_user is distinct from auth.uid()
$$;

create or replace function app.notify_roles(p_project uuid, p_roles public.app_role[], p_title text, p_body text,
  p_entity_type text, p_entity uuid, p_critical boolean default false) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, project_id, title, body, entity_type, entity_id, is_critical)
  select pr.id, p_project, p_title, p_body, p_entity_type, p_entity, p_critical
  from public.profiles pr
  join public.project_members m on m.user_id = pr.id and m.project_id = p_project
  where pr.is_active and pr.role = any (p_roles) and pr.id is distinct from auth.uid()
$$;

-- -----------------------------------------------------------------------------
-- Devices (FR-OF-06)
-- -----------------------------------------------------------------------------

create or replace function public.register_device(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_prefix text;
begin
  if not app.is_active_user() then
    raise exception 'Account is inactive' using errcode = '42501';
  end if;
  select prefix into v_prefix from public.devices where id = (p ->> 'device_id')::uuid;
  if v_prefix is null then
    v_prefix := 'D' || lpad(nextval('app.device_seq')::text, 3, '0');
    insert into public.devices (id, user_id, prefix, name)
    values ((p ->> 'device_id')::uuid, auth.uid(), v_prefix, p ->> 'name');
  else
    update public.devices set last_seen_at = now(), user_id = auth.uid() where id = (p ->> 'device_id')::uuid;
  end if;
  return jsonb_build_object('prefix', v_prefix);
end $$;

-- -----------------------------------------------------------------------------
-- Material requests (4.2) and workflow (4.3)
-- -----------------------------------------------------------------------------

-- Planned (take-off incl. wastage) vs already-requested quantity for an element/spec.
create or replace function app.element_boq_balance(p_element uuid, p_spec uuid, p_exclude_mr uuid)
returns table (planned numeric, requested numeric)
language sql stable as $$
  select
    (select t.planned_qty * (1 + s.wastage_pct / 100)
       from public.element_takeoffs t join public.material_specs s on s.id = t.material_spec_id
      where t.element_id = p_element and t.material_spec_id = p_spec and t.deleted_at is null),
    coalesce((select sum(coalesce(le.qty * coalesce(l.approved_qty, l.qty) / l.qty, le.qty))
       from public.mr_line_elements le
       join public.mr_lines l on l.id = le.mr_line_id and l.deleted_at is null
       join public.material_requests r on r.id = l.mr_id
      where le.element_id = p_element and l.material_spec_id = p_spec and le.deleted_at is null
        and r.id <> p_exclude_mr
        and r.status not in ('draft','rejected','cancelled','returned')), 0)
$$;

create or replace function app.mr_submit(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.material_requests;
  l record;
  v_split numeric;
  v_bal record;
  v_el record;
  v_settings public.project_settings;
  v_lines int := 0;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if r.status = 'submitted' then
    return;
  end if;
  if r.status not in ('draft','returned') then
    raise exception 'Only draft or returned requests can be submitted (status: %)', r.status;
  end if;

  -- FR-MR-01: required fields
  if r.block_id is null then raise exception 'Block is required'; end if;
  if r.delivery_location is null and r.store_id is null then raise exception 'Delivery location is required'; end if;

  for l in select * from public.mr_lines where mr_id = p_mr and deleted_at is null order by line_no loop
    v_lines := v_lines + 1;
    select coalesce(sum(qty), 0) into v_split from public.mr_line_elements
      where mr_line_id = l.id and deleted_at is null;
    if v_split = 0 then
      raise exception 'Line %: at least one structural element is required', l.line_no;
    end if;
    if abs(v_split - l.qty) > 0.001 then
      raise exception 'Line %: element split (%) must equal the line quantity (%)', l.line_no, v_split, l.qty;
    end if;

    -- FR-MR-04 / BR-03: quantities above the remaining take-off need a reason.
    for v_el in select le.element_id, le.qty, e.code from public.mr_line_elements le
                join public.elements e on e.id = le.element_id
                where le.mr_line_id = l.id and le.deleted_at is null loop
      select * into v_bal from app.element_boq_balance(v_el.element_id, l.material_spec_id, p_mr);
      if v_bal.planned is not null and v_bal.requested + v_el.qty > v_bal.planned + 0.0005 then
        if coalesce(trim(l.over_boq_reason), '') = '' then
          raise exception 'Line %: % exceeds the BoQ balance for element % (planned %, already requested %). A reason is required.',
            l.line_no, v_el.qty, v_el.code, round(v_bal.planned, 3), round(v_bal.requested, 3);
        end if;
        update public.mr_lines set exceeds_boq = true where id = l.id;
      end if;
    end loop;

    -- Link BoQ item from the element take-off where possible.
    update public.mr_lines ml set boq_item_id = coalesce(ml.boq_item_id, (
      select t.boq_item_id from public.element_takeoffs t
      join public.mr_line_elements le on le.element_id = t.element_id and le.mr_line_id = ml.id
      where t.material_spec_id = ml.material_spec_id and t.boq_item_id is not null limit 1))
    where ml.id = l.id;
  end loop;

  if v_lines = 0 then
    raise exception 'A request needs at least one line';
  end if;

  update public.material_requests set status = 'submitted', submitted_at = now() where id = p_mr;
  insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
  values (p_mr, r.project_id, 'submit', r.status, 'submitted', auth.uid());

  select * into v_settings from public.project_settings where project_id = r.project_id;
  perform app.notify_roles(r.project_id,
    case when coalesce(v_settings.require_review, true)
         then '{office_engineer,coordinator,manager}'::public.app_role[]
         else '{coordinator,manager}'::public.app_role[] end,
    'New material request ' || r.number,
    initcap(r.priority::text) || ' — required ' || to_char(r.required_date, 'DD Mon YYYY'),
    'material_request', p_mr, r.priority <> 'normal');
  -- FR-WF-05: urgent/critical requests alert procurement immediately.
  if r.priority <> 'normal' then
    perform app.notify_roles(r.project_id, '{procurement}', initcap(r.priority::text) || ' request ' || r.number,
      'Required ' || to_char(r.required_date, 'DD Mon YYYY'), 'material_request', p_mr, true);
  end if;
end $$;

-- Create or update a request (draft/returned/submitted-before-approval) and optionally submit.
create or replace function public.save_mr(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  r public.material_requests;
  v_line jsonb;
  v_el jsonb;
  v_line_ids uuid[] := '{}';
  v_el_ids uuid[];
  v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');

  select * into r from public.material_requests where id = v_id for update;
  if found then
    if r.project_id <> v_project then raise exception 'Request belongs to another project'; end if;
    if r.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the requester can edit this request';
    end if;
    if r.status not in ('draft','returned','submitted') then
      raise exception 'Request % can no longer be edited (status: %)', r.number, r.status;
    end if;
    update public.material_requests set
      block_id = (p ->> 'block_id')::uuid,
      priority = coalesce((p ->> 'priority')::public.mr_priority, 'normal'),
      required_date = (p ->> 'required_date')::date,
      delivery_location = nullif(p ->> 'delivery_location', ''),
      store_id = (p ->> 'store_id')::uuid,
      drawing_ref = nullif(p ->> 'drawing_ref', ''),
      purpose = nullif(p ->> 'purpose', ''),
      is_lookahead = coalesce((p ->> 'is_lookahead')::boolean, false),
      version = version + 1,
      -- editing a submitted request sends it back through review
      status = case when status = 'submitted' then 'draft'::public.mr_status else status end
    where id = v_id;
  else
    if p ->> 'required_date' is null then raise exception 'Required date is required'; end if;
    insert into public.material_requests (id, project_id, number, block_id, requested_by, requester_role,
      priority, required_date, delivery_location, store_id, drawing_ref, purpose, is_lookahead, device_created_at)
    values (v_id, v_project, p ->> 'number', (p ->> 'block_id')::uuid, auth.uid(), app.my_role(),
      coalesce((p ->> 'priority')::public.mr_priority, 'normal'), (p ->> 'required_date')::date,
      nullif(p ->> 'delivery_location', ''), (p ->> 'store_id')::uuid, nullif(p ->> 'drawing_ref', ''),
      nullif(p ->> 'purpose', ''), coalesce((p ->> 'is_lookahead')::boolean, false),
      (p ->> 'device_created_at')::timestamptz);
    insert into public.mr_events (mr_id, project_id, action, to_status, actor)
    values (v_id, v_project, 'create', 'draft', auth.uid());
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if v_line ->> 'material_spec_id' is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce((v_line ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    v_line_ids := v_line_ids || (v_line ->> 'id')::uuid;
    insert into public.mr_lines (id, mr_id, project_id, line_no, material_spec_id, qty, required_date, remarks, over_boq_reason)
    values ((v_line ->> 'id')::uuid, v_id, v_project, v_n, (v_line ->> 'material_spec_id')::uuid,
      (v_line ->> 'qty')::numeric, coalesce((v_line ->> 'required_date')::date, (p ->> 'required_date')::date),
      nullif(v_line ->> 'remarks', ''), nullif(v_line ->> 'over_boq_reason', ''))
    on conflict (id) do update set
      line_no = excluded.line_no, material_spec_id = excluded.material_spec_id, qty = excluded.qty,
      required_date = excluded.required_date, remarks = excluded.remarks,
      over_boq_reason = excluded.over_boq_reason, exceeds_boq = false, deleted_at = null
    where public.mr_lines.mr_id = v_id;

    v_el_ids := '{}';
    for v_el in select * from jsonb_array_elements(coalesce(v_line -> 'elements', '[]'::jsonb)) loop
      if not exists (select 1 from public.elements where id = (v_el ->> 'element_id')::uuid and project_id = v_project) then
        raise exception 'Line %: element does not belong to this project', v_n;
      end if;
      v_el_ids := v_el_ids || (v_el ->> 'id')::uuid;
      insert into public.mr_line_elements (id, mr_line_id, project_id, element_id, qty)
      values ((v_el ->> 'id')::uuid, (v_line ->> 'id')::uuid, v_project, (v_el ->> 'element_id')::uuid, (v_el ->> 'qty')::numeric)
      on conflict (id) do update set element_id = excluded.element_id, qty = excluded.qty, deleted_at = null
      where public.mr_line_elements.mr_line_id = (v_line ->> 'id')::uuid;
    end loop;
    update public.mr_line_elements set deleted_at = now()
      where mr_line_id = (v_line ->> 'id')::uuid and deleted_at is null and not (id = any (v_el_ids));
  end loop;

  update public.mr_lines set deleted_at = now()
    where mr_id = v_id and deleted_at is null and not (id = any (v_line_ids));

  insert into public.mr_versions (mr_id, project_id, version, snapshot, changed_by)
  select v_id, v_project, version, p - 'op_id', auth.uid() from public.material_requests where id = v_id;

  if coalesce((p ->> 'submit')::boolean, false) then
    perform app.mr_submit(v_id);
  end if;

  return app.op_done(p, 'save_mr', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.material_requests where id = v_id)));
end $$;

-- Recompute issue status of an approved request from its non-reversed issues.
create or replace function app.refresh_mr_status(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.material_requests;
  v_total numeric; v_issued numeric; v_any boolean;
  v_new public.mr_status;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if r.status not in ('approved','partially_issued','issued') then
    return;
  end if;
  select coalesce(sum(l.approved_qty), 0),
         coalesce(sum(least(l.approved_qty, x.issued)), 0),
         coalesce(bool_or(x.issued > 0), false)
    into v_total, v_issued, v_any
  from public.mr_lines l
  left join lateral (
    select coalesce(sum(ml.qty), 0) issued from public.miv_lines ml
    join public.mivs m on m.id = ml.miv_id and m.status <> 'reversed'
    where ml.mr_line_id = l.id) x on true
  where l.mr_id = p_mr and l.deleted_at is null and l.approved_qty > 0;

  v_new := case when v_total > 0 and v_issued >= v_total then 'issued'
                when v_any then 'partially_issued'
                else 'approved' end;
  if v_new <> r.status then
    update public.material_requests set status = v_new where id = p_mr;
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
    values (p_mr, r.project_id, 'issue_status', r.status, v_new, auth.uid());
  end if;
end $$;

-- FR-WF-03: review, approve (incl. partial), reject, return, cancel, close.
create or replace function public.mr_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  r public.material_requests;
  v_settings public.project_settings;
  v_to public.mr_status;
  v_line jsonb;
  v_partial boolean := false;
  v_value numeric;
  v_limit numeric;
  v_issued boolean;
begin
  if v_seen is not null then return v_seen; end if;
  select * into r from public.material_requests where id = (p ->> 'mr_id')::uuid for update;
  if not found then raise exception 'Request not found'; end if;
  perform app.require_member(r.project_id);
  select * into v_settings from public.project_settings where project_id = r.project_id;
  select exists (select 1 from public.miv_lines ml join public.mivs m on m.id = ml.miv_id and m.status <> 'reversed'
                 join public.mr_lines l on l.id = ml.mr_line_id where l.mr_id = r.id) into v_issued;

  case v_action
  when 'review' then
    perform app.require_role('office_engineer','coordinator','manager','admin');
    if r.status <> 'submitted' then raise exception 'Only submitted requests can be reviewed'; end if;
    v_to := 'reviewed';
    update public.material_requests set reviewed_by = auth.uid(), reviewed_at = now() where id = r.id;

  when 'approve' then
    perform app.require_role('coordinator','manager','admin');
    if r.status not in ('submitted','reviewed') then
      raise exception 'Request cannot be approved from status %', r.status;
    end if;
    update public.mr_lines set approved_qty = qty where mr_id = r.id and deleted_at is null;
    for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      if (v_line ->> 'approved_qty')::numeric < 0 then raise exception 'Approved quantity cannot be negative'; end if;
      update public.mr_lines set approved_qty = least((v_line ->> 'approved_qty')::numeric, qty)
        where id = (v_line ->> 'id')::uuid and mr_id = r.id
          and (v_line ->> 'approved_qty')::numeric < qty;
      if found then v_partial := true; end if;
    end loop;
    -- BR-08: value-based approval limits.
    select coalesce(sum(l.approved_qty * sp.unit_price), 0) into v_value
      from public.mr_lines l join public.spec_prices sp on sp.material_spec_id = l.material_spec_id
      where l.mr_id = r.id and l.deleted_at is null;
    select max_value into v_limit from public.approval_limits
      where role = app.my_role() and (project_id = r.project_id or project_id is null)
      order by project_id nulls last limit 1;
    if v_limit is not null and v_value > v_limit then
      raise exception 'Request value % exceeds your approval limit of %; a higher approver is required',
        round(v_value, 2), round(v_limit, 2);
    end if;
    v_to := 'approved';
    update public.material_requests set approved_by = auth.uid(), approved_at = now() where id = r.id;
    if v_partial then v_action := 'partial_approve'; end if;
    perform app.notify_roles(r.project_id, '{store_keeper}', 'Request ' || r.number || ' approved',
      'Ready for issue from stock', 'material_request', r.id, r.priority <> 'normal');

  when 'reject' then
    perform app.require_role('coordinator','manager','admin');
    if v_comment is null then raise exception 'A reason is required to reject'; end if;
    if r.status not in ('submitted','reviewed','approved') or v_issued then
      raise exception 'Request cannot be rejected at this stage';
    end if;
    v_to := 'rejected';

  when 'return' then
    perform app.require_role('office_engineer','coordinator','manager','admin');
    if v_comment is null then raise exception 'Please say what needs clarification'; end if;
    if r.status not in ('submitted','reviewed') then raise exception 'Request cannot be returned at this stage'; end if;
    v_to := 'returned';

  when 'cancel' then
    if r.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the requester or management can cancel';
    end if;
    if r.status not in ('draft','submitted','reviewed','returned','approved') or v_issued then
      raise exception 'Request cannot be cancelled at this stage';
    end if;
    v_to := 'cancelled';

  when 'close' then
    perform app.require_role('store_keeper','coordinator','manager','admin');
    if r.status not in ('approved','partially_issued','issued') then
      raise exception 'Only approved/issued requests can be closed';
    end if;
    v_to := 'closed';

  else
    raise exception 'Unknown action %', v_action;
  end case;

  update public.material_requests set status = v_to where id = r.id;
  insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload, actor)
  values (r.id, r.project_id, v_action, r.status, v_to, v_comment, p -> 'lines', auth.uid());
  perform app.notify_user(r.requested_by, r.project_id,
    'Request ' || r.number || ': ' || replace(v_action, '_', ' '),
    coalesce(v_comment, 'Status: ' || v_to), 'material_request', r.id);

  return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', v_to));
end $$;

-- -----------------------------------------------------------------------------
-- Goods received (4.5)
-- -----------------------------------------------------------------------------

create or replace function public.post_grn(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  v_number text := p ->> 'number';
  v_at timestamptz := coalesce((p ->> 'received_at')::timestamptz, now());
  l jsonb; v_n int := 0;
  v_del numeric; v_acc numeric; v_rej numeric; v_ord numeric;
  v_flag text; v_mr_spec uuid; v_requester uuid; v_mr uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');   -- BR-04
  perform app.require_store(v_project, v_store);
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'A GRN needs at least one line'; end if;

  insert into public.grns (id, project_id, number, store_id, supplier_id, supplier_name, delivery_note_no,
    vehicle_plate, driver_name, received_at, remarks, supplier_signature, created_by, device_id)
  values (v_id, v_project, v_number, v_store, (p ->> 'supplier_id')::uuid, nullif(p ->> 'supplier_name', ''),
    nullif(p ->> 'delivery_note_no', ''), nullif(p ->> 'vehicle_plate', ''), nullif(p ->> 'driver_name', ''),
    v_at, nullif(p ->> 'remarks', ''), nullif(p ->> 'supplier_signature', ''), auth.uid(), app.device_id());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    v_del := (l ->> 'qty_delivered')::numeric;
    v_rej := coalesce((l ->> 'qty_rejected')::numeric, 0);
    v_acc := coalesce((l ->> 'qty_accepted')::numeric, v_del - v_rej);
    v_ord := (l ->> 'ordered_qty')::numeric;
    if v_del is null or v_del <= 0 then raise exception 'Line %: delivered quantity is required', v_n; end if;
    if abs(v_acc + v_rej - v_del) > 0.0005 then
      raise exception 'Line %: accepted + rejected must equal delivered', v_n;
    end if;
    if l ->> 'inspection_result' = 'reject' and v_acc > 0 then
      raise exception 'Line %: a rejected inspection cannot have accepted quantity', v_n;
    end if;

    -- FR-RC-02: shortage / excess / wrong grade flags
    v_flag := null;
    if l ->> 'mr_line_id' is not null then
      select ml.material_spec_id, r.requested_by, r.id into v_mr_spec, v_requester, v_mr
        from public.mr_lines ml join public.material_requests r on r.id = ml.mr_id
        where ml.id = (l ->> 'mr_line_id')::uuid and ml.project_id = v_project;
      if not found then raise exception 'Line %: request line not found in this project', v_n; end if;
      if v_mr_spec <> (l ->> 'material_spec_id')::uuid then v_flag := 'wrong_grade'; end if;
      perform app.notify_user(v_requester, v_project, 'Material arrived: ' || app.spec_label((l ->> 'material_spec_id')::uuid),
        'GRN ' || v_number || ' — ' || v_acc || ' accepted', 'grn', v_id);
    end if;
    if v_flag is null and v_ord is not null then
      v_flag := case when v_del < v_ord then 'shortage' when v_del > v_ord then 'excess' end;
    end if;

    insert into public.grn_lines (id, grn_id, project_id, line_no, material_spec_id, mr_line_id, ordered_qty,
      qty_delivered, qty_accepted, qty_rejected, entered_uom, entered_qty, batch_no, inspection_result,
      inspection_notes, variance_flag)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'mr_line_id')::uuid,
      v_ord, v_del, v_acc, v_rej, l ->> 'entered_uom', (l ->> 'entered_qty')::numeric, nullif(l ->> 'batch_no', ''),
      coalesce(l ->> 'inspection_result', 'pass'), nullif(l ->> 'inspection_notes', ''), v_flag);

    -- FR-RC-04 / FR-RC-08: accepted to available stock, rejected to quarantine.
    if v_acc > 0 then
      perform app.post_ledger(v_project, v_store, (l ->> 'material_spec_id')::uuid, v_acc, 'available', 'grn',
        'grn', v_id, v_number, (l ->> 'id')::uuid, null, (l ->> 'mr_line_id')::uuid, nullif(l ->> 'batch_no', ''), v_at);
    end if;
    if v_rej > 0 then
      perform app.post_ledger(v_project, v_store, (l ->> 'material_spec_id')::uuid, v_rej, 'quarantine', 'grn',
        'grn', v_id, v_number, (l ->> 'id')::uuid, null, (l ->> 'mr_line_id')::uuid, nullif(l ->> 'batch_no', ''), v_at);
    end if;
  end loop;

  return app.op_done(p, 'post_grn', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- FR-RC-07: requesting engineer confirms receipt.
create or replace function public.confirm_grn(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.grns;
begin
  select * into g from public.grns where id = (p ->> 'grn_id')::uuid;
  if not found then raise exception 'GRN not found'; end if;
  perform app.require_member(g.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  update public.grns set confirmed_by = coalesce(confirmed_by, auth.uid()), confirmed_at = coalesce(confirmed_at, now())
    where id = g.id;
  return jsonb_build_object('ok', true, 'id', g.id);
end $$;

-- -----------------------------------------------------------------------------
-- Issue (MIV), acknowledgement, emergency regularisation (4.6, BR-01/02/05)
-- -----------------------------------------------------------------------------

create or replace function public.post_miv(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  v_number text := p ->> 'number';
  v_mr uuid := (p ->> 'mr_id')::uuid;
  v_emergency boolean := coalesce((p ->> 'is_emergency')::boolean, false);
  v_at timestamptz := coalesce((p ->> 'issued_at')::timestamptz, now());
  v_sig text := nullif(p ->> 'receiver_signature', '');
  r public.material_requests;
  ml public.mr_lines;
  l jsonb; v_n int := 0;
  v_spec uuid; v_qty numeric; v_issued numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  perform app.require_store(v_project, v_store);
  if p ->> 'issued_to' is null then raise exception 'Receiver is required'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'An issue needs at least one line'; end if;

  if v_mr is not null then
    select * into r from public.material_requests where id = v_mr;
    if not found or r.project_id <> v_project then raise exception 'Request not found in this project'; end if;
    if r.status not in ('approved','sourced','ordered','partially_issued') then  -- sourced/ordered: procurement (0005)
      raise exception 'Request % is not approved for issue (status: %)', r.number, r.status;
    end if;
  elsif not v_emergency then
    raise exception 'Materials can only be issued against an approved request (BR-01)';
  elsif coalesce(trim(p ->> 'emergency_reason'), '') = '' then
    raise exception 'Emergency issue requires a reason';
  end if;

  insert into public.mivs (id, project_id, number, store_id, mr_id, issued_to, issued_by, issued_at, status,
    acknowledged_at, receiver_signature, is_emergency, emergency_reason, remarks, device_id)
  values (v_id, v_project, v_number, v_store, v_mr, (p ->> 'issued_to')::uuid, auth.uid(), v_at,
    case when v_sig is not null then 'acknowledged' else 'pending_ack' end,
    case when v_sig is not null then now() end, v_sig, v_emergency and v_mr is null,
    nullif(p ->> 'emergency_reason', ''), nullif(p ->> 'remarks', ''), app.device_id());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    v_spec := (l ->> 'material_spec_id')::uuid;
    v_qty := (l ->> 'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    if l ->> 'element_id' is null or not exists (
        select 1 from public.elements where id = (l ->> 'element_id')::uuid and project_id = v_project) then
      raise exception 'Line %: every issue must be tied to a structural element of this project (BR-02)', v_n;
    end if;

    if v_mr is not null then
      select * into ml from public.mr_lines
        where id = (l ->> 'mr_line_id')::uuid and mr_id = v_mr and deleted_at is null;
      if not found then raise exception 'Line %: request line not found', v_n; end if;
      -- FR-ST-03 / BR-05: no grade substitution without a recorded justification
      if ml.material_spec_id <> v_spec and coalesce(trim(l ->> 'substitution_reason'), '') = '' then
        raise exception 'Line %: issuing % instead of the requested % requires a substitution reason',
          v_n, app.spec_label(v_spec), app.spec_label(ml.material_spec_id);
      end if;
      select coalesce(sum(x.qty), 0) into v_issued from public.miv_lines x
        join public.mivs m on m.id = x.miv_id and m.status <> 'reversed'
        where x.mr_line_id = ml.id;
      -- FR-ST-04: partial issues allowed, never beyond the approved balance
      if v_issued + v_qty > coalesce(ml.approved_qty, 0) + 0.0005 then
        raise exception 'Line %: issue of % exceeds remaining approved balance of %',
          v_n, v_qty, coalesce(ml.approved_qty, 0) - v_issued;
      end if;
    end if;

    perform app.require_stock(v_store, v_spec, v_qty);
    insert into public.miv_lines (id, miv_id, project_id, line_no, mr_line_id, material_spec_id, element_id, qty,
      batch_no, substitution_reason)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'mr_line_id')::uuid, v_spec,
      (l ->> 'element_id')::uuid, v_qty, nullif(l ->> 'batch_no', ''), nullif(l ->> 'substitution_reason', ''));
    perform app.post_ledger(v_project, v_store, v_spec, -v_qty, 'available', 'miv', 'miv', v_id, v_number,
      (l ->> 'id')::uuid, (l ->> 'element_id')::uuid, (l ->> 'mr_line_id')::uuid, nullif(l ->> 'batch_no', ''), v_at);
  end loop;

  if v_mr is not null then perform app.refresh_mr_status(v_mr); end if;
  if v_sig is null then
    perform app.notify_user((p ->> 'issued_to')::uuid, v_project, 'Materials issued to you: ' || v_number,
      'Please acknowledge receipt', 'miv', v_id);
  end if;
  if v_emergency and v_mr is null then
    perform app.notify_roles(v_project, '{coordinator,manager}', 'Emergency issue ' || v_number,
      'Must be regularised within 24 hours: ' || (p ->> 'emergency_reason'), 'miv', v_id, true);
  end if;

  return app.op_done(p, 'post_miv', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function public.acknowledge_miv(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.mivs;
begin
  select * into m from public.mivs where id = (p ->> 'miv_id')::uuid for update;
  if not found then raise exception 'Issue voucher not found'; end if;
  perform app.require_member(m.project_id);
  if m.issued_to <> auth.uid() and not app.has_role('coordinator','manager','admin') then
    raise exception 'Only the receiver can acknowledge this issue';
  end if;
  if m.status = 'pending_ack' then
    update public.mivs set status = 'acknowledged', acknowledged_at = now(),
      receiver_signature = coalesce(nullif(p ->> 'signature', ''), receiver_signature)
    where id = m.id;
  end if;
  return jsonb_build_object('ok', true, 'id', m.id);
end $$;

-- BR-01: link an emergency issue to an approved request afterwards.
create or replace function public.regularise_miv(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  m public.mivs; r public.material_requests; l record; v_line uuid;
begin
  if v_seen is not null then return v_seen; end if;
  select * into m from public.mivs where id = (p ->> 'miv_id')::uuid for update;
  if not found or not m.is_emergency or m.mr_id is not null then
    raise exception 'Only unregularised emergency issues can be regularised';
  end if;
  perform app.require_member(m.project_id);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  select * into r from public.material_requests where id = (p ->> 'mr_id')::uuid;
  if not found or r.project_id <> m.project_id or r.status not in ('approved','partially_issued','issued') then
    raise exception 'Choose an approved request from the same project';
  end if;
  for l in select * from public.miv_lines where miv_id = m.id loop
    v_line := null;
    select id into v_line from public.mr_lines
      where mr_id = r.id and material_spec_id = l.material_spec_id and deleted_at is null limit 1;
    if v_line is null then
      raise exception 'Request % has no line for %', r.number, app.spec_label(l.material_spec_id);
    end if;
    update public.miv_lines set mr_line_id = v_line where id = l.id;
  end loop;
  update public.mivs set mr_id = r.id, regularised_at = now() where id = m.id;
  perform app.refresh_mr_status(r.id);
  insert into public.mr_events (mr_id, project_id, action, comment, actor)
  values (r.id, r.project_id, 'regularise_emergency_issue', m.number, auth.uid());
  return app.op_done(p, 'regularise_miv', jsonb_build_object('ok', true, 'id', m.id));
end $$;

-- -----------------------------------------------------------------------------
-- Returns (MRN)
-- -----------------------------------------------------------------------------

create or replace function public.post_mrn(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  v_number text := p ->> 'number';
  v_at timestamptz := coalesce((p ->> 'returned_at')::timestamptz, now());
  l jsonb; v_n int := 0;
  v_cond text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  perform app.require_store(v_project, v_store);
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'A return needs at least one line'; end if;

  insert into public.mrns (id, project_id, number, store_id, miv_id, returned_by, received_by, returned_at, remarks, device_id)
  values (v_id, v_project, v_number, v_store, (p ->> 'miv_id')::uuid, (p ->> 'returned_by')::uuid, auth.uid(),
    v_at, nullif(p ->> 'remarks', ''), app.device_id());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    v_cond := coalesce(l ->> 'condition', 'good');
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    insert into public.mrn_lines (id, mrn_id, project_id, line_no, material_spec_id, element_id, mr_line_id, qty, condition)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'element_id')::uuid,
      (l ->> 'mr_line_id')::uuid, (l ->> 'qty')::numeric, v_cond);
    -- Good returns restore available stock; damaged returns go to quarantine for write-off.
    perform app.post_ledger(v_project, v_store, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric,
      case when v_cond = 'good' then 'available' else 'quarantine' end, 'mrn', 'mrn', v_id, v_number,
      (l ->> 'id')::uuid, (l ->> 'element_id')::uuid, (l ->> 'mr_line_id')::uuid, null, v_at);
  end loop;

  return app.op_done(p, 'post_mrn', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- -----------------------------------------------------------------------------
-- Wastage / damage / loss adjustments with approval (FR-ST-07)
-- -----------------------------------------------------------------------------

create or replace function public.create_adjustment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_type text := p ->> 'adj_type';
  l jsonb; v_n int := 0; v_delta numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  perform app.require_store(v_project, (p ->> 'store_id')::uuid);
  if v_type not in ('wastage','damage','loss','write_off') then raise exception 'Invalid adjustment type'; end if;
  if coalesce(trim(p ->> 'reason_code'), '') = '' then raise exception 'A reason code is required'; end if;

  insert into public.adjustments (id, project_id, number, store_id, adj_type, reason_code, remarks, requested_by)
  values (v_id, v_project, p ->> 'number', (p ->> 'store_id')::uuid, v_type, p ->> 'reason_code',
    nullif(p ->> 'remarks', ''), auth.uid());

  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    v_delta := -abs((l ->> 'qty')::numeric);
    if v_delta = 0 then raise exception 'Line %: quantity is required', v_n; end if;
    insert into public.adjustment_lines (id, adjustment_id, project_id, line_no, material_spec_id, element_id, stock_status, qty_delta)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'element_id')::uuid,
      coalesce(l ->> 'stock_status', 'available'), v_delta);
  end loop;
  if v_n = 0 then raise exception 'An adjustment needs at least one line'; end if;

  perform app.notify_roles(v_project, '{coordinator,manager}', 'Approval needed: ' || v_type || ' ' || (p ->> 'number'),
    p ->> 'reason_code', 'adjustment', v_id);
  return app.op_done(p, 'create_adjustment', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function app.post_adjustment(p_adj uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.adjustments; l public.adjustment_lines;
begin
  select * into a from public.adjustments where id = p_adj;
  for l in select * from public.adjustment_lines where adjustment_id = p_adj order by line_no loop
    if l.qty_delta < 0 then
      perform app.require_stock(a.store_id, l.material_spec_id, -l.qty_delta, l.stock_status);
    end if;
    perform app.post_ledger(a.project_id, a.store_id, l.material_spec_id, l.qty_delta, l.stock_status, 'adjustment',
      'adjustment', a.id, a.number, l.id, l.element_id, null, null, now());
  end loop;
end $$;

create or replace function public.decide_adjustment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  a public.adjustments;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, false);
begin
  if v_seen is not null then return v_seen; end if;
  select * into a from public.adjustments where id = (p ->> 'adjustment_id')::uuid for update;
  if not found then raise exception 'Adjustment not found'; end if;
  perform app.require_member(a.project_id);
  perform app.require_role('coordinator','manager','admin');
  if a.status <> 'pending' then raise exception 'Adjustment already %', a.status; end if;
  if not v_approve and coalesce(trim(p ->> 'comment'), '') = '' then raise exception 'A reason is required to reject'; end if;

  update public.adjustments set status = case when v_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_comment = nullif(p ->> 'comment', '')
  where id = a.id;
  if v_approve then perform app.post_adjustment(a.id); end if;
  perform app.notify_user(a.requested_by, a.project_id, 'Adjustment ' || a.number || (case when v_approve then ' approved' else ' rejected' end),
    p ->> 'comment', 'adjustment', a.id);
  return app.op_done(p, 'decide_adjustment', jsonb_build_object('ok', true, 'id', a.id));
end $$;

-- -----------------------------------------------------------------------------
-- Stock counts (FR-ST-08)
-- -----------------------------------------------------------------------------

create or replace function public.submit_stock_count(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  l jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  perform app.require_store(v_project, v_store);

  insert into public.stock_counts (id, project_id, number, store_id, count_type, counted_by, counted_at, remarks)
  values (v_id, v_project, p ->> 'number', v_store, coalesce(p ->> 'count_type', 'periodic'), auth.uid(),
    coalesce((p ->> 'counted_at')::timestamptz, now()), nullif(p ->> 'remarks', ''));
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    insert into public.stock_count_lines (id, count_id, project_id, material_spec_id, system_qty, counted_qty)
    values ((l ->> 'id')::uuid, v_id, v_project, (l ->> 'material_spec_id')::uuid,
      app.stock_qty(v_store, (l ->> 'material_spec_id')::uuid), (l ->> 'counted_qty')::numeric);
  end loop;
  perform app.notify_roles(v_project, '{coordinator,manager}', 'Stock count ' || (p ->> 'number') || ' submitted',
    'Review variances and approve', 'stock_count', v_id);
  return app.op_done(p, 'submit_stock_count', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function public.decide_stock_count(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  c public.stock_counts;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, false);
  v_adj uuid := gen_random_uuid();
  v_n int := 0; l public.stock_count_lines;
begin
  if v_seen is not null then return v_seen; end if;
  select * into c from public.stock_counts where id = (p ->> 'count_id')::uuid for update;
  if not found then raise exception 'Stock count not found'; end if;
  perform app.require_member(c.project_id);
  perform app.require_role('coordinator','manager','admin');
  if c.status <> 'submitted' then raise exception 'Stock count already %', c.status; end if;

  update public.stock_counts set status = case when v_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_comment = nullif(p ->> 'comment', '')
  where id = c.id;

  if v_approve and exists (select 1 from public.stock_count_lines where count_id = c.id and variance <> 0) then
    insert into public.adjustments (id, project_id, number, store_id, adj_type, reason_code, stock_count_id,
      status, requested_by, decided_by, decided_at)
    values (v_adj, c.project_id, c.number || '-ADJ', c.store_id, 'count_variance', 'Stock count', c.id,
      'approved', c.counted_by, auth.uid(), now());
    for l in select * from public.stock_count_lines where count_id = c.id and variance <> 0 loop
      v_n := v_n + 1;
      insert into public.adjustment_lines (id, adjustment_id, project_id, line_no, material_spec_id, qty_delta)
      values (gen_random_uuid(), v_adj, c.project_id, v_n, l.material_spec_id, l.variance);
    end loop;
    -- Variance is applied as counted; stock may not go negative.
    perform app.post_adjustment(v_adj);
  end if;
  return app.op_done(p, 'decide_stock_count', jsonb_build_object('ok', true, 'id', c.id));
end $$;

-- -----------------------------------------------------------------------------
-- Transfers between stores / projects (FR-ST-06)
-- -----------------------------------------------------------------------------

create or replace function public.send_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_from uuid := (p ->> 'from_store_id')::uuid;
  v_to uuid := (p ->> 'to_store_id')::uuid;
  v_to_project uuid;
  v_at timestamptz := coalesce((p ->> 'sent_at')::timestamptz, now());
  l jsonb; v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  perform app.require_store(v_project, v_from);
  select project_id into v_to_project from public.stores where id = v_to and deleted_at is null;
  if v_to_project is null or v_to = v_from then raise exception 'Choose a different destination store'; end if;

  insert into public.transfers (id, project_id, number, from_store_id, to_project_id, to_store_id, sent_by, sent_at, remarks)
  values (v_id, v_project, p ->> 'number', v_from, v_to_project, v_to, auth.uid(), v_at, nullif(p ->> 'remarks', ''));
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    perform app.require_stock(v_from, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric);
    insert into public.transfer_lines (id, transfer_id, project_id, line_no, material_spec_id, qty)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric);
    perform app.post_ledger(v_project, v_from, (l ->> 'material_spec_id')::uuid, -(l ->> 'qty')::numeric, 'available',
      'transfer_out', 'transfer', v_id, p ->> 'number', (l ->> 'id')::uuid, null, null, null, v_at);
  end loop;
  if v_n = 0 then raise exception 'A transfer needs at least one line'; end if;
  perform app.notify_roles(v_to_project, '{store_keeper}', 'Incoming transfer ' || (p ->> 'number'),
    'Confirm receipt when it arrives', 'transfer', v_id);
  return app.op_done(p, 'send_transfer', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function public.receive_transfer(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  t public.transfers; l public.transfer_lines;
  v_recv numeric; v_at timestamptz := coalesce((p ->> 'received_at')::timestamptz, now());
begin
  if v_seen is not null then return v_seen; end if;
  select * into t from public.transfers where id = (p ->> 'transfer_id')::uuid for update;
  if not found then raise exception 'Transfer not found'; end if;
  perform app.require_member(t.to_project_id);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  if t.status <> 'in_transit' then raise exception 'Transfer already received'; end if;

  for l in select * from public.transfer_lines where transfer_id = t.id loop
    select coalesce((x ->> 'qty_received')::numeric, l.qty) into v_recv
      from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x where (x ->> 'id')::uuid = l.id;
    v_recv := coalesce(v_recv, l.qty);
    if v_recv < 0 or v_recv > l.qty then raise exception 'Received quantity must be between 0 and %', l.qty; end if;
    -- transfer_lines.qty_received is the one permitted post-send update
    update public.transfer_lines set qty_received = v_recv where id = l.id;
    if v_recv > 0 then
      perform app.post_ledger(t.to_project_id, t.to_store_id, l.material_spec_id, v_recv, 'available', 'transfer_in',
        'transfer', t.id, t.number, l.id, null, null, null, v_at);
    end if;
  end loop;
  update public.transfers set status = 'received', received_by = auth.uid(), received_at = v_at where id = t.id;
  return app.op_done(p, 'receive_transfer', jsonb_build_object('ok', true, 'id', t.id));
end $$;

-- -----------------------------------------------------------------------------
-- Reversal of posted documents (FR-AU-02, BR-07)
-- -----------------------------------------------------------------------------

create or replace function public.reverse_document(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_type text := p ->> 'doc_type';
  v_doc uuid := (p ->> 'doc_id')::uuid;
  v_reason text := nullif(trim(p ->> 'reason'), '');
  v_project uuid; v_status text; v_mr uuid;
  e public.stock_ledger;
begin
  if v_seen is not null then return v_seen; end if;
  if v_reason is null then raise exception 'A reversal reason is required'; end if;
  if v_type not in ('grn','miv','mrn') then raise exception 'Only GRN, MIV and MRN can be reversed'; end if;

  execute format('select project_id, status from public.%I where id = $1 for update', v_type || 's')
    into v_project, v_status using v_doc;
  if v_project is null then raise exception 'Document not found'; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  if v_status = 'reversed' then raise exception 'Document already reversed'; end if;

  for e in select * from public.stock_ledger where doc_id = v_doc and txn_type <> 'reversal' loop
    if e.qty > 0 then
      perform app.require_stock(e.store_id, e.material_spec_id, e.qty, e.stock_status);
    end if;
    perform app.post_ledger(e.project_id, e.store_id, e.material_spec_id, -e.qty, e.stock_status, 'reversal',
      e.doc_type, e.doc_id, e.doc_number, e.doc_line_id, e.element_id, e.mr_line_id, e.batch_no, now(), e.id);
  end loop;

  execute format('update public.%I set status = ''reversed'', reversed_by = $1, reversal_reason = $2 where id = $3', v_type || 's')
    using auth.uid(), v_reason, v_doc;

  if v_type = 'miv' then
    select mr_id into v_mr from public.mivs where id = v_doc;
    if v_mr is not null then perform app.refresh_mr_status(v_mr); end if;
  end if;
  return app.op_done(p, 'reverse_document', jsonb_build_object('ok', true, 'id', v_doc));
end $$;

-- -----------------------------------------------------------------------------
-- Progress (FR-PG-02, 03, 05, 06)
-- -----------------------------------------------------------------------------

create or replace function app.refresh_element_progress(p_element uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_pct numeric;
begin
  select case when sum(weight) > 0 then round(sum(weight * verified_pct) / sum(weight), 2) else 0 end
    into v_pct from public.element_activities where element_id = p_element;
  update public.elements set progress_pct = v_pct,
    status = case when v_pct >= 100 then 'completed' when v_pct > 0 or actual_start is not null then 'in_progress' else 'not_started' end,
    actual_finish = case when v_pct >= 100 then coalesce(actual_finish, current_date) else null end
  where id = p_element;
end $$;

create or replace function public.report_progress(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  a public.element_activities;
  v_blocking text;
  v_settings public.project_settings;
  v_pct numeric := (p ->> 'pct_complete')::numeric;
begin
  if v_seen is not null then return v_seen; end if;
  select * into a from public.element_activities where id = (p ->> 'element_activity_id')::uuid;
  if not found then raise exception 'Activity not found'; end if;
  perform app.require_member(a.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if v_pct is null or v_pct < 0 or v_pct > 100 then raise exception 'Percent complete must be between 0 and 100'; end if;

  select * into v_settings from public.project_settings where project_id = a.project_id;
  if coalesce(v_settings.enforce_hold_points, true) and v_pct > 0 then
    select name into v_blocking from public.element_activities
      where element_id = a.element_id and seq < a.seq and is_hold_point and verified_pct < 100
      order by seq limit 1;
    if v_blocking is not null then
      raise exception 'Hold point "%" must be signed off before progressing "%"', v_blocking, a.name;
    end if;
  end if;

  insert into public.progress_updates (id, project_id, element_id, element_activity_id, report_date, pct_complete,
    qty_achieved, uom, remarks, reported_by)
  values (v_id, a.project_id, a.element_id, a.id, coalesce((p ->> 'report_date')::date, current_date), v_pct,
    (p ->> 'qty_achieved')::numeric, nullif(p ->> 'uom', ''), nullif(p ->> 'remarks', ''), auth.uid());
  update public.element_activities set reported_pct = v_pct where id = a.id;
  update public.elements set actual_start = coalesce(actual_start, coalesce((p ->> 'report_date')::date, current_date)),
    status = case when status = 'not_started' then 'in_progress' else status end
  where id = a.element_id and v_pct > 0;

  perform app.notify_roles(a.project_id, '{office_engineer}', 'Progress to verify',
    a.name || ' at ' || v_pct || '%', 'progress_update', v_id);
  return app.op_done(p, 'report_progress', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function public.verify_progress(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  u public.progress_updates;
  v_approve boolean := coalesce((p ->> 'approve')::boolean, true);
  v_pct numeric;
  v_status text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into u from public.progress_updates where id = (p ->> 'progress_id')::uuid for update;
  if not found then raise exception 'Progress update not found'; end if;
  perform app.require_member(u.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if u.status <> 'reported' then raise exception 'Progress update already %', u.status; end if;

  v_pct := coalesce((p ->> 'verified_pct')::numeric, u.pct_complete);
  if v_pct < 0 or v_pct > 100 then raise exception 'Percent must be between 0 and 100'; end if;
  v_status := case when not v_approve then 'rejected' when v_pct <> u.pct_complete then 'adjusted' else 'verified' end;
  if v_status <> 'verified' and coalesce(trim(p ->> 'comment'), '') = '' then
    raise exception 'A comment is required when adjusting or rejecting progress';
  end if;

  update public.progress_updates set status = v_status, verified_by = auth.uid(), verified_at = now(),
    verified_pct = case when v_approve then v_pct end, verify_comment = nullif(p ->> 'comment', '')
  where id = u.id;
  if v_approve then
    update public.element_activities set verified_pct = v_pct where id = u.element_activity_id;
    perform app.refresh_element_progress(u.element_id);
  end if;
  perform app.notify_user(u.reported_by, u.project_id, 'Progress ' || v_status, p ->> 'comment', 'progress_update', u.id);
  return app.op_done(p, 'verify_progress', jsonb_build_object('ok', true, 'id', u.id, 'status', v_status));
end $$;

-- -----------------------------------------------------------------------------
-- Opening balances (project setup) and notification housekeeping
-- -----------------------------------------------------------------------------

create or replace function public.post_opening_balance(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  v_doc uuid := gen_random_uuid();
  l jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('coordinator','manager','admin');
  perform app.require_store(v_project, v_store);
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    if coalesce((l ->> 'qty')::numeric, 0) > 0 then
      perform app.post_ledger(v_project, v_store, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric,
        'available', 'opening', 'opening', v_doc, 'OPENING', null, null, null, null, now());
    end if;
  end loop;
  return app.op_done(p, 'post_opening_balance', jsonb_build_object('ok', true, 'id', v_doc));
end $$;

create or replace function public.mark_notifications_read(p jsonb) returns jsonb
language sql security definer set search_path = public as $$
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null
    and (p -> 'ids' is null or id in (select (jsonb_array_elements_text(p -> 'ids'))::uuid));
  select jsonb_build_object('ok', true);
$$;

-- FR-WF-04: escalate stale approvals. Schedule with pg_cron (see README).
create or replace function public.escalate_pending_requests() returns int
language plpgsql security definer set search_path = public as $$
declare r record; v_n int := 0;
begin
  for r in
    select mr.* from public.material_requests mr
    join public.project_settings s on s.project_id = mr.project_id
    where mr.status in ('submitted','reviewed')
      and coalesce(mr.reviewed_at, mr.submitted_at) < now() - make_interval(hours => s.escalation_hours)
      and not exists (select 1 from public.mr_events e where e.mr_id = mr.id and e.action = 'escalated'
                      and e.created_at > now() - make_interval(hours => s.escalation_hours))
  loop
    insert into public.mr_events (mr_id, project_id, action, comment) values (r.id, r.project_id, 'escalated', 'Pending approval');
    perform app.notify_roles(r.project_id, '{manager}', 'Overdue approval: ' || r.number,
      'Waiting since ' || to_char(coalesce(r.reviewed_at, r.submitted_at), 'DD Mon HH24:MI'), 'material_request', r.id, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke execute on function public.escalate_pending_requests() from public, anon, authenticated;

-- RPCs are for signed-in users only.
do $$
declare f text;
begin
  foreach f in array array['register_device','save_mr','mr_action','post_grn','confirm_grn','post_miv',
    'acknowledge_miv','regularise_miv','post_mrn','create_adjustment','decide_adjustment','submit_stock_count',
    'decide_stock_count','send_transfer','receive_transfer','reverse_document','report_progress',
    'verify_progress','post_opening_balance','mark_notifications_read'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;
