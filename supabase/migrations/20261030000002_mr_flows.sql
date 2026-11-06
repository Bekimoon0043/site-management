-- =============================================================================
-- Material procurement flows (docs/research/procurement-lookahead.md §2–§7, §11)
--
--   Flow A — PURCHASE request (request_type = 'purchase'):
--     Office Engineer raises → Coordinator reviews → Management (manager) approves
--     → Procurement accepts and buys (RFQ / quotations / PO, or direct purchase)
--     → delivery notice to Store Keeper (+ security) → Store Keeper acknowledges
--     → GRN (= store keeper's confirmation) → received → closed; requester informed.
--   Flow B — SITE USE request (request_type = 'site_use', all pre-existing rows):
--     Site Engineer requests → Office Engineer reviews (qty vs BoQ, stock check)
--     → Coordinator approves = store order → Store Keeper issues (MIV)
--     → Site Engineer acknowledges → received → closed (auto after N hours).
--
-- Compatibility: site_use keeps every pre-existing status, payload and inbox
-- kind (mr_review / mr_approve). Functions redefined here start from their
-- current definitions (post_grn / refresh_mr_status / refresh_mr_procurement /
-- check_mr_line / po_action / create_mr_from_suggestions from 0005, post_miv /
-- save_mr / mr_submit / mr_action / acknowledge_miv / escalate from 0003,
-- approvals_for from 0007) so earlier behaviour is kept.
--
-- Uses the mr_status values added in 20261030000001_mr_flow_enums.sql.
-- Client settings (all configurable, nothing hard-coded): project_settings
-- pr_require_coordinator_review (true), pr_coordinator_final_limit (null =
-- management always approves), po_tolerance_pct (10), wf_sla_hours (24 h per
-- step), direct_purchase_limit, po_auto_approve; approval_limits rows for
-- doc_type 'purchase_request' (coordinator 50,000 / manager 1,000,000 ETB,
-- admin unlimited) seeded as company defaults.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------

alter table public.material_requests
  add column if not exists request_type text not null default 'site_use'
      check (request_type in ('site_use','purchase')),
  add column if not exists source_mr_id uuid references public.material_requests (id),   -- PR converted from a SUR
  add column if not exists lookahead_plan_id uuid,                                        -- FK added by the look-ahead migration
  add column if not exists current_owner_role text,                                       -- ball in court ('requester' or a role)
  add column if not exists coordinator_reviewed_by uuid references public.profiles (id),
  add column if not exists coordinator_reviewed_at timestamptz,
  add column if not exists procurement_owner uuid references public.profiles (id),
  add column if not exists procurement_accepted_at timestamptz,
  add column if not exists issue_by date,                                                 -- SUR: coordinator's store-order date
  add column if not exists received_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists status_reason text;
create index if not exists material_requests_type_status_idx on public.material_requests (project_id, request_type, status);
create index if not exists material_requests_source_idx on public.material_requests (source_mr_id) where source_mr_id is not null;

alter table public.mr_lines
  add column if not exists reviewed_qty numeric(16,3) check (reviewed_qty >= 0),          -- OE (SUR) / coordinator (PR) recommendation
  add column if not exists source_mr_line_id uuid references public.mr_lines (id),        -- PR line ← SUR line
  add column if not exists lookahead_item_id uuid,                                         -- FK added by the look-ahead migration
  add column if not exists qty_received numeric(16,3) not null default 0,                  -- PR: accepted via GRN (maintained)
  add column if not exists line_status text not null default 'open'
      check (line_status in ('open','short_closed','cancelled'));
create index if not exists mr_lines_source_line_idx on public.mr_lines (source_mr_line_id) where source_mr_line_id is not null;

alter table public.project_settings
  add column if not exists wf_sla_hours jsonb not null default
    '{"pr":{"submitted":24,"reviewed_by_coordinator":24,"approved_by_management":24,"with_procurement":24,"delivery_overdue":24},
      "sur":{"submitted":24,"reviewed":24,"approved":24,"issued":24,"issued_unacked":24}}'::jsonb,
  add column if not exists pr_require_coordinator_review boolean not null default true,
  add column if not exists pr_coordinator_final_limit numeric(18,2),   -- null = management always approves (client flow)
  add column if not exists direct_purchase_limit numeric(18,2) not null default 0,   -- 0 = direct purchase off
  add column if not exists po_tolerance_pct numeric(5,2) not null default 10,
  add column if not exists po_auto_approve boolean not null default true,
  add column if not exists delivery_notice_days int not null default 2,
  add column if not exists pr_requires_elements boolean not null default false,
  add column if not exists sur_auto_close_hours int not null default 24;

alter table public.purchase_orders
  add column if not exists purchase_method text not null default 'rfq' check (purchase_method in ('rfq','direct','framework')),
  add column if not exists auto_approved boolean not null default false,
  add column if not exists receipt_ref text;

-- BR-08 extended: limit per document type, optional per-person override.
alter table public.approval_limits
  add column if not exists doc_type text not null default 'any'
      check (doc_type in ('any','purchase_request','site_use','po')),
  add column if not exists user_id uuid references public.profiles (id) on delete cascade;
alter table public.approval_limits drop constraint if exists approval_limits_project_id_role_key;
create unique index if not exists approval_limits_key on public.approval_limits (project_id, role, doc_type, user_id) nulls not distinct;

-- Company defaults for purchase requests (client to confirm; edit the rows, not the code).
insert into public.approval_limits (project_id, role, doc_type, max_value) values
  (null, 'coordinator', 'purchase_request', 50000),
  (null, 'manager', 'purchase_request', 1000000)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- 2. New tables
-- -----------------------------------------------------------------------------

