-- =============================================================================
-- PAYMENTS
--   A. Subcontractor interim payment certificates, measured and quantity-verified per BoQ / task line.
--   B. Daily-labour payroll: day-rate work from the attendance register (muster roll) and PIECE-RATE work
--      measured in units — berga (one 12 m reinforcement bar), m2, m3, pcs … — quantity verified on site
--      before payment.
-- Approval chain for both: office engineer prepares → project coordinator checks → manager approves →
-- finance pays (payment voucher). Approval posts actual cost (cost_entries, ex-VAT) for cost control / EVM.
--
-- Rules applied (Ethiopia):
--   * Withholding tax on payments for services of ETB 10,000 or more: 3 % of the ex-VAT amount
--     (Income Tax (Amendment) Proclamation No. 1395/2025, up from 2 %). Rate and threshold are per subcontract.
--   * VAT 15 % on the value of work certified when the subcontractor is VAT-registered (0 % otherwise).
--   * Retention 5 % by default (typical 5–10 %), released at completion / end of defects liability.
--   * Advance payment recovered by a fixed % of each certificate until fully recovered (all of it on the final one).
--   * Daily labour: tax withheld at the payroll's rate (15 % or 30 % — 30 % where the worker has no TIN),
--     overridable per worker; overtime = hours × daily rate / 8 × multiplier (1.25 normal working days).
--   * Rebar: 1 berga = one 12 m bar = 12 × d²/162 kg (Ø6 2.67 · Ø8 4.74 · Ø10 7.41 · Ø12 10.67 · Ø14 14.52 ·
--     Ø16 18.96 · Ø20 29.63 · Ø24 42.67 · Ø25 46.30 · Ø32 75.85 kg) — an alternative unit of every rebar spec.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Finance sees prices (cost control, PO values) like management.
-- ---------------------------------------------------------------------------
update public.app_settings set price_roles = array_append(price_roles, 'finance'::public.app_role)
 where id = 1 and not ('finance'::public.app_role = any (price_roles));
alter table public.app_settings alter column price_roles set default '{coordinator,manager,procurement,admin,finance}';

-- Payment documents are confidential (rates, bank details): payment roles only, independent of price_roles.
create or replace function app.is_payment_role() returns boolean
language sql stable as $$
  select app.has_role_txt('office_engineer', 'coordinator', 'manager', 'finance', 'admin')
