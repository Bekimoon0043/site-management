-- =============================================================================
-- Procurement & cost (features P1 #1–#5):
--   RFQ + quotation comparison, purchase orders (VAT / withholding from
--   tax_settings, approval limits, amendments, delivery tracking), GRN against
--   PO, price history + spike alerts, budget / cost control, reorder suggestions.
--
-- Price visibility: every money column lives in a separate price-restricted
-- table (quotation_line_prices, po_line_prices, po_totals, po_revisions,
-- price_observations, budget_lines) readable only when app.can_see_prices().
-- Quantity tables (purchase_orders, po_lines, …) are readable by all project
-- members so store keepers can receive against POs offline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Column additions to existing tables
-- -----------------------------------------------------------------------------

alter table public.suppliers
  add column if not exists tin text,
  add column if not exists vat_registered boolean not null default true,
  add column if not exists payment_terms text;

alter table public.material_specs
  add column if not exists pack_size numeric(14,3) not null default 1 check (pack_size > 0),
  add column if not exists safety_days int not null default 3 check (safety_days >= 0);

alter table public.project_settings
  add column if not exists min_quotes int not null default 3 check (min_quotes >= 1),
  add column if not exists price_spike_pct numeric(5,2) not null default 15,
  add column if not exists over_receipt_pct numeric(5,2) not null default 2;

-- -----------------------------------------------------------------------------
-- Tax settings (company-wide, effective-dated; never hard-coded in functions)
-- -----------------------------------------------------------------------------

create table public.tax_settings (
  id                   uuid primary key default gen_random_uuid(),
  effective_from       date not null unique,
  vat_rate             numeric(5,2) not null default 15,
  wht_goods_rate       numeric(5,2) not null default 3,
  wht_goods_threshold  numeric(18,2) not null default 20000,
  wht_no_tin_rate      numeric(5,2) not null default 30,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
insert into public.tax_settings (effective_from) values ('2000-01-01');

-- -----------------------------------------------------------------------------
-- RFQ & quotations (P1-1)
-- -----------------------------------------------------------------------------

create table public.rfqs (
  id                 uuid primary key,
  project_id         uuid not null references public.projects (id),
  number             text not null unique,
  title              text not null,
  status             text not null default 'draft' check (status in ('draft','sent','closed','awarded','cancelled')),
  required_by        date,
  delivery_store_id  uuid references public.stores (id),
  min_quotes         int not null default 3 check (min_quotes >= 1),
  notes              text,
  min_quotes_override_reason text,
  created_by         uuid not null references public.profiles (id) default auth.uid(),
  device_id          uuid,
  sent_at            timestamptz,
  closed_at          timestamptz,
  awarded_by         uuid references public.profiles (id),
  awarded_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table public.rfq_lines (
  id                uuid primary key,
  rfq_id            uuid not null references public.rfqs (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  line_no           int not null,
  material_spec_id  uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null check (qty > 0),
  mr_line_id        uuid references public.mr_lines (id),
  required_date     date,
  remarks           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index rfq_lines_rfq_idx on public.rfq_lines (rfq_id);
create index rfq_lines_mr_line_idx on public.rfq_lines (mr_line_id) where mr_line_id is not null;

create table public.rfq_suppliers (
  id           uuid primary key,
  rfq_id       uuid not null references public.rfqs (id) on delete cascade,
  project_id   uuid not null references public.projects (id),
  supplier_id  uuid not null references public.suppliers (id),
  sent_via     text check (sent_via in ('telegram','whatsapp','email','sms','in_person','phone')),
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (rfq_id, supplier_id)
);

create table public.quotations (
  id                  uuid primary key,
  rfq_id              uuid not null references public.rfqs (id),
  project_id          uuid not null references public.projects (id),
  supplier_id         uuid not null references public.suppliers (id),
  number              text not null unique,
  quote_ref           text,
  quote_date          date not null,
  valid_until         date,
  prices_include_vat  boolean not null default false,
  delivery_days       int,
  payment_terms       text,
  transport_included  boolean,
  status              text not null default 'received' check (status in ('received','withdrawn','awarded','not_awarded')),
  created_by          uuid not null references public.profiles (id) default auth.uid(),
  device_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (rfq_id, supplier_id)
);

create table public.quotation_lines (
  id                uuid primary key,
  quotation_id      uuid not null references public.quotations (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  rfq_line_id       uuid not null references public.rfq_lines (id),
  offered_spec_id   uuid not null references public.material_specs (id),
  qty               numeric(16,3) not null check (qty > 0),
  available         boolean not null default true,
  remarks           text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (quotation_id, rfq_line_id)
);

-- Price-restricted. unit_price as quoted (incl. VAT when quotations.prices_include_vat);
-- transport_cost is the total for the line.
create table public.quotation_line_prices (
  quotation_line_id  uuid primary key references public.quotation_lines (id) on delete cascade,
  project_id         uuid not null references public.projects (id),
  unit_price         numeric(18,2) not null check (unit_price >= 0),
  currency           text not null default 'ETB',
  transport_cost     numeric(18,2) not null default 0 check (transport_cost >= 0),
  updated_at         timestamptz not null default now()
);

create table public.rfq_awards (
  id                 uuid primary key,
  rfq_id             uuid not null references public.rfqs (id),
  project_id         uuid not null references public.projects (id),
  rfq_line_id        uuid not null references public.rfq_lines (id),
  quotation_line_id  uuid not null references public.quotation_lines (id),
  supplier_id        uuid not null references public.suppliers (id),
  qty                numeric(16,3) not null check (qty > 0),
  is_lowest          boolean not null,
  reason             text,                 -- required when not the lowest landed cost
  awarded_by         uuid not null references public.profiles (id),
  awarded_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Purchase orders & deliveries (P1-2)
-- -----------------------------------------------------------------------------

create table public.purchase_orders (
  id                 uuid primary key,
  project_id         uuid not null references public.projects (id),
  number             text not null unique,
  supplier_id        uuid not null references public.suppliers (id),
  rfq_id             uuid references public.rfqs (id),
  delivery_store_id  uuid not null references public.stores (id),
  status             text not null default 'draft' check (status in
                       ('draft','submitted','approved','rejected','sent','partially_received','received','closed','cancelled')),
  revision           int not null default 0,
  order_date         date not null default current_date,
  expected_date      date,
  eta                date,
  delivery_status    text not null default 'pending'
                       check (delivery_status in ('pending','confirmed','dispatched','delayed','delivered')),
  payment_terms      text,
  advance_pct        numeric(5,2) check (advance_pct between 0 and 100),
  delivery_terms     text,
  remarks            text,
  created_by         uuid not null references public.profiles (id) default auth.uid(),
  device_id          uuid,
  submitted_at       timestamptz,
  approved_by        uuid references public.profiles (id),
  approved_at        timestamptz,
  sent_at            timestamptz,
  closed_at          timestamptz,
  cancelled_at       timestamptz,
  status_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index purchase_orders_project_status_idx on public.purchase_orders (project_id, status);

-- Quantities only (no prices) so store keepers can receive against them offline.
create table public.po_lines (
  id                 uuid primary key,
  po_id              uuid not null references public.purchase_orders (id) on delete cascade,
  project_id         uuid not null references public.projects (id),
  line_no            int not null,
  material_spec_id   uuid not null references public.material_specs (id),
  qty                numeric(16,3) not null check (qty > 0),
  uom                text,
  mr_line_id         uuid references public.mr_lines (id),
  quotation_line_id  uuid references public.quotation_lines (id),
  expected_date      date,
  qty_received       numeric(16,3) not null default 0,   -- delivered, maintained by post_grn
  qty_accepted       numeric(16,3) not null default 0,
  qty_rejected       numeric(16,3) not null default 0,
  closed             boolean not null default false,
  remarks            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index po_lines_po_idx on public.po_lines (po_id);
create index po_lines_mr_line_idx on public.po_lines (mr_line_id) where mr_line_id is not null;
create index po_lines_spec_idx on public.po_lines (material_spec_id);

-- Price-restricted. unit_price is ex-VAT per base uom.
create table public.po_line_prices (
  po_line_id      uuid primary key references public.po_lines (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  unit_price      numeric(18,2) not null check (unit_price >= 0),
  vat_applicable  boolean not null default true,
  currency        text not null default 'ETB',
  updated_at      timestamptz not null default now()
);

-- Price-restricted, maintained by app.po_recompute_totals().
create table public.po_totals (
  po_id             uuid primary key references public.purchase_orders (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  tax_settings_id   uuid references public.tax_settings (id),
  subtotal          numeric(18,2) not null default 0,
  vat_rate          numeric(5,2) not null default 0,
  vat               numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,   -- subtotal + VAT (PO value, used for approval limits)
  withholding_rate  numeric(5,2) not null default 0,
  withholding       numeric(18,2) not null default 0,
  net_payable       numeric(18,2) not null default 0,   -- total − withholding
  currency          text not null default 'ETB',
  updated_at        timestamptz not null default now()
);

-- Snapshot (incl. prices) of a PO before each amendment. Price-restricted.
create table public.po_revisions (
  id          uuid primary key default gen_random_uuid(),
  po_id       uuid not null references public.purchase_orders (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  revision    int not null,
  snapshot    jsonb not null,
  reason      text not null,
  created_by  uuid references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (po_id, revision)
);

create table public.po_events (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references public.purchase_orders (id) on delete cascade,
  project_id   uuid not null references public.projects (id),
  action       text not null,
  from_status  text,
  to_status    text,
  comment      text,
  actor        uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index po_events_po_idx on public.po_events (po_id);

create table public.po_delivery_updates (
  id          uuid primary key,
  po_id       uuid not null references public.purchase_orders (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  status      text not null check (status in ('pending','confirmed','dispatched','delayed','delivered')),
  eta         date,
  note        text,
  created_by  uuid not null references public.profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.grns add column if not exists po_id uuid references public.purchase_orders (id);
alter table public.grn_lines add column if not exists po_line_id uuid references public.po_lines (id);
create index grn_lines_po_line_idx on public.grn_lines (po_line_id) where po_line_id is not null;

-- -----------------------------------------------------------------------------
-- Price history (P1-3) and budget (P1-4) — both price-restricted
-- -----------------------------------------------------------------------------

create table public.price_observations (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id),
  material_spec_id  uuid not null references public.material_specs (id),
  supplier_id       uuid references public.suppliers (id),
  unit_price        numeric(18,2) not null check (unit_price >= 0),   -- ex-VAT, base uom
  currency          text not null default 'ETB',
  observed_on       date not null,
  source            text not null check (source in ('quotation','po','grn','market')),
  source_id         uuid,
  location          text,
  note              text,
  avg_90d           numeric(18,2),        -- company-wide average of the previous 90 days
  is_spike          boolean not null default false,
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index price_observations_spec_idx on public.price_observations (material_spec_id, observed_on);

-- Scope: boq_item (optionally narrowed to a spec) > material spec > material category.
create table public.budget_lines (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  boq_item_id       uuid references public.boq_items (id),
  material_spec_id  uuid references public.material_specs (id),
  category          text,
  description       text,
  budget_qty        numeric(16,3),
  budget_rate       numeric(18,2),
  budget_amount     numeric(18,2) not null check (budget_amount >= 0),
  created_by        uuid references public.profiles (id) default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  check (boq_item_id is not null or material_spec_id is not null or category is not null)
);

-- -----------------------------------------------------------------------------
-- Triggers, indexes, RLS
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'tax_settings','rfqs','rfq_lines','rfq_suppliers','quotations','quotation_lines','quotation_line_prices',
    'rfq_awards','purchase_orders','po_lines','po_line_prices','po_totals','po_revisions','po_events',
    'po_delivery_updates','price_observations','budget_lines'
  ] loop
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;

  -- audit trail on headers / commitments (price tables are covered by po_revisions)
  foreach t in array array['tax_settings','rfqs','rfq_lines','quotations','rfq_awards','purchase_orders','po_lines','budget_lines'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;

  -- append-only records
  foreach t in array array['rfq_awards','po_revisions','po_events','po_delivery_updates','price_observations'] loop
    execute format('create trigger immutable before update or delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
  foreach t in array array['rfqs','quotations','purchase_orders'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;

  -- members read quantity/document tables; writes only through the RPCs below
  foreach t in array array['rfqs','rfq_lines','rfq_suppliers','quotations','quotation_lines','rfq_awards',
                           'purchase_orders','po_lines','po_events','po_delivery_updates'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;

  -- price-restricted tables (FR-ACC-03, NFR-05)
  foreach t in array array['quotation_line_prices','po_line_prices','po_totals','po_revisions','price_observations','budget_lines'] loop
    execute format('create policy price_read on public.%I for select to authenticated
                    using (app.can_see_prices() and app.is_member(project_id))', t);
  end loop;
end $$;

create policy read_all on public.tax_settings for select to authenticated using (app.is_active_user());
create policy mgmt_write on public.tax_settings for all to authenticated
  using (app.has_role('manager','admin')) with check (app.has_role('manager','admin'));

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------

create or replace function app.require_prices() returns void
language plpgsql stable as $$
begin
  if not app.can_see_prices() then
    raise exception 'Your role (%) is not allowed to view or enter prices', coalesce(app.my_role()::text, 'inactive')
      using errcode = '42501';
  end if;
end $$;

create or replace function app.tax_for(p_date date) returns public.tax_settings
language sql stable security definer set search_path = public as $$
  select * from public.tax_settings where effective_from <= coalesce(p_date, current_date)
  order by effective_from desc limit 1
$$;

-- Quoted unit price converted to ex-VAT.
create or replace function app.quote_unit_exvat(p_qline uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select round(pr.unit_price / case when q.prices_include_vat then 1 + coalesce((app.tax_for(q.quote_date)).vat_rate, 0) / 100 else 1 end, 2)
  from public.quotation_lines ql
  join public.quotations q on q.id = ql.quotation_id
  join public.quotation_line_prices pr on pr.quotation_line_id = ql.id
  where ql.id = p_qline
$$;

-- Roles that receive price notifications: management roles that may see prices.
create or replace function app.price_mgmt_roles() returns public.app_role[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(r), '{}') from unnest('{coordinator,manager,admin}'::public.app_role[]) r
  where r = 'admin' or r = any (coalesce((select price_roles from public.app_settings where id = 1), '{}'))
$$;

-- Record a price; flag + notify when it exceeds the 90-day average by project_settings.price_spike_pct.
create or replace function app.observe_price(p_id uuid, p_project uuid, p_spec uuid, p_supplier uuid, p_price numeric,
  p_on date, p_source text, p_source_id uuid, p_location text default null, p_note text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_avg numeric; v_pct numeric; v_spike boolean := false;
begin
  select avg(unit_price) into v_avg from public.price_observations
   where material_spec_id = p_spec and observed_on between p_on - 90 and p_on;
  select price_spike_pct into v_pct from public.project_settings where project_id = p_project;
  v_spike := v_avg is not null and v_avg > 0 and p_price > v_avg * (1 + coalesce(v_pct, 15) / 100);
  insert into public.price_observations (id, project_id, material_spec_id, supplier_id, unit_price, observed_on, source,
    source_id, location, note, avg_90d, is_spike)
  values (coalesce(p_id, gen_random_uuid()), p_project, p_spec, p_supplier, p_price, coalesce(p_on, current_date), p_source,
    p_source_id, p_location, p_note, round(v_avg, 2), v_spike);
  if v_spike then
    perform app.notify_roles(p_project, app.price_mgmt_roles(), 'Price spike: ' || app.spec_label(p_spec),
      p_price || ' vs 90-day average ' || round(v_avg, 2) || ' (+' || round((p_price / v_avg - 1) * 100, 1) || '%, ' || p_source || ')',
      'price_observation', null, true);
  end if;
  return v_spike;
end $$;

-- MR status while nothing has been issued: approved → sourced (on an RFQ / draft PO) → ordered (PO sent).
create or replace function app.refresh_mr_procurement(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.material_requests; v_new public.mr_status;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if not found or r.status not in ('approved','sourced','ordered') then return; end if;
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
  if v_new <> r.status then
    update public.material_requests set status = v_new where id = p_mr;
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
    values (p_mr, r.project_id, 'procurement_status', r.status, v_new, auth.uid());
  end if;
end $$;

create or replace function app.refresh_mrs_for_rfq(p_rfq uuid) returns void
language sql security definer set search_path = public as $$
  select app.refresh_mr_procurement(x.mr_id) from (
    select distinct ml.mr_id from public.rfq_lines rl join public.mr_lines ml on ml.id = rl.mr_line_id where rl.rfq_id = p_rfq) x
$$;

create or replace function app.refresh_mrs_for_po(p_po uuid) returns void
language sql security definer set search_path = public as $$
  select app.refresh_mr_procurement(x.mr_id) from (
    select distinct ml.mr_id from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id where pl.po_id = p_po) x
$$;

-- Issue-status refresh from 0003, extended so a sourced/ordered request moves to
-- partially_issued/issued on issue and keeps its procurement stage otherwise.
create or replace function app.refresh_mr_status(p_mr uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.material_requests;
  v_total numeric; v_issued numeric; v_any boolean;
  v_new public.mr_status;
begin
  select * into r from public.material_requests where id = p_mr for update;
  if r.status not in ('approved','sourced','ordered','partially_issued','issued') then
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
                when r.status in ('sourced','ordered') then r.status
                else 'approved' end;
  if v_new <> r.status then
    update public.material_requests set status = v_new where id = p_mr;
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
    values (p_mr, r.project_id, 'issue_status', r.status, v_new, auth.uid());
    if v_new = 'approved' then perform app.refresh_mr_procurement(p_mr); end if;
  end if;
end $$;

-- An MR line can be sourced/ordered only while approved and within its approved quantity.
create or replace function app.check_mr_line(p_mr_line uuid, p_project uuid, p_spec uuid, p_qty numeric,
  p_exclude_po_line uuid, p_label text) returns void
language plpgsql security definer set search_path = public as $$
declare ml record; v_ordered numeric;
begin
  select l.*, r.status as mr_status, r.number as mr_number into ml
    from public.mr_lines l join public.material_requests r on r.id = l.mr_id
   where l.id = p_mr_line and l.project_id = p_project and l.deleted_at is null;
  if not found then raise exception '%: request line not found in this project', p_label; end if;
  if ml.mr_status not in ('approved','sourced','ordered','partially_issued') then
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

create or replace function app.po_recompute_totals(p_po uuid) returns public.po_totals
language plpgsql security definer set search_path = public as $$
declare
  po public.purchase_orders; v_tin text; tx public.tax_settings;
  v_sub numeric; v_vatable numeric; v_vat numeric; v_wrate numeric; v_wht numeric;
  t public.po_totals;
begin
  select * into po from public.purchase_orders where id = p_po;
  select tin into v_tin from public.suppliers where id = po.supplier_id;
  tx := app.tax_for(po.order_date);
  select coalesce(sum(round(l.qty * pr.unit_price, 2)), 0),
         coalesce(sum(round(l.qty * pr.unit_price, 2)) filter (where pr.vat_applicable), 0)
    into v_sub, v_vatable
    from public.po_lines l join public.po_line_prices pr on pr.po_line_id = l.id
   where l.po_id = p_po and l.deleted_at is null;
  v_vat := round(v_vatable * coalesce(tx.vat_rate, 0) / 100, 2);
  -- Withholding on goods at/above the threshold; higher rate when the supplier has no TIN.
  v_wrate := case when v_sub >= coalesce(tx.wht_goods_threshold, 0)
                  then case when coalesce(trim(v_tin), '') = '' then coalesce(tx.wht_no_tin_rate, 0) else coalesce(tx.wht_goods_rate, 0) end
                  else 0 end;
  v_wht := round(v_sub * v_wrate / 100, 2);
  insert into public.po_totals (po_id, project_id, tax_settings_id, subtotal, vat_rate, vat, total, withholding_rate,
    withholding, net_payable)
  values (p_po, po.project_id, tx.id, v_sub, coalesce(tx.vat_rate, 0), v_vat, v_sub + v_vat, v_wrate, v_wht, v_sub + v_vat - v_wht)
  on conflict (po_id) do update set tax_settings_id = excluded.tax_settings_id, subtotal = excluded.subtotal,
    vat_rate = excluded.vat_rate, vat = excluded.vat, total = excluded.total, withholding_rate = excluded.withholding_rate,
    withholding = excluded.withholding, net_payable = excluded.net_payable
  returning * into t;
  return t;
end $$;

-- Upsert PO lines + prices from a jsonb array; lines missing from the array are soft-deleted.
create or replace function app.po_save_lines(p_po uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  po public.purchase_orders;
  l jsonb; v_n int := 0; v_ids uuid[] := '{}';
  v_id uuid; v_spec uuid; v_qty numeric; v_price numeric; v_qline uuid;
  v_old public.po_lines;
begin
  select * into po from public.purchase_orders where id = p_po;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'A purchase order needs at least one line'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    v_id := coalesce((l ->> 'id')::uuid, gen_random_uuid());
    v_spec := (l ->> 'material_spec_id')::uuid;
    v_qty := (l ->> 'qty')::numeric;
    v_qline := (l ->> 'quotation_line_id')::uuid;
    if v_spec is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce(v_qty, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    if v_qline is not null and not exists (select 1 from public.quotation_lines where id = v_qline and project_id = po.project_id) then
      raise exception 'Line %: quotation line not found in this project', v_n;
    end if;
    v_price := coalesce((l ->> 'unit_price')::numeric, app.quote_unit_exvat(v_qline));
    if v_price is null or v_price < 0 then raise exception 'Line %: unit price is required', v_n; end if;

    select * into v_old from public.po_lines where id = v_id;
    if found then
      if v_old.po_id <> p_po then raise exception 'Line %: belongs to another purchase order', v_n; end if;
      if v_old.qty_received > 0 and v_old.material_spec_id <> v_spec then
        raise exception 'Line %: material cannot be changed after receipt', v_n;
      end if;
      if v_qty < v_old.qty_accepted - 0.0005 then
        raise exception 'Line %: quantity % is below the % already received', v_n, v_qty, v_old.qty_accepted;
      end if;
    end if;
    if l ->> 'mr_line_id' is not null then
      perform app.check_mr_line((l ->> 'mr_line_id')::uuid, po.project_id, v_spec, v_qty, v_id, 'Line ' || v_n);
    end if;

    v_ids := v_ids || v_id;
    insert into public.po_lines (id, po_id, project_id, line_no, material_spec_id, qty, uom, mr_line_id, quotation_line_id,
      expected_date, remarks)
    values (v_id, p_po, po.project_id, v_n, v_spec, v_qty, nullif(l ->> 'uom', ''), (l ->> 'mr_line_id')::uuid, v_qline,
      (l ->> 'expected_date')::date, nullif(l ->> 'remarks', ''))
    on conflict (id) do update set line_no = excluded.line_no, material_spec_id = excluded.material_spec_id,
      qty = excluded.qty, uom = excluded.uom, mr_line_id = excluded.mr_line_id, quotation_line_id = excluded.quotation_line_id,
      expected_date = excluded.expected_date, remarks = excluded.remarks, deleted_at = null;
    insert into public.po_line_prices (po_line_id, project_id, unit_price, vat_applicable)
    values (v_id, po.project_id, v_price, coalesce((l ->> 'vat_applicable')::boolean, true))
    on conflict (po_line_id) do update set unit_price = excluded.unit_price, vat_applicable = excluded.vat_applicable;
  end loop;

  if exists (select 1 from public.po_lines where po_id = p_po and deleted_at is null and not (id = any (v_ids)) and qty_received > 0) then
    raise exception 'Lines that have already been received cannot be removed';
  end if;
  update public.po_lines set deleted_at = now() where po_id = p_po and deleted_at is null and not (id = any (v_ids));
end $$;

create or replace function app.po_event(p_po uuid, p_action text, p_from text, p_to text, p_comment text) returns void
language sql security definer set search_path = public as $$
  insert into public.po_events (po_id, project_id, action, from_status, to_status, comment, actor)
  select p_po, project_id, p_action, p_from, p_to, p_comment, auth.uid() from public.purchase_orders where id = p_po
$$;

-- Receipt-driven status of an approved/sent PO.
create or replace function app.refresh_po_status(p_po uuid) returns void
language plpgsql security definer set search_path = public as $$
declare po public.purchase_orders; v_new text; v_all boolean; v_any boolean;
begin
  select * into po from public.purchase_orders where id = p_po for update;
  if po.status not in ('approved','sent','partially_received','received') then return; end if;
  select coalesce(bool_and(closed or qty_accepted >= qty - 0.0005), false), coalesce(bool_or(qty_received > 0), false)
    into v_all, v_any
    from public.po_lines where po_id = p_po and deleted_at is null;
  v_new := case when v_all then 'received'
                when v_any then 'partially_received'
                when po.sent_at is not null then 'sent'
                else 'approved' end;
  if v_new <> po.status then
    update public.purchase_orders set status = v_new,
      delivery_status = case when v_new = 'received' then 'delivered' else delivery_status end
     where id = p_po;
    perform app.po_event(p_po, 'receipt_status', po.status, v_new, null);
    if v_new = 'received' then
      perform app.notify_roles(po.project_id, '{procurement}', 'PO ' || po.number || ' fully received', null, 'purchase_order', p_po);
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- RFQ RPCs
-- -----------------------------------------------------------------------------

create or replace function app.rfq_send(p_rfq uuid) returns void
language plpgsql security definer set search_path = public as $$
declare q public.rfqs;
begin
  select * into q from public.rfqs where id = p_rfq for update;
  if q.status = 'sent' then return; end if;
  if q.status <> 'draft' then raise exception 'Only draft RFQs can be sent (status: %)', q.status; end if;
  if not exists (select 1 from public.rfq_lines where rfq_id = p_rfq and deleted_at is null) then
    raise exception 'An RFQ needs at least one line';
  end if;
  if not exists (select 1 from public.rfq_suppliers where rfq_id = p_rfq and deleted_at is null) then
    raise exception 'Choose at least one supplier to send the RFQ to';
  end if;
  update public.rfqs set status = 'sent', sent_at = now() where id = p_rfq;
  update public.rfq_suppliers set sent_at = coalesce(sent_at, now()) where rfq_id = p_rfq and deleted_at is null;
  perform app.refresh_mrs_for_rfq(p_rfq);
end $$;

create or replace function public.save_rfq(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  q public.rfqs;
  l jsonb; v_n int := 0; v_ids uuid[] := '{}'; v_sup uuid[] := '{}';
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('procurement','coordinator','manager','admin');
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'RFQ title is required'; end if;
  if p ->> 'delivery_store_id' is not null then perform app.require_store(v_project, (p ->> 'delivery_store_id')::uuid); end if;

  select * into q from public.rfqs where id = v_id for update;
  if found then
    if q.project_id <> v_project then raise exception 'RFQ belongs to another project'; end if;
    if q.status <> 'draft' then raise exception 'RFQ % can no longer be edited (status: %)', q.number, q.status; end if;
    update public.rfqs set title = p ->> 'title', required_by = (p ->> 'required_by')::date,
      delivery_store_id = (p ->> 'delivery_store_id')::uuid, notes = nullif(p ->> 'notes', ''),
      min_quotes = coalesce((p ->> 'min_quotes')::int, min_quotes)
     where id = v_id;
  else
    insert into public.rfqs (id, project_id, number, title, required_by, delivery_store_id, min_quotes, notes, device_id)
    values (v_id, v_project, p ->> 'number', p ->> 'title', (p ->> 'required_by')::date, (p ->> 'delivery_store_id')::uuid,
      coalesce((p ->> 'min_quotes')::int, (select min_quotes from public.project_settings where project_id = v_project), 3),
      nullif(p ->> 'notes', ''), app.device_id());
  end if;

  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if l ->> 'material_spec_id' is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    if l ->> 'mr_line_id' is not null then
      perform app.check_mr_line((l ->> 'mr_line_id')::uuid, v_project, (l ->> 'material_spec_id')::uuid, null, null, 'Line ' || v_n);
    end if;
    v_ids := v_ids || (l ->> 'id')::uuid;
    insert into public.rfq_lines (id, rfq_id, project_id, line_no, material_spec_id, qty, mr_line_id, required_date, remarks)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric,
      (l ->> 'mr_line_id')::uuid, coalesce((l ->> 'required_date')::date, (p ->> 'required_by')::date), nullif(l ->> 'remarks', ''))
    on conflict (id) do update set line_no = excluded.line_no, material_spec_id = excluded.material_spec_id, qty = excluded.qty,
      mr_line_id = excluded.mr_line_id, required_date = excluded.required_date, remarks = excluded.remarks, deleted_at = null
    where public.rfq_lines.rfq_id = v_id;
  end loop;
  update public.rfq_lines set deleted_at = now() where rfq_id = v_id and deleted_at is null and not (id = any (v_ids));

  for l in select * from jsonb_array_elements(coalesce(p -> 'suppliers', '[]'::jsonb)) loop
    if not exists (select 1 from public.suppliers where id = (l ->> 'supplier_id')::uuid and deleted_at is null) then
      raise exception 'Supplier not found';
    end if;
    v_sup := v_sup || (l ->> 'supplier_id')::uuid;
    insert into public.rfq_suppliers (id, rfq_id, project_id, supplier_id, sent_via)
    values (coalesce((l ->> 'id')::uuid, gen_random_uuid()), v_id, v_project, (l ->> 'supplier_id')::uuid, nullif(l ->> 'sent_via', ''))
    on conflict (rfq_id, supplier_id) do update set sent_via = excluded.sent_via, deleted_at = null;
  end loop;
  update public.rfq_suppliers set deleted_at = now() where rfq_id = v_id and deleted_at is null and not (supplier_id = any (v_sup));

  if coalesce((p ->> 'send')::boolean, false) then perform app.rfq_send(v_id); end if;
  return app.op_done(p, 'save_rfq', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.rfqs where id = v_id)));
end $$;

create or replace function public.rfq_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  q public.rfqs;
begin
  if v_seen is not null then return v_seen; end if;
  select * into q from public.rfqs where id = (p ->> 'rfq_id')::uuid for update;
  if not found then raise exception 'RFQ not found'; end if;
  perform app.require_member(q.project_id);
  perform app.require_role('procurement','coordinator','manager','admin');
  case v_action
  when 'send' then perform app.rfq_send(q.id);
  when 'close' then
    if q.status <> 'sent' then raise exception 'Only sent RFQs can be closed for quotations'; end if;
    update public.rfqs set status = 'closed', closed_at = now() where id = q.id;
  when 'cancel' then
    if q.status not in ('draft','sent','closed') then raise exception 'RFQ cannot be cancelled (status: %)', q.status; end if;
    if coalesce(trim(p ->> 'comment'), '') = '' then raise exception 'A reason is required to cancel'; end if;
    update public.rfqs set status = 'cancelled', notes = concat_ws(E'\n', notes, 'Cancelled: ' || (p ->> 'comment')) where id = q.id;
    perform app.refresh_mrs_for_rfq(q.id);
  else raise exception 'Unknown action %', v_action;
  end case;
  return app.op_done(p, 'rfq_action', jsonb_build_object('ok', true, 'id', q.id,
    'status', (select status from public.rfqs where id = q.id)));
end $$;

create or replace function public.record_quotation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_supplier uuid := (p ->> 'supplier_id')::uuid;
  q public.rfqs; qt public.quotations; rl public.rfq_lines;
  l jsonb; v_n int := 0; v_avail boolean; v_qline uuid;
begin
  if v_seen is not null then return v_seen; end if;
  select * into q from public.rfqs where id = (p ->> 'rfq_id')::uuid;
  if not found then raise exception 'RFQ not found'; end if;
  perform app.require_member(q.project_id);
  perform app.require_role('procurement','coordinator','manager','admin');
  perform app.require_prices();
  if q.status not in ('sent','closed') then raise exception 'Quotations can only be recorded for a sent RFQ (status: %)', q.status; end if;
  if p ->> 'quote_date' is null then raise exception 'Quotation date is required'; end if;
  if not exists (select 1 from public.suppliers where id = v_supplier and deleted_at is null) then raise exception 'Supplier not found'; end if;

  select * into qt from public.quotations where id = v_id for update;
  if found then
    if qt.rfq_id <> q.id or qt.supplier_id <> v_supplier then raise exception 'Quotation belongs to another RFQ/supplier'; end if;
    if qt.status <> 'received' then raise exception 'Quotation can no longer be edited (status: %)', qt.status; end if;
    update public.quotations set quote_ref = nullif(p ->> 'quote_ref', ''), quote_date = (p ->> 'quote_date')::date,
      valid_until = (p ->> 'valid_until')::date, prices_include_vat = coalesce((p ->> 'prices_include_vat')::boolean, false),
      delivery_days = (p ->> 'delivery_days')::int, payment_terms = nullif(p ->> 'payment_terms', ''),
      transport_included = (p ->> 'transport_included')::boolean
     where id = v_id;
  else
    if exists (select 1 from public.quotations where rfq_id = q.id and supplier_id = v_supplier) then
      raise exception 'A quotation from this supplier is already recorded for RFQ %', q.number;
    end if;
    insert into public.quotations (id, rfq_id, project_id, supplier_id, number, quote_ref, quote_date, valid_until,
      prices_include_vat, delivery_days, payment_terms, transport_included, device_id)
    values (v_id, q.id, q.project_id, v_supplier, p ->> 'number', nullif(p ->> 'quote_ref', ''), (p ->> 'quote_date')::date,
      (p ->> 'valid_until')::date, coalesce((p ->> 'prices_include_vat')::boolean, false), (p ->> 'delivery_days')::int,
      nullif(p ->> 'payment_terms', ''), (p ->> 'transport_included')::boolean, app.device_id());
  end if;
  insert into public.rfq_suppliers (id, rfq_id, project_id, supplier_id, sent_at)
  values (gen_random_uuid(), q.id, q.project_id, v_supplier, now()) on conflict (rfq_id, supplier_id) do update set deleted_at = null;

  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'A quotation needs at least one priced line'; end if;
  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    select * into rl from public.rfq_lines where id = (l ->> 'rfq_line_id')::uuid and rfq_id = q.id and deleted_at is null;
    if not found then raise exception 'Line %: RFQ line not found', v_n; end if;
    v_avail := coalesce((l ->> 'available')::boolean, true);
    if v_avail and (l ->> 'unit_price') is null then raise exception 'Line %: unit price is required', v_n; end if;
    v_qline := (l ->> 'id')::uuid;
    insert into public.quotation_lines (id, quotation_id, project_id, rfq_line_id, offered_spec_id, qty, available, remarks)
    values (v_qline, v_id, q.project_id, rl.id, coalesce((l ->> 'offered_spec_id')::uuid, rl.material_spec_id),
      coalesce((l ->> 'qty')::numeric, rl.qty), v_avail, nullif(l ->> 'remarks', ''))
    on conflict (id) do update set offered_spec_id = excluded.offered_spec_id, qty = excluded.qty,
      available = excluded.available, remarks = excluded.remarks
    where public.quotation_lines.quotation_id = v_id;
    if v_avail then
      insert into public.quotation_line_prices (quotation_line_id, project_id, unit_price, transport_cost)
      values (v_qline, q.project_id, (l ->> 'unit_price')::numeric, coalesce((l ->> 'transport_cost')::numeric, 0))
      on conflict (quotation_line_id) do update set unit_price = excluded.unit_price, transport_cost = excluded.transport_cost;
    else
      delete from public.quotation_line_prices where quotation_line_id = v_qline;
    end if;
  end loop;

  -- Proforma photos are uploaded through the attachment outbox (kind 'document' or 'photo').
  update public.attachments set entity_type = 'quotation', entity_id = v_id
   where project_id = q.project_id
     and id in (select (jsonb_array_elements_text(coalesce(p -> 'attachment_ids', '[]'::jsonb)))::uuid);

  return app.op_done(p, 'record_quotation', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function public.award_rfq(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  q public.rfqs;
  a jsonb; v_n int := 0;
  rl public.rfq_lines; ql record;
  v_quotes int; v_min_landed numeric; v_landed numeric; v_qty numeric; v_awarded numeric; v_lowest boolean;
  v_override text := nullif(trim(p ->> 'override_reason'), '');
  v_sup uuid; v_po jsonb; v_po_id uuid; v_po_ids uuid[] := '{}'; v_lines jsonb; qt public.quotations;
begin
  if v_seen is not null then return v_seen; end if;
  select * into q from public.rfqs where id = (p ->> 'rfq_id')::uuid for update;
  if not found then raise exception 'RFQ not found'; end if;
  perform app.require_member(q.project_id);
  perform app.require_role('coordinator','manager','admin');
  perform app.require_prices();
  if q.status not in ('sent','closed') then raise exception 'RFQ % cannot be awarded (status: %)', q.number, q.status; end if;
  if jsonb_array_length(coalesce(p -> 'awards', '[]'::jsonb)) = 0 then raise exception 'Choose at least one quotation line to award'; end if;

  select count(*) into v_quotes from public.quotations where rfq_id = q.id and status <> 'withdrawn';
  if v_quotes < q.min_quotes and v_override is null then
    raise exception 'Only % of the required % quotations received; an override reason is required', v_quotes, q.min_quotes;
  end if;

  for a in select * from jsonb_array_elements(p -> 'awards') loop
    v_n := v_n + 1;
    select * into rl from public.rfq_lines where id = (a ->> 'rfq_line_id')::uuid and rfq_id = q.id and deleted_at is null;
    if not found then raise exception 'Award %: RFQ line not found', v_n; end if;
    select ql2.*, qt2.supplier_id, qt2.status as q_status into ql
      from public.quotation_lines ql2 join public.quotations qt2 on qt2.id = ql2.quotation_id
     where ql2.id = (a ->> 'quotation_line_id')::uuid and ql2.rfq_line_id = rl.id;
    if not found then raise exception 'Award %: quotation line does not answer this RFQ line', v_n; end if;
    if not ql.available or ql.q_status = 'withdrawn' then raise exception 'Award %: the supplier did not offer this item', v_n; end if;

    -- landed unit cost = ex-VAT price + transport per unit
    select min(app.quote_unit_exvat(x.id) + coalesce(pr.transport_cost, 0) / x.qty) into v_min_landed
      from public.quotation_lines x join public.quotations y on y.id = x.quotation_id and y.status <> 'withdrawn'
      join public.quotation_line_prices pr on pr.quotation_line_id = x.id
     where x.rfq_line_id = rl.id and x.available;
    select app.quote_unit_exvat(ql.id) + coalesce(pr.transport_cost, 0) / ql.qty into v_landed
      from public.quotation_line_prices pr where pr.quotation_line_id = ql.id;
    v_lowest := v_landed <= v_min_landed + 0.005;
    if not v_lowest and coalesce(trim(a ->> 'reason'), '') = '' then
      raise exception 'Award %: % is not the lowest landed cost (% vs %); a reason is required',
        v_n, app.spec_label(rl.material_spec_id), round(v_landed, 2), round(v_min_landed, 2);
    end if;
    v_qty := coalesce((a ->> 'qty')::numeric, rl.qty);
    select coalesce(sum(qty), 0) into v_awarded from public.rfq_awards where rfq_line_id = rl.id;
    if v_awarded + v_qty > rl.qty + 0.0005 then
      raise exception 'Award %: awarded quantity exceeds the RFQ quantity (%)', v_n, rl.qty;
    end if;
    insert into public.rfq_awards (id, rfq_id, project_id, rfq_line_id, quotation_line_id, supplier_id, qty, is_lowest, reason, awarded_by)
    values (coalesce((a ->> 'id')::uuid, gen_random_uuid()), q.id, q.project_id, rl.id, ql.id, ql.supplier_id, v_qty, v_lowest,
      nullif(trim(a ->> 'reason'), ''), auth.uid());
    perform app.observe_price(null, q.project_id, ql.offered_spec_id, ql.supplier_id, app.quote_unit_exvat(ql.id),
      (select quote_date from public.quotations where id = ql.quotation_id), 'quotation', ql.id);
  end loop;

  update public.quotations set status = case when exists (
      select 1 from public.rfq_awards aw join public.quotation_lines x on x.id = aw.quotation_line_id
       where x.quotation_id = quotations.id) then 'awarded' else 'not_awarded' end
   where rfq_id = q.id and status in ('received','awarded','not_awarded');
  update public.rfqs set status = 'awarded', awarded_by = auth.uid(), awarded_at = now(),
    closed_at = coalesce(closed_at, now()), min_quotes_override_reason = v_override
   where id = q.id;

  -- Optional: one draft PO per awarded supplier; the client supplies id + number for each.
  if coalesce((p ->> 'create_po')::boolean, false) then
    if q.delivery_store_id is null then raise exception 'Set the RFQ delivery store before creating purchase orders'; end if;
    for v_sup in select distinct supplier_id from public.rfq_awards where rfq_id = q.id loop
      select x.value into v_po from jsonb_array_elements(coalesce(p -> 'pos', '[]'::jsonb)) as x(value) where (x.value ->> 'supplier_id')::uuid = v_sup;
      if v_po is null then
        raise exception 'PO id and number are required for supplier %', (select name from public.suppliers where id = v_sup);
      end if;
      v_po_id := (v_po ->> 'id')::uuid;
      select qt2.* into qt from public.quotations qt2 where qt2.rfq_id = q.id and qt2.supplier_id = v_sup;
      insert into public.purchase_orders (id, project_id, number, supplier_id, rfq_id, delivery_store_id, order_date,
        expected_date, payment_terms, device_id)
      values (v_po_id, q.project_id, v_po ->> 'number', v_sup, q.id, q.delivery_store_id,
        coalesce((v_po ->> 'order_date')::date, current_date),
        coalesce((v_po ->> 'expected_date')::date, current_date + qt.delivery_days, q.required_by),
        coalesce(qt.payment_terms, (select payment_terms from public.suppliers where id = v_sup)), app.device_id());
      select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'material_spec_id', x.offered_spec_id, 'qty', aw.qty,
               'mr_line_id', r2.mr_line_id, 'quotation_line_id', x.id, 'expected_date', r2.required_date) order by r2.line_no)
        into v_lines
        from public.rfq_awards aw join public.quotation_lines x on x.id = aw.quotation_line_id
        join public.rfq_lines r2 on r2.id = aw.rfq_line_id
       where aw.rfq_id = q.id and aw.supplier_id = v_sup;
      perform app.po_save_lines(v_po_id, v_lines);
      perform app.po_recompute_totals(v_po_id);
      perform app.po_event(v_po_id, 'create_from_award', null, 'draft', q.number);
      perform app.refresh_mrs_for_po(v_po_id);
      v_po_ids := v_po_ids || v_po_id;
    end loop;
  end if;

  return app.op_done(p, 'award_rfq', jsonb_build_object('ok', true, 'id', q.id, 'po_ids', to_jsonb(v_po_ids)));
end $$;

-- -----------------------------------------------------------------------------
-- Purchase order RPCs
-- -----------------------------------------------------------------------------

create or replace function public.save_po(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  po public.purchase_orders;
  t public.po_totals;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('procurement','coordinator','manager','admin');
  perform app.require_prices();
  perform app.require_store(v_project, (p ->> 'delivery_store_id')::uuid);
  if not exists (select 1 from public.suppliers where id = (p ->> 'supplier_id')::uuid and deleted_at is null) then
    raise exception 'Supplier is required';
  end if;
  if p ->> 'rfq_id' is not null and not exists (select 1 from public.rfqs where id = (p ->> 'rfq_id')::uuid and project_id = v_project) then
    raise exception 'RFQ not found in this project';
  end if;

  select * into po from public.purchase_orders where id = v_id for update;
  if found then
    if po.project_id <> v_project then raise exception 'Purchase order belongs to another project'; end if;
    if po.status not in ('draft','rejected') then
      raise exception 'PO % can no longer be edited (status: %); use an amendment', po.number, po.status;
    end if;
    if po.created_by <> auth.uid() and not app.has_role('coordinator','manager','admin') then
      raise exception 'Only the author can edit this purchase order';
    end if;
    update public.purchase_orders set supplier_id = (p ->> 'supplier_id')::uuid, rfq_id = (p ->> 'rfq_id')::uuid,
      delivery_store_id = (p ->> 'delivery_store_id')::uuid, order_date = coalesce((p ->> 'order_date')::date, order_date),
      expected_date = (p ->> 'expected_date')::date, payment_terms = nullif(p ->> 'payment_terms', ''),
      advance_pct = (p ->> 'advance_pct')::numeric, delivery_terms = nullif(p ->> 'delivery_terms', ''),
      remarks = nullif(p ->> 'remarks', ''), status = 'draft'
     where id = v_id;
    perform app.po_event(v_id, 'edit', po.status, 'draft', null);
  else
    insert into public.purchase_orders (id, project_id, number, supplier_id, rfq_id, delivery_store_id, order_date, expected_date,
      payment_terms, advance_pct, delivery_terms, remarks, device_id)
    values (v_id, v_project, p ->> 'number', (p ->> 'supplier_id')::uuid, (p ->> 'rfq_id')::uuid, (p ->> 'delivery_store_id')::uuid,
      coalesce((p ->> 'order_date')::date, current_date), (p ->> 'expected_date')::date,
      coalesce(nullif(p ->> 'payment_terms', ''), (select payment_terms from public.suppliers where id = (p ->> 'supplier_id')::uuid)),
      (p ->> 'advance_pct')::numeric, nullif(p ->> 'delivery_terms', ''), nullif(p ->> 'remarks', ''), app.device_id());
    perform app.po_event(v_id, 'create', null, 'draft', null);
  end if;

  perform app.po_save_lines(v_id, p -> 'lines');
  t := app.po_recompute_totals(v_id);
  perform app.refresh_mrs_for_po(v_id);

  if coalesce((p ->> 'submit')::boolean, false) then
    perform public.po_action(jsonb_build_object('po_id', v_id, 'action', 'submit'));
  end if;
  return app.op_done(p, 'save_po', jsonb_build_object('ok', true, 'id', v_id,
    'status', (select status from public.purchase_orders where id = v_id), 'totals', to_jsonb(t) - 'project_id'));
end $$;

create or replace function public.po_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  po public.purchase_orders;
  t public.po_totals;
  v_to text; v_limit numeric; l record;
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
    perform app.notify_roles(po.project_id, '{coordinator,manager}', 'PO ' || po.number || ' awaiting approval',
      (select name from public.suppliers where id = po.supplier_id), 'purchase_order', po.id);

  when 'approve' then
    perform app.require_role('coordinator','manager','admin');
    if po.status <> 'submitted' then raise exception 'Only submitted purchase orders can be approved (status: %)', po.status; end if;
    -- BR-08: value-based approval limits on the PO value incl. VAT.
    select max_value into v_limit from public.approval_limits
     where role = app.my_role() and (project_id = po.project_id or project_id is null)
     order by project_id nulls last limit 1;
    if v_limit is not null and coalesce(t.total, 0) > v_limit then
      raise exception 'PO value % exceeds your approval limit of %; a higher approver is required',
        round(t.total, 2), round(v_limit, 2);
    end if;
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
    for l in select distinct r.requested_by, r.number from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
              join public.material_requests r on r.id = ml.mr_id where pl.po_id = po.id and pl.deleted_at is null loop
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

  when 'close' then
    perform app.require_role('procurement','coordinator','manager','admin');
    if po.status not in ('sent','partially_received','received','approved') then
      raise exception 'Purchase order cannot be closed (status: %)', po.status;
    end if;
    if po.status <> 'received' and v_comment is null then raise exception 'A reason is required to short-close'; end if;
    v_to := 'closed';
    update public.purchase_orders set closed_at = now(), status_reason = v_comment where id = po.id;
    update public.po_lines set closed = true where po_id = po.id and deleted_at is null;

  else
    raise exception 'Unknown action %', v_action;
  end case;

  update public.purchase_orders set status = v_to where id = po.id;
  perform app.po_event(po.id, v_action, po.status, v_to, v_comment);
  if v_action = 'approve' and v_to = 'sent' then perform app.refresh_po_status(po.id); end if;
  perform app.refresh_mrs_for_po(po.id);

  return app.op_done(p, 'po_action', jsonb_build_object('ok', true, 'id', po.id,
    'status', (select status from public.purchase_orders where id = po.id)));
end $$;

-- Amendment of an approved/sent PO: snapshot → revision + 1 → re-approval when the value increases.
create or replace function public.amend_po(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_reason text := nullif(trim(p ->> 'reason'), '');
  po public.purchase_orders;
  t_old public.po_totals; t_new public.po_totals;
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid for update;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  perform app.require_role('procurement','coordinator','manager','admin');
  perform app.require_prices();
  if po.status not in ('approved','sent','partially_received') then
    raise exception 'Only approved/sent purchase orders can be amended (status: %)', po.status;
  end if;
  if v_reason is null then raise exception 'An amendment reason is required'; end if;
  select * into t_old from public.po_totals where po_id = po.id;

  insert into public.po_revisions (po_id, project_id, revision, snapshot, reason)
  values (po.id, po.project_id, po.revision, jsonb_build_object(
    'header', to_jsonb(po),
    'lines', (select coalesce(jsonb_agg(to_jsonb(l) || jsonb_build_object('unit_price', pr.unit_price, 'vat_applicable', pr.vat_applicable)
                       order by l.line_no), '[]')
                from public.po_lines l left join public.po_line_prices pr on pr.po_line_id = l.id
               where l.po_id = po.id and l.deleted_at is null),
    'totals', to_jsonb(t_old)), v_reason);

  update public.purchase_orders set revision = revision + 1,
    expected_date = coalesce((p ->> 'expected_date')::date, expected_date),
    payment_terms = coalesce(nullif(p ->> 'payment_terms', ''), payment_terms),
    delivery_terms = coalesce(nullif(p ->> 'delivery_terms', ''), delivery_terms),
    remarks = coalesce(nullif(p ->> 'remarks', ''), remarks)
   where id = po.id;
  if p ? 'lines' then perform app.po_save_lines(po.id, p -> 'lines'); end if;
  t_new := app.po_recompute_totals(po.id);

  if t_new.total > coalesce(t_old.total, 0) + 0.005 then
    update public.purchase_orders set status = 'submitted', submitted_at = now() where id = po.id;
    perform app.po_event(po.id, 'amend', po.status, 'submitted', v_reason);
    perform app.notify_roles(po.project_id, '{coordinator,manager}', 'PO ' || po.number || ' amended — re-approval needed',
      v_reason, 'purchase_order', po.id);
  else
    perform app.po_event(po.id, 'amend', po.status, po.status, v_reason);
    perform app.refresh_po_status(po.id);
  end if;
  perform app.refresh_mrs_for_po(po.id);
  return app.op_done(p, 'amend_po', jsonb_build_object('ok', true, 'id', po.id, 'revision', po.revision + 1,
    'status', (select status from public.purchase_orders where id = po.id)));
end $$;

create or replace function public.update_po_delivery(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_status text := p ->> 'status';
  po public.purchase_orders; l record;
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid for update;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  perform app.require_role('procurement','coordinator','manager','admin');
  if po.status not in ('approved','sent','partially_received') then
    raise exception 'Delivery can only be tracked for open purchase orders (status: %)', po.status;
  end if;
  if v_status = 'delayed' and coalesce(trim(p ->> 'note'), '') = '' and p ->> 'eta' is null then
    raise exception 'Give a new ETA or a note for a delay';
  end if;
  insert into public.po_delivery_updates (id, po_id, project_id, status, eta, note)
  values (coalesce((p ->> 'id')::uuid, gen_random_uuid()), po.id, po.project_id, v_status, (p ->> 'eta')::date, nullif(p ->> 'note', ''));
  update public.purchase_orders set delivery_status = v_status, eta = coalesce((p ->> 'eta')::date, eta) where id = po.id;

  for l in select distinct r.requested_by from public.po_lines pl join public.mr_lines ml on ml.id = pl.mr_line_id
            join public.material_requests r on r.id = ml.mr_id where pl.po_id = po.id and pl.deleted_at is null loop
    perform app.notify_user(l.requested_by, po.project_id, 'PO ' || po.number || ': ' || v_status,
      concat_ws(' — ', 'ETA ' || to_char((p ->> 'eta')::date, 'DD Mon YYYY'), nullif(p ->> 'note', '')), 'purchase_order', po.id,
      v_status = 'delayed');
  end loop;
  perform app.notify_roles(po.project_id, '{store_keeper}', 'PO ' || po.number || ': ' || v_status,
    concat_ws(' — ', 'ETA ' || to_char((p ->> 'eta')::date, 'DD Mon YYYY'), nullif(p ->> 'note', '')), 'purchase_order', po.id);
  return app.op_done(p, 'update_po_delivery', jsonb_build_object('ok', true, 'id', po.id));
end $$;

-- -----------------------------------------------------------------------------
-- GRN against PO (extends post_grn from 0003; payloads without PO fields are unchanged)
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
  v_po_supplier uuid;
  l jsonb; v_n int := 0;
  v_del numeric; v_acc numeric; v_rej numeric; v_ord numeric;
  v_flag text; v_mr_spec uuid; v_requester uuid; v_mr uuid;
  v_mr_line uuid; v_spec uuid;
  pl public.po_lines; v_po_status text; v_tol numeric; v_pos uuid[] := '{}'; v_mrs uuid[] := '{}'; x uuid;
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
  if v_po is not null then
    select supplier_id, status into v_po_supplier, v_po_status from public.purchase_orders
     where id = v_po and project_id = v_project for update;
    if not found then raise exception 'Purchase order not found in this project'; end if;
    if v_po_status not in ('approved','sent','partially_received') then
      raise exception 'Purchase order is not open for receiving (status: %)', v_po_status;
    end if;
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

  foreach x in array v_pos loop perform app.refresh_po_status(x); end loop;
  foreach x in array v_mrs loop perform app.refresh_mr_procurement(x); end loop;

  return app.op_done(p, 'post_grn', jsonb_build_object('ok', true, 'id', v_id, 'po_id', v_po,
    'po_status', (select status from public.purchase_orders where id = v_po)));
end $$;

-- A reversed GRN gives its quantities back to the PO lines (reverse_document is unchanged).
create or replace function app.grn_reversed() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record;
begin
  for g in select po_line_id, sum(qty_delivered) d, sum(qty_accepted) a, sum(qty_rejected) r
             from public.grn_lines where grn_id = new.id and po_line_id is not null group by po_line_id loop
    update public.po_lines set qty_received = qty_received - g.d, qty_accepted = qty_accepted - g.a,
      qty_rejected = qty_rejected - g.r where id = g.po_line_id;
  end loop;
  if new.po_id is not null then
    perform app.refresh_po_status(new.po_id);
  end if;
  return new;
end $$;

create trigger po_receipt_reversal after update of status on public.grns
  for each row when (new.status = 'reversed' and old.status is distinct from 'reversed')
  execute function app.grn_reversed();

-- -----------------------------------------------------------------------------
-- Price history, budget, reorder RPCs
-- -----------------------------------------------------------------------------

create or replace function public.log_market_price(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  v_price numeric := (p ->> 'unit_price')::numeric;
  v_on date := coalesce((p ->> 'observed_on')::date, current_date);
  v_spike boolean;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('procurement','coordinator','manager','admin');
  perform app.require_prices();
  if p ->> 'material_spec_id' is null then raise exception 'Material/grade is required'; end if;
  if v_price is null or v_price < 0 then raise exception 'Unit price is required'; end if;
  if coalesce((p ->> 'prices_include_vat')::boolean, false) then
    v_price := round(v_price / (1 + coalesce((app.tax_for(v_on)).vat_rate, 0) / 100), 2);
  end if;
  v_spike := app.observe_price((p ->> 'id')::uuid, v_project, (p ->> 'material_spec_id')::uuid, (p ->> 'supplier_id')::uuid,
    v_price, v_on, 'market', null, nullif(p ->> 'location', ''), nullif(p ->> 'note', ''));
  return app.op_done(p, 'log_market_price', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid, 'is_spike', v_spike));
end $$;

create or replace function public.save_budget(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  l jsonb; v_n int := 0; v_amount numeric; v_cat text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('coordinator','manager','admin');
  perform app.require_prices();
  for l in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) loop
    v_n := v_n + 1;
    if coalesce((l ->> 'deleted')::boolean, false) then
      update public.budget_lines set deleted_at = now() where id = (l ->> 'id')::uuid and project_id = v_project;
      continue;
    end if;
    if l ->> 'boq_item_id' is not null and not exists (
        select 1 from public.boq_items where id = (l ->> 'boq_item_id')::uuid and project_id = v_project) then
      raise exception 'Line %: BoQ item not found in this project', v_n;
    end if;
    v_cat := nullif(trim(l ->> 'category'), '');
    if l ->> 'boq_item_id' is null and l ->> 'material_spec_id' is null and v_cat is null then
      raise exception 'Line %: choose a BoQ item, material or category', v_n;
    end if;
    v_amount := coalesce((l ->> 'budget_amount')::numeric, (l ->> 'budget_qty')::numeric * (l ->> 'budget_rate')::numeric);
    if v_amount is null or v_amount < 0 then raise exception 'Line %: budget amount (or qty × rate) is required', v_n; end if;
    insert into public.budget_lines (id, project_id, boq_item_id, material_spec_id, category, description, budget_qty,
      budget_rate, budget_amount)
    values ((l ->> 'id')::uuid, v_project, (l ->> 'boq_item_id')::uuid, (l ->> 'material_spec_id')::uuid, v_cat,
      nullif(l ->> 'description', ''), (l ->> 'budget_qty')::numeric, (l ->> 'budget_rate')::numeric, round(v_amount, 2))
    on conflict (id) do update set boq_item_id = excluded.boq_item_id, material_spec_id = excluded.material_spec_id,
      category = excluded.category, description = excluded.description, budget_qty = excluded.budget_qty,
      budget_rate = excluded.budget_rate, budget_amount = excluded.budget_amount, deleted_at = null
    where public.budget_lines.project_id = v_project;
  end loop;
  return app.op_done(p, 'save_budget', jsonb_build_object('ok', true, 'lines', v_n));
end $$;

-- Stock-replenishment request from v_reorder_suggestions. Elements are not
-- required (purpose 'Reorder'); issues against it are still tied to elements (BR-02).
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
  v_settings public.project_settings;
  l jsonb; v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role('store_keeper','procurement','office_engineer','coordinator','manager','admin');
  perform app.require_store(v_project, v_store);
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Choose at least one suggestion'; end if;
  if exists (select 1 from public.material_requests where id = v_id) then raise exception 'Request already exists'; end if;

  insert into public.material_requests (id, project_id, number, block_id, requested_by, requester_role, priority, required_date,
    delivery_location, store_id, purpose, status, submitted_at, device_created_at)
  values (v_id, v_project, p ->> 'number', (p ->> 'block_id')::uuid, auth.uid(), app.my_role(), v_priority, v_req,
    (select name from public.stores where id = v_store), v_store, 'Reorder',
    case when v_submit then 'submitted' else 'draft' end::public.mr_status, case when v_submit then now() end,
    (p ->> 'device_created_at')::timestamptz);
  insert into public.mr_events (mr_id, project_id, action, to_status, actor) values (v_id, v_project, 'create', 'draft', auth.uid());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_n := v_n + 1;
    if l ->> 'material_spec_id' is null then raise exception 'Line %: material/grade is required', v_n; end if;
    if coalesce((l ->> 'qty')::numeric, 0) <= 0 then raise exception 'Line %: quantity must be greater than zero', v_n; end if;
    insert into public.mr_lines (id, mr_id, project_id, line_no, material_spec_id, qty, required_date, remarks)
    values ((l ->> 'id')::uuid, v_id, v_project, v_n, (l ->> 'material_spec_id')::uuid, (l ->> 'qty')::numeric, v_req,
      coalesce(nullif(l ->> 'remarks', ''), 'Reorder suggestion'));
  end loop;
  insert into public.mr_versions (mr_id, project_id, version, snapshot, changed_by) values (v_id, v_project, 1, p - 'op_id', auth.uid());

  if v_submit then
    insert into public.mr_events (mr_id, project_id, action, from_status, to_status, actor)
    values (v_id, v_project, 'submit', 'draft', 'submitted', auth.uid());
    select * into v_settings from public.project_settings where project_id = v_project;
    perform app.notify_roles(v_project,
      case when coalesce(v_settings.require_review, true) then '{office_engineer,coordinator,manager}'::public.app_role[]
           else '{coordinator,manager}'::public.app_role[] end,
      'Reorder request ' || (p ->> 'number'), 'Stock replenishment for ' || (select name from public.stores where id = v_store),
      'material_request', v_id, v_priority <> 'normal');
  end if;
  return app.op_done(p, 'create_mr_from_suggestions', jsonb_build_object('ok', true, 'id', v_id,
    'status', case when v_submit then 'submitted' else 'draft' end));
end $$;

-- -----------------------------------------------------------------------------
-- Views (security_invoker: price columns come only from price-restricted tables)
-- -----------------------------------------------------------------------------

-- Ordered / received / outstanding per PO line, with delay flag (no prices; store keepers can read).
create or replace view public.v_po_line_status with (security_invoker = true) as
select pl.id as po_line_id, pl.po_id, po.number as po_number, po.project_id, po.supplier_id, s.name as supplier_name,
       po.delivery_store_id, po.status as po_status, po.delivery_status, pl.line_no, pl.material_spec_id, sp.label, sp.uom,
       pl.mr_line_id, pl.qty as ordered_qty, pl.qty_received, pl.qty_accepted, pl.qty_rejected,
       case when pl.closed or po.status in ('closed','cancelled','rejected','draft','submitted') then 0
            else greatest(pl.qty - pl.qty_accepted, 0) end as outstanding_qty,
       coalesce(po.eta, pl.expected_date, po.expected_date) as expected_date,
       (po.status in ('approved','sent','partially_received') and not pl.closed and pl.qty - pl.qty_accepted > 0.0005
        and (coalesce(po.eta, pl.expected_date, po.expected_date) < current_date or po.delivery_status = 'delayed')) as is_delayed
from public.po_lines pl
join public.purchase_orders po on po.id = pl.po_id
join public.suppliers s on s.id = po.supplier_id
join public.v_specs sp on sp.id = pl.material_spec_id
where pl.deleted_at is null;

-- Store dashboard: what is coming, by date (overdue first).
create or replace view public.v_expected_deliveries with (security_invoker = true) as
select * from public.v_po_line_status
where po_status in ('approved','sent','partially_received') and outstanding_qty > 0;

-- PO header status with delayed flag and receipt progress (no prices).
create or replace view public.v_po_status with (security_invoker = true) as
select po.id, po.project_id, po.number, po.supplier_id, s.name as supplier_name, po.delivery_store_id, po.status,
       po.revision, po.order_date, po.expected_date, po.eta, po.delivery_status, po.sent_at, po.approved_at,
       count(pl.id) as lines,
       round(100 * coalesce(sum(least(pl.qty_accepted, pl.qty)) / nullif(sum(pl.qty), 0), 0), 1) as received_pct,
       (po.status in ('approved','sent','partially_received')
        and (po.delivery_status = 'delayed' or coalesce(po.eta, po.expected_date) < current_date)) as is_delayed,
       greatest(current_date - coalesce(po.eta, po.expected_date), 0) as days_late
from public.purchase_orders po
join public.suppliers s on s.id = po.supplier_id
left join public.po_lines pl on pl.po_id = po.id and pl.deleted_at is null
group by po.id, s.name;

-- Quotation comparison grid (lines × suppliers); empty for roles without price access.
create or replace view public.v_quotation_comparison with (security_invoker = true) as
with x as (
  select rl.rfq_id, rl.project_id, rl.id as rfq_line_id, rl.line_no, rl.material_spec_id, rl.qty as rfq_qty,
         q.id as quotation_id, q.number as quotation_number, q.supplier_id, s.name as supplier_name, s.rating,
         q.quote_date, q.valid_until, q.delivery_days, q.payment_terms, q.prices_include_vat, q.status as quotation_status,
         ql.id as quotation_line_id, ql.offered_spec_id, ql.qty as offered_qty, ql.available,
         pr.unit_price as quoted_unit_price, pr.transport_cost,
         app.quote_unit_exvat(ql.id) as unit_price_ex_vat,
         app.quote_unit_exvat(ql.id) + pr.transport_cost / ql.qty as landed_unit_cost
  from public.rfq_lines rl
  join public.quotation_lines ql on ql.rfq_line_id = rl.id
  join public.quotations q on q.id = ql.quotation_id and q.status <> 'withdrawn'
  join public.suppliers s on s.id = q.supplier_id
  join public.quotation_line_prices pr on pr.quotation_line_id = ql.id
  where rl.deleted_at is null and ql.available
)
select x.*, sp.label, sp.uom,
       round(x.landed_unit_cost * x.rfq_qty, 2) as landed_total,
       dense_rank() over (partition by x.rfq_line_id order by x.landed_unit_cost) as price_rank,
       x.landed_unit_cost = min(x.landed_unit_cost) over (partition by x.rfq_line_id) as is_lowest,
       exists (select 1 from public.rfq_awards a where a.quotation_line_id = x.quotation_line_id) as is_awarded,
       (select o.unit_price from public.price_observations o where o.material_spec_id = x.material_spec_id and o.source = 'po'
         order by o.observed_on desc, o.created_at desc limit 1) as last_po_price
from x join public.v_specs sp on sp.id = x.material_spec_id;

-- Weekly price trend per spec with the current 90-day average (company-wide across visible projects).
create or replace view public.v_price_trend with (security_invoker = true) as
with w as (
  select material_spec_id, date_trunc('week', observed_on)::date as week, count(*) as observations,
         min(unit_price) as min_price, round(avg(unit_price), 2) as avg_price,
         percentile_cont(0.5) within group (order by unit_price) as median_price, max(unit_price) as max_price,
         bool_or(is_spike) as has_spike
  from public.price_observations group by material_spec_id, date_trunc('week', observed_on)
),
cur as (
  select material_spec_id,
         round(avg(unit_price) filter (where observed_on >= current_date - 90), 2) as avg_90d,
         (array_agg(unit_price order by observed_on desc, created_at desc))[1] as latest_price,
         max(observed_on) as latest_on
  from public.price_observations group by material_spec_id
)
select w.*, sp.label, sp.category, sp.uom, cur.avg_90d, cur.latest_price, cur.latest_on,
       round((w.avg_price / nullif(cur.avg_90d, 0) - 1) * 100, 2) as week_vs_90d_pct,
       round((cur.latest_price / nullif(cur.avg_90d, 0) - 1) * 100, 2) as latest_vs_90d_pct
from w join cur using (material_spec_id) join public.v_specs sp on sp.id = w.material_spec_id;

-- Open commitment per PO line (ex-VAT).
create or replace view public.v_committed_cost with (security_invoker = true) as
select s.project_id, s.po_id, s.po_number, s.supplier_name, s.po_line_id, s.material_spec_id, s.label, sp.category,
       s.mr_line_id, ml.boq_item_id, s.outstanding_qty, pr.unit_price, round(s.outstanding_qty * pr.unit_price, 2) as committed_value
from public.v_po_line_status s
join public.po_line_prices pr on pr.po_line_id = s.po_line_id
join public.v_specs sp on sp.id = s.material_spec_id
left join public.mr_lines ml on ml.id = s.mr_line_id
where s.outstanding_qty > 0;

-- Budget vs committed (open PO) vs received vs issued per budget line (ex-VAT).
-- Received is valued at PO price (spec_prices when no PO); issued at the project's
-- average received cost per spec (spec_prices fallback).
create or replace view public.v_cost_control with (security_invoker = true) as
with recv as (
  select gl.project_id, gl.material_spec_id, gl.mr_line_id, gl.qty_accepted,
         coalesce(pr.unit_price, spp.unit_price) as unit_cost
  from public.grn_lines gl
  join public.grns g on g.id = gl.grn_id and g.status = 'posted'
  left join public.po_line_prices pr on pr.po_line_id = gl.po_line_id
  left join public.spec_prices spp on spp.material_spec_id = gl.material_spec_id
),
avg_cost as (
  select project_id, material_spec_id, sum(qty_accepted * unit_cost) / nullif(sum(qty_accepted), 0) as unit_cost
  from recv where unit_cost is not null group by project_id, material_spec_id
),
facts as (
  select c.project_id, c.material_spec_id, c.boq_item_id, c.committed_value as committed, 0::numeric as received, 0::numeric as issued
  from public.v_committed_cost c
  union all
  select r.project_id, r.material_spec_id, ml.boq_item_id, 0, r.qty_accepted * r.unit_cost, 0
  from recv r left join public.mr_lines ml on ml.id = r.mr_line_id
  union all
  select l.project_id, l.material_spec_id, ml.boq_item_id, 0, 0,
         -l.qty * coalesce(ac.unit_cost, spp.unit_price)
  from public.stock_ledger l
  left join public.mr_lines ml on ml.id = l.mr_line_id
  left join avg_cost ac on ac.project_id = l.project_id and ac.material_spec_id = l.material_spec_id
  left join public.spec_prices spp on spp.material_spec_id = l.material_spec_id
  where l.doc_type in ('miv','mrn')
),
f as (select facts.*, sp.category from facts join public.v_specs sp on sp.id = facts.material_spec_id)
select b.id as budget_line_id, b.project_id,
       case when b.boq_item_id is not null then 'boq_item' when b.material_spec_id is not null then 'material' else 'category' end as scope,
       b.boq_item_id, bi.item_no as boq_item_no, b.material_spec_id, sp.label, coalesce(b.category, sp.category) as category,
       coalesce(b.description, bi.description, sp.label, b.category) as description,
       b.budget_qty, b.budget_rate, b.budget_amount,
       round(coalesce(sum(f.committed), 0), 2) as committed,
       round(coalesce(sum(f.received), 0), 2) as received,
       round(coalesce(sum(f.issued), 0), 2) as issued,
       round(b.budget_amount - coalesce(sum(f.committed), 0) - coalesce(sum(f.received), 0), 2) as remaining,
       round(100 * (coalesce(sum(f.committed), 0) + coalesce(sum(f.received), 0)) / nullif(b.budget_amount, 0), 1) as pct_used
from public.budget_lines b
left join public.boq_items bi on bi.id = b.boq_item_id
left join public.v_specs sp on sp.id = b.material_spec_id
left join f on f.project_id = b.project_id and (
       (b.boq_item_id is not null and f.boq_item_id = b.boq_item_id
          and (b.material_spec_id is null or f.material_spec_id = b.material_spec_id))
    or (b.boq_item_id is null and b.material_spec_id is not null and f.material_spec_id = b.material_spec_id)
    or (b.boq_item_id is null and b.material_spec_id is null and f.category = b.category))
where b.deleted_at is null
group by b.id, bi.item_no, bi.description, sp.label, sp.category;

-- Reorder suggestions / stock-out forecast per store × spec (no prices).
-- suggested = max(reorder_level, (lead + safety days) × avg daily issue) + pending MR − available − open PO,
-- rounded up to pack_size.
create or replace view public.v_reorder_suggestions with (security_invoker = true) as
with main_store as (
  select distinct on (project_id) project_id, id as store_id from public.stores
  where deleted_at is null order by project_id, (store_type = 'main') desc, created_at
),
ledger as (
  select project_id, store_id, material_spec_id,
         coalesce(sum(qty) filter (where stock_status = 'available'), 0) as available,
         coalesce(-sum(qty) filter (where doc_type in ('miv','mrn') and txn_at >= now() - interval '30 days'), 0) / 30.0 as avg_daily
  from public.stock_ledger group by project_id, store_id, material_spec_id
),
on_order as (
  select project_id, delivery_store_id as store_id, material_spec_id, sum(outstanding_qty) as qty, min(expected_date) as next_eta
  from public.v_po_line_status where po_status in ('approved','sent','partially_received') and outstanding_qty > 0
  group by project_id, delivery_store_id, material_spec_id
),
pending as (
  select s.project_id, coalesce(r.store_id, ms.store_id) as store_id, s.material_spec_id, sum(s.remaining_qty) as qty
  from public.v_mr_line_status s
  join public.material_requests r on r.id = s.mr_id
  left join main_store ms on ms.project_id = s.project_id
  where s.status in ('approved','sourced','ordered','partially_issued') and s.remaining_qty > 0
  group by s.project_id, coalesce(r.store_id, ms.store_id), s.material_spec_id
),
k as (
  select project_id, store_id, material_spec_id from ledger
  union select project_id, store_id, material_spec_id from on_order
  union select project_id, store_id, material_spec_id from pending where store_id is not null
),
calc as (
  select k.project_id, k.store_id, st.name as store_name, k.material_spec_id, sp.label, sp.category, sp.uom,
         coalesce(l.available, 0) as available, sp.reorder_level, sp.min_level, sp.lead_time_days, ms.safety_days, ms.pack_size,
         round(coalesce(l.avg_daily, 0), 3) as avg_daily_issue_30d,
         coalesce(p.qty, 0) as pending_mr_qty, coalesce(o.qty, 0) as open_po_qty, o.next_eta,
         greatest(sp.reorder_level, (sp.lead_time_days + ms.safety_days) * coalesce(l.avg_daily, 0))
           + coalesce(p.qty, 0) - coalesce(l.available, 0) - coalesce(o.qty, 0) as shortfall
  from k
  join public.stores st on st.id = k.store_id
  join public.v_specs sp on sp.id = k.material_spec_id
  join public.material_specs ms on ms.id = k.material_spec_id
  left join ledger l on l.store_id = k.store_id and l.material_spec_id = k.material_spec_id
  left join on_order o on o.store_id = k.store_id and o.material_spec_id = k.material_spec_id
  left join pending p on p.store_id = k.store_id and p.material_spec_id = k.material_spec_id
)
select c.project_id, c.store_id, c.store_name, c.material_spec_id, c.label, c.category, c.uom, c.available,
       c.reorder_level, c.min_level, c.lead_time_days, c.safety_days, c.pack_size, c.avg_daily_issue_30d,
       case when c.avg_daily_issue_30d > 0 then round(c.available / c.avg_daily_issue_30d, 1) end as days_cover,
       case when c.avg_daily_issue_30d > 0 then current_date + floor(c.available / c.avg_daily_issue_30d)::int end as stockout_date,
       c.pending_mr_qty, c.open_po_qty, c.next_eta,
       ceil(c.shortfall / c.pack_size) * c.pack_size as suggested_qty,
       (c.avg_daily_issue_30d > 0 and c.available / c.avg_daily_issue_30d < c.lead_time_days) as stockout_before_lead_time
from calc c
where c.shortfall > 0.0005;

-- MR line procurement progress: ordered / received quantities (no prices).
create or replace view public.v_mr_line_procurement with (security_invoker = true) as
select ml.id as mr_line_id, ml.mr_id, ml.project_id, ml.material_spec_id, ml.approved_qty,
       coalesce(sum(pl.qty) filter (where po.status not in ('cancelled','rejected')), 0) as ordered_qty,
       coalesce(sum(pl.qty_accepted), 0) as received_qty,
       exists (select 1 from public.rfq_lines rl join public.rfqs q on q.id = rl.rfq_id
               where rl.mr_line_id = ml.id and rl.deleted_at is null and q.status <> 'cancelled') as on_rfq
from public.mr_lines ml
left join public.po_lines pl on pl.mr_line_id = ml.id and pl.deleted_at is null
left join public.purchase_orders po on po.id = pl.po_id
where ml.deleted_at is null
group by ml.id;

grant select on public.v_po_line_status, public.v_expected_deliveries, public.v_po_status, public.v_quotation_comparison,
  public.v_price_trend, public.v_committed_cost, public.v_cost_control, public.v_reorder_suggestions,
  public.v_mr_line_procurement to authenticated;

-- RPCs are for signed-in users only.
do $$
declare f text;
begin
  foreach f in array array['save_rfq','rfq_action','record_quotation','award_rfq','save_po','po_action','amend_po',
    'update_po_delivery','post_grn','log_market_price','save_budget','create_mr_from_suggestions'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;