-- Every sign-off (review, endorse, approve, accept) — DoA evidence. Values live in mr_approval_values.
create table public.mr_approvals (
  id              uuid primary key default gen_random_uuid(),
  mr_id           uuid not null references public.material_requests (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  step            text not null check (step in ('oe_review','coordinator_review','endorse','approve','procurement_accept')),
  actor           uuid not null references public.profiles (id),
  actor_role      public.app_role not null,
  delegated_from  uuid references public.profiles (id),
  comment         text,
  superseded      boolean not null default false,    -- true once the request was returned / resubmitted
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index mr_approvals_mr_idx on public.mr_approvals (mr_id);

-- Price-restricted companion of mr_approvals.
create table public.mr_approval_values (
  approval_id  uuid primary key references public.mr_approvals (id) on delete cascade,
  project_id   uuid not null references public.projects (id),
  est_value    numeric(18,2),
  limit_used   numeric(18,2),           -- null = unlimited
  updated_at   timestamptz not null default now()
);

-- Price-restricted estimate (latest 90-day price observation, else spec_prices).
create table public.mr_estimates (
  mr_id           uuid primary key references public.material_requests (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  est_value       numeric(18,2),
  priced_lines    int,
  unpriced_lines  int,
  line_prices     jsonb not null default '[]'::jsonb,   -- [{mr_line_id, unit_price, qty}] frozen at approval
  computed_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.approval_delegations (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects (id),
  from_user   uuid not null references public.profiles (id),
  to_user     uuid not null references public.profiles (id),
  doc_type    text not null default 'any' check (doc_type in ('any','purchase_request','site_use','po')),
  valid_from  date not null,
  valid_to    date not null,
  reason      text not null,
  revoked_at  timestamptz,
  created_by  uuid not null references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (valid_to >= valid_from), check (from_user <> to_user)
);
create index approval_delegations_to_idx on public.approval_delegations (to_user, valid_from, valid_to);

-- Procurement → store keeper (+ security): one row per PO per expected trip. No prices.
create table public.delivery_notices (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id),
  po_id            uuid not null references public.purchase_orders (id),
  store_id         uuid not null references public.stores (id),
  expected_date    date not null,
  expected_window  text,
  vehicle_plate    text,
  driver_name      text,
  driver_phone     text,
  lines            jsonb not null,            -- [{po_line_id, material_spec_id, qty}]
  note             text,
  status           text not null default 'notified'
                   check (status in ('notified','acknowledged','reschedule_requested','arrived','received','cancelled')),
  ack_by           uuid references public.profiles (id),
  ack_at           timestamptz,
  ack_note         text,
  proposed_date    date,
  grn_id           uuid references public.grns (id),
  escalated_at     timestamptz,
  created_by       uuid not null references public.profiles (id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index delivery_notices_po_idx on public.delivery_notices (po_id);
create index delivery_notices_store_idx on public.delivery_notices (store_id, expected_date);

do $$
declare t text;
begin
  foreach t in array array['mr_approvals','mr_approval_values','mr_estimates','approval_delegations','delivery_notices'] loop
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['mr_approvals','approval_delegations','delivery_notices'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;
end $$;

create policy member_read on public.mr_approvals for select to authenticated using (app.is_member(project_id));
create policy member_read on public.delivery_notices for select to authenticated using (app.is_member(project_id));
create policy price_read on public.mr_approval_values for select to authenticated
  using (app.can_see_prices() and app.is_member(project_id));
create policy price_read on public.mr_estimates for select to authenticated
  using (app.can_see_prices() and app.is_member(project_id));
create policy own_or_mgmt_read on public.approval_delegations for select to authenticated
  using (app.is_active_user() and (from_user = auth.uid() or to_user = auth.uid()
         or (app.has_role('coordinator','manager','admin') and (project_id is null or app.is_member(project_id)))));

-- Gate: an incoming vehicle can be linked to a delivery notice.
select app.extend_check_values('public.vehicle_movements', 'linked_doc_type', array['delivery_notice']);

-- -----------------------------------------------------------------------------
-- 3. Backfill + type immutability
-- -----------------------------------------------------------------------------

-- Reorder requests (create_mr_from_suggestions) are purchases; legacy reviewed/approved map to the PR statuses.
-- Reorder rows that were already issued against stay site_use (they were used as store orders).
update public.material_requests set request_type = 'purchase',
  status = case status::text when 'reviewed' then 'reviewed_by_coordinator'::public.mr_status
                             when 'approved' then 'approved_by_management'::public.mr_status else status end
where purpose = 'Reorder' and status::text not in ('partially_issued','issued');

create trigger mr_type_immutable before update of request_type on public.material_requests
  for each row when (old.status <> 'draft' and new.request_type is distinct from old.request_type)
  execute function app.block_mutation();

-- -----------------------------------------------------------------------------
-- 4. Helpers
-- -----------------------------------------------------------------------------

create or replace function app.main_store(p_project uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.stores where project_id = p_project and deleted_at is null
  order by (store_type = 'main') desc, created_at limit 1
$$;

-- Ball in court per (type, status). 'requester' = the request's requested_by.
create or replace function app.mr_owner_role(p_type text, p_status public.mr_status, p_project uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_status::text in ('draft','returned') then 'requester'
    when p_type = 'purchase' then case p_status::text
      when 'submitted' then case when coalesce(s.pr_require_coordinator_review, true) then 'coordinator' else 'manager' end
      when 'reviewed_by_coordinator' then 'manager'
      when 'reviewed' then 'manager'
      when 'approved_by_management' then 'procurement'
      when 'approved' then 'procurement'
      when 'with_procurement' then 'procurement'
      when 'sourced' then 'procurement'
      when 'ordered' then 'procurement'
      when 'delivery_expected' then 'store_keeper'
      when 'partially_received' then 'procurement'
      when 'received' then 'requester'
      end
    else case p_status::text
      when 'submitted' then case when coalesce(s.require_review, true) then 'office_engineer' else 'coordinator' end
      when 'reviewed' then 'coordinator'
      when 'approved' then 'store_keeper'
      when 'sourced' then 'store_keeper'
      when 'ordered' then 'store_keeper'
      when 'partially_issued' then 'store_keeper'
      when 'issued' then 'requester'
      end
  end
  from (select 1) d left join public.project_settings s on s.project_id = p_project
$$;

create or replace function app.mr_status_label(p_type text, p_status text) returns text
language sql immutable as $$
  select case
    when p_type = 'purchase' then case p_status
      when 'submitted' then 'Submitted to coordinator' when 'reviewed_by_coordinator' then 'Reviewed by coordinator'
      when 'approved_by_management' then 'Approved by management' when 'with_procurement' then 'With procurement'
      when 'sourced' then 'Sourcing (RFQ / PO)' when 'ordered' then 'Purchased' when 'delivery_expected' then 'Delivery expected'
      when 'partially_received' then 'Partially received' when 'received' then 'Received' end
    else case p_status
      when 'submitted' then 'Waiting for office engineer review' when 'reviewed' then 'Forwarded to coordinator'
      when 'approved' then 'Store order issued' when 'partially_issued' then 'Partially issued'
      when 'issued' then 'Issued — awaiting acknowledgement' when 'received' then 'Received on site' end
  end
$$;

-- Status change + ball in court + timestamps + history row (one place for every transition).
create or replace function app.mr_transition(p_mr uuid, p_to public.mr_status, p_action text,
  p_comment text default null, p_payload jsonb default null) returns public.mr_status
language plpgsql security definer set search_path = public as $$
declare r public.material_requests;
begin
  select * into r from public.material_requests where id = p_mr;
  update public.material_requests set
    status = p_to,
    current_owner_role = app.mr_owner_role(r.request_type, p_to, r.project_id),
    submitted_at = case when p_to::text = 'submitted' then now() else submitted_at end,
    received_at = case when p_to::text = 'received' then now() when p_to::text in ('submitted','draft') then null else received_at end,
    closed_at = case when p_to::text in ('closed','rejected','cancelled') then now() else closed_at end,
    status_reason = case when p_to::text in ('returned','rejected','cancelled','closed') then coalesce(p_comment, status_reason)
                         when p_to::text = 'submitted' then null else status_reason end
  where id = p_mr;
  insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload, actor)
  values (p_mr, r.project_id, p_action, r.status, p_to, p_comment, p_payload, auth.uid());
  return r.status;
end $$;

-- Best known unit price (ex-VAT): latest price observation ≤ 90 days, else spec_prices.
create or replace function app.spec_est_price(p_spec uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.unit_price from public.price_observations o
      where o.material_spec_id = p_spec and o.observed_on >= current_date - 90
      order by o.observed_on desc, o.created_at desc limit 1),
    (select unit_price from public.spec_prices where material_spec_id = p_spec))
$$;

-- Upserts the price-restricted estimate; returns the priced value (unpriced lines don't block).
create or replace function app.mr_estimate(p_mr uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare v_val numeric; v_priced int; v_unpriced int; v_lines jsonb; v_project uuid;
begin
  select project_id into v_project from public.material_requests where id = p_mr;
  select round(coalesce(sum(x.q * x.price) filter (where x.price is not null), 0), 2),
         count(*) filter (where x.price is not null), count(*) filter (where x.price is null),
         coalesce(jsonb_agg(jsonb_build_object('mr_line_id', x.id, 'unit_price', x.price, 'qty', x.q)), '[]'::jsonb)
    into v_val, v_priced, v_unpriced, v_lines
  from (select l.id, coalesce(l.approved_qty, l.reviewed_qty, l.qty) as q, app.spec_est_price(l.material_spec_id) as price
          from public.mr_lines l
         where l.mr_id = p_mr and l.deleted_at is null and l.line_status = 'open'
           and coalesce(l.approved_qty, l.reviewed_qty, l.qty) > 0) x;
  insert into public.mr_estimates (mr_id, project_id, est_value, priced_lines, unpriced_lines, line_prices, computed_at)
  values (p_mr, v_project, v_val, v_priced, v_unpriced, v_lines, now())
  on conflict (mr_id) do update set est_value = excluded.est_value, priced_lines = excluded.priced_lines,
    unpriced_lines = excluded.unpriced_lines, line_prices = excluded.line_prices, computed_at = now();
  return v_val;
end $$;

-- Most specific approval_limits row for a user: per-user > per-project > doc_type match. null = no row = unlimited.
create or replace function app.limit_row(p_user uuid, p_project uuid, p_doc text) returns numeric
language sql stable security definer set search_path = public as $$
  select l.max_value from public.approval_limits l
  join public.profiles pr on pr.id = p_user
  where (l.user_id = p_user or (l.user_id is null and l.role = pr.role))
    and (l.project_id = p_project or l.project_id is null)
    and l.doc_type in (p_doc, 'any')
  order by (l.user_id is not null) desc, (l.project_id is not null) desc, (l.doc_type = p_doc) desc
  limit 1
$$;

-- Effective limit incl. active delegations (a delegate inherits the delegator's limit inside the window).
create or replace function app.approval_limit_for(p_user uuid, p_project uuid, p_doc text,
  out unlimited boolean, out max_value numeric, out delegated_from uuid)
language plpgsql stable security definer set search_path = public as $$
declare v numeric; d record;
begin
  v := app.limit_row(p_user, p_project, p_doc);
  unlimited := v is null; max_value := v; delegated_from := null;
  if unlimited then return; end if;
  for d in select dl.from_user from public.approval_delegations dl
           join public.profiles pr on pr.id = dl.from_user and pr.is_active
           where dl.to_user = p_user and dl.revoked_at is null and current_date between dl.valid_from and dl.valid_to
             and dl.doc_type in (p_doc, 'any') and (dl.project_id is null or dl.project_id = p_project) loop
    v := app.limit_row(d.from_user, p_project, p_doc);
    if v is null then unlimited := true; max_value := null; delegated_from := d.from_user; return; end if;
    if v > max_value then max_value := v; delegated_from := d.from_user; end if;
  end loop;
end $$;

create or replace function app.limit_covers(p_user uuid, p_project uuid, p_doc text, p_value numeric) returns boolean
language sql stable security definer set search_path = public as $$
  select l.unlimited or coalesce(p_value, 0) <= l.max_value from app.approval_limit_for(p_user, p_project, p_doc) l
$$;

-- Own role + roles of users who delegated to p_user (active window).
create or replace function app.acting_roles(p_user uuid, p_project uuid, p_doc text) returns text[]
language sql stable security definer set search_path = public as $$
  select array(
    select pr.role::text from public.profiles pr where pr.id = p_user and pr.is_active
    union
    select f.role::text from public.approval_delegations dl join public.profiles f on f.id = dl.from_user and f.is_active
     where dl.to_user = p_user and dl.revoked_at is null and current_date between dl.valid_from and dl.valid_to
       and dl.doc_type in (p_doc, 'any') and (dl.project_id is null or dl.project_id = p_project))
$$;

create or replace function app.require_acting(p_roles text[], variadic p_allowed text[]) returns void
language plpgsql stable as $$
begin
  if not coalesce(p_roles && p_allowed, false) then
    raise exception 'Your role (%) is not allowed to perform this action', coalesce(app.my_role()::text, 'inactive')
      using errcode = '42501';
  end if;
end $$;

create or replace function app.record_approval(p_mr uuid, p_project uuid, p_step text, p_comment text,
  p_value numeric default null, p_limit numeric default null, p_delegated uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.mr_approvals (mr_id, project_id, step, actor, actor_role, delegated_from, comment)
  values (p_mr, p_project, p_step, auth.uid(), app.my_role(), p_delegated, p_comment) returning id into v_id;
  if p_value is not null or p_limit is not null then
    insert into public.mr_approval_values (approval_id, project_id, est_value, limit_used) values (v_id, p_project, p_value, p_limit);
  end if;
  return v_id;
end $$;

-- Users (manager/admin members) whose limit covers the value — for "endorse up".
create or replace function app.notify_covering_approvers(p_mr uuid, p_value numeric, p_doc text, p_title text, p_body text)
returns int language plpgsql security definer set search_path = public as $$
declare r public.material_requests; u record; v_n int := 0;
begin
  select * into r from public.material_requests where id = p_mr;
  for u in select pr.id from public.profiles pr
           where pr.is_active and pr.role in ('manager','admin') and pr.id <> r.requested_by and pr.id is distinct from auth.uid()
             and (pr.role = 'admin' or exists (select 1 from public.project_members m where m.project_id = r.project_id and m.user_id = pr.id))
             and app.limit_covers(pr.id, r.project_id, p_doc, p_value)
             and not exists (select 1 from public.mr_approvals a where a.mr_id = p_mr and a.actor = pr.id and a.step = 'endorse' and not a.superseded) loop
    perform app.notify_user(u.id, r.project_id, p_title, p_body, 'material_request', p_mr, true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- -----------------------------------------------------------------------------
-- 5. Reservation-based available-to-issue (§5.1)
-- -----------------------------------------------------------------------------

create or replace function app.line_issued(p_line uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(ml.qty), 0) from public.miv_lines ml
  join public.mivs m on m.id = ml.miv_id and m.status <> 'reversed' where ml.mr_line_id = p_line
$$;

-- Unissued approved qty of site-use requests for store × spec (requests without a store use the main store).
-- p_before_* limits it to requests approved earlier (FIFO by approved_at).
create or replace function app.reserved_qty(p_store uuid, p_spec uuid, p_exclude_mr uuid default null,
  p_before_at timestamptz default null, p_before_id uuid default null) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(greatest(l.approved_qty - app.line_issued(l.id), 0)), 0)
  from public.mr_lines l join public.material_requests r on r.id = l.mr_id
  where l.deleted_at is null and l.material_spec_id = p_spec and l.approved_qty > 0 and l.line_status = 'open'
    and r.request_type = 'site_use' and r.status in ('approved','sourced','ordered','partially_issued')
    and coalesce(r.store_id, app.main_store(r.project_id)) = p_store
    and r.id is distinct from p_exclude_mr
    and (p_before_at is null or (r.approved_at, r.id) < (p_before_at, coalesce(p_before_id, r.id)))
$$;

-- Stock check per line returned by review / approve: ATI, shortfall, other stores, open POs.
create or replace function app.stock_check(p_mr uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  with r as (
    select m.*, coalesce(m.store_id, app.main_store(m.project_id)) as st,
           case when m.status in ('approved','sourced','ordered','partially_issued') then m.approved_at end as fifo_at
    from public.material_requests m where m.id = p_mr)
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'line_no', l.line_no, 'material_spec_id', l.material_spec_id, 'store_id', r.st,
      'requested', coalesce(l.approved_qty, l.reviewed_qty, l.qty), 'qty', l.qty,
      'reviewed_qty', l.reviewed_qty, 'approved_qty', l.approved_qty, 'issued', x.issued, 'ati', x.ati,
      'shortfall', greatest(coalesce(l.approved_qty, l.reviewed_qty, l.qty) - x.issued - x.ati, 0),
      'other_stores', (select coalesce(jsonb_agg(jsonb_build_object('store_id', s.id, 'store_name', s.name, 'qty', q.ati)), '[]'::jsonb)
                         from public.stores s
                         cross join lateral (select greatest(app.stock_qty(s.id, l.material_spec_id)
                                                - app.reserved_qty(s.id, l.material_spec_id, r.id), 0) as ati) q
                        where s.project_id = r.project_id and s.id <> r.st and s.deleted_at is null and q.ati > 0),
      'open_po', (select coalesce(jsonb_agg(jsonb_build_object('po_id', v.po_id, 'po_number', v.po_number, 'eta', v.expected_date,
                                                              'qty', v.outstanding_qty) order by v.expected_date), '[]'::jsonb)
                    from public.v_po_line_status v
                   where v.project_id = r.project_id and v.delivery_store_id = r.st and v.material_spec_id = l.material_spec_id
                     and v.po_status in ('approved','sent','partially_received') and v.outstanding_qty > 0)
    ) order by l.line_no), '[]'::jsonb)
  from r
  join public.mr_lines l on l.mr_id = r.id and l.deleted_at is null
  cross join lateral (select app.line_issued(l.id) as issued,
                             greatest(app.stock_qty(r.st, l.material_spec_id)
                                      - app.reserved_qty(r.st, l.material_spec_id, r.id, r.fifo_at, r.id), 0) as ati) x
$$;

-- BoQ balance (0003) now counts site-use requests only: a PR buys stock, the SUR consumes it.
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
        and r.id <> p_exclude_mr and r.request_type = 'site_use'
        and r.status not in ('draft','rejected','cancelled','returned')), 0)
$$;

-- -----------------------------------------------------------------------------
-- 6. Submit / save (0003 redefined, per type)
-- -----------------------------------------------------------------------------

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
  v_urgent boolean;
  v_roles text[];
  v_src text;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if r.status = 'submitted' then
    return;
  end if;
  if r.status not in ('draft','returned') then
    raise exception 'Only draft or returned requests can be submitted (status: %)', r.status;
  end if;
  select * into v_settings from public.project_settings where project_id = r.project_id;
  v_urgent := r.priority <> 'normal';

  -- FR-MR-01: required fields (a PR for stock / reorder need not be tied to a block)
  if r.request_type = 'site_use' and r.block_id is null then raise exception 'Block is required'; end if;
  if r.delivery_location is null and r.store_id is null then raise exception 'Delivery location is required'; end if;

  for l in select * from public.mr_lines where mr_id = p_mr and deleted_at is null order by line_no loop
    v_lines := v_lines + 1;
    select coalesce(sum(qty), 0) into v_split from public.mr_line_elements
      where mr_line_id = l.id and deleted_at is null;
    if v_split = 0 then
      if r.request_type = 'site_use'
         or (coalesce(v_settings.pr_requires_elements, false) and r.source_mr_id is null and r.purpose is distinct from 'Reorder') then
        raise exception 'Line %: at least one structural element is required', l.line_no;
      end if;
      continue;
    end if;
    if abs(v_split - l.qty) > 0.001 then
      raise exception 'Line %: element split (%) must equal the line quantity (%)', l.line_no, v_split, l.qty;
    end if;

    -- FR-MR-04 / BR-03: quantities above the remaining take-off need a reason (a converted PR is part of its SUR).
    if r.source_mr_id is null then
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
    end if;

    update public.mr_lines ml set boq_item_id = coalesce(ml.boq_item_id, (
      select t.boq_item_id from public.element_takeoffs t
      join public.mr_line_elements le on le.element_id = t.element_id and le.mr_line_id = ml.id
      where t.material_spec_id = ml.material_spec_id and t.boq_item_id is not null limit 1))
    where ml.id = l.id;
  end loop;

  if v_lines = 0 then
    raise exception 'A request needs at least one line';
  end if;

  -- Resubmission restarts the approval chain.
  if r.status = 'returned' then
    update public.mr_lines set approved_qty = null, reviewed_qty = null where mr_id = p_mr;
    update public.material_requests set reviewed_by = null, reviewed_at = null, coordinator_reviewed_by = null,
      coordinator_reviewed_at = null, approved_by = null, approved_at = null, procurement_owner = null,
      procurement_accepted_at = null where id = p_mr;
  end if;
  update public.mr_approvals set superseded = true where mr_id = p_mr and not superseded;

  perform app.mr_transition(p_mr, 'submitted', 'submit');

  if r.request_type = 'site_use' then
    v_roles := case when coalesce(v_settings.require_review, true) then '{office_engineer}'::text[] else '{coordinator}'::text[] end;
    if v_urgent and not ('coordinator' = any (v_roles)) then v_roles := v_roles || 'coordinator'::text; end if;
    perform app.notify_roles_txt(r.project_id, v_roles, 'New material request ' || r.number,
      initcap(r.priority::text) || ' — required ' || to_char(r.required_date, 'DD Mon YYYY'),
      'material_request', p_mr, v_urgent);
  else
    perform app.mr_estimate(p_mr);
    select number into v_src from public.material_requests where id = r.source_mr_id;
    v_roles := case when coalesce(v_settings.pr_require_coordinator_review, true) then '{coordinator}'::text[] else '{manager}'::text[] end;
    perform app.notify_roles_txt(r.project_id, v_roles, 'Purchase request ' || r.number || ' submitted',
      concat_ws(' — ', 'Shortfall of ' || v_src, initcap(r.priority::text), 'required ' || to_char(r.required_date, 'DD Mon YYYY')),
      'material_request', p_mr, v_urgent);
  end if;
  -- FR-WF-05: urgent/critical requests alert procurement immediately.
  if v_urgent then
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
  v_type text := nullif(p ->> 'request_type', '');
  v_exists boolean;
  r public.material_requests;
  v_line jsonb;
  v_el jsonb;
  v_line_ids uuid[] := '{}';
  v_el_ids uuid[];
  v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);

  select * into r from public.material_requests where id = v_id for update;
  v_exists := found;
  if v_exists then
    if v_type is not null and v_type <> r.request_type and (r.status <> 'draft' or r.submitted_at is not null) then
      raise exception 'The request type cannot be changed after the request was submitted';
    end if;
    v_type := coalesce(v_type, r.request_type);
  else
    v_type := coalesce(v_type, 'site_use');
  end if;
  if v_type not in ('site_use','purchase') then raise exception 'Unknown request type %', v_type; end if;
  if v_type = 'site_use' then
    perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  else
    perform app.require_role('office_engineer','coordinator','manager','procurement','store_keeper','admin');
  end if;

  if v_exists then
    if r.project_id <> v_project then raise exception 'Request belongs to another project'; end if;
    if r.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the requester can edit this request';
    end if;
    if r.status not in ('draft','returned','submitted') then
      raise exception 'Request % can no longer be edited (status: %)', r.number, r.status;
    end if;
    update public.material_requests set
      request_type = v_type,
      block_id = (p ->> 'block_id')::uuid,
      priority = coalesce((p ->> 'priority')::public.mr_priority, 'normal'),
      required_date = (p ->> 'required_date')::date,
      delivery_location = nullif(p ->> 'delivery_location', ''),
      store_id = (p ->> 'store_id')::uuid,
      drawing_ref = nullif(p ->> 'drawing_ref', ''),
      purpose = nullif(p ->> 'purpose', ''),
      is_lookahead = coalesce((p ->> 'is_lookahead')::boolean, false),
      lookahead_plan_id = coalesce((p ->> 'lookahead_plan_id')::uuid, lookahead_plan_id),
      version = version + 1,
      -- editing a submitted request sends it back through review
      status = case when status = 'submitted' then 'draft'::public.mr_status else status end,
      current_owner_role = case when status in ('submitted','draft') then 'requester' else current_owner_role end
    where id = v_id;
    if r.status = 'submitted' then
      insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
      values (v_id, v_project, 'edit', 'submitted', 'draft', auth.uid());
    end if;
  else
    if p ->> 'required_date' is null then raise exception 'Required date is required'; end if;
    if v_type = 'purchase' and coalesce(p ->> 'number', '') !~ '(^|-)PR-' then
      raise exception 'Purchase request numbers use the PR document type (e.g. PROJ-PR-D001-0001)';
    end if;
    insert into public.material_requests (id, project_id, number, block_id, requested_by, requester_role,
      priority, required_date, delivery_location, store_id, drawing_ref, purpose, is_lookahead, device_created_at,
      request_type, lookahead_plan_id, current_owner_role)
    values (v_id, v_project, p ->> 'number', (p ->> 'block_id')::uuid, auth.uid(), app.my_role(),
      coalesce((p ->> 'priority')::public.mr_priority, 'normal'), (p ->> 'required_date')::date,
      nullif(p ->> 'delivery_location', ''), (p ->> 'store_id')::uuid, nullif(p ->> 'drawing_ref', ''),
      nullif(p ->> 'purpose', ''), coalesce((p ->> 'is_lookahead')::boolean, false),
      (p ->> 'device_created_at')::timestamptz, v_type, (p ->> 'lookahead_plan_id')::uuid, 'requester');
    insert into public.mr_events (mr_id, project_id, action, to_status, actor, payload)
    values (v_id, v_project, 'create', 'draft', auth.uid(), jsonb_build_object('request_type', v_type));
  end if;

  for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if v_line ->> 'material_spec_id' is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce((v_line ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    v_line_ids := v_line_ids || (v_line ->> 'id')::uuid;
    insert into public.mr_lines (id, mr_id, project_id, line_no, material_spec_id, qty, required_date, remarks, over_boq_reason,
      lookahead_item_id)
    values ((v_line ->> 'id')::uuid, v_id, v_project, v_n, (v_line ->> 'material_spec_id')::uuid,
      (v_line ->> 'qty')::numeric, coalesce((v_line ->> 'required_date')::date, (p ->> 'required_date')::date),
      nullif(v_line ->> 'remarks', ''), nullif(v_line ->> 'over_boq_reason', ''), (v_line ->> 'lookahead_item_id')::uuid)
    on conflict (id) do update set
      line_no = excluded.line_no, material_spec_id = excluded.material_spec_id, qty = excluded.qty,
      required_date = excluded.required_date, remarks = excluded.remarks,
      over_boq_reason = excluded.over_boq_reason, exceeds_boq = false, deleted_at = null,
      lookahead_item_id = coalesce(excluded.lookahead_item_id, public.mr_lines.lookahead_item_id)
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

  return app.op_done(p, 'save_mr', jsonb_build_object('ok', true, 'id', v_id, 'request_type', v_type,
    'status', (select status from public.material_requests where id = v_id)));
end $$;

-- -----------------------------------------------------------------------------
-- 7. Workflow actions
-- -----------------------------------------------------------------------------

-- Site-use shortfall → linked purchase request (enters Flow A at the coordinator).
create or replace function app.convert_shortfall(r public.material_requests, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_pr uuid := coalesce((p ->> 'pr_id')::uuid, gen_random_uuid());
  v_number text := nullif(trim(p ->> 'pr_number'), '');
  v_line jsonb; ml public.mr_lines; v_q numeric; v_n int := 0; v_new uuid;
  v_el record; v_cnt int; v_tot numeric; v_i int; v_acc numeric; v_eq numeric; v_lines jsonb := '[]'::jsonb;
begin
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'Choose the line(s) and quantity to purchase';
  end if;
  if v_number is null then
    v_number := case when r.number ~ '-(MR|SR)-' then regexp_replace(r.number, '-(MR|SR)-', '-PR-') else 'PR-' || r.number end;
    if exists (select 1 from public.material_requests where number = v_number) then
      v_number := v_number || '-' || ((select count(*) from public.material_requests where source_mr_id = r.id) + 1);
    end if;
  end if;

  insert into public.material_requests (id, project_id, number, block_id, requested_by, requester_role, priority, required_date,
    delivery_location, store_id, drawing_ref, purpose, is_lookahead, lookahead_plan_id, request_type, source_mr_id, current_owner_role)
  values (v_pr, r.project_id, v_number, r.block_id, auth.uid(), app.my_role(), r.priority, r.required_date, r.delivery_location,
    coalesce(r.store_id, app.main_store(r.project_id)), r.drawing_ref, 'Shortfall of ' || r.number || coalesce(': ' || r.purpose, ''),
    r.is_lookahead, r.lookahead_plan_id, 'purchase', r.id, 'requester');
  insert into public.mr_events (mr_id, project_id, action, to_status, actor, payload)
  values (v_pr, r.project_id, 'create', 'draft', auth.uid(), jsonb_build_object('request_type', 'purchase', 'source_mr_id', r.id));

  for v_line in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    select * into ml from public.mr_lines where id = (v_line ->> 'id')::uuid and mr_id = r.id and deleted_at is null;
    if not found then raise exception 'Line %: request line not found on %', v_n, r.number; end if;
    v_q := (v_line ->> 'qty')::numeric;
    if v_q is null or v_q <= 0 then raise exception 'Line %: purchase quantity must be greater than zero', ml.line_no; end if;
    if v_q > ml.qty + 0.0005 then raise exception 'Line %: cannot purchase more than the requested %', ml.line_no, ml.qty; end if;
    v_new := coalesce((v_line ->> 'pr_line_id')::uuid, gen_random_uuid());
    insert into public.mr_lines (id, mr_id, project_id, line_no, material_spec_id, qty, required_date, remarks, boq_item_id,
      source_mr_line_id, lookahead_item_id)
    values (v_new, v_pr, r.project_id, v_n, ml.material_spec_id, v_q, ml.required_date,
      'Shortfall of ' || r.number || ' line ' || ml.line_no, ml.boq_item_id, ml.id, ml.lookahead_item_id);
    -- element split scaled to the purchase quantity (remainder on the last element)
    select count(*), coalesce(sum(qty), 0) into v_cnt, v_tot from public.mr_line_elements where mr_line_id = ml.id and deleted_at is null;
    if v_cnt > 0 and v_tot > 0 then
      v_i := 0; v_acc := 0;
      for v_el in select * from public.mr_line_elements where mr_line_id = ml.id and deleted_at is null order by id loop
        v_i := v_i + 1;
        v_eq := case when v_i = v_cnt then v_q - v_acc else round(v_el.qty * v_q / v_tot, 3) end;
        v_acc := v_acc + v_eq;
        if v_eq > 0 then
          insert into public.mr_line_elements (id, mr_line_id, project_id, element_id, qty)
          values (gen_random_uuid(), v_new, r.project_id, v_el.element_id, v_eq);
        end if;
      end loop;
    end if;
    v_lines := v_lines || jsonb_build_object('sur_line_id', ml.id, 'pr_line_id', v_new, 'qty', v_q);
  end loop;

  insert into public.mr_versions (mr_id, project_id, version, snapshot, changed_by)
  values (v_pr, r.project_id, 1, jsonb_build_object('converted_from', r.id, 'lines', v_lines), auth.uid());
  perform app.mr_submit(v_pr);
  return jsonb_build_object('pr_id', v_pr, 'pr_number', v_number, 'pr_lines', v_lines);
end $$;

-- Flow B (site use). Legacy actions/payloads unchanged; adds reviewed_qty, stock check,
-- issue_by/store_id on approve, convert_shortfall, self-approval block.
create or replace function app.mr_action_site_use(p jsonb, r public.material_requests) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  v_settings public.project_settings;
  v_to public.mr_status;
  v_line jsonb;
  v_partial boolean := false;
  v_value numeric;
  v_lim record;
  v_issued boolean;
  v_q numeric;
  ml public.mr_lines;
  v_extra jsonb := '{}'::jsonb;
  v_name text;
begin
  select * into v_settings from public.project_settings where project_id = r.project_id;
  select exists (select 1 from public.miv_lines x join public.mivs m on m.id = x.miv_id and m.status <> 'reversed'
                 join public.mr_lines l on l.id = x.mr_line_id where l.mr_id = r.id) into v_issued;

  case v_action
  when 'review' then
    perform app.require_role('office_engineer','coordinator','manager','admin');
    if r.status <> 'submitted' then raise exception 'Only submitted requests can be reviewed'; end if;
    for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      continue when v_line ->> 'reviewed_qty' is null;
      select * into ml from public.mr_lines where id = (v_line ->> 'id')::uuid and mr_id = r.id and deleted_at is null;
      if not found then raise exception 'Line not found on request %', r.number; end if;
      v_q := (v_line ->> 'reviewed_qty')::numeric;
      if v_q < 0 or v_q > ml.qty + 0.0005 then
        raise exception 'Line %: reviewed quantity must be between 0 and the requested %', ml.line_no, ml.qty;
      end if;
      update public.mr_lines set reviewed_qty = v_q where id = ml.id;
    end loop;
    update public.material_requests set reviewed_by = auth.uid(), reviewed_at = now() where id = r.id;
    perform app.record_approval(r.id, r.project_id, 'oe_review', v_comment);
    v_to := 'reviewed';
    v_extra := jsonb_build_object('stock', app.stock_check(r.id));
    perform app.notify_roles(r.project_id, '{coordinator}', 'Request ' || r.number || ' forwarded for approval',
      coalesce(v_comment, 'Reviewed against BoQ / take-off'), 'material_request', r.id, r.priority <> 'normal');

  when 'approve' then
    perform app.require_role('coordinator','manager','admin');
    if r.status not in ('submitted','reviewed') then
      raise exception 'Request cannot be approved from status %', r.status;
    end if;
    if r.requested_by = auth.uid() then raise exception 'You cannot approve your own request'; end if;
    update public.mr_lines set approved_qty = coalesce(reviewed_qty, qty) where mr_id = r.id and deleted_at is null;
    for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      continue when v_line ->> 'approved_qty' is null;
      if (v_line ->> 'approved_qty')::numeric < 0 then raise exception 'Approved quantity cannot be negative'; end if;
      update public.mr_lines set approved_qty = least((v_line ->> 'approved_qty')::numeric, coalesce(reviewed_qty, qty))
        where id = (v_line ->> 'id')::uuid and mr_id = r.id;
    end loop;
    v_partial := exists (select 1 from public.mr_lines where mr_id = r.id and deleted_at is null and approved_qty < qty);
    -- BR-08: value-based approval limits (doc_type 'site_use', usually unlimited).
    select coalesce(sum(l.approved_qty * sp.unit_price), 0) into v_value
      from public.mr_lines l join public.spec_prices sp on sp.material_spec_id = l.material_spec_id
      where l.mr_id = r.id and l.deleted_at is null;
    select * into v_lim from app.approval_limit_for(auth.uid(), r.project_id, 'site_use');
    if not v_lim.unlimited and v_value > v_lim.max_value then
      raise exception 'Request value % exceeds your approval limit of %; a higher approver is required',
        round(v_value, 2), round(v_lim.max_value, 2);
    end if;
    if p ->> 'store_id' is not null then perform app.require_store(r.project_id, (p ->> 'store_id')::uuid); end if;
    update public.material_requests set approved_by = auth.uid(), approved_at = now(),
      store_id = coalesce((p ->> 'store_id')::uuid, store_id), issue_by = coalesce((p ->> 'issue_by')::date, issue_by)
    where id = r.id;
    perform app.record_approval(r.id, r.project_id, 'approve', v_comment, null, null, v_lim.delegated_from);
    v_to := 'approved';
    if v_partial then v_action := 'partial_approve'; end if;
    select full_name into v_name from public.profiles where id = r.requested_by;
    perform app.notify_roles(r.project_id, '{store_keeper}', 'Store order ' || r.number || ': issue to ' || coalesce(nullif(v_name, ''), 'requester'),
      'Issue by ' || to_char(coalesce((p ->> 'issue_by')::date, r.issue_by, r.required_date), 'DD Mon YYYY'),
      'material_request', r.id, r.priority <> 'normal');
    v_extra := jsonb_build_object('stock', app.stock_check(r.id));

  when 'convert_shortfall' then
    perform app.require_role('office_engineer','coordinator','admin');
    if r.status not in ('submitted','reviewed','approved','partially_issued') then
      raise exception 'Shortfall can only be converted while the request is open (status: %)', r.status;
    end if;
    v_extra := app.convert_shortfall(r, p);
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload, actor)
    values (r.id, r.project_id, 'convert_shortfall', r.status, r.status, v_comment, v_extra, auth.uid());
    perform app.notify_user(r.requested_by, r.project_id, 'Request ' || r.number || ': shortfall to be purchased',
      'Purchase request ' || (v_extra ->> 'pr_number') || ' raised for the missing quantity', 'material_request', r.id);
    return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', r.status) || v_extra);

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
    update public.mr_approvals set superseded = true where mr_id = r.id and not superseded;
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
    if r.status not in ('approved','partially_issued','issued','received') then
      raise exception 'Only approved/issued requests can be closed';
    end if;
    v_to := 'closed';

  else
    raise exception 'Unknown action %', v_action;
  end case;

  perform app.mr_transition(r.id, v_to, v_action, v_comment, p -> 'lines');
  perform app.notify_user(r.requested_by, r.project_id,
    'Request ' || r.number || ': ' || replace(v_action, '_', ' '),
    coalesce(v_comment, 'Status: ' || coalesce(app.mr_status_label('site_use', v_to::text), v_to::text)), 'material_request', r.id);

  return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', v_to) || v_extra);
end $$;

-- Procurement accepted (also implicit when procurement raises an RFQ / direct purchase from the PR).
create or replace function app.pr_accept(p_mr uuid, p_owner uuid, p_comment text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.material_requests;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if r.request_type <> 'purchase' or r.status::text not in ('approved_by_management','approved') then return; end if;
  update public.material_requests set procurement_owner = coalesce(p_owner, auth.uid()), procurement_accepted_at = now() where id = p_mr;
  perform app.record_approval(p_mr, r.project_id, 'procurement_accept', p_comment);
  perform app.mr_transition(p_mr, 'with_procurement', 'accept', p_comment);
  perform app.notify_user(r.requested_by, r.project_id, 'Purchase request ' || r.number || ': with procurement',
    coalesce(p_comment, 'Procurement is buying the materials'), 'material_request', p_mr);
  if p_owner is not null and p_owner is distinct from auth.uid() then
    perform app.notify_user(p_owner, r.project_id, 'Purchase request ' || r.number || ' assigned to you',
      'Required ' || to_char(r.required_date, 'DD Mon YYYY'), 'material_request', p_mr, r.priority <> 'normal');
  end if;
end $$;

-- Flow A (purchase request) state machine — §3.2 A2–A16.
create or replace function app.mr_action_purchase(p jsonb, r public.material_requests) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  v_settings public.project_settings;
  v_to public.mr_status;
  v_line jsonb;
  ml public.mr_lines;
  v_q numeric;
  v_partial boolean;
  v_value numeric;
  v_lim record;
  v_roles text[];
  v_mgmt boolean;
  v_coord boolean;
  v_committed boolean;
  v_src public.material_requests;
  v_status text := r.status::text;
begin
  select * into v_settings from public.project_settings where project_id = r.project_id;
  v_roles := app.acting_roles(auth.uid(), r.project_id, 'purchase_request');
  -- an RFQ went out or a (non-cancelled) PO exists for any line
  v_committed := exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                         join public.mr_lines l on l.id = pl.mr_line_id
                         where l.mr_id = r.id and pl.deleted_at is null and po.status not in ('cancelled','rejected'))
              or exists (select 1 from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
                         join public.mr_lines l on l.id = rl.mr_line_id
                         where l.mr_id = r.id and rl.deleted_at is null and q.status in ('sent','closed','awarded'));
  select * into v_src from public.material_requests where id = r.source_mr_id;

  case v_action
  when 'review' then                                                   -- A2
    perform app.require_acting(v_roles, 'coordinator', 'admin');
    if v_status <> 'submitted' then
      raise exception 'Only submitted purchase requests can be reviewed (status: %)', r.status;
    end if;
    if r.requested_by = auth.uid() then raise exception 'You cannot review your own request'; end if;
    for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      continue when v_line ->> 'reviewed_qty' is null;
      select * into ml from public.mr_lines where id = (v_line ->> 'id')::uuid and mr_id = r.id and deleted_at is null;
      if not found then raise exception 'Line not found on request %', r.number; end if;
      v_q := (v_line ->> 'reviewed_qty')::numeric;
      if v_q < 0 or v_q > ml.qty + 0.0005 then
        raise exception 'Line %: reviewed quantity must be between 0 and the requested %', ml.line_no, ml.qty;
      end if;
      update public.mr_lines set reviewed_qty = v_q where id = ml.id;
    end loop;
    update public.material_requests set coordinator_reviewed_by = auth.uid(), coordinator_reviewed_at = now(),
      reviewed_by = auth.uid(), reviewed_at = now() where id = r.id;
    v_value := app.mr_estimate(r.id);
    perform app.record_approval(r.id, r.project_id, 'coordinator_review', v_comment, v_value);
    v_to := 'reviewed_by_coordinator';
    perform app.notify_roles(r.project_id, '{manager}', 'Purchase request ' || r.number || ' reviewed — approval needed',
      coalesce(v_comment, 'Reviewed by the coordinator'), 'material_request', r.id, r.priority <> 'normal');

  when 'approve' then                                                  -- A3 (+ coordinator shortcut, endorse-up)
    v_mgmt := v_roles && array['manager','admin'];
    v_coord := not v_mgmt and 'coordinator' = any (v_roles);
    if not v_mgmt and not v_coord then perform app.require_acting(v_roles, 'manager', 'admin'); end if;
    if v_coord and v_settings.pr_coordinator_final_limit is null then
      raise exception 'Your role (coordinator) is not allowed to approve purchase requests; management approval is required'
        using errcode = '42501';
    end if;
    if r.requested_by = auth.uid() then raise exception 'You cannot approve your own request'; end if;
    if v_coord then
      if v_status not in ('submitted','reviewed_by_coordinator') then
        raise exception 'Purchase request cannot be approved from status %', r.status;
      end if;
    elsif v_status = 'submitted' and coalesce(v_settings.pr_require_coordinator_review, true) then
      raise exception 'Purchase request % must be reviewed by the coordinator first', r.number;
    elsif v_status not in ('submitted','reviewed_by_coordinator','reviewed') then
      raise exception 'Only coordinator-reviewed purchase requests can be approved (status: %)', r.status;
    end if;
    update public.mr_lines set approved_qty = coalesce(approved_qty, reviewed_qty, qty)
      where mr_id = r.id and deleted_at is null and line_status = 'open';
    for v_line in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
      continue when v_line ->> 'approved_qty' is null;
      select * into ml from public.mr_lines where id = (v_line ->> 'id')::uuid and mr_id = r.id and deleted_at is null;
      if not found then raise exception 'Line not found on request %', r.number; end if;
      v_q := (v_line ->> 'approved_qty')::numeric;
      if v_q < 0 or v_q > coalesce(ml.reviewed_qty, ml.qty) + 0.0005 then
        raise exception 'Line %: approved quantity must be between 0 and %', ml.line_no, coalesce(ml.reviewed_qty, ml.qty);
      end if;
      update public.mr_lines set approved_qty = v_q where id = ml.id;
    end loop;
    if not exists (select 1 from public.mr_lines where mr_id = r.id and deleted_at is null and approved_qty > 0) then
      raise exception 'Approve at least one line, or reject the request';
    end if;
    v_partial := exists (select 1 from public.mr_lines where mr_id = r.id and deleted_at is null and approved_qty < qty);
    v_value := app.mr_estimate(r.id);
    if v_coord and v_value > v_settings.pr_coordinator_final_limit then
      raise exception 'Requests above the coordinator approval limit need management approval; review it instead'
        using errcode = '42501';
    end if;
    select * into v_lim from app.approval_limit_for(auth.uid(), r.project_id, 'purchase_request');
    if not v_lim.unlimited and v_value > v_lim.max_value then
      -- over the approver's limit: endorse and route to a higher approver; status stays.
      if exists (select 1 from public.mr_approvals where mr_id = r.id and actor = auth.uid() and step = 'endorse' and not superseded) then
        raise exception 'You already endorsed %; it is waiting for an approver with a higher limit', r.number;
      end if;
      perform app.record_approval(r.id, r.project_id, 'endorse', v_comment, v_value, v_lim.max_value, v_lim.delegated_from);
      insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload, actor)
      values (r.id, r.project_id, 'endorse', r.status, r.status, v_comment, p -> 'lines', auth.uid());
      perform app.notify_covering_approvers(r.id, v_value, 'purchase_request',
        'Purchase request ' || r.number || ' needs your approval', 'Endorsed; value above the endorser''s approval limit');
      perform app.notify_user(r.requested_by, r.project_id, 'Purchase request ' || r.number || ': endorsed',
        'Sent to a higher approver', 'material_request', r.id);
      return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', r.status, 'endorsed', true));
    end if;
    update public.material_requests set approved_by = auth.uid(), approved_at = now(),
      coordinator_reviewed_by = coalesce(coordinator_reviewed_by, case when v_coord then auth.uid() end),
      coordinator_reviewed_at = coalesce(coordinator_reviewed_at, case when v_coord then now() end)
    where id = r.id;
    perform app.record_approval(r.id, r.project_id, 'approve', v_comment, v_value,
      case when v_lim.unlimited then null else v_lim.max_value end, v_lim.delegated_from);
    v_to := 'approved_by_management';
    if v_partial then v_action := 'partial_approve'; end if;
    perform app.notify_roles(r.project_id, '{procurement}', 'Purchase request ' || r.number || ' approved — please buy',
      'Required ' || to_char(r.required_date, 'DD Mon YYYY'), 'material_request', r.id, r.priority <> 'normal');
    if v_src.id is not null then
      perform app.notify_user(v_src.requested_by, r.project_id, 'Purchase for ' || v_src.number || ' approved',
        'Purchase request ' || r.number, 'material_request', v_src.id);
    end if;

  when 'accept' then                                                   -- A6
    perform app.require_acting(v_roles, 'procurement', 'admin');
    if v_status not in ('approved_by_management','approved') then
      raise exception 'Only management-approved purchase requests can be accepted (status: %)', r.status;
    end if;
    perform app.pr_accept(r.id, coalesce((p ->> 'assign_to')::uuid, auth.uid()), v_comment);
    perform app.refresh_mr_procurement(r.id);
    return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id,
      'status', (select status from public.material_requests where id = r.id)));

  when 'return' then                                                   -- A4 / A7
    if v_comment is null then raise exception 'Please say what needs clarification'; end if;
    if v_status in ('submitted','reviewed_by_coordinator','reviewed') then
      perform app.require_acting(v_roles, 'coordinator', 'manager', 'admin');
    elsif v_status in ('approved_by_management','with_procurement','approved') then
      perform app.require_acting(v_roles, 'procurement', 'coordinator', 'manager', 'admin');
      if v_committed then raise exception 'An RFQ was sent or a PO exists for %; cancel it first', r.number; end if;
    else
      raise exception 'Request cannot be returned at this stage (status: %)', r.status;
    end if;
    update public.mr_lines set approved_qty = null where mr_id = r.id;
    update public.material_requests set approved_by = null, approved_at = null, procurement_owner = null,
      procurement_accepted_at = null where id = r.id;
    update public.mr_approvals set superseded = true where mr_id = r.id and not superseded;
    v_to := 'returned';
    if v_src.id is not null then
      perform app.notify_user(v_src.requested_by, r.project_id, 'Purchase for ' || v_src.number || ' returned', v_comment,
        'material_request', v_src.id);
    end if;

  when 'reject' then                                                   -- A5
    if v_comment is null then raise exception 'A reason is required to reject'; end if;
    if v_status = 'submitted' then
      perform app.require_acting(v_roles, 'coordinator', 'manager', 'admin');
    elsif v_status in ('reviewed_by_coordinator','reviewed','approved_by_management','approved') then
      perform app.require_acting(v_roles, 'manager', 'admin');
    else
      raise exception 'Request cannot be rejected at this stage (status: %)', r.status;
    end if;
    if v_committed then raise exception 'An RFQ was sent or a PO exists for %; it can no longer be rejected', r.number; end if;
    v_to := 'rejected';
    if v_src.id is not null then
      perform app.notify_user(v_src.requested_by, r.project_id, 'Purchase for ' || v_src.number || ' rejected', v_comment,
        'material_request', v_src.id);
    end if;

  when 'cancel' then                                                   -- A15 / A16
    if v_status in ('draft','submitted','returned','reviewed_by_coordinator','reviewed') then
      if r.requested_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
        raise exception 'Only the requester or management can cancel';
      end if;
    elsif v_status in ('approved_by_management','with_procurement','sourced','approved') then
      perform app.require_role('coordinator','manager','admin');
      if v_comment is null then raise exception 'A reason is required to cancel an approved purchase request'; end if;
      if exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                 join public.mr_lines l on l.id = pl.mr_line_id
                 where l.mr_id = r.id and pl.deleted_at is null and po.status not in ('draft','rejected','cancelled')) then
        raise exception 'A purchase order was already issued for %; cancel the PO first', r.number;
      end if;
      update public.po_lines pl set mr_line_id = null
        from public.purchase_orders po
       where po.id = pl.po_id and po.status in ('draft','rejected','cancelled')
         and pl.mr_line_id in (select id from public.mr_lines where mr_id = r.id);
      update public.rfq_lines rl set mr_line_id = null
        from public.rfqs q
       where q.id = rl.rfq_id and q.status <> 'awarded'
         and rl.mr_line_id in (select id from public.mr_lines where mr_id = r.id);
    else
      raise exception 'Request cannot be cancelled at this stage (status: %)', r.status;
    end if;
    v_to := 'cancelled';

  when 'close' then                                                    -- A14 short-close
    perform app.require_role('procurement','coordinator','manager','admin');
    if v_status not in ('with_procurement','sourced','ordered','delivery_expected','partially_received','received') then
      raise exception 'Only purchased requests can be closed (status: %)', r.status;
    end if;
    if v_status <> 'received' and v_comment is null then raise exception 'A reason is required to short-close'; end if;
    update public.mr_lines set line_status = 'short_closed'
      where mr_id = r.id and deleted_at is null and line_status = 'open' and qty_received < coalesce(approved_qty, 0) - 0.0005;
    v_to := 'closed';

  when 'convert_shortfall' then
    raise exception 'Shortfall conversion applies to site-use requests only';

  else
    raise exception 'Unknown action %', v_action;
  end case;

  perform app.mr_transition(r.id, v_to, v_action, v_comment, p -> 'lines');
  perform app.notify_user(r.requested_by, r.project_id,
    'Purchase request ' || r.number || ': ' || coalesce(app.mr_status_label('purchase', v_to::text), replace(v_to::text, '_', ' ')),
    coalesce(v_comment, replace(v_action, '_', ' ')), 'material_request', r.id);

  return app.op_done(p, 'mr_action', jsonb_build_object('ok', true, 'id', r.id, 'status', v_to));
end $$;

-- FR-WF-03: one entry point; the state machine depends on request_type.
create or replace function public.mr_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  r public.material_requests;
begin
  if v_seen is not null then return v_seen; end if;
  select * into r from public.material_requests where id = (p ->> 'mr_id')::uuid for update;
  if not found then raise exception 'Request not found'; end if;
  perform app.require_member(r.project_id);
  if r.request_type = 'purchase' then
    return app.mr_action_purchase(p, r);
  end if;
  return app.mr_action_site_use(p, r);
end $$;

-- -----------------------------------------------------------------------------
-- 8. Status refresh (0005 definitions extended per type)
-- -----------------------------------------------------------------------------

-- Site use: approved → sourced → ordered (legacy, unchanged).
-- Purchase: approved_by_management/with_procurement → sourced → ordered → delivery_expected
--           → partially_received → received → closed; maintains mr_lines.qty_received.
create or replace function app.refresh_mr_procurement(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.material_requests; v_new public.mr_status;
  v_open int; v_all boolean; v_any boolean; v_notice boolean; v_po boolean; v_src boolean; v_pos text;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if not found then return; end if;

  if r.request_type = 'site_use' then
    if r.status not in ('approved','sourced','ordered') then return; end if;
    v_new := case
      when exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                   join public.mr_lines ml on ml.id = pl.mr_line_id
                   where ml.mr_id = p_mr and pl.deleted_at is null
                     and po.status in ('sent','partially_received','received','closed')) then 'ordered'
      when exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                   join public.mr_lines ml on ml.id = pl.mr_line_id
                   where ml.mr_id = p_mr and pl.deleted_at is null
                     and po.status in ('draft','submitted','approved'))
        or exists (select 1 from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
                   join public.mr_lines ml on ml.id = rl.mr_line_id
                   where ml.mr_id = p_mr and rl.deleted_at is null and q.status in ('sent','closed','awarded')) then 'sourced'
      else 'approved' end;
    if v_new <> r.status then perform app.mr_transition(p_mr, v_new, 'procurement_status'); end if;
    return;
  end if;

  if r.status::text not in ('approved','approved_by_management','with_procurement','sourced','ordered',
                            'delivery_expected','partially_received') then
    return;
  end if;

  update public.mr_lines ml set qty_received = x.q
    from (select l.id, coalesce(sum(gl.qty_accepted) filter (where g.id is not null), 0) as q
            from public.mr_lines l
            left join public.grn_lines gl on gl.mr_line_id = l.id
            left join public.grns g on g.id = gl.grn_id and g.status = 'posted'
           where l.mr_id = p_mr group by l.id) x
   where ml.id = x.id and ml.qty_received is distinct from x.q;

  select count(*), coalesce(bool_and(qty_received >= approved_qty - 0.0005), false), coalesce(bool_or(qty_received > 0), false)
    into v_open, v_all, v_any
    from public.mr_lines where mr_id = p_mr and deleted_at is null and line_status = 'open' and approved_qty > 0;
  v_notice := exists (select 1 from public.delivery_notices dn
                      where dn.status in ('notified','acknowledged','reschedule_requested','arrived')
                        and dn.po_id in (select pl.po_id from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
                                          where ml.mr_id = p_mr and pl.deleted_at is null));
  v_po := exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                  join public.mr_lines ml on ml.id = pl.mr_line_id
                  where ml.mr_id = p_mr and pl.deleted_at is null and po.status in ('sent','partially_received','received','closed'));
  v_src := exists (select 1 from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
                   join public.mr_lines ml on ml.id = pl.mr_line_id
                   where ml.mr_id = p_mr and pl.deleted_at is null and po.status in ('draft','submitted','approved'))
        or exists (select 1 from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
                   join public.mr_lines ml on ml.id = rl.mr_line_id
                   where ml.mr_id = p_mr and rl.deleted_at is null and q.status in ('sent','closed','awarded'));
  v_new := case
    when v_open > 0 and v_all then 'received'
    when v_notice then 'delivery_expected'
    when v_any then 'partially_received'
    when v_po then 'ordered'
    when v_src then 'sourced'
    when r.status::text in ('approved','approved_by_management','with_procurement') then r.status
    when r.procurement_owner is not null then 'with_procurement'
    else 'approved_by_management' end;
  if v_new = r.status then return; end if;

  perform app.mr_transition(p_mr, v_new, 'procurement_status');
  if v_new::text = 'ordered' then
    select string_agg(distinct po.number || ' (' || s.name
             || coalesce(', ETA ' || to_char(coalesce(po.eta, po.expected_date), 'DD Mon YYYY'), '') || ')', '; ')
      into v_pos
      from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id join public.suppliers s on s.id = po.supplier_id
      join public.mr_lines ml on ml.id = pl.mr_line_id
     where ml.mr_id = p_mr and pl.deleted_at is null and po.status in ('sent','partially_received','received','closed');
    perform app.notify_roles(r.project_id, '{coordinator}', 'Purchased: ' || r.number, 'PO ' || v_pos, 'material_request', p_mr);
  end if;
  perform app.notify_user(r.requested_by, r.project_id,
    'Purchase request ' || r.number || ': ' || app.mr_status_label('purchase', v_new::text),
    case when v_new::text = 'ordered' then 'PO ' || v_pos else null end, 'material_request', p_mr);
  if v_new::text = 'received' then
    perform app.mr_transition(p_mr, 'closed', 'auto_close', 'All approved quantities received');
  end if;
end $$;

-- Issue-status refresh (0005) for site use, + received when every non-reversed MIV is acknowledged.
-- Purchase requests are never issued: they refresh their receipt status instead.
create or replace function app.refresh_mr_status(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.material_requests;
  v_total numeric; v_issued numeric; v_any boolean; v_all_ack boolean;
  v_new public.mr_status;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if not found then return; end if;
  if r.request_type = 'purchase' then
    perform app.refresh_mr_procurement(p_mr);
    return;
  end if;
  if r.status::text not in ('approved','sourced','ordered','partially_issued','issued','received') then
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
  v_all_ack := exists (select 1 from public.mivs where mr_id = p_mr and status <> 'reversed')
               and not exists (select 1 from public.mivs where mr_id = p_mr and status = 'pending_ack');

  v_new := case when v_total > 0 and v_issued >= v_total
                  then case when v_all_ack then 'received'::public.mr_status else 'issued'::public.mr_status end
                when v_any then 'partially_issued'::public.mr_status
                when r.status::text in ('sourced','ordered') then r.status
                else 'approved'::public.mr_status end;
  if v_new <> r.status then
    perform app.mr_transition(p_mr, v_new, case when v_new::text = 'received' then 'received' else 'issue_status' end);
    if v_new::text = 'approved' then perform app.refresh_mr_procurement(p_mr); end if;
  end if;
end $$;

-- An MR line can be sourced/ordered only while approved and within its approved quantity.
-- Purchase requests need management approval; legacy site-use lines keep the 0005 rule.
create or replace function app.check_mr_line(p_mr_line uuid, p_project uuid, p_spec uuid, p_qty numeric,
  p_exclude_po_line uuid, p_label text) returns void
language plpgsql security definer set search_path = public as $$
declare ml record; v_ordered numeric;
begin
  select l.*, r.status as mr_status, r.number as mr_number, r.request_type into ml
    from public.mr_lines l join public.material_requests r on r.id = l.mr_id
   where l.id = p_mr_line and l.project_id = p_project and l.deleted_at is null;
  if not found then raise exception '%: request line not found in this project', p_label; end if;
  if ml.request_type = 'purchase' then
    if ml.mr_status::text not in ('approved','approved_by_management','with_procurement','sourced','ordered',
                                  'delivery_expected','partially_received') then
      raise exception '%: purchase request % is not approved by management (status: %)', p_label, ml.mr_number, ml.mr_status;
    end if;
    if ml.line_status <> 'open' then raise exception '%: line % of % is closed', p_label, ml.line_no, ml.mr_number; end if;
  elsif ml.mr_status::text not in ('approved','sourced','ordered','partially_issued') then
    raise exception '%: request % is not approved (status: %)', p_label, ml.mr_number, ml.mr_status;
  end if;
  if ml.material_spec_id <> p_spec and not exists (
      select 1 from public.spec_equivalents e
       where (e.material_spec_id = ml.material_spec_id and e.equivalent_spec_id = p_spec)
          or (e.material_spec_id = p_spec and e.equivalent_spec_id = ml.material_spec_id)) then
    raise exception '%: % is not the requested % (or an approved equivalent)', p_label, app.spec_label(p_spec), app.spec_label(ml.material_spec_id);
  end if;
  if p_qty is not null then
    select coalesce(sum(case when po.status = 'closed' or pl.closed then pl.qty_accepted else pl.qty end), 0) into v_ordered
      from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
     where pl.mr_line_id = p_mr_line and pl.deleted_at is null and po.status not in ('cancelled','rejected')
       and pl.id is distinct from p_exclude_po_line;
    if v_ordered + p_qty > coalesce(ml.approved_qty, 0) + 0.0005 then
      raise exception '%: ordering % exceeds the approved balance of request % (approved %, already ordered %)',
        p_label, p_qty, ml.mr_number, coalesce(ml.approved_qty, 0), v_ordered;
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 9. Store transactions (post_grn from 0005, post_miv / acknowledge_miv from 0003)
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
  v_po uuid := (p ->> 'po_id')::uuid;
  v_notice uuid := (p ->> 'delivery_notice_id')::uuid;
  v_po_supplier uuid;
  l jsonb; v_n int := 0;
  v_del numeric; v_acc numeric; v_rej numeric; v_ord numeric;
  v_flag text; v_mr_spec uuid; v_requester uuid; v_mr uuid;
  v_mr_line uuid; v_spec uuid;
  pl public.po_lines; v_po_status text; v_tol numeric; v_pos uuid[] := '{}'; v_mrs uuid[] := '{}'; x uuid;
  pr record; sl record; v_ati numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','coordinator','manager','admin');   -- BR-04
  perform app.require_store(v_project, v_store);
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'A GRN needs at least one line'; end if;

  -- Header PO defaults to the PO of the first PO-linked line.
  if v_po is null then
    select pl2.po_id into v_po from jsonb_array_elements(p -> 'lines') e
      join public.po_lines pl2 on pl2.id = (e ->> 'po_line_id')::uuid limit 1;
  end if;
  if v_po is null and v_notice is not null then
    select po_id into v_po from public.delivery_notices where id = v_notice and project_id = v_project;
  end if;
  if v_po is not null then
    select supplier_id, status into v_po_supplier, v_po_status from public.purchase_orders
     where id = v_po and project_id = v_project for update;
    if not found then raise exception 'Purchase order not found in this project'; end if;
    if v_po_status not in ('approved','sent','partially_received') then
      raise exception 'Purchase order is not open for receiving (status: %)', v_po_status;
    end if;
  end if;
  if v_notice is not null and not exists (select 1 from public.delivery_notices where id = v_notice and project_id = v_project
                                          and (v_po is null or po_id = v_po)) then
    raise exception 'Delivery notice not found for this purchase order';
  end if;
  select over_receipt_pct into v_tol from public.project_settings where project_id = v_project;

  insert into public.grns (id, project_id, number, store_id, supplier_id, supplier_name, delivery_note_no,
    vehicle_plate, driver_name, received_at, remarks, supplier_signature, created_by, device_id, po_id)
  values (v_id, v_project, v_number, v_store, coalesce((p ->> 'supplier_id')::uuid, v_po_supplier), nullif(p ->> 'supplier_name', ''),
    nullif(p ->> 'delivery_note_no', ''), nullif(p ->> 'vehicle_plate', ''), nullif(p ->> 'driver_name', ''),
    v_at, nullif(p ->> 'remarks', ''), nullif(p ->> 'supplier_signature', ''), auth.uid(), app.device_id(), v_po);

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    v_spec := (l ->> 'material_spec_id')::uuid;
    v_mr_line := (l ->> 'mr_line_id')::uuid;
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

    -- Receive against a PO line: re-validate the outstanding quantity (offline clients may be stale).
    pl := null;
    if l ->> 'po_line_id' is not null then
      select * into pl from public.po_lines where id = (l ->> 'po_line_id')::uuid and deleted_at is null for update;
      if not found or pl.po_id <> v_po then raise exception 'Line %: PO line not found on purchase order', v_n; end if;
      if pl.closed then raise exception 'Line %: PO line is closed', v_n; end if;
      if pl.material_spec_id <> v_spec then
        raise exception 'Line %: % does not match the ordered %', v_n, app.spec_label(v_spec), app.spec_label(pl.material_spec_id);
      end if;
      if pl.qty_accepted + v_acc > pl.qty * (1 + coalesce(v_tol, 0) / 100) + 0.0005 then
        raise exception 'Line %: receiving % exceeds the outstanding PO quantity of % (over-receipt tolerance % percent)',
          v_n, v_acc, greatest(pl.qty - pl.qty_accepted, 0), coalesce(v_tol, 0);
      end if;
      v_ord := coalesce(v_ord, greatest(pl.qty - pl.qty_accepted, 0));
      v_mr_line := coalesce(v_mr_line, pl.mr_line_id);
      update public.po_lines set qty_received = qty_received + v_del, qty_accepted = qty_accepted + v_acc,
        qty_rejected = qty_rejected + v_rej where id = pl.id;
      if not (pl.po_id = any (v_pos)) then v_pos := v_pos || pl.po_id; end if;
    end if;

    -- FR-RC-02: shortage / excess / wrong grade flags
    v_flag := null;
    if v_mr_line is not null then
      select ml.material_spec_id, r.requested_by, r.id into v_mr_spec, v_requester, v_mr
        from public.mr_lines ml join public.material_requests r on r.id = ml.mr_id
        where ml.id = v_mr_line and ml.project_id = v_project;
      if not found then raise exception 'Line %: request line not found in this project', v_n; end if;
      if v_mr_spec <> v_spec and pl.id is null then v_flag := 'wrong_grade'; end if;
      if not (v_mr = any (v_mrs)) then v_mrs := v_mrs || v_mr; end if;
      perform app.notify_user(v_requester, v_project, 'Material arrived: ' || app.spec_label(v_spec),
        'GRN ' || v_number || ' — ' || v_acc || ' accepted', 'grn', v_id);
    end if;
    if v_flag is null and v_ord is not null then
      v_flag := case when v_del < v_ord then 'shortage' when v_del > v_ord then 'excess' end;
    end if;

    insert into public.grn_lines (id, grn_id, project_id, line_no, material_spec_id, mr_line_id, ordered_qty,
      qty_delivered, qty_accepted, qty_rejected, entered_uom, entered_qty, batch_no, inspection_result,
      inspection_notes, variance_flag, po_line_id)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, v_spec, v_mr_line,
      v_ord, v_del, v_acc, v_rej, l ->> 'entered_uom', (l ->> 'entered_qty')::numeric, nullif(l ->> 'batch_no', ''),
      coalesce(l ->> 'inspection_result', 'pass'), nullif(l ->> 'inspection_notes', ''), v_flag, pl.id);

    -- FR-RC-04 / FR-RC-08: accepted to available stock, rejected to quarantine.
    if v_acc > 0 then
      perform app.post_ledger(v_project, v_store, v_spec, v_acc, 'available', 'grn',
        'grn', v_id, v_number, (l ->> 'id')::uuid, null, v_mr_line, nullif(l ->> 'batch_no', ''), v_at);
    end if;
    if v_rej > 0 then
      perform app.post_ledger(v_project, v_store, v_spec, v_rej, 'quarantine', 'grn',
        'grn', v_id, v_number, (l ->> 'id')::uuid, null, v_mr_line, nullif(l ->> 'batch_no', ''), v_at);
    end if;
  end loop;

  -- The GRN is the store keeper's confirmation of an announced delivery (§5.4).
  if v_notice is null and v_po is not null then
    select id into v_notice from public.delivery_notices
     where po_id = v_po and status in ('notified','acknowledged','reschedule_requested','arrived')
     order by expected_date, created_at limit 1;
  end if;
  if v_notice is not null then
    update public.delivery_notices set status = 'received', grn_id = v_id where id = v_notice;
  end if;

  foreach x in array v_pos loop perform app.refresh_po_status(x); end loop;
  foreach x in array v_mrs loop perform app.refresh_mr_procurement(x); end loop;

  -- Purchase requests: tell coordinator + procurement how much has arrived.
  for pr in select r.id, r.number, r.project_id,
                   coalesce(sum(l2.qty_received) filter (where l2.approved_qty > 0), 0) as recv,
                   coalesce(sum(l2.approved_qty) filter (where l2.approved_qty > 0), 0) as appr
              from public.material_requests r join public.mr_lines l2 on l2.mr_id = r.id and l2.deleted_at is null
             where r.id = any (v_mrs) and r.request_type = 'purchase'
             group by r.id loop
    perform app.notify_roles(v_project, '{coordinator,procurement}', 'GRN ' || v_number || ' received against ' || pr.number,
      'Received ' || round(pr.recv, 3) || ' of ' || round(pr.appr, 3), 'material_request', pr.id);
  end loop;
  -- PR converted from a site-use request: that request's line is now issuable (§5.1.3).
  for sl in select distinct sur.id, sur.number, sur.requested_by, sur.approved_at, sml.line_no, sml.material_spec_id,
                   coalesce(sur.store_id, app.main_store(sur.project_id)) as st
              from public.grn_lines gl
              join public.mr_lines pl2 on pl2.id = gl.mr_line_id
              join public.mr_lines sml on sml.id = pl2.source_mr_line_id
              join public.material_requests sur on sur.id = sml.mr_id
             where gl.grn_id = v_id and gl.qty_accepted > 0 loop
    v_ati := greatest(app.stock_qty(sl.st, sl.material_spec_id)
                      - app.reserved_qty(sl.st, sl.material_spec_id, sl.id, sl.approved_at, sl.id), 0);
    perform app.notify_user(sl.requested_by, v_project, 'Request ' || sl.number || ' line ' || sl.line_no || ' now issuable',
      round(v_ati, 3) || ' available after GRN ' || v_number, 'material_request', sl.id);
    perform app.notify_roles(v_project, '{store_keeper}', 'Request ' || sl.number || ' line ' || sl.line_no || ' now issuable',
      round(v_ati, 3) || ' available after GRN ' || v_number, 'material_request', sl.id);
  end loop;

  return app.op_done(p, 'post_grn', jsonb_build_object('ok', true, 'id', v_id, 'po_id', v_po,
    'po_status', (select status from public.purchase_orders where id = v_po), 'delivery_notice_id', v_notice));
end $$;

-- A reversed GRN takes the quantity back from the purchase requests it fed.
create or replace function app.grn_reversed_mrs() returns trigger
language plpgsql security definer set search_path = public as $$
declare x uuid;
begin
  for x in select distinct ml.mr_id from public.grn_lines gl join public.mr_lines ml on ml.id = gl.mr_line_id
           where gl.grn_id = new.id loop
    perform app.refresh_mr_procurement(x);
  end loop;
  return new;
end $$;

create trigger mr_receipt_reversal after update of status on public.grns
  for each row when (new.status = 'reversed' and old.status is distinct from 'reversed')
  execute function app.grn_reversed_mrs();

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
  v_spec uuid; v_qty numeric; v_issued numeric; v_res numeric; v_avail numeric;
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
    if r.request_type = 'purchase' then
      raise exception 'Request % is a purchase request; issue against the site-use request instead', r.number;
    end if;
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
    -- §5.1 reservation: stock promised to earlier-approved store orders is not available to this one.
    if v_mr is not null then
      v_res := app.reserved_qty(v_store, v_spec, v_mr, r.approved_at, r.id);
      v_avail := app.stock_qty(v_store, v_spec) - v_res;
      if v_avail < v_qty - 0.0005 then
        raise exception 'Line %: only % of % is available to issue (% reserved for earlier approved requests)',
          v_n, greatest(round(v_avail, 3), 0), app.spec_label(v_spec), round(v_res, 3);
      end if;
    end if;
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
      'Please acknowledge receipt', 'miv', v_id, v_mr is not null and r.priority <> 'normal');
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
  if m.mr_id is not null then perform app.refresh_mr_status(m.mr_id); end if;   -- issued → received
  return jsonb_build_object('ok', true, 'id', m.id,
    'mr_status', (select status from public.material_requests where id = m.mr_id));