$$;
create or replace function app.can_see_payments(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_payment_role() and app.is_member(p_project)
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.subcontractors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  trade           text,
  tin             text,
  vat_registered  boolean not null default false,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  bank_name       text,
  bank_account    text,
  is_active       boolean not null default true,
  created_by      uuid references public.profiles (id) default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.subcontracts (
  id                    uuid primary key,
  project_id            uuid not null references public.projects (id),
  number                text not null unique,
  subcontractor_id      uuid not null references public.subcontractors (id),
  title                 text not null,
  scope                 text,
  start_date            date,
  end_date              date,
  retention_pct         numeric(5,2) not null default 5 check (retention_pct between 0 and 20),
  advance_amount        numeric(18,2) not null default 0 check (advance_amount >= 0),
  advance_recovery_pct  numeric(5,2) not null default 0 check (advance_recovery_pct between 0 and 100),
  vat_pct               numeric(5,2) not null default 0 check (vat_pct in (0, 15)),
  wht_pct               numeric(5,2) not null default 3 check (wht_pct between 0 and 30),
  wht_threshold         numeric(18,2) not null default 10000 check (wht_threshold >= 0),
  status                text not null default 'active' check (status in ('draft','active','completed','terminated')),
  created_by            uuid references public.profiles (id) default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index subcontracts_project_idx on public.subcontracts (project_id);

create table public.subcontract_items (
  id              uuid primary key default gen_random_uuid(),
  subcontract_id  uuid not null references public.subcontracts (id),
  project_id      uuid not null references public.projects (id),
  line_no         int not null,
  boq_item_id     uuid references public.boq_items (id),
  task_id         uuid references public.schedule_tasks (id),
  description     text not null,
  unit            text not null,
  qty             numeric(16,3) not null check (qty >= 0),
  rate            numeric(18,4) not null check (rate >= 0),
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index subcontract_items_sc_idx on public.subcontract_items (subcontract_id);

create table public.sc_certificates (
  id                     uuid primary key,
  project_id             uuid not null references public.projects (id),
  subcontract_id         uuid not null references public.subcontracts (id),
  number                 text not null unique,
  cert_no                int not null,
  period_from            date not null,
  period_to              date not null,
  is_final               boolean not null default false,
  status                 text not null default 'draft'
                           check (status in ('draft','submitted','checked','approved','paid','returned','rejected')),
  gross_to_date          numeric(18,2) not null default 0,
  gross_previous         numeric(18,2) not null default 0,
  gross_this             numeric(18,2) not null default 0,
  retention_pct          numeric(5,2) not null default 0,
  retention_this         numeric(18,2) not null default 0,
  retention_release      numeric(18,2) not null default 0,
  advance_recovery_this  numeric(18,2) not null default 0,
  material_deduction     numeric(18,2) not null default 0 check (material_deduction >= 0),
  penalty                numeric(18,2) not null default 0 check (penalty >= 0),
  other_deduction        numeric(18,2) not null default 0 check (other_deduction >= 0),
  other_deduction_note   text,
  vat_pct                numeric(5,2) not null default 0,
  vat_this               numeric(18,2) not null default 0,
  wht_pct                numeric(5,2) not null default 0,
  wht_this               numeric(18,2) not null default 0,
  net_payable            numeric(18,2) not null default 0,
  remarks                text,
  prepared_by            uuid references public.profiles (id),
  submitted_at           timestamptz,
  checked_by             uuid references public.profiles (id),
  checked_at             timestamptz,
  approved_by            uuid references public.profiles (id),
  approved_at            timestamptz,
  paid_by                uuid references public.profiles (id),
  paid_at                timestamptz,
  payment_method         text check (payment_method in ('bank_transfer','cheque','cash')),
  payment_ref            text,
  payment_date           date,
  return_comment         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (subcontract_id, cert_no),
  check (period_to >= period_from)
);
create index sc_certificates_project_idx on public.sc_certificates (project_id, status);

create table public.sc_certificate_lines (
  id                    uuid primary key default gen_random_uuid(),
  certificate_id        uuid not null references public.sc_certificates (id) on delete cascade,
  project_id            uuid not null references public.projects (id),
  subcontract_item_id   uuid not null references public.subcontract_items (id),
  qty_claimed_to_date   numeric(16,3) not null default 0 check (qty_claimed_to_date >= 0),
  qty_verified_to_date  numeric(16,3) not null default 0 check (qty_verified_to_date >= 0),
  qty_previous          numeric(16,3) not null default 0,
  site_qty_to_date      numeric(16,3),     -- verified site progress on the linked task / BoQ item when prepared
  rate                  numeric(18,4) not null default 0,
  amount_to_date        numeric(18,2) not null default 0,
  amount_previous       numeric(18,2) not null default 0,
  amount_this           numeric(18,2) not null default 0,
  remark                text,
  unique (certificate_id, subcontract_item_id)
);

create table public.labour_workers (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id),
  full_name    text not null,
  trade_id     uuid references public.labour_trades (id),
  trade_name   text,
  daily_rate   numeric(12,2) not null default 0 check (daily_rate >= 0),   -- 0 = piece-rate only
  tin          text,
  tax_pct      numeric(5,2) check (tax_pct between 0 and 35),   -- null = the payroll's rate
  id_no        text,
  phone        text,
  bank_account text,
  is_active    boolean not null default true,
  created_by   uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index labour_workers_project_idx on public.labour_workers (project_id);

create table public.labour_payrolls (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  number          text not null unique,
  period_from     date not null,
  period_to       date not null,
  frequency       text not null default 'weekly' check (frequency in ('weekly','fortnightly','monthly')),
  tax_pct         numeric(5,2) not null default 15 check (tax_pct between 0 and 35),
  ot_multiplier   numeric(4,2) not null default 1.25 check (ot_multiplier between 1 and 3),
  status          text not null default 'draft' check (status in ('draft','submitted','checked','approved','paid','returned','rejected')),
  workers         int not null default 0,
  days            numeric(10,2) not null default 0,
  gross           numeric(18,2) not null default 0,
  tax             numeric(18,2) not null default 0,
  deductions      numeric(18,2) not null default 0,
  net             numeric(18,2) not null default 0,
  remarks         text,
  prepared_by     uuid references public.profiles (id),
  submitted_at    timestamptz,
  checked_by      uuid references public.profiles (id),
  checked_at      timestamptz,
  approved_by     uuid references public.profiles (id),
  approved_at     timestamptz,
  paid_by         uuid references public.profiles (id),
  paid_at         timestamptz,
  payment_method  text check (payment_method in ('bank_transfer','cheque','cash')),
  payment_ref     text,
  payment_date    date,
  return_comment  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (period_to >= period_from and period_to - period_from <= 31)
);
create index labour_payrolls_project_idx on public.labour_payrolls (project_id, status);

create table public.labour_attendance (
  id          uuid primary key default gen_random_uuid(),
  payroll_id  uuid not null references public.labour_payrolls (id) on delete cascade,
  project_id  uuid not null references public.projects (id),
  worker_id   uuid not null references public.labour_workers (id),
  work_date   date not null,
  day_value   numeric(3,2) not null check (day_value in (0, 0.5, 1)),
  ot_hours    numeric(4,1) not null default 0 check (ot_hours between 0 and 12),
  task_id     uuid references public.schedule_tasks (id),
  unique (payroll_id, worker_id, work_date)
);
create index labour_attendance_worker_idx on public.labour_attendance (worker_id, work_date);

-- Piece-rate work (by unit of output), paid to a worker or crew leader once the quantity is verified.
create table public.labour_piecework (
  id                uuid primary key default gen_random_uuid(),
  payroll_id        uuid not null references public.labour_payrolls (id) on delete cascade,
  project_id        uuid not null references public.projects (id),
  worker_id         uuid not null references public.labour_workers (id),
  work_date         date not null,
  description       text not null,
  unit              text not null,                                   -- berga, m2, m3, pcs, kg …
  qty_claimed       numeric(14,3) not null check (qty_claimed >= 0),
  qty_verified      numeric(14,3) check (qty_verified >= 0),         -- null = not yet verified
  rate              numeric(12,2) not null check (rate >= 0),
  amount            numeric(18,2) not null default 0,                -- verified qty × rate
  task_id           uuid references public.schedule_tasks (id),
  element_id        uuid references public.elements (id),
  boq_item_id       uuid references public.boq_items (id),
  material_spec_id  uuid references public.material_specs (id),      -- e.g. rebar Ø16 when the unit is berga
  kg_equivalent     numeric(14,3),                                   -- verified berga × kg per 12 m bar
  verified_by       uuid references public.profiles (id),
  verified_at       timestamptz,
  remark            text
);
create index labour_piecework_payroll_idx on public.labour_piecework (payroll_id);

create table public.labour_payroll_lines (
  id               uuid primary key default gen_random_uuid(),
  payroll_id       uuid not null references public.labour_payrolls (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  worker_id        uuid not null references public.labour_workers (id),
  days             numeric(6,2) not null default 0,
  ot_hours         numeric(6,1) not null default 0,
  daily_rate       numeric(12,2) not null,
  ot_amount        numeric(18,2) not null default 0,
  piece_amount     numeric(18,2) not null default 0,
  gross            numeric(18,2) not null default 0,
  tax_pct          numeric(5,2) not null default 0,
  tax              numeric(18,2) not null default 0,
  other_deduction  numeric(18,2) not null default 0 check (other_deduction >= 0),
  deduction_note   text,
  net              numeric(18,2) not null default 0,
  unique (payroll_id, worker_id)
);

-- Who did what to a payment document (insert-only).
create table public.payment_events (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id),
  doc_type     text not null check (doc_type in ('sc_certificate','payroll')),
  doc_id       uuid not null,
  action       text not null,
  from_status  text,
  to_status    text,
  actor        uuid references public.profiles (id) default auth.uid(),
  comment      text,
  created_at   timestamptz not null default now()
);
create index payment_events_doc_idx on public.payment_events (doc_id, created_at);

do $$
declare t text;
begin
  foreach t in array array['subcontractors','subcontracts','subcontract_items','sc_certificates','labour_workers','labour_payrolls'] loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
  end loop;
  foreach t in array array['subcontractors','subcontracts','subcontract_items','sc_certificates','sc_certificate_lines',
                           'labour_workers','labour_payrolls','labour_attendance','labour_piecework','labour_payroll_lines','payment_events'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['subcontracts','subcontract_items','sc_certificates','sc_certificate_lines',
                           'labour_workers','labour_payrolls','labour_attendance','labour_piecework','labour_payroll_lines','payment_events'] loop
    execute format('create policy payment_read on public.%I for select to authenticated using (app.can_see_payments(project_id))', t);
  end loop;
end $$;
create policy payment_read on public.subcontractors for select to authenticated using (app.is_payment_role());
-- Site engineers verify piece-work quantities on site: they read the payroll header, workers and piece-work lines
-- (not the pay lines, certificates or bank details of subcontractors).
create policy site_verify_read on public.labour_payrolls for select to authenticated
  using (app.has_role_txt('site_engineer') and app.is_member(project_id));
create policy site_verify_read on public.labour_piecework for select to authenticated
  using (app.has_role_txt('site_engineer') and app.is_member(project_id));
create policy site_verify_read on public.labour_workers for select to authenticated
  using (app.has_role_txt('site_engineer') and app.is_member(project_id));
create trigger immutable before update or delete on public.payment_events for each row execute function app.block_mutation();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- <PRJ>-<TYPE>-0001 per project (server-side: payment documents are created online).
create or replace function app.pay_next_no(p_project uuid, p_type text, p_table text) returns text
language plpgsql security definer set search_path = public as $$
declare v_code text; v_n int;
begin
  select code into v_code from public.projects where id = p_project;
  perform pg_advisory_xact_lock(hashtext('pay:' || p_project::text || ':' || p_type));
  execute format('select coalesce(max(nullif(substring(number from ''-(\d+)$''), '''')::int), 0) from public.%I where project_id = $1 and number like $2', p_table)
    into v_n using p_project, v_code || '-' || p_type || '-%';
  return v_code || '-' || p_type || '-' || lpad((v_n + 1)::text, 4, '0');
end $$;

create or replace function app.pay_event(p_project uuid, p_type text, p_doc uuid, p_action text, p_from text, p_to text, p_comment text)
returns void language sql security definer set search_path = public as $$
  insert into public.payment_events (project_id, doc_type, doc_id, action, from_status, to_status, comment)
  values (p_project, p_type, p_doc, p_action, p_from, p_to, nullif(trim(p_comment), ''))
$$;

-- Actual cost line (rolls past a closed EVM cut-off like record_actual_cost).
create or replace function app.pay_cost(p_project uuid, p_number text, p_date date, p_category text, p_task uuid, p_boq uuid,
  p_description text, p_subcontractor text, p_qty numeric, p_uom text, p_rate numeric, p_amount numeric, p_source text, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
declare v_cut date := app.closed_cutoff(p_project); v_date date := least(p_date, app.eat_date(now())); v_orig date; v_period uuid;
begin
  if coalesce(p_amount, 0) = 0 then return; end if;
  if v_cut is not null and v_date <= v_cut then
    v_orig := v_date; v_period := app.closed_period_for(p_project, v_date); v_date := v_cut + 1;
  end if;
  insert into public.cost_entries (id, project_id, number, entry_date, original_entry_date, relates_to_period_id, category, task_id,
    boq_item_id, description, subcontractor, qty, uom, rate, amount, source, source_ref)
  values (gen_random_uuid(), p_project, p_number, v_date, v_orig, v_period, p_category, p_task, p_boq, p_description,
    p_subcontractor, p_qty, p_uom, p_rate, round(p_amount, 2), p_source, p_ref);
end $$;

revoke execute on function app.pay_next_no(uuid, text, text) from public;
revoke execute on function app.pay_event(uuid, text, uuid, text, text, text, text) from public;
revoke execute on function app.pay_cost(uuid, text, date, text, uuid, uuid, text, text, numeric, text, numeric, numeric, text, text) from public;

-- ---------------------------------------------------------------------------
-- Subcontractors & subcontracts
-- ---------------------------------------------------------------------------
create or replace function public.save_subcontractor(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_role_txt('office_engineer', 'coordinator', 'manager', 'finance', 'admin');
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Subcontractor name is required'; end if;
  if nullif(trim(p ->> 'tin'), '') is not null and trim(p ->> 'tin') !~ '^[0-9]{10}$' then
    raise exception 'TIN must be 10 digits';
  end if;
  insert into public.subcontractors (id, name, trade, tin, vat_registered, contact_person, phone, email, address, bank_name, bank_account, is_active)
  values (v_id, trim(p ->> 'name'), nullif(trim(p ->> 'trade'), ''), nullif(trim(p ->> 'tin'), ''), coalesce((p ->> 'vat_registered')::boolean, false),
    nullif(trim(p ->> 'contact_person'), ''), nullif(trim(p ->> 'phone'), ''), nullif(trim(p ->> 'email'), ''), nullif(trim(p ->> 'address'), ''),
    nullif(trim(p ->> 'bank_name'), ''), nullif(trim(p ->> 'bank_account'), ''), coalesce((p ->> 'is_active')::boolean, true))
  on conflict (id) do update set name = excluded.name, trade = excluded.trade, tin = excluded.tin, vat_registered = excluded.vat_registered,
    contact_person = excluded.contact_person, phone = excluded.phone, email = excluded.email, address = excluded.address,
    bank_name = excluded.bank_name, bank_account = excluded.bank_account, is_active = excluded.is_active;
  return app.op_done(p, 'save_subcontractor', jsonb_build_object('ok', true, 'id', v_id));
exception when unique_violation then
  raise exception 'A subcontractor named "%" already exists', trim(p ->> 'name');
end $$;

create or replace function public.save_subcontract(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  s public.subcontracts;
  sub public.subcontractors;
  it jsonb; v_line int := 0; v_item uuid; v_keep uuid[] := '{}'; v_number text;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'Subcontract id is required'; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('office_engineer', 'coordinator', 'manager', 'admin');
  select * into sub from public.subcontractors where id = (p ->> 'subcontractor_id')::uuid and is_active;
  if not found then raise exception 'Choose an active subcontractor'; end if;
  if coalesce(trim(p ->> 'title'), '') = '' then raise exception 'Subcontract title is required'; end if;
  select * into s from public.subcontracts where id = v_id for update;
  if found and s.project_id <> v_project then raise exception 'Subcontract belongs to another project'; end if;
  if not found then
    v_number := app.pay_next_no(v_project, 'SUB', 'subcontracts');
    insert into public.subcontracts (id, project_id, number, subcontractor_id, title) values (v_id, v_project, v_number, sub.id, trim(p ->> 'title'));
  end if;
  update public.subcontracts set subcontractor_id = sub.id, title = trim(p ->> 'title'), scope = nullif(trim(p ->> 'scope'), ''),
    start_date = (p ->> 'start_date')::date, end_date = (p ->> 'end_date')::date,
    retention_pct = coalesce((p ->> 'retention_pct')::numeric, retention_pct),
    advance_amount = coalesce((p ->> 'advance_amount')::numeric, advance_amount),
    advance_recovery_pct = coalesce((p ->> 'advance_recovery_pct')::numeric, advance_recovery_pct),
    vat_pct = coalesce((p ->> 'vat_pct')::numeric, case when sub.vat_registered then 15 else 0 end),
    wht_pct = coalesce((p ->> 'wht_pct')::numeric, wht_pct),
    wht_threshold = coalesce((p ->> 'wht_threshold')::numeric, wht_threshold),
    status = coalesce(nullif(p ->> 'status', ''), status)
  where id = v_id;

  if p ? 'items' then
    for it in select x from jsonb_array_elements(p -> 'items') x loop
      v_line := v_line + 1;
      if coalesce(trim(it ->> 'description'), '') = '' or coalesce(trim(it ->> 'unit'), '') = '' then
        raise exception 'Line %: description and unit are required', v_line;
      end if;
      if (it ->> 'qty')::numeric is null or (it ->> 'qty')::numeric < 0 or (it ->> 'rate')::numeric is null or (it ->> 'rate')::numeric < 0 then
        raise exception 'Line %: quantity and rate must be zero or more', v_line;
      end if;
      if (it ->> 'boq_item_id') is not null and not exists (select 1 from public.boq_items where id = (it ->> 'boq_item_id')::uuid and project_id = v_project) then
        raise exception 'Line %: BoQ item not in this project', v_line;
      end if;
      if (it ->> 'task_id') is not null and not exists (select 1 from public.schedule_tasks where id = (it ->> 'task_id')::uuid and project_id = v_project) then
        raise exception 'Line %: task not in this project', v_line;
      end if;
      v_item := coalesce((it ->> 'id')::uuid, gen_random_uuid());
      -- a certified rate is contractual: it can't change once a certificate has been approved on it
      if exists (select 1 from public.subcontract_items si join public.sc_certificate_lines cl on cl.subcontract_item_id = si.id
                 join public.sc_certificates c on c.id = cl.certificate_id
                 where si.id = v_item and c.status in ('approved','paid') and si.rate <> (it ->> 'rate')::numeric) then
        raise exception 'Line %: the rate has been certified and cannot change (add a new line for a variation)', v_line;
      end if;
      insert into public.subcontract_items (id, subcontract_id, project_id, line_no, boq_item_id, task_id, description, unit, qty, rate)
      values (v_item, v_id, v_project, v_line, (it ->> 'boq_item_id')::uuid, (it ->> 'task_id')::uuid, trim(it ->> 'description'),
        trim(it ->> 'unit'), (it ->> 'qty')::numeric, (it ->> 'rate')::numeric)
      on conflict (id) do update set line_no = excluded.line_no, boq_item_id = excluded.boq_item_id, task_id = excluded.task_id,
        description = excluded.description, unit = excluded.unit, qty = excluded.qty, rate = excluded.rate, deleted_at = null
      where subcontract_items.subcontract_id = v_id;
      v_keep := v_keep || v_item;
    end loop;
    if exists (select 1 from public.subcontract_items si where si.subcontract_id = v_id and si.deleted_at is null and not (si.id = any (v_keep))
               and exists (select 1 from public.sc_certificate_lines cl join public.sc_certificates c on c.id = cl.certificate_id
                           where cl.subcontract_item_id = si.id and c.status <> 'rejected')) then
      raise exception 'A line that is on a payment certificate cannot be removed';
    end if;
    update public.subcontract_items set deleted_at = now() where subcontract_id = v_id and deleted_at is null and not (id = any (v_keep));
  end if;
  return app.op_done(p, 'save_subcontract', jsonb_build_object('ok', true, 'id', v_id,
    'number', (select number from public.subcontracts where id = v_id)));
end $$;

-- ---------------------------------------------------------------------------
-- Payment certificates
-- ---------------------------------------------------------------------------
create or replace function app.sc_recalc(p_cert uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.sc_certificates; s public.subcontracts;
  v_to numeric; v_prev numeric; v_this numeric; v_ret numeric; v_adv_left numeric; v_adv numeric; v_vat numeric; v_wht numeric; v_rel numeric;
begin
  select * into c from public.sc_certificates where id = p_cert;
  select * into s from public.subcontracts where id = c.subcontract_id;
  update public.sc_certificate_lines l set
    rate = si.rate,
    amount_to_date = round(l.qty_verified_to_date * si.rate, 2),
    amount_previous = round(l.qty_previous * si.rate, 2),
    amount_this = round(l.qty_verified_to_date * si.rate, 2) - round(l.qty_previous * si.rate, 2)
  from public.subcontract_items si where si.id = l.subcontract_item_id and l.certificate_id = p_cert;
  select coalesce(sum(amount_to_date), 0), coalesce(sum(amount_previous), 0) into v_to, v_prev
    from public.sc_certificate_lines where certificate_id = p_cert;
  v_this := v_to - v_prev;
  v_ret := round(v_this * s.retention_pct / 100, 2);
  v_adv_left := s.advance_amount - coalesce((select sum(advance_recovery_this) from public.sc_certificates
                 where subcontract_id = s.id and id <> p_cert and status in ('approved','paid')), 0);
  v_adv := case when c.is_final then greatest(v_adv_left, 0)
                else least(greatest(v_adv_left, 0), greatest(round(v_this * s.advance_recovery_pct / 100, 2), 0)) end;
  -- final certificate releases all retention held so far (incl. this one); otherwise the entered (partial) release
  v_rel := case when c.is_final then coalesce((select sum(retention_this - retention_release) from public.sc_certificates
                 where subcontract_id = s.id and id <> p_cert and status in ('approved','paid')), 0) + v_ret
                else least(c.retention_release, greatest(coalesce((select sum(retention_this - retention_release) from public.sc_certificates
                 where subcontract_id = s.id and id <> p_cert and status in ('approved','paid')), 0), 0)) end;
  v_vat := round(greatest(v_this, 0) * s.vat_pct / 100, 2);
  v_wht := case when v_this >= s.wht_threshold then round(v_this * s.wht_pct / 100, 2) else 0 end;
  update public.sc_certificates set
    gross_to_date = v_to, gross_previous = v_prev, gross_this = v_this,
    retention_pct = s.retention_pct, retention_this = v_ret, retention_release = v_rel, advance_recovery_this = v_adv,
    vat_pct = s.vat_pct, vat_this = v_vat, wht_pct = case when v_this >= s.wht_threshold then s.wht_pct else 0 end, wht_this = v_wht,
    net_payable = v_this + v_vat - v_ret + v_rel - v_adv - material_deduction - penalty - other_deduction - v_wht
  where id = p_cert;
end $$;
revoke execute on function app.sc_recalc(uuid) from public;

create or replace function public.save_sc_certificate(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  s public.subcontracts; c public.sc_certificates;
  v_prev_cert uuid; ln jsonb; si public.subcontract_items; v_prev numeric; v_site numeric; v_number text; v_no int;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'Certificate id is required'; end if;
  select * into c from public.sc_certificates where id = v_id for update;
  select * into s from public.subcontracts where id = coalesce(c.subcontract_id, (p ->> 'subcontract_id')::uuid);
  if s.id is null then raise exception 'Subcontract not found'; end if;
  perform app.require_member(s.project_id);
  perform app.require_role_txt('office_engineer', 'coordinator', 'admin');
  if c.id is not null and c.status not in ('draft', 'returned') then
    raise exception 'Certificate % is % — only drafts and returned certificates can be edited', c.number, c.status;
  end if;
  if (p ->> 'period_from') is null or (p ->> 'period_to') is null then raise exception 'Enter the measurement period'; end if;
  if (p ->> 'period_to')::date > app.eat_date(now()) then raise exception 'The period cannot end in the future'; end if;
  if c.id is null then
    if s.status <> 'active' then raise exception 'Subcontract % is %', s.number, s.status; end if;
    if exists (select 1 from public.sc_certificates where subcontract_id = s.id and status in ('draft','submitted','checked','returned')) then
      raise exception 'Subcontract % already has a certificate in progress — finish it first', s.number;
    end if;
    select coalesce(max(cert_no), 0) + 1 into v_no from public.sc_certificates where subcontract_id = s.id;
    v_number := s.number || '-IPC' || lpad(v_no::text, 2, '0');
    insert into public.sc_certificates (id, project_id, subcontract_id, number, cert_no, period_from, period_to, prepared_by)
    values (v_id, s.project_id, s.id, v_number, v_no, (p ->> 'period_from')::date, (p ->> 'period_to')::date, auth.uid())
    returning * into c;
  end if;
  if (p ->> 'period_from')::date <= coalesce((select max(period_to) from public.sc_certificates where subcontract_id = s.id
       and id <> v_id and status in ('approved','paid')), '1900-01-01'::date) then
    raise exception 'The period must start after the last approved certificate''s period';
  end if;
  update public.sc_certificates set period_from = (p ->> 'period_from')::date, period_to = (p ->> 'period_to')::date,
    is_final = coalesce((p ->> 'is_final')::boolean, false), retention_release = coalesce((p ->> 'retention_release')::numeric, 0),
    material_deduction = coalesce((p ->> 'material_deduction')::numeric, 0), penalty = coalesce((p ->> 'penalty')::numeric, 0),
    other_deduction = coalesce((p ->> 'other_deduction')::numeric, 0), other_deduction_note = nullif(trim(p ->> 'other_deduction_note'), ''),
    remarks = nullif(trim(p ->> 'remarks'), ''), prepared_by = coalesce(prepared_by, auth.uid())
  where id = v_id;

  -- previous = verified to date on the last approved / paid certificate of this subcontract
  select id into v_prev_cert from public.sc_certificates where subcontract_id = s.id and id <> v_id and status in ('approved','paid')
   order by cert_no desc limit 1;
  delete from public.sc_certificate_lines where certificate_id = v_id;
  for si in select * from public.subcontract_items where subcontract_id = s.id and deleted_at is null order by line_no loop
    ln := (select x from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x where (x ->> 'subcontract_item_id')::uuid = si.id limit 1);
    v_prev := coalesce((select qty_verified_to_date from public.sc_certificate_lines where certificate_id = v_prev_cert and subcontract_item_id = si.id), 0);
    -- site reference: verified progress on the linked BoQ item (task share) or the task's verified %
    v_site := coalesce(
      (select sum(l.verified_qty) from public.task_boq_links l where l.boq_item_id = si.boq_item_id and l.deleted_at is null
         and (si.task_id is null or l.task_id = si.task_id)),
      (select round(si.qty * t.pct_complete / 100, 3) from public.schedule_tasks t where t.id = si.task_id));
    if ln is null then
      insert into public.sc_certificate_lines (certificate_id, project_id, subcontract_item_id, qty_claimed_to_date, qty_verified_to_date, qty_previous, site_qty_to_date)
      values (v_id, s.project_id, si.id, v_prev, v_prev, v_prev, v_site);
      continue;
    end if;
    if coalesce((ln ->> 'qty_verified_to_date')::numeric, 0) > coalesce((ln ->> 'qty_claimed_to_date')::numeric, 0) then
      raise exception 'Line %: verified quantity is more than claimed', si.line_no;
    end if;
    if coalesce((ln ->> 'qty_verified_to_date')::numeric, 0) < v_prev and nullif(trim(ln ->> 'remark'), '') is null then
      raise exception 'Line %: verified quantity is below the previous certificate (%) — add a remark (re-measurement)', si.line_no, v_prev;
    end if;
    if coalesce((ln ->> 'qty_verified_to_date')::numeric, 0) > si.qty and nullif(trim(ln ->> 'remark'), '') is null then
      raise exception 'Line %: verified quantity is more than the contract quantity (%) — add a remark (variation / re-measurement)', si.line_no, si.qty;
    end if;
    insert into public.sc_certificate_lines (certificate_id, project_id, subcontract_item_id, qty_claimed_to_date, qty_verified_to_date, qty_previous, site_qty_to_date, remark)
    values (v_id, s.project_id, si.id, coalesce((ln ->> 'qty_claimed_to_date')::numeric, 0), coalesce((ln ->> 'qty_verified_to_date')::numeric, 0),
      v_prev, v_site, nullif(trim(ln ->> 'remark'), ''));
  end loop;
  perform app.sc_recalc(v_id);
  if c.status = 'draft' and not exists (select 1 from public.payment_events where doc_id = v_id) then
    perform app.pay_event(s.project_id, 'sc_certificate', v_id, 'prepare', null, 'draft', null);
  end if;
  select * into c from public.sc_certificates where id = v_id;
  return app.op_done(p, 'save_sc_certificate', jsonb_build_object('ok', true, 'id', v_id, 'number', c.number, 'status', c.status,
    'gross_this', c.gross_this, 'net_payable', c.net_payable));
end $$;

-- ---------------------------------------------------------------------------
-- Labour workers & payroll
-- ---------------------------------------------------------------------------
create or replace function public.save_labour_worker(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('office_engineer', 'coordinator', 'manager', 'admin');
  if coalesce(trim(p ->> 'full_name'), '') = '' then raise exception 'Worker name is required'; end if;
  if (p ->> 'daily_rate')::numeric is null or (p ->> 'daily_rate')::numeric < 0 then
    raise exception 'Enter the daily rate (0 for piece-rate only workers)';
  end if;
  if exists (select 1 from public.labour_workers where id = v_id and project_id <> v_project) then raise exception 'Worker belongs to another project'; end if;
  insert into public.labour_workers (id, project_id, full_name, trade_id, trade_name, daily_rate, tin, tax_pct, id_no, phone, bank_account, is_active)
  values (v_id, v_project, trim(p ->> 'full_name'), (p ->> 'trade_id')::uuid, nullif(trim(p ->> 'trade_name'), ''), (p ->> 'daily_rate')::numeric,
    nullif(trim(p ->> 'tin'), ''), (p ->> 'tax_pct')::numeric, nullif(trim(p ->> 'id_no'), ''), nullif(trim(p ->> 'phone'), ''),
    nullif(trim(p ->> 'bank_account'), ''), coalesce((p ->> 'is_active')::boolean, true))
  on conflict (id) do update set full_name = excluded.full_name, trade_id = excluded.trade_id, trade_name = excluded.trade_name,
    daily_rate = excluded.daily_rate, tin = excluded.tin, tax_pct = excluded.tax_pct, id_no = excluded.id_no, phone = excluded.phone,
    bank_account = excluded.bank_account, is_active = excluded.is_active;
  return app.op_done(p, 'save_labour_worker', jsonb_build_object('ok', true, 'id', v_id));
end $$;

create or replace function app.payroll_recalc(p_payroll uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pr public.labour_payrolls; v_ded jsonb;
begin
  select * into pr from public.labour_payrolls where id = p_payroll;
  update public.labour_piecework pw set amount = round(coalesce(pw.qty_verified, 0) * pw.rate, 2),
    kg_equivalent = case when lower(pw.unit) = 'berga' and pw.qty_verified is not null then
      round(pw.qty_verified * (select c.factor from public.spec_conversions c where c.material_spec_id = pw.material_spec_id
                                 and lower(c.alt_uom) = 'berga' and c.deleted_at is null), 3) end
  where pw.payroll_id = p_payroll;
  -- keep entered deductions, rebuild the rest from attendance + verified piece-work
  select coalesce(jsonb_object_agg(worker_id::text, jsonb_build_object('d', other_deduction, 'n', deduction_note)), '{}'::jsonb)
    into v_ded from public.labour_payroll_lines where payroll_id = p_payroll;
  delete from public.labour_payroll_lines where payroll_id = p_payroll;
  insert into public.labour_payroll_lines (payroll_id, project_id, worker_id, days, ot_hours, daily_rate, ot_amount, piece_amount, gross,
    tax_pct, tax, other_deduction, deduction_note, net)
  select p_payroll, pr.project_id, w.id, coalesce(a.days, 0), coalesce(a.ot, 0), w.daily_rate, g.ot_amt, coalesce(pw.amt, 0), g.gross, g.tax_pct, t.tax,
         coalesce((v_ded -> w.id::text ->> 'd')::numeric, 0), v_ded -> w.id::text ->> 'n',
         g.gross - t.tax - coalesce((v_ded -> w.id::text ->> 'd')::numeric, 0)
  from (select worker_id from public.labour_attendance where payroll_id = p_payroll
        union select worker_id from public.labour_piecework where payroll_id = p_payroll) ws
  join public.labour_workers w on w.id = ws.worker_id
  left join (select worker_id, sum(day_value) as days, sum(ot_hours) as ot from public.labour_attendance
              where payroll_id = p_payroll group by worker_id) a on a.worker_id = w.id
  left join (select worker_id, sum(amount) as amt from public.labour_piecework where payroll_id = p_payroll group by worker_id) pw on pw.worker_id = w.id
  cross join lateral (select round(coalesce(a.ot, 0) * w.daily_rate / 8 * pr.ot_multiplier, 2) as ot_amt) o
  cross join lateral (select o.ot_amt, round(coalesce(a.days, 0) * w.daily_rate, 2) + o.ot_amt + coalesce(pw.amt, 0) as gross,
                             coalesce(w.tax_pct, pr.tax_pct) as tax_pct) g
  cross join lateral (select round(g.gross * g.tax_pct / 100, 2) as tax) t;
  if exists (select 1 from public.labour_payroll_lines where payroll_id = p_payroll and net < 0) then
    raise exception 'Deductions are more than a worker''s pay after tax';
  end if;
  update public.labour_payrolls set
    workers = (select count(*) from public.labour_payroll_lines where payroll_id = p_payroll),
    days = coalesce((select sum(days) from public.labour_payroll_lines where payroll_id = p_payroll), 0),
    gross = coalesce((select sum(gross) from public.labour_payroll_lines where payroll_id = p_payroll), 0),
    tax = coalesce((select sum(tax) from public.labour_payroll_lines where payroll_id = p_payroll), 0),
    deductions = coalesce((select sum(other_deduction) from public.labour_payroll_lines where payroll_id = p_payroll), 0),
    net = coalesce((select sum(net) from public.labour_payroll_lines where payroll_id = p_payroll), 0)
  where id = p_payroll;
end $$;
revoke execute on function app.payroll_recalc(uuid) from public;

create or replace function public.save_payroll(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := (p ->> 'id')::uuid;
  v_project uuid := (p ->> 'project_id')::uuid;
  pr public.labour_payrolls;
  v_from date := (p ->> 'period_from')::date; v_to date := (p ->> 'period_to')::date;
  a jsonb; v_clash text; v_keep jsonb; v_pid uuid;
begin
  if v_seen is not null then return v_seen; end if;
  if v_id is null then raise exception 'Payroll id is required'; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('office_engineer', 'coordinator', 'admin');
  if v_from is null or v_to is null or v_to < v_from then raise exception 'Enter a valid payroll period'; end if;
  if v_to - v_from > 31 then raise exception 'A payroll period is at most one month'; end if;
  if v_to > app.eat_date(now()) then raise exception 'The payroll period cannot end in the future'; end if;
  if coalesce((p ->> 'tax_pct')::numeric, 15) not between 0 and 35 then raise exception 'Tax rate must be between 0 and 35 %%'; end if;
  select * into pr from public.labour_payrolls where id = v_id for update;
  if found and pr.project_id <> v_project then raise exception 'Payroll belongs to another project'; end if;
  if found and pr.status not in ('draft','returned') then raise exception 'Payroll % is % and cannot be edited', pr.number, pr.status; end if;
  if not found then
    insert into public.labour_payrolls (id, project_id, number, period_from, period_to, prepared_by)
    values (v_id, v_project, app.pay_next_no(v_project, 'PAY', 'labour_payrolls'), v_from, v_to, auth.uid());
    perform app.pay_event(v_project, 'payroll', v_id, 'prepare', null, 'draft', null);
  end if;
  update public.labour_payrolls set period_from = v_from, period_to = v_to,
    frequency = coalesce(nullif(p ->> 'frequency', ''), frequency), tax_pct = coalesce((p ->> 'tax_pct')::numeric, tax_pct),
    ot_multiplier = coalesce((p ->> 'ot_multiplier')::numeric, ot_multiplier), remarks = nullif(trim(p ->> 'remarks'), '')
  where id = v_id;

  if p ? 'attendance' then
    delete from public.labour_attendance where payroll_id = v_id;
    for a in select x from jsonb_array_elements(p -> 'attendance') x loop
      if coalesce((a ->> 'day_value')::numeric, 0) = 0 and coalesce((a ->> 'ot_hours')::numeric, 0) = 0 then continue; end if;
      if (a ->> 'work_date')::date not between v_from and v_to then
        raise exception 'Attendance on % is outside the payroll period', a ->> 'work_date';
      end if;
      if not exists (select 1 from public.labour_workers where id = (a ->> 'worker_id')::uuid and project_id = v_project) then
        raise exception 'Worker not registered on this project';
      end if;
      if (a ->> 'task_id') is not null and not exists (select 1 from public.schedule_tasks where id = (a ->> 'task_id')::uuid and project_id = v_project) then
        raise exception 'Task not in this project';
      end if;
      insert into public.labour_attendance (payroll_id, project_id, worker_id, work_date, day_value, ot_hours, task_id)
      values (v_id, v_project, (a ->> 'worker_id')::uuid, (a ->> 'work_date')::date, coalesce((a ->> 'day_value')::numeric, 0),
        coalesce((a ->> 'ot_hours')::numeric, 0), (a ->> 'task_id')::uuid);
    end loop;
    -- a worker is paid once per day: no overlap with another live payroll
    select w.full_name || ' on ' || to_char(x.work_date, 'DD Mon') || ' (' || o.number || ')' into v_clash
      from public.labour_attendance x join public.labour_attendance y on y.worker_id = x.worker_id and y.work_date = x.work_date and y.payroll_id <> x.payroll_id
      join public.labour_payrolls o on o.id = y.payroll_id and o.status <> 'rejected'
      join public.labour_workers w on w.id = x.worker_id
     where x.payroll_id = v_id limit 1;
    if v_clash is not null then raise exception 'Already on another payroll: %', v_clash; end if;
  end if;

  if p ? 'piecework' then
    -- verification survives a re-save when the line's quantity and rate are unchanged
    select coalesce(jsonb_object_agg(id::text, jsonb_build_object('c', qty_claimed, 'r', rate, 'v', qty_verified, 'by', verified_by, 'at', verified_at)), '{}'::jsonb)
      into v_keep from public.labour_piecework where payroll_id = v_id;
    delete from public.labour_piecework where payroll_id = v_id;
    for a in select x from jsonb_array_elements(p -> 'piecework') x loop
      v_pid := coalesce((a ->> 'id')::uuid, gen_random_uuid());
      if (a ->> 'work_date')::date is null or (a ->> 'work_date')::date not between v_from and v_to then
        raise exception 'Piece-work on % is outside the payroll period', coalesce(a ->> 'work_date', '(no date)');
      end if;
      if not exists (select 1 from public.labour_workers where id = (a ->> 'worker_id')::uuid and project_id = v_project) then
        raise exception 'Worker not registered on this project';
      end if;
      if coalesce(trim(a ->> 'description'), '') = '' or coalesce(trim(a ->> 'unit'), '') = '' then
        raise exception 'Piece-work needs a description and a unit (e.g. berga, m2)';
      end if;
      if coalesce((a ->> 'qty_claimed')::numeric, -1) < 0 or coalesce((a ->> 'rate')::numeric, -1) < 0 then
        raise exception 'Piece-work quantity and rate must be zero or more';
      end if;
      if lower(trim(a ->> 'unit')) = 'berga' and (a ->> 'material_spec_id') is null then
        raise exception 'Choose the bar diameter (rebar spec) for work measured in berga';
      end if;
      if (a ->> 'task_id') is not null and not exists (select 1 from public.schedule_tasks where id = (a ->> 'task_id')::uuid and project_id = v_project) then
        raise exception 'Task not in this project';
      end if;
      if (a ->> 'element_id') is not null and not exists (select 1 from public.elements where id = (a ->> 'element_id')::uuid and project_id = v_project) then
        raise exception 'Element not in this project';
      end if;
      if (a ->> 'boq_item_id') is not null and not exists (select 1 from public.boq_items where id = (a ->> 'boq_item_id')::uuid and project_id = v_project) then
        raise exception 'BoQ item not in this project';
      end if;
      insert into public.labour_piecework (id, payroll_id, project_id, worker_id, work_date, description, unit, qty_claimed, rate,
        task_id, element_id, boq_item_id, material_spec_id, remark, qty_verified, verified_by, verified_at)
      select v_pid, v_id, v_project, (a ->> 'worker_id')::uuid, (a ->> 'work_date')::date, trim(a ->> 'description'), trim(a ->> 'unit'),
        (a ->> 'qty_claimed')::numeric, (a ->> 'rate')::numeric, (a ->> 'task_id')::uuid, (a ->> 'element_id')::uuid, (a ->> 'boq_item_id')::uuid,
        (a ->> 'material_spec_id')::uuid, nullif(trim(a ->> 'remark'), ''),
        case when k.c = (a ->> 'qty_claimed')::numeric and k.r = (a ->> 'rate')::numeric then k.v end,
        case when k.c = (a ->> 'qty_claimed')::numeric and k.r = (a ->> 'rate')::numeric then k.vb end,
        case when k.c = (a ->> 'qty_claimed')::numeric and k.r = (a ->> 'rate')::numeric then k.va end
      from (select (v_keep -> v_pid::text ->> 'c')::numeric as c, (v_keep -> v_pid::text ->> 'r')::numeric as r,
                   (v_keep -> v_pid::text ->> 'v')::numeric as v, (v_keep -> v_pid::text ->> 'by')::uuid as vb,
                   (v_keep -> v_pid::text ->> 'at')::timestamptz as va) k;
    end loop;
  end if;

  perform app.payroll_recalc(v_id);
  if p ? 'deductions' then
    update public.labour_payroll_lines l set other_deduction = coalesce((d ->> 'other_deduction')::numeric, 0),
      deduction_note = nullif(trim(d ->> 'deduction_note'), '')
    from jsonb_array_elements(p -> 'deductions') d where l.payroll_id = v_id and l.worker_id = (d ->> 'worker_id')::uuid;
    perform app.payroll_recalc(v_id);
  end if;
  select * into pr from public.labour_payrolls where id = v_id;
  return app.op_done(p, 'save_payroll', jsonb_build_object('ok', true, 'id', v_id, 'number', pr.number, 'status', pr.status,
    'workers', pr.workers, 'gross', pr.gross, 'tax', pr.tax, 'net', pr.net));
end $$;

-- Site / office engineer verifies the piece-work quantities measured on site before the payroll goes for checking.
create or replace function public.verify_piecework(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); pr public.labour_payrolls; ln jsonb; w public.labour_piecework; n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pr from public.labour_payrolls where id = (p ->> 'payroll_id')::uuid for update;
  if not found then raise exception 'Payroll not found'; end if;
  perform app.require_member(pr.project_id);
  perform app.require_role_txt('site_engineer', 'office_engineer', 'coordinator', 'admin');
  if pr.status not in ('draft','returned') then raise exception 'Payroll % is % — quantities are verified before it is submitted', pr.number, pr.status; end if;
  for ln in select x from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x loop
    select * into w from public.labour_piecework where id = (ln ->> 'id')::uuid and payroll_id = pr.id;
    if not found then raise exception 'Piece-work line not on payroll %', pr.number; end if;
    if (ln ->> 'qty_verified')::numeric is null or (ln ->> 'qty_verified')::numeric < 0 then raise exception 'Enter the verified quantity for "%"', w.description; end if;
    if (ln ->> 'qty_verified')::numeric > w.qty_claimed then
      raise exception '"%": verified % % is more than claimed %', w.description, (ln ->> 'qty_verified')::numeric, w.unit, w.qty_claimed;
    end if;
    update public.labour_piecework set qty_verified = (ln ->> 'qty_verified')::numeric, verified_by = auth.uid(), verified_at = now(),
      remark = coalesce(nullif(trim(ln ->> 'remark'), ''), remark) where id = w.id;
    n := n + 1;
  end loop;
  perform app.payroll_recalc(pr.id);
  perform app.pay_event(pr.project_id, 'payroll', pr.id, 'verify_quantities', pr.status, pr.status, n || ' piece-work line(s) verified');
  select * into pr from public.labour_payrolls where id = pr.id;
  return app.op_done(p, 'verify_piecework', jsonb_build_object('ok', true, 'verified', n, 'gross', pr.gross, 'net', pr.net));
end $$;

-- ---------------------------------------------------------------------------
-- Approval chain: submit (office engineer) → check (coordinator) → approve (manager, posts cost) → pay (finance)
-- ---------------------------------------------------------------------------
create or replace function app.post_certificate_cost(p_cert uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.sc_certificates; s public.subcontracts; v_sub text; l record; n int := 0;
begin
  select * into c from public.sc_certificates where id = p_cert;
  select * into s from public.subcontracts where id = c.subcontract_id;
  select name into v_sub from public.subcontractors where id = s.subcontractor_id;
  for l in select cl.*, si.task_id, si.boq_item_id, si.description, si.unit from public.sc_certificate_lines cl
           join public.subcontract_items si on si.id = cl.subcontract_item_id where cl.certificate_id = p_cert and cl.amount_this <> 0
           order by si.line_no loop
    n := n + 1;
    perform app.pay_cost(c.project_id, c.number || '-CE' || n, c.period_to, 'subcontract', l.task_id, l.boq_item_id,
      v_sub || ': ' || l.description, v_sub, l.qty_verified_to_date - l.qty_previous, l.unit, l.rate, l.amount_this, 'invoice', c.number);
  end loop;
  -- charges against the subcontractor reduce the cost of the subcontract (materials are costed when issued)
  if c.material_deduction + c.penalty + c.other_deduction > 0 then
    perform app.pay_cost(c.project_id, c.number || '-CE' || (n + 1), c.period_to, 'subcontract', null, null,
      v_sub || ': deductions (materials supplied ' || c.material_deduction || ', penalty ' || c.penalty || ', other ' || c.other_deduction || ')',
      v_sub, null, null, null, -(c.material_deduction + c.penalty + c.other_deduction), 'invoice', c.number);
  end if;
end $$;

create or replace function app.post_payroll_cost(p_payroll uuid) returns void
language plpgsql security definer set search_path = public as $$
declare pr public.labour_payrolls; v_left numeric; v_tot_hc numeric; r record; n int := 0;
begin
  select * into pr from public.labour_payrolls where id = p_payroll;
  -- 0. piece-work goes to the task / BoQ item it was measured on
  for r in select pw.*, coalesce(pw.task_id, (select l.task_id from public.task_boq_links l where l.boq_item_id = pw.boq_item_id
                                                and l.deleted_at is null order by l.created_at limit 1)) as t
           from public.labour_piecework pw where pw.payroll_id = p_payroll and pw.amount <> 0 order by pw.work_date, pw.id loop
    n := n + 1;
    perform app.pay_cost(pr.project_id, pr.number || '-CE' || n, pr.period_to, 'labour', r.t, r.boq_item_id,
      'Piece-work ' || pr.number || ': ' || r.description, null, r.qty_verified, r.unit, r.rate, r.amount, 'payroll', pr.number);
  end loop;
  -- 1. attendance booked on a task
  for r in
    select a.task_id, sum(a.day_value * w.daily_rate + round(a.ot_hours * w.daily_rate / 8 * pr.ot_multiplier, 2)) as amt, sum(a.day_value) as days
    from public.labour_attendance a join public.labour_workers w on w.id = a.worker_id
    where a.payroll_id = p_payroll and a.task_id is not null group by a.task_id
  loop
    n := n + 1;
    perform app.pay_cost(pr.project_id, pr.number || '-CE' || n, pr.period_to, 'labour', r.task_id, null,
      'Daily labour ' || pr.number || ' (attendance)', null, r.days, 'man-day', null, r.amt, 'payroll', pr.number);
  end loop;
  v_left := pr.gross - coalesce((select sum(a.day_value * w.daily_rate + round(a.ot_hours * w.daily_rate / 8 * pr.ot_multiplier, 2))
    from public.labour_attendance a join public.labour_workers w on w.id = a.worker_id where a.payroll_id = p_payroll and a.task_id is not null), 0)
    - coalesce((select sum(amount) from public.labour_piecework where payroll_id = p_payroll), 0);
  if v_left <= 0 then return; end if;
  -- 2. the rest is spread over the activities the daily output reports manpower on in the period
  select sum(headcount) into v_tot_hc from public.diary_activities
   where project_id = pr.project_id and activity_date between pr.period_from and pr.period_to and deleted_at is null and coalesce(headcount, 0) > 0;
  if coalesce(v_tot_hc, 0) = 0 then
    perform app.pay_cost(pr.project_id, pr.number || '-CE' || (n + 1), pr.period_to, 'labour', null, null,
      'Daily labour ' || pr.number || ' (not allocated to activities)', null, null, null, null, v_left, 'payroll', pr.number);
    return;
  end if;
  for r in
    select task_id, sum(headcount) as hc from public.diary_activities
    where project_id = pr.project_id and activity_date between pr.period_from and pr.period_to and deleted_at is null and coalesce(headcount, 0) > 0
    group by task_id order by task_id
  loop
    n := n + 1;
    perform app.pay_cost(pr.project_id, pr.number || '-CE' || n, pr.period_to, 'labour', r.task_id, null,
      'Daily labour ' || pr.number || ' (by daily-output manpower)', null, r.hc, 'man-day', null, round(v_left * r.hc / v_tot_hc, 2), 'payroll', pr.number);
  end loop;
end $$;
revoke execute on function app.post_certificate_cost(uuid) from public;
revoke execute on function app.post_payroll_cost(uuid) from public;

create or replace function public.payment_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_type text := p ->> 'doc_type';
  v_id uuid := (p ->> 'id')::uuid;
  v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), '');
  v_project uuid; v_status text; v_number text; v_prep uuid; v_checked uuid; v_amount numeric; v_to text; v_label text;
begin
  if v_seen is not null then return v_seen; end if;
  if v_type = 'sc_certificate' then
    select project_id, status, number, prepared_by, checked_by, net_payable into v_project, v_status, v_number, v_prep, v_checked, v_amount
      from public.sc_certificates where id = v_id for update;
    v_label := 'Subcontractor certificate ' || v_number;
  elsif v_type = 'payroll' then
    select project_id, status, number, prepared_by, checked_by, net into v_project, v_status, v_number, v_prep, v_checked, v_amount
      from public.labour_payrolls where id = v_id for update;
    v_label := 'Labour payroll ' || v_number;
  else
    raise exception 'Unknown payment document type %', v_type;
  end if;
  if v_project is null then raise exception 'Payment document not found'; end if;
  perform app.require_member(v_project);

  if v_action = 'submit' then
    perform app.require_role_txt('office_engineer', 'coordinator', 'admin');
    if v_status not in ('draft','returned') then raise exception '% is % — only drafts can be submitted', v_label, v_status; end if;
    if v_type = 'sc_certificate' and not exists (select 1 from public.sc_certificate_lines where certificate_id = v_id and amount_this <> 0)
       and not exists (select 1 from public.sc_certificates where id = v_id and (is_final or retention_release > 0)) then
      raise exception 'Nothing to certify: no quantity was verified this period';
    end if;
    if v_type = 'payroll' and not exists (select 1 from public.labour_payroll_lines where payroll_id = v_id) then
      raise exception 'The payroll has no attendance or piece-work';
    end if;
    if v_type = 'payroll' and exists (select 1 from public.labour_piecework where payroll_id = v_id and qty_verified is null) then
      raise exception 'Piece-work quantities must be verified on site before the payroll is submitted';
    end if;
    v_to := 'submitted';
    perform app.notify_roles_txt(v_project, '{coordinator}', v_label || ' to check', 'Net ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB', v_type, v_id);
  elsif v_action = 'check' then
    perform app.require_role_txt('coordinator', 'admin');
    if v_status <> 'submitted' then raise exception '% is % — only submitted documents can be checked', v_label, v_status; end if;
    if v_prep = auth.uid() and not app.has_role_txt('admin') then raise exception 'You prepared % — another person must check it', v_number using errcode = '42501'; end if;
    v_to := 'checked';
    perform app.notify_roles_txt(v_project, '{manager}', v_label || ' to approve', 'Checked · net ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB', v_type, v_id);
  elsif v_action = 'approve' then
    perform app.require_role_txt('manager', 'admin');
    if v_status <> 'checked' then raise exception '% is % — it must be checked by the coordinator first', v_label, v_status; end if;
    if (v_prep = auth.uid() or v_checked = auth.uid()) and not app.has_role_txt('admin') then
      raise exception 'You prepared or checked % — the approver must be someone else', v_number using errcode = '42501';
    end if;
    v_to := 'approved';
    if v_type = 'sc_certificate' then perform app.post_certificate_cost(v_id); else perform app.post_payroll_cost(v_id); end if;
    perform app.notify_roles_txt(v_project, '{finance}', v_label || ' approved — to pay', 'Net payable ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB', v_type, v_id);
    perform app.notify_user(v_prep, v_project, v_label || ' approved', null, v_type, v_id);
  elsif v_action = 'pay' then
    perform app.require_role_txt('finance', 'admin');
    if v_status <> 'approved' then raise exception '% is % — only approved documents can be paid', v_label, v_status; end if;
    if coalesce(p ->> 'payment_method', '') not in ('bank_transfer','cheque','cash') then raise exception 'Choose how it was paid'; end if;
    if (p ->> 'payment_date') is null or (p ->> 'payment_date')::date > app.eat_date(now()) then raise exception 'Enter the payment date (not in the future)'; end if;
    if p ->> 'payment_method' <> 'cash' and nullif(trim(p ->> 'payment_ref'), '') is null then raise exception 'Enter the transfer / cheque reference'; end if;
    v_to := 'paid';
    if v_type = 'sc_certificate' then
      update public.sc_certificates set paid_by = auth.uid(), paid_at = now(), payment_method = p ->> 'payment_method',
        payment_ref = nullif(trim(p ->> 'payment_ref'), ''), payment_date = (p ->> 'payment_date')::date where id = v_id;
    else
      update public.labour_payrolls set paid_by = auth.uid(), paid_at = now(), payment_method = p ->> 'payment_method',
        payment_ref = nullif(trim(p ->> 'payment_ref'), ''), payment_date = (p ->> 'payment_date')::date where id = v_id;
    end if;
    perform app.notify_user(v_prep, v_project, v_label || ' paid', coalesce(p ->> 'payment_ref', 'cash'), v_type, v_id);
    perform app.notify_roles_txt(v_project, '{coordinator}', v_label || ' paid', coalesce(p ->> 'payment_ref', 'cash'), v_type, v_id);
  elsif v_action in ('return', 'reject') then
    if v_comment is null then raise exception 'Say why it is %', case when v_action = 'return' then 'returned' else 'rejected' end; end if;
    if v_status = 'submitted' then perform app.require_role_txt('coordinator', 'manager', 'admin');
    elsif v_status = 'checked' then perform app.require_role_txt('manager', 'admin');
    else raise exception '% is % — it can no longer be %', v_label, v_status, case when v_action = 'return' then 'returned' else 'rejected' end;
    end if;
    v_to := case when v_action = 'return' then 'returned' else 'rejected' end;
    perform app.notify_user(v_prep, v_project, v_label || ' ' || v_to, v_comment, v_type, v_id);
  else
    raise exception 'Unknown action %', v_action;
  end if;

  if v_type = 'sc_certificate' then
    update public.sc_certificates set status = v_to,
      submitted_at = case when v_to = 'submitted' then now() else submitted_at end,
      checked_by = case when v_to = 'checked' then auth.uid() when v_to = 'submitted' then null else checked_by end,
      checked_at = case when v_to = 'checked' then now() when v_to = 'submitted' then null else checked_at end,
      approved_by = case when v_to = 'approved' then auth.uid() else approved_by end,
      approved_at = case when v_to = 'approved' then now() else approved_at end,
      return_comment = case when v_to in ('returned','rejected') then v_comment when v_to = 'submitted' then null else return_comment end
    where id = v_id;
  else
    update public.labour_payrolls set status = v_to,
      submitted_at = case when v_to = 'submitted' then now() else submitted_at end,
      checked_by = case when v_to = 'checked' then auth.uid() when v_to = 'submitted' then null else checked_by end,
      checked_at = case when v_to = 'checked' then now() when v_to = 'submitted' then null else checked_at end,
      approved_by = case when v_to = 'approved' then auth.uid() else approved_by end,
      approved_at = case when v_to = 'approved' then now() else approved_at end,
      return_comment = case when v_to in ('returned','rejected') then v_comment when v_to = 'submitted' then null else return_comment end
    where id = v_id;
  end if;
  perform app.pay_event(v_project, v_type, v_id, v_action, v_status, v_to,
    coalesce(v_comment, case when v_action = 'pay' then (p ->> 'payment_method') || coalesce(' ' || (p ->> 'payment_ref'), '') end));
  return app.op_done(p, 'payment_action', jsonb_build_object('ok', true, 'id', v_id, 'number', v_number, 'status', v_to));
end $$;

-- ---------------------------------------------------------------------------
-- Inbox (approvals registry) and reporting views
-- ---------------------------------------------------------------------------
create or replace function app.payments_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null or v_role not in ('office_engineer','coordinator','manager','finance','admin') then return; end if;
  return query
  with mem as (select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
               union select pj.id from public.projects pj where v_role = 'admin'),
  docs as (
    select 'sc_certificate'::text as t, c.id, c.project_id, c.number, c.status, c.prepared_by, c.submitted_at, c.checked_at, c.approved_at, c.updated_at,
           (select sc.name from public.subcontracts k join public.subcontractors sc on sc.id = k.subcontractor_id where k.id = c.subcontract_id) as party,
           c.net_payable as net
    from public.sc_certificates c where c.project_id in (select pid from mem)
    union all
    select 'payroll', l.id, l.project_id, l.number, l.status, l.prepared_by, l.submitted_at, l.checked_at, l.approved_at, l.updated_at,
           'Daily labour · ' || l.workers || ' workers', l.net
    from public.labour_payrolls l where l.project_id in (select pid from mem))
  select 'payment'::text, d.t, d.id, d.project_id, d.number,
         d.party || ' · net ' || to_char(d.net, 'FM999,999,999,990.00') || ' ETB',
         d.status, d.prepared_by,
         coalesce(case d.status when 'submitted' then d.submitted_at when 'checked' then d.checked_at when 'approved' then d.approved_at end, d.updated_at),
         d.status = 'approved' and d.approved_at < now() - interval '7 days',
         array[case d.status when 'submitted' then 'check' when 'checked' then 'approve' when 'approved' then 'pay' else 'fix' end],
         round((extract(epoch from now() - coalesce(d.approved_at, d.checked_at, d.submitted_at, d.updated_at)) / 3600)::numeric, 1)
  from docs d
  where (d.status = 'submitted' and v_role in ('coordinator','admin'))
     or (d.status = 'checked' and v_role in ('manager','admin'))
     or (d.status = 'approved' and v_role in ('finance','admin'))
     or (d.status = 'returned' and d.prepared_by = p_user);
end $$;
insert into app.approval_sources (fn) values ('app.payments_approvals_for') on conflict do nothing;

create or replace view public.v_subcontracts with (security_invoker = true) as
select s.*, sc.name as subcontractor_name, sc.tin as subcontractor_tin, sc.vat_registered,
       coalesce((select sum(round(i.qty * i.rate, 2)) from public.subcontract_items i where i.subcontract_id = s.id and i.deleted_at is null), 0) as contract_value,
       coalesce((select c.gross_to_date from public.sc_certificates c where c.subcontract_id = s.id and c.status in ('approved','paid')
                 order by c.cert_no desc limit 1), 0) as certified_to_date,
       coalesce((select sum(c.net_payable) from public.sc_certificates c where c.subcontract_id = s.id and c.status = 'paid'), 0) as paid_to_date,
       coalesce((select sum(c.retention_this - c.retention_release) from public.sc_certificates c where c.subcontract_id = s.id and c.status in ('approved','paid')), 0) as retention_held,
       coalesce((select sum(c.advance_recovery_this) from public.sc_certificates c where c.subcontract_id = s.id and c.status in ('approved','paid')), 0) as advance_recovered,
       (select c.status from public.sc_certificates c where c.subcontract_id = s.id order by c.cert_no desc limit 1) as last_certificate_status
from public.subcontracts s join public.subcontractors sc on sc.id = s.subcontractor_id;

create or replace view public.v_payment_register with (security_invoker = true) as
select 'sc_certificate'::text as doc_type, c.id, c.project_id, c.number, sc.name as party, c.period_from, c.period_to, c.status,
       c.gross_this as gross, (c.retention_this - c.retention_release + c.advance_recovery_this + c.material_deduction + c.penalty + c.other_deduction) as deductions,
       c.vat_this as vat, c.wht_this as tax, c.net_payable as net, c.prepared_by, c.checked_by, c.approved_by, c.approved_at,
       c.paid_by, c.paid_at, c.payment_method, c.payment_ref, c.payment_date, c.created_at
from public.sc_certificates c join public.subcontracts s on s.id = c.subcontract_id join public.subcontractors sc on sc.id = s.subcontractor_id
union all
select 'payroll', l.id, l.project_id, l.number, 'Daily labour (' || l.workers || ' workers)', l.period_from, l.period_to, l.status,
       l.gross, l.deductions, 0, l.tax, l.net, l.prepared_by, l.checked_by, l.approved_by, l.approved_at,
       l.paid_by, l.paid_at, l.payment_method, l.payment_ref, l.payment_date, l.created_at
from public.labour_payrolls l;

grant select on public.v_subcontracts, public.v_payment_register to authenticated;

-- ---------------------------------------------------------------------------
-- Rebar in berga (one 12 m bar): alternative unit on every rebar spec, kept in step with the diameter
-- (spec_conversions: 1 berga = factor × the spec's base unit), so rebar can be requested / issued / counted in berga.
-- ---------------------------------------------------------------------------
create or replace function app.berga_factor(p_spec uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select case lower(s.uom) when 'kg' then f.kg when 't' then round(f.kg / 1000, 6) when 'ton' then round(f.kg / 1000, 6)
                           when 'tonne' then round(f.kg / 1000, 6) end
  from public.material_specs s join public.materials m on m.id = s.material_id
  cross join lateral (select (regexp_match(s.grade || ' ' || coalesce(s.description, ''), '(?:Ø|ø|Φ|φ|dia\.?\s*)\s*(\d{1,2})', 'i'))[1]::numeric as d) dd
  cross join lateral (select round(12 * dd.d * dd.d / 162, 2) as kg) f
  where s.id = p_spec and dd.d between 6 and 40
    and (m.name ilike '%rebar%' or m.name ilike '%reinforc%' or m.category ilike '%reinforc%')
$$;

create or replace function app.trg_spec_berga() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_f numeric := app.berga_factor(new.id);
begin
  if v_f is not null and v_f > 0 then
    insert into public.spec_conversions (material_spec_id, alt_uom, factor) values (new.id, 'berga', v_f)
    on conflict (material_spec_id, alt_uom) do update set factor = excluded.factor, deleted_at = null;
  end if;
  return null;
end $$;
drop trigger if exists berga_unit on public.material_specs;
create trigger berga_unit after insert or update of grade, uom, description on public.material_specs
  for each row execute function app.trg_spec_berga();

insert into public.spec_conversions (material_spec_id, alt_uom, factor)
select s.id, 'berga', app.berga_factor(s.id) from public.material_specs s
 where app.berga_factor(s.id) > 0
on conflict (material_spec_id, alt_uom) do update set factor = excluded.factor, deleted_at = null;