end $$;

-- -----------------------------------------------------------------------------
-- 10. Purchase orders: auto-approval when fully traced to approved PRs (§5.3)
-- -----------------------------------------------------------------------------

create or replace function app.po_auto_approval(p_po uuid, out eligible boolean, out approver uuid, out reason text)
language plpgsql stable security definer set search_path = public as $$
declare
  po public.purchase_orders; s public.project_settings;
  v_n int; v_bad int; v_est numeric; v_unpriced int; v_sub numeric; v_not_lowest int;
begin
  eligible := false;
  select * into po from public.purchase_orders where id = p_po;
  select * into s from public.project_settings where project_id = po.project_id;
  if not coalesce(s.po_auto_approve, true) then reason := 'Auto-approval is switched off'; return; end if;
  -- (a) every line traces to a management-approved purchase-request line
  select count(*), count(*) filter (where r.id is null or r.request_type <> 'purchase' or r.approved_by is null
           or r.status::text not in ('approved_by_management','with_procurement','sourced','ordered','delivery_expected','partially_received'))
    into v_n, v_bad
    from public.po_lines pl
    left join public.mr_lines ml on ml.id = pl.mr_line_id
    left join public.material_requests r on r.id = ml.mr_id
   where pl.po_id = p_po and pl.deleted_at is null;
  if v_n = 0 or v_bad > 0 then reason := 'Not every line traces to a management-approved purchase request'; return; end if;
  -- (b) PO value (ex-VAT) within the approved estimate + tolerance
  select coalesce(sum(pl.qty * (j.lp ->> 'unit_price')::numeric), 0),
         count(*) filter (where j.lp is null or (j.lp ->> 'unit_price') is null)
    into v_est, v_unpriced
    from public.po_lines pl
    join public.mr_lines ml on ml.id = pl.mr_line_id
    left join public.mr_estimates e on e.mr_id = ml.mr_id
    left join lateral (select x as lp from jsonb_array_elements(coalesce(e.line_prices, '[]'::jsonb)) x
                        where x ->> 'mr_line_id' = ml.id::text limit 1) j on true
   where pl.po_id = p_po and pl.deleted_at is null;
  if v_unpriced > 0 then reason := 'The approved estimate has unpriced lines'; return; end if;
  select subtotal into v_sub from public.po_totals where po_id = p_po;
  if coalesce(v_sub, 0) > v_est * (1 + coalesce(s.po_tolerance_pct, 10) / 100) + 0.005 then
    reason := 'PO value is above the approved estimate plus tolerance'; return;
  end if;
  -- (c) lowest landed cost on every line
  select count(*) filter (where pl.quotation_line_id is null or not exists (
           select 1 from public.rfq_awards a where a.quotation_line_id = pl.quotation_line_id and a.is_lowest))
    into v_not_lowest
    from public.po_lines pl where pl.po_id = p_po and pl.deleted_at is null;
  if v_not_lowest > 0 then reason := 'The supplier was not the lowest quotation on every line'; return; end if;
  select r.approved_by into approver
    from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id join public.material_requests r on r.id = ml.mr_id
   where pl.po_id = p_po and pl.deleted_at is null order by r.approved_at desc limit 1;
  eligible := true;
  reason := 'Auto-approved: management-approved purchase request(s), within ' || coalesce(s.po_tolerance_pct, 10)
            || '% of the estimate, lowest quotation';
end $$;

create or replace function public.po_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  po public.purchase_orders;
  t public.po_totals;
  v_to text; v_lim record; l record; v_auto record;
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid for update;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  select * into t from public.po_totals where po_id = po.id;

  case v_action
  when 'submit' then
    perform app.require_role('procurement','coordinator','manager','admin');
    if po.status not in ('draft','rejected') then raise exception 'Only draft purchase orders can be submitted (status: %)', po.status; end if;
    if not exists (select 1 from public.po_lines where po_id = po.id and deleted_at is null) then
      raise exception 'A purchase order needs at least one line';
    end if;
    v_to := 'submitted';
    update public.purchase_orders set submitted_at = now() where id = po.id;
    select * into v_auto from app.po_auto_approval(po.id);
    if v_auto.eligible then
      -- The purchase was already approved by management on the PR: no second approval.
      v_to := 'approved';
      update public.purchase_orders set approved_by = v_auto.approver, approved_at = now(), auto_approved = true where id = po.id;
      perform app.po_event(po.id, 'auto_approve', 'submitted', 'approved', v_auto.reason);
      perform app.notify_user(po.created_by, po.project_id, 'PO ' || po.number || ' approved automatically', v_auto.reason,
        'purchase_order', po.id);
    else
      perform app.notify_roles(po.project_id, '{coordinator,manager}', 'PO ' || po.number || ' awaiting approval',
        (select name from public.suppliers where id = po.supplier_id), 'purchase_order', po.id);
    end if;

  when 'approve' then
    perform app.require_role('coordinator','manager','admin');
    if po.status <> 'submitted' then raise exception 'Only submitted purchase orders can be approved (status: %)', po.status; end if;
    -- BR-08: value-based approval limits on the PO value incl. VAT (doc_type 'po', per-user override, delegations).
    select * into v_lim from app.approval_limit_for(auth.uid(), po.project_id, 'po');
    if not v_lim.unlimited and coalesce(t.total, 0) > v_lim.max_value then
      raise exception 'PO value % exceeds your approval limit of %; a higher approver is required',
        round(t.total, 2), round(v_lim.max_value, 2);
    end if;
    if po.created_by = auth.uid() then raise exception 'You cannot approve your own purchase order'; end if;
    update public.purchase_orders set approved_by = auth.uid(), approved_at = now() where id = po.id;
    -- First approval goes to 'approved'; re-approval after an amendment returns to the receipt status.
    v_to := case when po.sent_at is null and not exists (select 1 from public.po_lines where po_id = po.id and qty_received > 0)
                 then 'approved' else 'sent' end;
    -- Manual PO prices feed the price history (awarded quotes were recorded at award).
    for l in select pl.*, pr.unit_price from public.po_lines pl join public.po_line_prices pr on pr.po_line_id = pl.id
              where pl.po_id = po.id and pl.deleted_at is null and pl.quotation_line_id is null
                and not exists (select 1 from public.price_observations o where o.source = 'po' and o.source_id = pl.id
                                and o.unit_price = pr.unit_price) loop
      perform app.observe_price(null, po.project_id, l.material_spec_id, po.supplier_id, l.unit_price, po.order_date, 'po', l.id);
    end loop;
    perform app.notify_user(po.created_by, po.project_id, 'PO ' || po.number || ' approved', v_comment, 'purchase_order', po.id);

  when 'reject' then
    perform app.require_role('coordinator','manager','admin');
    if po.status <> 'submitted' then raise exception 'Only submitted purchase orders can be rejected'; end if;
    if v_comment is null then raise exception 'A reason is required to reject'; end if;
    if po.approved_at is not null then
      raise exception 'An amended PO cannot be rejected after first approval; cancel or amend it again';
    end if;
    v_to := 'rejected';
    perform app.notify_user(po.created_by, po.project_id, 'PO ' || po.number || ' rejected', v_comment, 'purchase_order', po.id);

  when 'send' then
    perform app.require_role('procurement','coordinator','manager','admin');
    if po.status <> 'approved' then raise exception 'Only approved purchase orders can be sent (status: %)', po.status; end if;
    v_to := 'sent';
    update public.purchase_orders set sent_at = now() where id = po.id;
    perform app.notify_roles(po.project_id, '{store_keeper}', 'Expected delivery: PO ' || po.number,
      'Expected ' || coalesce(to_char(coalesce(po.eta, po.expected_date), 'DD Mon YYYY'), 'date not set'), 'purchase_order', po.id);
    -- site-use requesters (legacy); purchase requesters are told "Purchased" by refresh_mr_procurement
    for l in select distinct r.requested_by, r.number from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
              join public.material_requests r on r.id = ml.mr_id
              where pl.po_id = po.id and pl.deleted_at is null and r.request_type = 'site_use' loop
      perform app.notify_user(l.requested_by, po.project_id, 'Request ' || l.number || ' ordered',
        'PO ' || po.number || ', expected ' || coalesce(to_char(po.expected_date, 'DD Mon YYYY'), 'date not set'), 'purchase_order', po.id);
    end loop;

  when 'cancel' then
    perform app.require_role('procurement','coordinator','manager','admin');
    if po.status not in ('draft','submitted','approved','rejected','sent') then
      raise exception 'Purchase order cannot be cancelled (status: %); close it instead', po.status;
    end if;
    if exists (select 1 from public.po_lines where po_id = po.id and qty_received > 0) then
      raise exception 'Goods were already received against this PO; close it instead';
    end if;
    if po.status <> 'draft' and v_comment is null then raise exception 'A reason is required to cancel'; end if;
    v_to := 'cancelled';
    update public.purchase_orders set cancelled_at = now(), status_reason = v_comment where id = po.id;
    update public.delivery_notices set status = 'cancelled' where po_id = po.id and status in ('notified','acknowledged','reschedule_requested');

  when 'close' then
    perform app.require_role('procurement','coordinator','manager','admin');
    if po.status not in ('sent','partially_received','received','approved') then
      raise exception 'Purchase order cannot be closed (status: %)', po.status;
    end if;
    if po.status <> 'received' and v_comment is null then raise exception 'A reason is required to short-close'; end if;
    v_to := 'closed';
    update public.purchase_orders set closed_at = now(), status_reason = v_comment where id = po.id;
    update public.po_lines set closed = true where po_id = po.id and deleted_at is null;
    update public.delivery_notices set status = 'cancelled' where po_id = po.id and status in ('notified','acknowledged','reschedule_requested');

  else
    raise exception 'Unknown action %', v_action;
  end case;

  update public.purchase_orders set status = v_to where id = po.id;
  perform app.po_event(po.id, v_action, po.status, v_to, v_comment);
  if v_action = 'approve' and v_to = 'sent' then perform app.refresh_po_status(po.id); end if;
  perform app.refresh_mrs_for_po(po.id);

  return app.op_done(p, 'po_action', jsonb_build_object('ok', true, 'id', po.id,
    'status', (select status from public.purchase_orders where id = po.id),
    'auto_approved', (select auto_approved from public.purchase_orders where id = po.id)));
end $$;

-- -----------------------------------------------------------------------------
-- 11. New procurement / store RPCs
-- -----------------------------------------------------------------------------

-- RFQ pre-filled from management-approved purchase-request lines (one RFQ line per PR line).
create or replace function public.create_rfq_from_prs(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  x text; ml record; v_qty numeric; v_rl uuid;
  v_lines jsonb := '[]'::jsonb; v_map jsonb := '[]'::jsonb; v_sup jsonb := '[]'::jsonb;
  v_project uuid; v_store uuid; v_req date; v_numbers text[] := '{}'; v_mrs uuid[] := '{}'; m uuid; v_res jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'RFQ id is required'; end if;
  if jsonb_array_length(coalesce(p -> 'mr_line_ids', '[]'::jsonb)) = 0 then
    raise exception 'Choose at least one purchase request line';
  end if;
  for x in select jsonb_array_elements_text(p -> 'mr_line_ids') loop
    select l.*, r.project_id as pid, r.request_type, r.status::text as mr_status, r.number as mr_number,
           r.store_id as mr_store, r.required_date as mr_req
      into ml
      from public.mr_lines l join public.material_requests r on r.id = l.mr_id
     where l.id = x::uuid and l.deleted_at is null;
    if not found then raise exception 'Purchase request line not found'; end if;
    if v_project is null then
      v_project := ml.pid;
      perform app.require_member(v_project);
      perform app.require_role('procurement','coordinator','manager','admin');
    elsif ml.pid <> v_project then
      raise exception 'All lines must belong to the same project';
    end if;
    if ml.request_type <> 'purchase' then
      raise exception 'RFQs are raised from purchase requests (% is a site-use request)', ml.mr_number;
    end if;
    if ml.mr_status not in ('approved','approved_by_management','with_procurement','sourced','ordered','partially_received') then
      raise exception 'Purchase request % is not approved by management (status: %)', ml.mr_number, ml.mr_status;
    end if;
    if ml.line_status <> 'open' or coalesce(ml.approved_qty, 0) <= 0 then
      raise exception 'Line % of % is not open for purchase', ml.line_no, ml.mr_number;
    end if;
    select coalesce(ml.approved_qty, 0) - coalesce(sum(case when po.status = 'closed' or pl.closed then pl.qty_accepted else pl.qty end), 0)
      into v_qty
      from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
     where pl.mr_line_id = ml.id and pl.deleted_at is null and po.status not in ('cancelled','rejected');
    if v_qty <= 0.0005 then raise exception 'Line % of % is already fully ordered', ml.line_no, ml.mr_number; end if;
    v_rl := gen_random_uuid();
    v_lines := v_lines || jsonb_build_object('id', v_rl, 'material_spec_id', ml.material_spec_id, 'qty', v_qty,
      'mr_line_id', ml.id, 'required_date', coalesce(ml.required_date, ml.mr_req));
    v_map := v_map || jsonb_build_object('mr_line_id', ml.id, 'rfq_line_id', v_rl, 'qty', v_qty);
    if not (ml.mr_number = any (v_numbers)) then v_numbers := v_numbers || ml.mr_number; end if;
    if not (ml.mr_id = any (v_mrs)) then v_mrs := v_mrs || ml.mr_id; end if;
    v_req := least(coalesce(v_req, coalesce(ml.required_date, ml.mr_req)), coalesce(ml.required_date, ml.mr_req));
    v_store := coalesce(v_store, ml.mr_store);
  end loop;

  foreach m in array v_mrs loop perform app.pr_accept(m, auth.uid(), 'Accepted on RFQ'); end loop;
  select coalesce(jsonb_agg(jsonb_build_object('supplier_id', s, 'sent_via', p ->> 'sent_via')), '[]'::jsonb) into v_sup
    from jsonb_array_elements_text(coalesce(p -> 'supplier_ids', '[]'::jsonb)) s;

  v_res := public.save_rfq(jsonb_build_object('id', v_id, 'project_id', v_project, 'number', p ->> 'number',
    'title', coalesce(nullif(p ->> 'title', ''), 'RFQ for ' || array_to_string(v_numbers, ', ')),
    'required_by', coalesce((p ->> 'required_by')::date, v_req),
    'delivery_store_id', coalesce((p ->> 'delivery_store_id')::uuid, v_store, app.main_store(v_project)),
    'min_quotes', p -> 'min_quotes', 'notes', p ->> 'notes',
    'send', coalesce((p ->> 'send')::boolean, true), 'lines', v_lines, 'suppliers', v_sup));
  return app.op_done(p, 'create_rfq_from_prs', v_res || jsonb_build_object('lines', v_map));
end $$;

-- Direct (cash / single proforma) purchase below project_settings.direct_purchase_limit:
-- a PO with purchase_method 'direct', status 'sent', approved_by = management approver of the PR.
create or replace function public.record_direct_purchase(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'po_id')::uuid, (p ->> 'id')::uuid);
  v_reason text := nullif(trim(p ->> 'reason'), '');
  l jsonb; ml record; v_lines jsonb := '[]'::jsonb; v_project uuid; v_store uuid; v_approver uuid;
  v_mrs uuid[] := '{}'; m uuid; t public.po_totals; s public.project_settings; x record;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'po_id is required'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one line'; end if;
  if v_reason is null then raise exception 'A reason is required for a direct purchase'; end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select ml2.*, r.project_id as pid, r.request_type, r.store_id as mr_store, r.approved_by as mr_approver
      into ml from public.mr_lines ml2 join public.material_requests r on r.id = ml2.mr_id
     where ml2.id = (l ->> 'mr_line_id')::uuid and ml2.deleted_at is null;
    if not found or ml.request_type <> 'purchase' then
      raise exception 'Direct purchases are recorded against approved purchase request lines';
    end if;
    if v_project is null then
      v_project := ml.pid;
      perform app.require_member(v_project);
      perform app.require_role('procurement','coordinator','manager','admin');
      perform app.require_prices();
    elsif ml.pid <> v_project then
      raise exception 'All lines must belong to the same project';
    end if;
    v_approver := coalesce(v_approver, ml.mr_approver);
    v_store := coalesce(v_store, ml.mr_store);
    if not (ml.mr_id = any (v_mrs)) then v_mrs := v_mrs || ml.mr_id; end if;
    v_lines := v_lines || jsonb_build_object('id', coalesce((l ->> 'id')::uuid, gen_random_uuid()),
      'material_spec_id', coalesce((l ->> 'material_spec_id')::uuid, ml.material_spec_id),
      'qty', coalesce((l ->> 'qty')::numeric, ml.approved_qty), 'unit_price', (l ->> 'unit_price')::numeric,
      'mr_line_id', ml.id, 'vat_applicable', coalesce((l ->> 'vat_applicable')::boolean, true));
  end loop;
  if v_approver is null then raise exception 'The purchase request is not approved by management'; end if;
  v_store := coalesce((p ->> 'delivery_store_id')::uuid, v_store, app.main_store(v_project));
  perform app.require_store(v_project, v_store);
  if not exists (select 1 from public.suppliers where id = (p ->> 'supplier_id')::uuid and deleted_at is null) then
    raise exception 'Supplier is required';
  end if;

  foreach m in array v_mrs loop perform app.pr_accept(m, auth.uid(), 'Direct purchase'); end loop;
  insert into public.purchase_orders (id, project_id, number, supplier_id, delivery_store_id, order_date, expected_date,
    payment_terms, remarks, device_id, purchase_method, receipt_ref, status_reason)
  values (v_id, v_project, p ->> 'number', (p ->> 'supplier_id')::uuid, v_store,
    coalesce((p ->> 'order_date')::date, current_date), coalesce((p ->> 'expected_date')::date, current_date),
    coalesce(nullif(p ->> 'payment_terms', ''), 'Cash'), v_reason, app.device_id(), 'direct', nullif(p ->> 'receipt_ref', ''), v_reason);
  perform app.po_save_lines(v_id, v_lines);
  t := app.po_recompute_totals(v_id);
  select * into s from public.project_settings where project_id = v_project;
  if t.total > coalesce(s.direct_purchase_limit, 0) then
    raise exception 'Direct purchase total % exceeds the direct purchase limit of %; use an RFQ', t.total, coalesce(s.direct_purchase_limit, 0);
  end if;
  update public.purchase_orders set status = 'sent', approved_by = v_approver, approved_at = now(), sent_at = now()
   where id = v_id;
  perform app.po_event(v_id, 'direct_purchase', null, 'sent', v_reason);
  for x in select pl.id, pl.material_spec_id, pr.unit_price from public.po_lines pl join public.po_line_prices pr on pr.po_line_id = pl.id
            where pl.po_id = v_id and pl.deleted_at is null loop
    perform app.observe_price(null, v_project, x.material_spec_id, (p ->> 'supplier_id')::uuid, x.unit_price, current_date, 'po', x.id);
  end loop;
  perform app.refresh_mrs_for_po(v_id);
  return app.op_done(p, 'record_direct_purchase', jsonb_build_object('ok', true, 'id', v_id, 'status', 'sent',
    'totals', to_jsonb(t) - 'project_id'));
end $$;

-- Procurement tells the store (and the gate) a delivery is coming.
create or replace function public.notify_store_delivery(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_date date := (p ->> 'expected_date')::date;
  po public.purchase_orders; pl public.po_lines; l jsonb; v_lines jsonb := '[]'::jsonb; v_q numeric;
  v_crit boolean; v_items text; v_supplier text; v_plate text := nullif(upper(trim(p ->> 'vehicle_plate')), '');
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid for update;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  perform app.require_role('procurement','coordinator','manager','admin');
  if po.status not in ('approved','sent','partially_received') then
    raise exception 'Deliveries can only be announced for approved/sent purchase orders (status: %)', po.status;
  end if;
  if v_date is null then raise exception 'Expected delivery date is required'; end if;

  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) > 0 then
    for l in select * from jsonb_array_elements(p -> 'lines') loop
      select * into pl from public.po_lines where id = (l ->> 'po_line_id')::uuid and po_id = po.id and deleted_at is null;
      if not found then raise exception 'PO line not found on %', po.number; end if;
      v_q := (l ->> 'qty')::numeric;
      if v_q is null or v_q <= 0 then raise exception 'Expected quantity must be greater than zero'; end if;
      v_lines := v_lines || jsonb_build_object('po_line_id', pl.id, 'material_spec_id', pl.material_spec_id, 'qty', v_q);
    end loop;
  else
    select coalesce(jsonb_agg(jsonb_build_object('po_line_id', x.id, 'material_spec_id', x.material_spec_id,
             'qty', x.qty - x.qty_accepted) order by x.line_no), '[]'::jsonb) into v_lines
      from public.po_lines x where x.po_id = po.id and x.deleted_at is null and not x.closed and x.qty - x.qty_accepted > 0.0005;
    if jsonb_array_length(v_lines) = 0 then raise exception 'Nothing is outstanding on PO %', po.number; end if;
  end if;

  insert into public.delivery_notices (id, project_id, po_id, store_id, expected_date, expected_window, vehicle_plate,
    driver_name, driver_phone, lines, note)
  values (v_id, po.project_id, po.id, po.delivery_store_id, v_date, nullif(p ->> 'expected_window', ''), v_plate,
    nullif(p ->> 'driver_name', ''), nullif(p ->> 'driver_phone', ''), v_lines, nullif(p ->> 'note', ''));
  update public.purchase_orders set eta = v_date,
    delivery_status = case when delivery_status in ('pending','delayed') then 'confirmed' else delivery_status end
   where id = po.id;
  insert into public.po_delivery_updates (id, po_id, project_id, status, eta, note)
  values (gen_random_uuid(), po.id, po.project_id, case when po.delivery_status = 'dispatched' then 'dispatched' else 'confirmed' end,
    v_date, 'Delivery notice to store');
  perform app.refresh_mrs_for_po(po.id);   -- linked purchase requests → delivery_expected

  v_crit := v_date <= current_date + 1;
  select name into v_supplier from public.suppliers where id = po.supplier_id;
  select string_agg(app.spec_label((e ->> 'material_spec_id')::uuid) || ' × ' || (e ->> 'qty'), ', ') into v_items
    from jsonb_array_elements(v_lines) e;
  perform app.notify_roles(po.project_id, '{store_keeper}', 'Delivery expected: PO ' || po.number || ' on ' || to_char(v_date, 'DD Mon YYYY'),
    concat_ws(' · ', v_supplier, 'vehicle ' || v_plate, nullif(p ->> 'expected_window', ''), v_items),
    'delivery_notice', v_id, v_crit);
  perform app.notify_roles_txt(po.project_id, '{security}', 'Expect vehicle ' || coalesce(v_plate, '(plate not given)')
      || ' on ' || to_char(v_date, 'DD Mon YYYY'),
    concat_ws(' · ', 'PO ' || po.number, v_supplier, nullif(p ->> 'driver_name', ''), nullif(p ->> 'driver_phone', ''),
      nullif(p ->> 'expected_window', '')), 'delivery_notice', v_id, v_crit);
  return app.op_done(p, 'notify_store_delivery', jsonb_build_object('ok', true, 'id', v_id, 'status', 'notified'));
end $$;

-- Store keeper accepts the announced delivery (space / labour ready) or asks for another date.
create or replace function public.acknowledge_delivery_notice(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_decision text := coalesce(p ->> 'decision', 'accept');
  v_note text := nullif(trim(p ->> 'note'), '');
  v_date date := (p ->> 'proposed_date')::date;
  dn public.delivery_notices; v_po text; v_to text; x record;
begin
  if v_seen is not null then return v_seen; end if;
  select * into dn from public.delivery_notices where id = (p ->> 'id')::uuid for update;
  if not found then raise exception 'Delivery notice not found'; end if;
  perform app.require_member(dn.project_id);
  perform app.require_role('store_keeper','coordinator','manager','admin');
  select number into v_po from public.purchase_orders where id = dn.po_id;
  if v_decision = 'accept' then
    if dn.status not in ('notified','reschedule_requested') then
      raise exception 'Delivery notice cannot be accepted (status: %)', dn.status;
    end if;
    v_to := 'acknowledged';
    update public.delivery_notices set status = v_to, ack_by = auth.uid(), ack_at = now(), ack_note = v_note where id = dn.id;
    perform app.notify_user(dn.created_by, dn.project_id, 'Store accepted delivery of PO ' || v_po,
      coalesce(v_note, 'Expected ' || to_char(dn.expected_date, 'DD Mon YYYY')), 'delivery_notice', dn.id);
  elsif v_decision = 'reschedule' then
    if dn.status not in ('notified','acknowledged') then
      raise exception 'Delivery notice cannot be rescheduled (status: %)', dn.status;
    end if;
    if v_date is null then raise exception 'Propose another delivery date'; end if;
    v_to := 'reschedule_requested';
    update public.delivery_notices set status = v_to, ack_by = auth.uid(), ack_at = now(), ack_note = v_note,
      proposed_date = v_date where id = dn.id;
    perform app.notify_roles(dn.project_id, '{procurement}', 'Store asks to reschedule delivery of PO ' || v_po,
      'Proposed ' || to_char(v_date, 'DD Mon YYYY') || coalesce(' — ' || v_note, ''), 'delivery_notice', dn.id, true);
    perform app.notify_user(dn.created_by, dn.project_id, 'Store asks to reschedule delivery of PO ' || v_po,
      'Proposed ' || to_char(v_date, 'DD Mon YYYY') || coalesce(' — ' || v_note, ''), 'delivery_notice', dn.id, true);
  else
    raise exception 'Decision must be accept or reschedule';
  end if;
  for x in select distinct r.id, r.status from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
            join public.material_requests r on r.id = ml.mr_id where pl.po_id = dn.po_id and pl.deleted_at is null loop
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload, actor)
    values (x.id, dn.project_id, case when v_to = 'acknowledged' then 'delivery_ack' else 'delivery_reschedule' end,
      x.status, x.status, v_note, jsonb_build_object('delivery_notice_id', dn.id, 'po_id', dn.po_id, 'proposed_date', v_date), auth.uid());
  end loop;
  return app.op_done(p, 'acknowledge_delivery_notice', jsonb_build_object('ok', true, 'id', dn.id, 'status', v_to));
end $$;

-- Gate: a vehicle logged in against a notice marks it arrived.
create or replace function app.vehicle_delivery_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.linked_doc_type = 'delivery_notice' and new.linked_doc_id is not null and new.direction = 'in' then
    update public.delivery_notices set status = 'arrived'
     where id = new.linked_doc_id and project_id = new.project_id and status in ('notified','acknowledged','reschedule_requested');
    if found then
      perform app.notify_roles(new.project_id, '{store_keeper}', 'Delivery vehicle ' || new.plate || ' at the gate',
        'Receive it with a GRN', 'delivery_notice', new.linked_doc_id, true);
    end if;
  end if;
  return new;
end $$;

create trigger delivery_notice_arrival after insert on public.vehicle_movements
  for each row execute function app.vehicle_delivery_notice();

-- Temporary approval cover (e.g. manager on leave). The delegate inherits the delegator's limit and role for approvals.
create or replace function public.save_approval_delegation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_from uuid := coalesce((p ->> 'from_user')::uuid, auth.uid());
  v_to uuid := (p ->> 'to_user')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  d public.approval_delegations;
begin
  if v_seen is not null then return v_seen; end if;
  if not app.is_active_user() then raise exception 'Account is inactive' using errcode = '42501'; end if;
  if v_project is not null then perform app.require_member(v_project); end if;
  select * into d from public.approval_delegations where id = v_id for update;
  if coalesce((p ->> 'revoke')::boolean, false) then
    if not found then raise exception 'Delegation not found'; end if;
    if d.from_user <> auth.uid() and d.created_by <> auth.uid() and not app.has_role('manager','admin') then
      raise exception 'Only the delegator or management can revoke a delegation' using errcode = '42501';
    end if;
    update public.approval_delegations set revoked_at = now() where id = v_id;
    return app.op_done(p, 'save_approval_delegation', jsonb_build_object('ok', true, 'id', v_id, 'revoked', true));
  end if;
  if v_from <> auth.uid() then perform app.require_role('manager','admin'); end if;
  if v_to is null or not exists (select 1 from public.profiles where id = v_to and is_active) then
    raise exception 'Choose an active user to delegate to';
  end if;
  if v_to = v_from then raise exception 'You cannot delegate to yourself'; end if;
  if coalesce(trim(p ->> 'reason'), '') = '' then raise exception 'A reason is required'; end if;
  insert into public.approval_delegations (id, project_id, from_user, to_user, doc_type, valid_from, valid_to, reason)
  values (v_id, v_project, v_from, v_to, coalesce(nullif(p ->> 'doc_type', ''), 'any'),
    coalesce((p ->> 'valid_from')::date, current_date), (p ->> 'valid_to')::date, trim(p ->> 'reason'))
  on conflict (id) do update set project_id = excluded.project_id, to_user = excluded.to_user, doc_type = excluded.doc_type,
    valid_from = excluded.valid_from, valid_to = excluded.valid_to, reason = excluded.reason, revoked_at = null
  where public.approval_delegations.from_user = v_from;
  perform app.notify_user(v_to, v_project, 'Approval cover delegated to you',
    (select full_name from public.profiles where id = v_from) || ' until ' || to_char((p ->> 'valid_to')::date, 'DD Mon YYYY'),
    'approval_delegation', v_id);
  return app.op_done(p, 'save_approval_delegation', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- Reorder suggestions → PURCHASE request entering Flow A at the coordinator (0005 redefined).
create or replace function public.create_mr_from_suggestions(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  v_store uuid := (p ->> 'store_id')::uuid;
  v_req date := coalesce((p ->> 'required_date')::date, current_date + 7);
  v_priority public.mr_priority := coalesce((p ->> 'priority')::public.mr_priority, 'normal');
  v_submit boolean := coalesce((p ->> 'submit')::boolean, true);
  l jsonb; v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','procurement','office_engineer','coordinator','manager','admin');
  perform app.require_store(v_project, v_store);
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Choose at least one suggestion'; end if;
  if exists (select 1 from public.material_requests where id = v_id) then raise exception 'Request already exists'; end if;

  insert into public.material_requests (id, project_id, number, block_id, requested_by, requester_role, priority, required_date,
    delivery_location, store_id, purpose, status, device_created_at, request_type, current_owner_role)
  values (v_id, v_project, p ->> 'number', (p ->> 'block_id')::uuid, auth.uid(), app.my_role(), v_priority, v_req,
    (select name from public.stores where id = v_store), v_store, 'Reorder', 'draft',
    (p ->> 'device_created_at')::timestamptz, 'purchase', 'requester');
  insert into public.mr_events (mr_id, project_id, action, to_status, actor, payload)
  values (v_id, v_project, 'create', 'draft', auth.uid(), jsonb_build_object('request_type', 'purchase', 'source', 'reorder'));

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    if l ->> 'material_spec_id' is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    insert into public.mr_lines (id, mr_id, project_id, line_no, material_spec_id, qty, required_date, remarks)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric, v_req,
      coalesce(nullif(l ->> 'remarks', ''), 'Reorder suggestion'));
  end loop;
  insert into public.mr_versions (mr_id, project_id, version, snapshot, changed_by) values (v_id, v_project, 1, p - 'op_id', auth.uid());

  if v_submit then perform app.mr_submit(v_id); end if;
  return app.op_done(p, 'create_mr_from_suggestions', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.material_requests where id = v_id)));
end $$;

-- -----------------------------------------------------------------------------
-- 12. SLA escalation (pg_cron; replaces 0003's escalate_pending_requests)
-- -----------------------------------------------------------------------------

create or replace function public.escalate_pending_requests() returns int
language plpgsql security definer set search_path = public as $$
declare
  rq record; dn record; mv record; cl record;
  v_n int := 0; v_key text; v_sla numeric; v_since timestamptz; v_roles text[]; v_label text; x record;
begin
  -- per type × status SLA (project_settings.wf_sla_hours, urgent/critical halve it)
  for rq in
    select mr.*, s.wf_sla_hours, s.escalation_hours
    from public.material_requests mr join public.project_settings s on s.project_id = mr.project_id
    where mr.status::text in ('submitted','reviewed','reviewed_by_coordinator','approved','approved_by_management',
                              'with_procurement','partially_issued')
  loop
    v_key := case when rq.request_type = 'purchase' then 'pr' else 'sur' end;
    continue when v_key = 'pr' and rq.status::text = 'partially_issued';
    v_sla := coalesce((rq.wf_sla_hours -> v_key ->> rq.status::text)::numeric, rq.escalation_hours, 24);
    if rq.priority <> 'normal' then v_sla := v_sla / 2; end if;
    v_since := coalesce((select max(e.created_at) from public.mr_events e
                          where e.mr_id = rq.id and e.to_status = rq.status and e.from_status is distinct from e.to_status),
                        rq.submitted_at, rq.updated_at);
    if v_key = 'sur' and rq.status::text in ('approved','partially_issued') then
      -- store order not issued by the coordinator's date
      continue when coalesce(rq.issue_by, rq.required_date) >= current_date;
    else
      continue when v_since > now() - make_interval(secs => v_sla * 3600);
    end if;
    continue when exists (select 1 from public.mr_events e where e.mr_id = rq.id and e.action = 'escalated'
                          and e.payload ->> 'status' = rq.status::text
                          and e.created_at > now() - make_interval(secs => v_sla * 3600));
    v_roles := case v_key || ':' || rq.status::text
      when 'pr:submitted' then '{manager}'
      when 'pr:reviewed_by_coordinator' then '{manager,admin}'
      when 'pr:reviewed' then '{manager,admin}'
      when 'pr:approved_by_management' then '{procurement}'
      when 'pr:approved' then '{procurement}'
      when 'pr:with_procurement' then '{coordinator,manager}'
      when 'sur:submitted' then '{coordinator}'
      when 'sur:reviewed' then '{manager}'
      when 'sur:approved' then '{store_keeper,coordinator}'
      when 'sur:partially_issued' then '{store_keeper,coordinator}'
      else '{manager}' end;
    v_label := coalesce(app.mr_status_label(rq.request_type, rq.status::text), rq.status::text);
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload)
    values (rq.id, rq.project_id, 'escalated', rq.status, rq.status, 'Overdue: ' || v_label,
      jsonb_build_object('status', rq.status, 'hours', round((extract(epoch from now() - v_since) / 3600)::numeric, 1),
                         'sla_hours', v_sla, 'notified', to_jsonb(v_roles)));
    perform app.notify_roles_txt(rq.project_id, v_roles, 'Overdue: ' || rq.number || ' (' || v_label || ')',
      'Waiting since ' || to_char(v_since + interval '3 hours', 'DD Mon HH24:MI'), 'material_request', rq.id, true);
    v_n := v_n + 1;
  end loop;

  -- delivery overdue: ETA + 1 day passed without GRN
  for dn in select d.*, po.number as po_number from public.delivery_notices d join public.purchase_orders po on po.id = d.po_id
             where d.status in ('notified','acknowledged','reschedule_requested','arrived')
               and d.expected_date + 1 < current_date
               and (d.escalated_at is null or d.escalated_at < now() - interval '24 hours') loop
    update public.delivery_notices set escalated_at = now() where id = dn.id;
    perform app.notify_roles(dn.project_id, '{procurement,coordinator}', 'Delivery overdue: PO ' || dn.po_number,
      'Expected ' || to_char(dn.expected_date, 'DD Mon YYYY') || ', no GRN yet', 'delivery_notice', dn.id, true);
    for x in select distinct ml.mr_id, r.status from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
              join public.material_requests r on r.id = ml.mr_id where pl.po_id = dn.po_id and pl.deleted_at is null loop
      insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload)
      values (x.mr_id, dn.project_id, 'escalated', x.status, x.status, 'Delivery overdue',
        jsonb_build_object('status', 'delivery_overdue', 'delivery_notice_id', dn.id));
    end loop;
    v_n := v_n + 1;
  end loop;

  -- site-use issue not acknowledged by the receiver
  for mv in select m.*, r.number as mr_number, r.project_id as pid, r.status as mr_status,
                   coalesce((s.wf_sla_hours -> 'sur' ->> 'issued_unacked')::numeric, 24) as sla
              from public.mivs m join public.material_requests r on r.id = m.mr_id and r.request_type = 'site_use'
              join public.project_settings s on s.project_id = r.project_id
             where m.status = 'pending_ack' loop
    continue when mv.issued_at > now() - make_interval(secs => mv.sla * 3600);
    continue when exists (select 1 from public.mr_events e where e.mr_id = mv.mr_id and e.action = 'escalated'
                          and e.payload ->> 'miv_id' = mv.id::text and e.created_at > now() - make_interval(secs => mv.sla * 3600));
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, comment, payload)
    values (mv.mr_id, mv.pid, 'escalated', mv.mr_status, mv.mr_status, 'Issue not acknowledged: ' || mv.number,
      jsonb_build_object('status', 'issued_unacked', 'miv_id', mv.id));
    perform app.notify_user(mv.issued_to, mv.pid, 'Please acknowledge ' || mv.number, 'Materials issued against ' || mv.mr_number,
      'miv', mv.id, true);
    perform app.notify_roles(mv.pid, '{coordinator}', 'Issue not acknowledged: ' || mv.number, 'Request ' || mv.mr_number,
      'miv', mv.id, true);
    v_n := v_n + 1;
  end loop;

  -- received site-use requests close automatically
  for cl in select mr.id from public.material_requests mr join public.project_settings s on s.project_id = mr.project_id
             where mr.request_type = 'site_use' and mr.status::text = 'received'
               and mr.received_at < now() - make_interval(hours => s.sur_auto_close_hours) loop
    perform app.mr_transition(cl.id, 'closed', 'auto_close', 'Closed automatically after receipt');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke execute on function public.escalate_pending_requests() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 13. Approval inbox (0007 redefined): per-flow kinds
--   site use : mr_review (OE), mr_approve (coordinator) — kind names unchanged for the apps
--              (= sur_review / sur_approve in the spec), sur_issue (store keeper), miv_ack (requester)
--   purchase : pr_review (coordinator), pr_approve (manager / covering approver), pr_accept (procurement),
--              delivery_ack (store keeper)
-- -----------------------------------------------------------------------------

create or replace function app.approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  -- Users may only read their own inbox; server contexts (service role, pg_cron) may read anyone's.
  if p_user is distinct from auth.uid()
     and (auth.uid() is not null or coalesce(auth.role(), '') in ('anon','authenticated')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;

  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin'
  )
  select x.kind, x.entity_type, x.entity_id, x.project_id, x.number, x.title, x.status, x.requested_by, x.requested_at,
         x.is_urgent, x.actions, round((extract(epoch from now() - coalesce(x.requested_at, now())) / 3600)::numeric, 1)
  from (
    select 'mr_review'::text as kind, 'material_request'::text as entity_type, r.id as entity_id, r.project_id, r.number,
           'Review material request ' || r.number as title, r.status::text as status, r.requested_by,
           r.submitted_at as requested_at, r.priority <> 'normal' as is_urgent, array['review','return'] as actions
    from public.material_requests r join public.project_settings s on s.project_id = r.project_id
    where r.project_id in (select pid from mem) and r.request_type = 'site_use' and r.status = 'submitted' and s.require_review
      and v_role = 'office_engineer'
    union all
    select 'mr_approve', 'material_request', r.id, r.project_id, r.number, 'Approve material request ' || r.number,
           r.status::text, r.requested_by, coalesce(r.reviewed_at, r.submitted_at), r.priority <> 'normal',
           array['approve','reject','return']
    from public.material_requests r join public.project_settings s on s.project_id = r.project_id
    where r.project_id in (select pid from mem) and v_role in ('coordinator','manager','admin') and r.request_type = 'site_use'
      and (r.status = 'reviewed' or (r.status = 'submitted' and not s.require_review)) and r.requested_by <> p_user
    union all
    select 'sur_issue', 'material_request', r.id, r.project_id, r.number, 'Issue store order ' || r.number,
           r.status::text, r.requested_by, r.approved_at, r.priority <> 'normal', array['issue']
    from public.material_requests r
    where r.project_id in (select pid from mem) and v_role = 'store_keeper' and r.request_type = 'site_use'
      and r.status::text in ('approved','partially_issued','sourced','ordered')
    union all
    select 'pr_review', 'material_request', r.id, r.project_id, r.number, 'Review purchase request ' || r.number,
           r.status::text, r.requested_by, r.submitted_at, r.priority <> 'normal', array['review','return','reject']
    from public.material_requests r join public.project_settings s on s.project_id = r.project_id
    where r.project_id in (select pid from mem) and v_role = 'coordinator' and r.request_type = 'purchase'
      and r.status = 'submitted' and coalesce(s.pr_require_coordinator_review, true) and r.requested_by <> p_user
    union all
    select 'pr_approve', 'material_request', r.id, r.project_id, r.number, 'Approve purchase request ' || r.number,
           r.status::text, r.requested_by, coalesce(r.coordinator_reviewed_at, r.submitted_at), r.priority <> 'normal',
           array['approve','return','reject']
    from public.material_requests r
    join public.project_settings s on s.project_id = r.project_id
    left join public.mr_estimates e on e.mr_id = r.id
    where r.project_id in (select pid from mem) and r.request_type = 'purchase' and r.requested_by <> p_user
      and (r.status::text in ('reviewed_by_coordinator','reviewed')
           or (r.status = 'submitted' and not coalesce(s.pr_require_coordinator_review, true)))
      and app.acting_roles(p_user, r.project_id, 'purchase_request') && array['manager','admin']
      and not exists (select 1 from public.mr_approvals a where a.mr_id = r.id and a.actor = p_user and a.step = 'endorse' and not a.superseded)
      and (not exists (select 1 from public.mr_approvals a where a.mr_id = r.id and a.step = 'endorse' and not a.superseded)
           or app.limit_covers(p_user, r.project_id, 'purchase_request', e.est_value))
    union all
    select 'pr_accept', 'material_request', r.id, r.project_id, r.number, 'Buy materials for ' || r.number,
           r.status::text, r.requested_by, r.approved_at, r.priority <> 'normal', array['accept','return']
    from public.material_requests r
    where r.project_id in (select pid from mem) and v_role = 'procurement' and r.request_type = 'purchase'
      and r.status::text in ('approved_by_management','approved')
    union all
    select 'delivery_ack', 'delivery_notice', d.id, d.project_id, po.number,
           'Confirm delivery of PO ' || po.number || ' on ' || to_char(d.expected_date, 'DD Mon YYYY'),
           d.status, d.created_by, d.created_at, d.expected_date <= current_date + 1, array['accept','reschedule']
    from public.delivery_notices d join public.purchase_orders po on po.id = d.po_id
    where d.project_id in (select pid from mem) and v_role = 'store_keeper' and d.status = 'notified'
    union all
    select 'adjustment', 'adjustment', a.id, a.project_id, a.number, 'Approve ' || replace(a.adj_type, '_', ' ') || ' ' || a.number,
           a.status, a.requested_by, a.created_at, false, array['approve','reject']
    from public.adjustments a
    where a.project_id in (select pid from mem) and a.status = 'pending' and v_role in ('coordinator','manager','admin')
    union all
    select 'stock_count', 'stock_count', c.id, c.project_id, c.number, 'Approve stock count ' || c.number,
           c.status, c.counted_by, c.counted_at, false, array['approve','reject']
    from public.stock_counts c
    where c.project_id in (select pid from mem) and c.status = 'submitted' and v_role in ('coordinator','manager','admin')
    union all
    select 'progress_verify', 'progress_update', u.id, u.project_id, e.code,
           'Verify ' || ea.name || ' on ' || e.code || ' (' || u.pct_complete || '%)',
           u.status, u.reported_by, u.created_at, false, array['approve','reject']
    from public.progress_updates u
    join public.element_activities ea on ea.id = u.element_activity_id
    join public.elements e on e.id = u.element_id
    where u.project_id in (select pid from mem) and u.status = 'reported' and u.reported_by <> p_user
      and v_role in ('office_engineer','coordinator','manager','admin')
    union all
    select 'gate_pass_approve', 'gate_pass', g.id, g.project_id, g.number,
           'Approve ' || replace(g.pass_type, '_', '-') || ' gate pass ' || g.number,
           g.status, g.requested_by, g.submitted_at, g.pass_type = 'non_returnable', array['approve','reject']
    from public.gate_passes g
    where g.project_id in (select pid from mem) and g.status = 'pending' and v_role in ('coordinator','manager','admin')
    union all
    select 'gate_exit', 'gate_pass', g.id, g.project_id, g.number,
           'Check out ' || g.number || coalesce(' — ' || g.vehicle_plate, ''),
           g.status, g.requested_by, g.approved_at, false, array['verify']
    from public.gate_passes g
    where g.project_id in (select pid from mem) and g.status = 'approved' and v_role = 'security'
    union all
    select 'miv_ack', 'miv', m.id, m.project_id, m.number, 'Acknowledge materials received ' || m.number,
           m.status, m.issued_by, m.issued_at, false, array['acknowledge']
    from public.mivs m
    where m.project_id in (select pid from mem) and m.status = 'pending_ack' and m.issued_to = p_user
    union all
    select 'po_approve', 'purchase_order', po.id, po.project_id, po.number, 'Approve purchase order ' || po.number,
           po.status, po.created_by, coalesce(po.submitted_at, po.created_at), false, array['approve','reject']
    from public.purchase_orders po
    where po.project_id in (select pid from mem) and po.status = 'submitted' and v_role in ('coordinator','manager','admin')
      and po.created_by <> p_user
  ) x;
end $$;

-- -----------------------------------------------------------------------------
-- 14. Views
-- -----------------------------------------------------------------------------

-- Available-to-issue per store × spec = available ledger qty − unissued approved site-use qty (§5.1).
create or replace view public.v_stock_available_to_issue with (security_invoker = true) as
with stock as (
  select project_id, store_id, material_spec_id, sum(qty) as available
  from public.stock_ledger where stock_status = 'available' group by project_id, store_id, material_spec_id
),
res as (
  select r.project_id, coalesce(r.store_id, app.main_store(r.project_id)) as store_id, l.material_spec_id,
         sum(greatest(l.approved_qty - coalesce(x.issued, 0), 0)) as reserved
  from public.mr_lines l
  join public.material_requests r on r.id = l.mr_id
  left join lateral (select sum(ml.qty) as issued from public.miv_lines ml
                     join public.mivs m on m.id = ml.miv_id and m.status <> 'reversed' where ml.mr_line_id = l.id) x on true
  where l.deleted_at is null and l.approved_qty > 0 and l.line_status = 'open' and r.request_type = 'site_use'
    and r.status in ('approved','sourced','ordered','partially_issued')
  group by r.project_id, coalesce(r.store_id, app.main_store(r.project_id)), l.material_spec_id
),
k as (select project_id, store_id, material_spec_id from stock union select project_id, store_id, material_spec_id from res)
select k.project_id, k.store_id, st.name as store_name, k.material_spec_id, sp.label, sp.uom,
       coalesce(s.available, 0) as available, coalesce(r.reserved, 0) as reserved,
       greatest(coalesce(s.available, 0) - coalesce(r.reserved, 0), 0) as ati,
       coalesce(r.reserved, 0) > coalesce(s.available, 0) + 0.0005 as over_promised
from k
join public.stores st on st.id = k.store_id
join public.v_specs sp on sp.id = k.material_spec_id
left join stock s on s.store_id = k.store_id and s.material_spec_id = k.material_spec_id
left join res r on r.store_id = k.store_id and r.material_spec_id = k.material_spec_id;

-- One row per request: ball in court, age in status, SLA, linked documents. (Supersedes v_request_ageing.)
create or replace view public.v_mr_workflow with (security_invoker = true) as
select r.id, r.project_id, r.number, r.request_type, r.status, r.priority, r.current_owner_role,
       r.requested_by, p.full_name as requested_by_name, r.requester_role, r.required_date, r.issue_by, r.store_id,
       r.source_mr_id, src.number as source_number, r.procurement_owner,
       st.since as status_since,
       round((extract(epoch from now() - st.since) / 3600)::numeric, 1) as hours_in_status,
       sla.hours as sla_hours,
       case when sla.hours is not null then st.since + make_interval(secs => sla.hours * 3600) end as sla_due,
       coalesce(sla.hours is not null and now() > st.since + make_interval(secs => sla.hours * 3600), false) as is_overdue,
       (select coalesce(array_agg(c.number order by c.created_at), '{}') from public.material_requests c where c.source_mr_id = r.id) as linked_pr_numbers,
       (select coalesce(array_agg(distinct po.number), '{}') from public.po_lines pl
          join public.purchase_orders po on po.id = pl.po_id join public.mr_lines ml on ml.id = pl.mr_line_id
         where ml.mr_id = r.id and pl.deleted_at is null and po.status not in ('cancelled','rejected')) as po_numbers,
       (select coalesce(array_agg(distinct g.number), '{}') from public.grn_lines gl
          join public.grns g on g.id = gl.grn_id and g.status = 'posted' join public.mr_lines ml on ml.id = gl.mr_line_id
         where ml.mr_id = r.id) as grn_numbers,
       (select coalesce(array_agg(m.number order by m.issued_at), '{}') from public.mivs m where m.mr_id = r.id and m.status <> 'reversed') as miv_numbers
from public.material_requests r
join public.profiles p on p.id = r.requested_by
left join public.material_requests src on src.id = r.source_mr_id
left join public.project_settings s on s.project_id = r.project_id
cross join lateral (
  select coalesce((select max(e.created_at) from public.mr_events e
                    where e.mr_id = r.id and e.to_status = r.status and e.from_status is distinct from e.to_status),
                  r.submitted_at, r.created_at) as since) st
cross join lateral (
  select case when r.status::text in ('draft','returned','closed','rejected','cancelled','received') then null
              else (s.wf_sla_hours -> case when r.request_type = 'purchase' then 'pr' else 'sur' end
                                   ->> case when r.status::text = 'issued' then 'issued_unacked' else r.status::text end)::numeric
                   / case when r.priority <> 'normal' then 2 else 1 end end as hours) sla;

-- Purchase-request line tracker: approved → on RFQ → ordered → ETA / notice → received → outstanding. No prices.
create or replace view public.v_pr_tracker with (security_invoker = true) as
select ml.id as mr_line_id, ml.mr_id, r.number, r.project_id, r.status, r.priority, r.source_mr_id, ml.source_mr_line_id,
       ml.line_no, ml.material_spec_id, sp.label, sp.uom, ml.qty as requested_qty, ml.reviewed_qty, ml.approved_qty, ml.line_status,
       coalesce((select sum(rl.qty) from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
                  where rl.mr_line_id = ml.id and rl.deleted_at is null and q.status <> 'cancelled'), 0) as on_rfq_qty,
       coalesce((select sum(pl.qty) from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
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

grant select on public.v_stock_available_to_issue, public.v_mr_workflow, public.v_pr_tracker to authenticated;

-- -----------------------------------------------------------------------------
-- 15. Backfill ball-in-court, grants
-- -----------------------------------------------------------------------------

update public.material_requests set current_owner_role = app.mr_owner_role(request_type, status, project_id)
where current_owner_role is distinct from app.mr_owner_role(request_type, status, project_id);

do $$
declare f text;
begin
  foreach f in array array['create_rfq_from_prs','record_direct_purchase','notify_store_delivery',
    'acknowledge_delivery_notice','save_approval_delegation'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;
