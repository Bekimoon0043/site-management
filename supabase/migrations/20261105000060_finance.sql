-- =============================================================================
-- FINANCE & ADMIN
--   A. Supplier invoices with a 3-way match (PO price · goods accepted on GRN · invoiced quantity). Duplicate
--      supplier invoice numbers are refused. Chain: procurement / finance / office engineer records → coordinator
--      checks → manager approves (a variance needs a written override) → finance pays. Invoices are PAYABLES only:
--      material cost is recognised when the material is used (20261103000020), so no cost entry is posted here.
--   B. Petty cash (imprest): a float per custodian; expenses are recorded against the balance and replenished by a
--      claim that goes custodian → coordinator → manager → finance. Approval posts the actual cost.
--   C. Cash-flow forecast (13 weeks): client receipts vs supplier, subcontractor, labour, petty-cash and committed
--      purchase-order payments, plus a finance overview (receivable ageing, retention receivable / payable).
--   D. Monthly tax report: withholding to remit, payroll tax, VAT output / input, withholding suffered.
--   E. Admin: pending inbox of another user (handover before deactivation).
-- Tax rates and thresholds come only from effective-dated tax_settings. Current reference sources:
-- Income Tax (Amendment) Proclamation 1395/2025 (EY tax alert 2025-2542, withholding effective 7 Aug 2025),
-- VAT Proclamation 1341/2024 (EY tax alert, 16 Sep 2024), and PwC Ethiopia Tax Summaries (VAT / WHT).
-- No-TIN withholding here is a configured calculation, not proof of the supplier's TIN and business-licence status.
-- Exports are internal working papers: confirm tax periods, deadlines and input-VAT eligibility with the MoR.
-- Re-runnable.
-- =============================================================================

alter table public.suppliers add column if not exists tin text;
alter table public.client_contracts add column if not exists payment_days int not null default 30;
alter table public.tax_settings add column if not exists bank_payment_threshold numeric(18,2) not null default 50000
  check (bank_payment_threshold >= 0);

alter table public.payment_events drop constraint if exists payment_events_doc_type_check;
alter table public.payment_events add constraint payment_events_doc_type_check
  check (doc_type in ('sc_certificate','payroll','supplier_invoice','petty_cash'));

-- ---------------------------------------------------------------------------
-- A. Supplier invoices
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_invoices (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null unique,
  supplier_id       uuid not null references public.suppliers (id),
  po_id             uuid not null references public.purchase_orders (id),
  invoice_no        text not null,
  invoice_date      date not null,
  due_date          date not null,
  status            text not null default 'draft'
                      check (status in ('draft','submitted','checked','approved','paid','returned','rejected')),
  subtotal          numeric(18,2) not null default 0,
  vat               numeric(18,2) not null default 0,
  total             numeric(18,2) not null default 0,
  withholding_rate  numeric(5,2) not null default 0,
  withholding       numeric(18,2) not null default 0,
  net_payable       numeric(18,2) not null default 0,
  match_status      text not null default 'matched' check (match_status in ('matched','variance')),
  match_notes       text[] not null default '{}',
  override_comment  text,
  remarks           text,
  return_comment    text,
  prepared_by       uuid references public.profiles (id),
  submitted_at      timestamptz,
  checked_by        uuid references public.profiles (id),
  checked_at        timestamptz,
  approved_by       uuid references public.profiles (id),
  approved_at       timestamptz,
  paid_by           uuid references public.profiles (id),
  paid_at           timestamptz,
  payment_method    text check (payment_method in ('bank_transfer','cheque','cash')),
  payment_ref       text,
  payment_date      date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists supplier_invoices_dup on public.supplier_invoices (supplier_id, lower(invoice_no)) where status <> 'rejected';
create index if not exists supplier_invoices_project_idx on public.supplier_invoices (project_id, status);
create index if not exists supplier_invoices_po_idx on public.supplier_invoices (po_id);

create table if not exists public.supplier_invoice_lines (
  id                 uuid primary key default gen_random_uuid(),
  invoice_id         uuid not null references public.supplier_invoices (id) on delete cascade,
  project_id         uuid not null references public.projects (id),
  po_line_id         uuid not null references public.po_lines (id),
  line_no            int not null,
  description        text,
  qty                numeric(16,3) not null check (qty > 0),
  unit_price         numeric(18,2) not null check (unit_price >= 0),
  amount             numeric(18,2) generated always as (round(qty * unit_price, 2)) stored,
  vat_applicable     boolean not null default true,
  po_unit_price      numeric(18,2),
  qty_ordered        numeric(16,3),
  qty_accepted       numeric(16,3),
  qty_invoiced_before numeric(16,3),
  flag               text check (flag in ('price','qty','price_qty')),
  unique (invoice_id, po_line_id)
);
create index if not exists supplier_invoice_lines_inv_idx on public.supplier_invoice_lines (invoice_id);
create index if not exists supplier_invoice_lines_po_line_idx on public.supplier_invoice_lines (po_line_id);

-- ---------------------------------------------------------------------------
-- B. Petty cash
-- ---------------------------------------------------------------------------
create table if not exists public.petty_cash_floats (
  id            uuid primary key,
  project_id    uuid not null references public.projects (id),
  name          text not null,
  custodian_id  uuid not null references public.profiles (id),
  float_amount  numeric(18,2) not null check (float_amount > 0),
  is_active     boolean not null default true,
  created_by    uuid references public.profiles (id) default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists petty_cash_floats_one on public.petty_cash_floats (project_id, custodian_id) where is_active;

create table if not exists public.petty_cash_claims (
  id              uuid primary key,
  project_id      uuid not null references public.projects (id),
  float_id        uuid not null references public.petty_cash_floats (id),
  number          text not null unique,
  status          text not null default 'submitted'
                    check (status in ('submitted','checked','approved','paid','returned','rejected')),
  total           numeric(18,2) not null default 0,
  entries         int not null default 0,
  remarks         text,
  return_comment  text,
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
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.petty_cash_entries (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  float_id     uuid not null references public.petty_cash_floats (id),
  number       text not null unique,
  entry_date   date not null,
  category     text not null check (category in ('transport','fuel','food','materials','repairs','office','labour','other')),
  description  text not null,
  payee        text,
  receipt_no   text,
  amount       numeric(18,2) not null check (amount > 0),
  claim_id     uuid references public.petty_cash_claims (id),
  voided       boolean not null default false,
  recorded_by  uuid references public.profiles (id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists petty_cash_entries_float_idx on public.petty_cash_entries (float_id, claim_id);

do $$
declare t text;
begin
  foreach t in array array['supplier_invoices','supplier_invoice_lines','petty_cash_floats','petty_cash_claims','petty_cash_entries'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['supplier_invoices','petty_cash_floats','petty_cash_claims','petty_cash_entries'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
  end loop;
  foreach t in array array['supplier_invoices','supplier_invoice_lines'] loop
    execute format('drop policy if exists price_read on public.%I', t);
    execute format('create policy price_read on public.%I for select to authenticated using (app.is_member(project_id) and app.can_see_prices())', t);
  end loop;
end $$;

-- Custodians see their own float; payment roles see all floats of their projects.
create or replace function app.can_see_petty(p_project uuid, p_float uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_member(p_project) and (app.is_payment_role()
    or exists (select 1 from public.petty_cash_floats f where f.id = p_float and f.custodian_id = auth.uid()))
$$;
drop policy if exists petty_read on public.petty_cash_floats;
create policy petty_read on public.petty_cash_floats for select to authenticated using (app.can_see_petty(project_id, id));
drop policy if exists petty_read on public.petty_cash_claims;
create policy petty_read on public.petty_cash_claims for select to authenticated using (app.can_see_petty(project_id, float_id));
drop policy if exists petty_read on public.petty_cash_entries;
create policy petty_read on public.petty_cash_entries for select to authenticated using (app.can_see_petty(project_id, float_id));

-- ---------------------------------------------------------------------------
-- A. Supplier invoice: match + totals
-- ---------------------------------------------------------------------------
drop function if exists app.sinv_recalc(uuid);
create or replace function app.sinv_recalc(p_inv uuid, p_include_later boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare
  i public.supplier_invoices; ts public.tax_settings; v_vat_rate numeric; v_wht_rate numeric; v_sub numeric; v_vat numeric;
  v_wht numeric; v_notes text[];
begin
  select * into i from public.supplier_invoices where id = p_inv;
  if not found then raise exception 'Supplier invoice not found'; end if;
  ts := app.tax_for(i.invoice_date);
  if ts.id is null then raise exception 'No tax settings are effective on %', i.invoice_date; end if;
  select pt.vat_rate into v_vat_rate from public.po_totals pt where pt.po_id = i.po_id;
  v_vat_rate := coalesce(v_vat_rate, ts.vat_rate);

  update public.supplier_invoice_lines l set
    po_unit_price = pp.unit_price,
    vat_applicable = coalesce(pp.vat_applicable, true),
    qty_ordered = pl.qty,
    qty_accepted = pl.qty_accepted,
    qty_invoiced_before = coalesce((select sum(o.qty) from public.supplier_invoice_lines o join public.supplier_invoices oi on oi.id = o.invoice_id
                                    where o.po_line_id = l.po_line_id and o.invoice_id <> l.invoice_id and oi.status <> 'rejected'
                                      and (p_include_later or (oi.created_at, oi.id) < (i.created_at, i.id))), 0)
  from public.po_lines pl left join public.po_line_prices pp on pp.po_line_id = pl.id
  where pl.id = l.po_line_id and l.invoice_id = p_inv;
  update public.supplier_invoice_lines l set flag = case
      when l.unit_price > coalesce(l.po_unit_price, 0) + 0.005 and l.qty + l.qty_invoiced_before > l.qty_accepted + 0.0005 then 'price_qty'
      when l.unit_price > coalesce(l.po_unit_price, 0) + 0.005 then 'price'
      when l.qty + l.qty_invoiced_before > l.qty_accepted + 0.0005 then 'qty' end
  where l.invoice_id = p_inv;

  select coalesce(sum(amount), 0), coalesce(round(sum(case when vat_applicable then amount else 0 end) * v_vat_rate / 100, 2), 0)
    into v_sub, v_vat from public.supplier_invoice_lines where invoice_id = p_inv;
  v_wht_rate := case when v_sub >= ts.wht_goods_threshold then
      case when nullif(trim((select tin from public.suppliers where id = i.supplier_id)), '') is null
           then ts.wht_no_tin_rate else ts.wht_goods_rate end else 0 end;
  v_wht := round(v_sub * v_wht_rate / 100, 2);
  select coalesce(array_agg(format('Line %s: %s', l.line_no, case l.flag
           when 'price' then format('price %s above the PO price %s', to_char(l.unit_price, 'FM999,999,990.00'), to_char(l.po_unit_price, 'FM999,999,990.00'))
           when 'qty' then format('invoiced %s but only %s accepted on GRNs (%s on other invoices)', l.qty::text, l.qty_accepted::text, l.qty_invoiced_before::text)
           else format('price above the PO and quantity above what was accepted (%s of %s)', (l.qty + l.qty_invoiced_before)::text, l.qty_accepted::text) end)
           order by l.line_no), '{}')
    into v_notes from public.supplier_invoice_lines l where l.invoice_id = p_inv and l.flag is not null;
  update public.supplier_invoices set subtotal = v_sub, vat = v_vat, total = v_sub + v_vat, withholding_rate = v_wht_rate,
    withholding = v_wht, net_payable = v_sub + v_vat - v_wht, match_notes = v_notes,
    match_status = case when cardinality(v_notes) > 0 then 'variance' else 'matched' end
  where id = p_inv;
end $$;
revoke execute on function app.sinv_recalc(uuid, boolean) from public;

-- {id, po_id, invoice_no, invoice_date, due_date?, remarks?, lines: [{po_line_id, qty, unit_price?, description?}], submit?}
create or replace function public.save_supplier_invoice(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; i public.supplier_invoices; po public.purchase_orders;
  x record; n int := 0; v_no text; v_date date := (p ->> 'invoice_date')::date;
begin
  if v_seen is not null then return v_seen; end if;
  select * into po from public.purchase_orders where id = (p ->> 'po_id')::uuid;
  if not found then raise exception 'Purchase order not found'; end if;
  perform app.require_member(po.project_id);
  perform app.require_role_txt('procurement', 'finance', 'office_engineer', 'coordinator', 'admin');
  if not app.can_see_prices() then raise exception 'Supplier invoices need access to prices' using errcode = '42501'; end if;
  if po.status not in ('approved','sent','partially_received','received','closed') then
    raise exception 'PO % is % — invoices are recorded against approved purchase orders', po.number, po.status;
  end if;
  if nullif(trim(p ->> 'invoice_no'), '') is null then raise exception 'Enter the supplier''s invoice number'; end if;
  if v_date is null then raise exception 'Enter the invoice date'; end if;
  if v_date > app.eat_date(now()) then raise exception 'The invoice date cannot be in the future'; end if;
  if exists (select 1 from public.supplier_invoices s where s.supplier_id = po.supplier_id and lower(s.invoice_no) = lower(trim(p ->> 'invoice_no'))
             and s.id <> v_id and s.status <> 'rejected') then
    raise exception 'Invoice % from this supplier is already recorded (%)', trim(p ->> 'invoice_no'),
      (select s.number from public.supplier_invoices s where s.supplier_id = po.supplier_id and lower(s.invoice_no) = lower(trim(p ->> 'invoice_no'))
        and s.id <> v_id and s.status <> 'rejected' limit 1);
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one invoice line'; end if;

  select * into i from public.supplier_invoices where id = v_id for update;
  if found then
    if i.status not in ('draft','returned') then raise exception 'Invoice % is % and cannot be changed', i.number, i.status; end if;
    if i.po_id <> po.id then raise exception 'The purchase order of an invoice cannot be changed'; end if;
    update public.supplier_invoices set invoice_no = trim(p ->> 'invoice_no'), invoice_date = v_date,
      due_date = coalesce((p ->> 'due_date')::date, v_date + 30), remarks = nullif(trim(p ->> 'remarks'), '') where id = v_id;
    delete from public.supplier_invoice_lines where invoice_id = v_id;
  else
    v_no := app.pay_next_no(po.project_id, 'SINV', 'supplier_invoices');
    insert into public.supplier_invoices (id, project_id, number, supplier_id, po_id, invoice_no, invoice_date, due_date, remarks, prepared_by)
    values (v_id, po.project_id, v_no, po.supplier_id, po.id, trim(p ->> 'invoice_no'), v_date,
      coalesce((p ->> 'due_date')::date, v_date + 30), nullif(trim(p ->> 'remarks'), ''), auth.uid());
  end if;
  for x in select * from jsonb_to_recordset(p -> 'lines') as y(po_line_id uuid, qty numeric, unit_price numeric, description text) loop
    n := n + 1;
    if not exists (select 1 from public.po_lines where id = x.po_line_id and po_id = po.id and deleted_at is null) then
      raise exception 'Line %: not a line of PO %', n, po.number;
    end if;
    if x.qty is null or x.qty <= 0 then raise exception 'Line %: enter the invoiced quantity', n; end if;
    insert into public.supplier_invoice_lines (invoice_id, project_id, po_line_id, line_no, description, qty, unit_price)
    values (v_id, po.project_id, x.po_line_id, n, nullif(trim(x.description), ''), x.qty,
      coalesce(x.unit_price, (select unit_price from public.po_line_prices where po_line_id = x.po_line_id), 0));
  end loop;
  perform app.sinv_recalc(v_id, true);
  if coalesce((p ->> 'submit')::boolean, false) then
    perform public.finance_doc_action(jsonb_build_object('doc_type', 'supplier_invoice', 'id', v_id, 'action', 'submit'));
  end if;
  select * into i from public.supplier_invoices where id = v_id;
  return app.op_done(p, 'save_supplier_invoice', jsonb_build_object('ok', true, 'id', v_id, 'number', i.number, 'status', i.status,
    'match_status', i.match_status, 'match_notes', to_jsonb(i.match_notes), 'net_payable', i.net_payable));
end $$;

-- ---------------------------------------------------------------------------
-- B. Petty cash
-- ---------------------------------------------------------------------------
-- {id, project_id, name, custodian_id, float_amount, is_active?}
create or replace function public.save_petty_float(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; v_project uuid := (p ->> 'project_id')::uuid; f public.petty_cash_floats;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('manager', 'finance', 'admin');
  if coalesce((p ->> 'float_amount')::numeric, 0) <= 0 then raise exception 'Enter the float amount'; end if;
  if not exists (select 1 from public.project_members where project_id = v_project and user_id = (p ->> 'custodian_id')::uuid)
     and not exists (select 1 from public.profiles where id = (p ->> 'custodian_id')::uuid and role = 'admin') then
    raise exception 'The custodian must be a member of the project';
  end if;
  select * into f from public.petty_cash_floats where id = v_id;
  if found then
    if f.project_id <> v_project then raise exception 'Float belongs to another project'; end if;
    if f.custodian_id <> (p ->> 'custodian_id')::uuid and exists (select 1 from public.petty_cash_entries where float_id = v_id and not voided
        and (claim_id is null or claim_id in (select id from public.petty_cash_claims where status not in ('paid','rejected')))) then
      raise exception 'Settle the open expenses before handing the float to another custodian';
    end if;
    update public.petty_cash_floats set name = coalesce(nullif(trim(p ->> 'name'), ''), name), custodian_id = (p ->> 'custodian_id')::uuid,
      float_amount = (p ->> 'float_amount')::numeric, is_active = coalesce((p ->> 'is_active')::boolean, is_active) where id = v_id;
  else
    insert into public.petty_cash_floats (id, project_id, name, custodian_id, float_amount)
    values (v_id, v_project, coalesce(nullif(trim(p ->> 'name'), ''), 'Site petty cash'), (p ->> 'custodian_id')::uuid, (p ->> 'float_amount')::numeric);
    perform app.notify_user((p ->> 'custodian_id')::uuid, v_project, 'You hold a petty cash float',
      to_char((p ->> 'float_amount')::numeric, 'FM999,999,990.00') || ' ETB', 'petty_cash', v_id);
  end if;
  return app.op_done(p, 'save_petty_float', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- Cash in hand = float − expenses not yet reimbursed (unclaimed or in an unpaid claim).
create or replace function app.petty_balance(p_float uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select f.float_amount - coalesce((select sum(e.amount) from public.petty_cash_entries e
           left join public.petty_cash_claims c on c.id = e.claim_id
           where e.float_id = f.id and not e.voided and (c.id is null or c.status <> 'paid')), 0)
  from public.petty_cash_floats f where f.id = p_float
$$;
revoke execute on function app.petty_balance(uuid) from public;

-- {id, float_id, entry_date, category, description, payee?, receipt_no?, amount} — or {id, void: true}
create or replace function public.record_petty_expense(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); f public.petty_cash_floats; e public.petty_cash_entries; v_no text;
begin
  if v_seen is not null then return v_seen; end if;
  if coalesce((p ->> 'void')::boolean, false) then
    select * into e from public.petty_cash_entries where id = (p ->> 'id')::uuid for update;
    if not found then raise exception 'Expense not found'; end if;
    select * into f from public.petty_cash_floats where id = e.float_id;
    if f.custodian_id <> auth.uid() and not app.has_role_txt('admin') then raise exception 'Only the custodian can void an expense' using errcode = '42501'; end if;
    if e.claim_id is not null and exists (select 1 from public.petty_cash_claims where id = e.claim_id and status <> 'returned') then
      raise exception 'Expense % is in a replenishment claim', e.number;
    end if;
    update public.petty_cash_entries set voided = true, claim_id = null where id = e.id;
    return app.op_done(p, 'record_petty_expense', jsonb_build_object('ok', true, 'id', e.id, 'balance', app.petty_balance(f.id)));
  end if;
  select * into f from public.petty_cash_floats where id = (p ->> 'float_id')::uuid for update;
  if not found or not f.is_active then raise exception 'Petty cash float not found or closed'; end if;
  perform app.require_member(f.project_id);
  if f.custodian_id <> auth.uid() and not app.has_role_txt('admin') then raise exception 'Only the custodian records petty cash expenses' using errcode = '42501'; end if;
  if coalesce((p ->> 'amount')::numeric, 0) <= 0 then raise exception 'Enter the amount'; end if;
  if nullif(trim(p ->> 'description'), '') is null then raise exception 'Say what it was for'; end if;
  if (p ->> 'entry_date')::date > app.eat_date(now()) then raise exception 'The date cannot be in the future'; end if;
  if (p ->> 'amount')::numeric > app.petty_balance(f.id) then
    raise exception 'Not enough cash in the float: % ETB left — submit a replenishment claim', to_char(app.petty_balance(f.id), 'FM999,999,990.00');
  end if;
  v_no := app.pay_next_no(f.project_id, 'PCE', 'petty_cash_entries');
  insert into public.petty_cash_entries (id, project_id, float_id, number, entry_date, category, description, payee, receipt_no, amount)
  values ((p ->> 'id')::uuid, f.project_id, f.id, v_no, coalesce((p ->> 'entry_date')::date, app.eat_date(now())),
    coalesce(p ->> 'category', 'other'), trim(p ->> 'description'), nullif(trim(p ->> 'payee'), ''), nullif(trim(p ->> 'receipt_no'), ''),
    (p ->> 'amount')::numeric);
  return app.op_done(p, 'record_petty_expense', jsonb_build_object('ok', true, 'id', (p ->> 'id')::uuid, 'number', v_no, 'balance', app.petty_balance(f.id)));
end $$;

-- {id, float_id, remarks?} — claims every unclaimed expense (and re-submits a returned claim with its id).
create or replace function public.submit_petty_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); f public.petty_cash_floats; c public.petty_cash_claims; v_id uuid := (p ->> 'id')::uuid; v_no text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into f from public.petty_cash_floats where id = (p ->> 'float_id')::uuid;
  if not found then raise exception 'Petty cash float not found'; end if;
  perform app.require_member(f.project_id);
  if f.custodian_id <> auth.uid() and not app.has_role_txt('admin') then raise exception 'Only the custodian claims replenishment' using errcode = '42501'; end if;
  select * into c from public.petty_cash_claims where id = v_id for update;
  if found and c.status <> 'returned' then raise exception 'Claim % is %', c.number, c.status; end if;
  if not found then
    if exists (select 1 from public.petty_cash_claims where float_id = f.id and status in ('submitted','checked','returned')) then
      raise exception 'A replenishment claim of this float is already in approval';
    end if;
    v_no := app.pay_next_no(f.project_id, 'PCR', 'petty_cash_claims');
    insert into public.petty_cash_claims (id, project_id, float_id, number, prepared_by, remarks) values (v_id, f.project_id, f.id, v_no, auth.uid(), nullif(trim(p ->> 'remarks'), ''));
  end if;
  update public.petty_cash_entries set claim_id = v_id where float_id = f.id and not voided and claim_id is null;
  update public.petty_cash_claims set total = coalesce((select sum(amount) from public.petty_cash_entries where claim_id = v_id and not voided), 0),
    entries = (select count(*) from public.petty_cash_entries where claim_id = v_id and not voided),
    status = 'submitted', submitted_at = now(), return_comment = null, checked_by = null, checked_at = null where id = v_id;
  select * into c from public.petty_cash_claims where id = v_id;
  if c.entries = 0 then raise exception 'No expenses to claim'; end if;
  perform app.pay_event(f.project_id, 'petty_cash', v_id, 'submit', null, 'submitted', null);
  perform app.notify_roles_txt(f.project_id, '{coordinator}', 'Petty cash claim ' || c.number || ' to check',
    to_char(c.total, 'FM999,999,990.00') || ' ETB · ' || c.entries || ' receipts', 'petty_cash', v_id);
  return app.op_done(p, 'submit_petty_claim', jsonb_build_object('ok', true, 'id', v_id, 'number', c.number, 'total', c.total, 'entries', c.entries));
end $$;

-- ---------------------------------------------------------------------------
-- A + B chain: {doc_type: supplier_invoice | petty_cash, id, action: submit|check|approve|pay|return|reject, comment?,
--               payment_method?, payment_ref?, payment_date?}
-- ---------------------------------------------------------------------------
create or replace function public.finance_doc_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_type text := p ->> 'doc_type'; v_id uuid := (p ->> 'id')::uuid; v_action text := p ->> 'action';
  v_comment text := nullif(trim(p ->> 'comment'), ''); v_project uuid; v_status text; v_number text; v_prep uuid; v_checked uuid;
  v_amount numeric; v_to text; v_label text; v_match text; e record;
begin
  if v_seen is not null then return v_seen; end if;
  if v_type = 'supplier_invoice' then
    select s.project_id, s.status, s.number, s.prepared_by, s.checked_by, s.net_payable, s.match_status,
           'Supplier invoice ' || s.number || ' (' || sp.name || ' ' || s.invoice_no || ')'
      into v_project, v_status, v_number, v_prep, v_checked, v_amount, v_match, v_label
      from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id where s.id = v_id for update of s;
  elsif v_type = 'petty_cash' then
    select project_id, status, number, prepared_by, checked_by, total, 'matched', 'Petty cash claim ' || number
      into v_project, v_status, v_number, v_prep, v_checked, v_amount, v_match, v_label
      from public.petty_cash_claims where id = v_id for update;
  else
    raise exception 'Unknown finance document type %', v_type;
  end if;
  if v_project is null then raise exception 'Document not found'; end if;
  perform app.require_member(v_project);
  if v_type = 'supplier_invoice' then perform app.require_prices(); end if;

  if v_action = 'submit' then
    if v_type <> 'supplier_invoice' then raise exception 'Petty cash claims are submitted by the custodian'; end if;
    perform app.require_role_txt('procurement', 'finance', 'office_engineer', 'coordinator', 'admin');
    if v_status not in ('draft','returned') then raise exception '% is % — only drafts can be submitted', v_label, v_status; end if;
    perform app.sinv_recalc(v_id);
    select net_payable, match_status into v_amount, v_match from public.supplier_invoices where id = v_id;
    v_to := 'submitted';
    perform app.notify_roles_txt(v_project, '{coordinator}', v_label || ' to check',
      'Net ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB' || case when v_match = 'variance' then ' · 3-way match variance' else '' end, v_type, v_id);
  elsif v_action = 'check' then
    perform app.require_role_txt('coordinator', 'admin');
    if v_status <> 'submitted' then raise exception '% is % — only submitted documents can be checked', v_label, v_status; end if;
    if v_prep = auth.uid() and not app.has_role_txt('admin') then raise exception 'You prepared % — another person must check it', v_number using errcode = '42501'; end if;
    v_to := 'checked';
    perform app.notify_roles_txt(v_project, '{manager}', v_label || ' to approve', 'Checked · ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB', v_type, v_id);
  elsif v_action = 'approve' then
    perform app.require_role_txt('manager', 'admin');
    if v_status <> 'checked' then raise exception '% is % — it must be checked by the coordinator first', v_label, v_status; end if;
    if (v_prep = auth.uid() or v_checked = auth.uid()) and not app.has_role_txt('admin') then
      raise exception 'You prepared or checked % — the approver must be someone else', v_number using errcode = '42501';
    end if;
    if v_type = 'supplier_invoice' then
      perform app.sinv_recalc(v_id);
      select match_status into v_match from public.supplier_invoices where id = v_id;
      if v_match = 'variance' and v_comment is null then
        raise exception 'The invoice does not match the PO / goods received — write why it is approved anyway';
      end if;
      update public.supplier_invoices set override_comment = case when v_match = 'variance' then v_comment end where id = v_id;
    else
      for e in select * from public.petty_cash_entries where claim_id = v_id and not voided loop
        perform app.pay_cost(v_project, e.number, e.entry_date,
          case e.category when 'materials' then 'material_direct' when 'labour' then 'labour' else 'overhead' end,
          null, null, 'Petty cash: ' || e.description, e.payee, null, null, null, e.amount, 'manual', v_number);
      end loop;
    end if;
    v_to := 'approved';
    perform app.notify_roles_txt(v_project, '{finance}', v_label || ' approved — to pay', 'Net payable ' || to_char(v_amount, 'FM999,999,999,990.00') || ' ETB', v_type, v_id);
    perform app.notify_user(v_prep, v_project, v_label || ' approved', null, v_type, v_id);
  elsif v_action = 'pay' then
    perform app.require_role_txt('finance', 'admin');
    if v_status <> 'approved' then raise exception '% is % — only approved documents can be paid', v_label, v_status; end if;
    if coalesce(p ->> 'payment_method', '') not in ('bank_transfer','cheque','cash') then raise exception 'Choose how it was paid'; end if;
    if (p ->> 'payment_date') is null or (p ->> 'payment_date')::date > app.eat_date(now()) then raise exception 'Enter the payment date (not in the future)'; end if;
    if p ->> 'payment_method' = 'cash' and (app.tax_for((p ->> 'payment_date')::date)).bank_payment_threshold is null then
      raise exception 'No tax settings are effective on the payment date';
    end if;
    if p ->> 'payment_method' = 'cash' and v_amount > (app.tax_for((p ->> 'payment_date')::date)).bank_payment_threshold then
      raise exception 'Cash is limited to % ETB for this payment; use a bank transfer or cheque',
        to_char((app.tax_for((p ->> 'payment_date')::date)).bank_payment_threshold, 'FM999,999,990.00');
    end if;
    if p ->> 'payment_method' <> 'cash' and nullif(trim(p ->> 'payment_ref'), '') is null then raise exception 'Enter the transfer / cheque reference'; end if;
    v_to := 'paid';
    if v_type = 'supplier_invoice' then
      update public.supplier_invoices set paid_by = auth.uid(), paid_at = now(), payment_method = p ->> 'payment_method',
        payment_ref = nullif(trim(p ->> 'payment_ref'), ''), payment_date = (p ->> 'payment_date')::date where id = v_id;
    else
      update public.petty_cash_claims set paid_by = auth.uid(), paid_at = now(), payment_method = p ->> 'payment_method',
        payment_ref = nullif(trim(p ->> 'payment_ref'), ''), payment_date = (p ->> 'payment_date')::date where id = v_id;
    end if;
    perform app.notify_user(v_prep, v_project, v_label || ' paid', coalesce(p ->> 'payment_ref', 'cash'), v_type, v_id);
  elsif v_action in ('return', 'reject') then
    if v_comment is null then raise exception 'Say why it is %', case when v_action = 'return' then 'returned' else 'rejected' end; end if;
    if v_status = 'submitted' then perform app.require_role_txt('coordinator', 'manager', 'admin');
    elsif v_status = 'checked' then perform app.require_role_txt('manager', 'admin');
    else raise exception '% is % — it can no longer be %', v_label, v_status, case when v_action = 'return' then 'returned' else 'rejected' end;
    end if;
    v_to := case when v_action = 'return' then 'returned' else 'rejected' end;
    if v_type = 'petty_cash' and v_to = 'rejected' then
      update public.petty_cash_entries set claim_id = null where claim_id = v_id;   -- back to unclaimed; custodian voids or re-claims
    end if;
    perform app.notify_user(v_prep, v_project, v_label || ' ' || v_to, v_comment, v_type, v_id);
  else
    raise exception 'Unknown action %', v_action;
  end if;

  if v_type = 'supplier_invoice' then
    update public.supplier_invoices set status = v_to,
      submitted_at = case when v_to = 'submitted' then now() else submitted_at end,
      checked_by = case when v_to = 'checked' then auth.uid() when v_to = 'submitted' then null else checked_by end,
      checked_at = case when v_to = 'checked' then now() when v_to = 'submitted' then null else checked_at end,
      approved_by = case when v_to = 'approved' then auth.uid() else approved_by end,
      approved_at = case when v_to = 'approved' then now() else approved_at end,
      return_comment = case when v_to in ('returned','rejected') then v_comment when v_to = 'submitted' then null else return_comment end
    where id = v_id;
  else
    update public.petty_cash_claims set status = v_to,
      checked_by = case when v_to = 'checked' then auth.uid() else checked_by end,
      checked_at = case when v_to = 'checked' then now() else checked_at end,
      approved_by = case when v_to = 'approved' then auth.uid() else approved_by end,
      approved_at = case when v_to = 'approved' then now() else approved_at end,
      return_comment = case when v_to in ('returned','rejected') then v_comment else return_comment end
    where id = v_id;
  end if;
  perform app.pay_event(v_project, v_type, v_id, v_action, v_status, v_to,
    coalesce(v_comment, case when v_action = 'pay' then (p ->> 'payment_method') || coalesce(' ' || (p ->> 'payment_ref'), '') end));
  return app.op_done(p, 'finance_doc_action', jsonb_build_object('ok', true, 'id', v_id, 'number', v_number, 'status', v_to));
end $$;

-- Inbox items (approvals registry)
create or replace function app.finance_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text; v_prices boolean;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  v_prices := v_role = 'admin' or v_role::public.app_role = any(coalesce((select price_roles from public.app_settings where id = 1), '{}'));
  return query
  with mem as (select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
               union select pj.id from public.projects pj where v_role = 'admin'),
  docs as (
    select 'supplier_invoice'::text as t, s.id, s.project_id, s.number, s.status, s.prepared_by, s.submitted_at, s.checked_at, s.approved_at, s.updated_at,
           sp.name || ' inv. ' || s.invoice_no || case when s.match_status = 'variance' then ' · MATCH VARIANCE' else '' end as party, s.net_payable as net,
           s.due_date
    from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id where v_prices and s.project_id in (select pid from mem)
    union all
    select 'petty_cash', c.id, c.project_id, c.number, c.status, c.prepared_by, c.submitted_at, c.checked_at, c.approved_at, c.updated_at,
           'Petty cash replenishment · ' || c.entries || ' receipts', c.total, null::date
    from public.petty_cash_claims c where c.project_id in (select pid from mem))
  select 'payment'::text, d.t, d.id, d.project_id, d.number,
         d.party || ' · ' || to_char(d.net, 'FM999,999,999,990.00') || ' ETB', d.status, d.prepared_by,
         coalesce(case d.status when 'submitted' then d.submitted_at when 'checked' then d.checked_at when 'approved' then d.approved_at end, d.updated_at),
         (d.status = 'approved' and d.due_date is not null and d.due_date <= app.eat_date(now())),
         array[case d.status when 'submitted' then 'check' when 'checked' then 'approve' when 'approved' then 'pay' else 'fix' end],
         round((extract(epoch from now() - coalesce(d.approved_at, d.checked_at, d.submitted_at, d.updated_at)) / 3600)::numeric, 1)
  from docs d
  where (d.status = 'submitted' and v_role in ('coordinator','admin') and d.prepared_by is distinct from p_user)
     or (d.status = 'checked' and v_role in ('manager','admin'))
     or (d.status = 'approved' and v_role in ('finance','admin'))
     or (d.status = 'returned' and d.prepared_by = p_user);
end $$;
revoke execute on function app.finance_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.finance_approvals_for') on conflict do nothing;

-- Views
create or replace view public.v_supplier_invoices with (security_invoker = true) as
select s.*, sp.name as supplier_name, sp.tin as supplier_tin, po.number as po_number
from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id join public.purchase_orders po on po.id = s.po_id;

create or replace view public.v_petty_cash_floats with (security_invoker = true) as
select f.*, pr.full_name as custodian_name,
       coalesce((select sum(e.amount) from public.petty_cash_entries e where e.float_id = f.id and not e.voided and e.claim_id is null), 0) as unclaimed,
       coalesce((select sum(e.amount) from public.petty_cash_entries e join public.petty_cash_claims c on c.id = e.claim_id
                 where e.float_id = f.id and not e.voided and c.status not in ('paid','rejected')), 0) as in_claim,
       f.float_amount - coalesce((select sum(e.amount) from public.petty_cash_entries e left join public.petty_cash_claims c on c.id = e.claim_id
                 where e.float_id = f.id and not e.voided and (c.id is null or c.status <> 'paid')), 0) as balance
from public.petty_cash_floats f join public.profiles pr on pr.id = f.custodian_id;

-- PO lines still to invoice (accepted on GRNs minus already invoiced), price data.
create or replace view public.v_po_invoiceable with (security_invoker = true) as
select pl.id as po_line_id, pl.po_id, pl.project_id, po.number as po_number, po.supplier_id, pl.line_no, pl.material_spec_id,
       ms.grade || coalesce(' ' || ms.description, '') as spec, m.name as material, pl.uom, pl.qty as qty_ordered, pl.qty_accepted,
       coalesce((select sum(l.qty) from public.supplier_invoice_lines l join public.supplier_invoices s on s.id = l.invoice_id
                 where l.po_line_id = pl.id and s.status <> 'rejected'), 0) as qty_invoiced,
       pp.unit_price, coalesce(pp.vat_applicable, true) as vat_applicable
from public.po_lines pl join public.purchase_orders po on po.id = pl.po_id
join public.material_specs ms on ms.id = pl.material_spec_id join public.materials m on m.id = ms.material_id
join public.po_line_prices pp on pp.po_line_id = pl.id
where pl.deleted_at is null;

grant select on public.v_supplier_invoices, public.v_petty_cash_floats, public.v_po_invoiceable to authenticated;

-- ---------------------------------------------------------------------------
-- C. Cash-flow forecast and finance overview
-- ---------------------------------------------------------------------------
create or replace function app.finance_guard(p_project uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_member(p_project);
  perform app.require_role_txt('finance', 'manager', 'coordinator', 'admin');
  if not app.can_see_prices() then raise exception 'This report needs access to prices' using errcode = '42501'; end if;
end $$;

-- Every expected cash movement: direction in/out, bucket, due date (overdue → today), amount.
create or replace function app.cash_items(p_project uuid)
returns table (direction text, bucket text, ref text, party text, due date, amount numeric)
language sql stable security definer set search_path = public as $$
  with t as (select app.eat_date(now()) as d),
  cc as (select coalesce((select payment_days from public.client_contracts where project_id = p_project), 30) as days)
  -- client receipts
  select 'in', 'client', 'IPC ' || i.ipc_no, coalesce(c.client_name, 'Client'),
         greatest(case when i.status = 'certified' then coalesce(i.certified_on, t.d) + cc.days
                       when i.status = 'submitted' then i.submitted_at::date + 14 + cc.days
                       else coalesce(i.prepared_at::date, t.d) + 21 + cc.days end, t.d),
         case when i.status = 'certified' then coalesce((i.certified ->> 'payable')::numeric, 0) - i.paid_amount
              else coalesce((i.claimed ->> 'payable')::numeric, 0) end
  from public.client_ipcs i left join public.client_contracts c on c.project_id = i.project_id, t, cc
  where i.project_id = p_project and i.status in ('prepared','checked','submitted','certified')
  union all
  select 'out', 'suppliers', s.number, sp.name, greatest(s.due_date, t.d), s.net_payable
  from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id, t
  where s.project_id = p_project and s.status in ('draft','submitted','checked','approved','returned')
  union all
  -- ordered but not yet invoiced: PO net minus invoices, due 30 days after expected delivery
  select 'out', 'committed', po.number, sp.name, greatest(coalesce(po.eta, po.expected_date, po.order_date) + 30, t.d),
         greatest(pt.net_payable - coalesce((select sum(s.net_payable) from public.supplier_invoices s where s.po_id = po.id and s.status <> 'rejected'), 0), 0)
  from public.purchase_orders po join public.po_totals pt on pt.po_id = po.id join public.suppliers sp on sp.id = po.supplier_id, t
  where po.project_id = p_project and po.status in ('approved','sent','partially_received','received')
  union all
  select 'out', 'subcontractors', c.number, sc.name, case when c.status = 'approved' then t.d else t.d + 7 end, c.net_payable
  from public.sc_certificates c join public.subcontracts k on k.id = c.subcontract_id join public.subcontractors sc on sc.id = k.subcontractor_id, t
  where c.project_id = p_project and c.status in ('submitted','checked','approved')
  union all
  select 'out', 'labour', l.number, 'Daily labour', case when l.status = 'approved' then t.d else t.d + 3 end, l.net
  from public.labour_payrolls l, t
  where l.project_id = p_project and l.status in ('submitted','checked','approved')
  union all
  select 'out', 'petty_cash', c.number, 'Petty cash', case when c.status = 'approved' then t.d else t.d + 3 end, c.total
  from public.petty_cash_claims c, t
  where c.project_id = p_project and c.status in ('submitted','checked','approved')
$$;
revoke execute on function app.cash_items(uuid) from public;

create or replace function public.cash_flow_forecast(p_project uuid, p_weeks int default 13)
returns table (week_start date, client_in numeric, suppliers_out numeric, subcontractors_out numeric, labour_out numeric,
               petty_cash_out numeric, committed_out numeric, net numeric, cumulative numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_start date;
begin
  perform app.finance_guard(p_project);
  v_start := app.eat_date(now()) - (extract(isodow from app.eat_date(now()))::int - 1);
  return query
  with w as (select generate_series(0, greatest(least(coalesce(p_weeks, 13), 52), 1) - 1) as k),
  it as (select greatest(((x.due - v_start) / 7), 0) as k, x.*
         from app.cash_items(p_project) x
         where x.amount > 0 and x.due < v_start + greatest(least(coalesce(p_weeks, 13), 52), 1) * 7),
  agg as (
    select w.k,
      coalesce(sum(it.amount) filter (where it.bucket = 'client'), 0) as cin,
      coalesce(sum(it.amount) filter (where it.bucket = 'suppliers'), 0) as sup,
      coalesce(sum(it.amount) filter (where it.bucket = 'subcontractors'), 0) as sub,
      coalesce(sum(it.amount) filter (where it.bucket = 'labour'), 0) as lab,
      coalesce(sum(it.amount) filter (where it.bucket = 'petty_cash'), 0) as pet,
      coalesce(sum(it.amount) filter (where it.bucket = 'committed'), 0) as com
    from w left join it on it.k = w.k group by w.k)
  select v_start + a.k * 7, round(a.cin, 2), round(a.sup, 2), round(a.sub, 2), round(a.lab, 2), round(a.pet, 2), round(a.com, 2),
         round(a.cin - a.sup - a.sub - a.lab - a.pet - a.com, 2),
         round(sum(a.cin - a.sup - a.sub - a.lab - a.pet - a.com) over (order by a.k), 2)
  from agg a order by a.k;
end $$;

-- The movements behind the forecast (drill-down / export).
create or replace function public.cash_flow_items(p_project uuid)
returns table (direction text, bucket text, ref text, party text, due date, amount numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.finance_guard(p_project);
  return query select * from app.cash_items(p_project) x where x.amount > 0 order by x.due, x.bucket;
end $$;

create or replace function public.finance_overview(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := app.eat_date(now()); r jsonb;
begin
  perform app.finance_guard(p_project);
  with rec as (
    select coalesce(i.certified_on, i.period_to) as d, coalesce((i.certified ->> 'payable')::numeric, 0) - i.paid_amount as amt
    from public.client_ipcs i where i.project_id = p_project and i.status = 'certified'),
  lastcert as (select coalesce(i.certified, i.claimed) as t from public.client_ipcs i
               where i.project_id = p_project and i.status in ('certified','paid') order by i.ipc_no desc limit 1),
  pay as (
    select s.due_date as d, s.net_payable as amt from public.supplier_invoices s where s.project_id = p_project and s.status = 'approved'
    union all select app.eat_date(c.approved_at), c.net_payable from public.sc_certificates c where c.project_id = p_project and c.status = 'approved'
    union all select app.eat_date(l.approved_at), l.net from public.labour_payrolls l where l.project_id = p_project and l.status = 'approved'
    union all select app.eat_date(c.approved_at), c.total from public.petty_cash_claims c where c.project_id = p_project and c.status = 'approved')
  select jsonb_build_object(
    'receivable', coalesce((select sum(amt) from rec), 0),
    'receivable_ageing', jsonb_build_object(
      'd0_30', coalesce((select sum(amt) from rec where v_today - d <= 30), 0),
      'd31_60', coalesce((select sum(amt) from rec where v_today - d between 31 and 60), 0),
      'd61_90', coalesce((select sum(amt) from rec where v_today - d between 61 and 90), 0),
      'd90_plus', coalesce((select sum(amt) from rec where v_today - d > 90), 0)),
    'retention_receivable', greatest(coalesce((select rs.still_held from public.v_retention_status rs where rs.project_id = p_project),
      (select (t ->> 'retention_cum')::numeric from lastcert), 0), 0),
    'advance_to_recover_from_us', coalesce((select c.advance_amount from public.client_contracts c where c.project_id = p_project), 0)
        - coalesce((select (t ->> 'advance_recovery_cum')::numeric from lastcert), 0),
    'retention_payable', coalesce((select sum(c.retention_this - c.retention_release) from public.sc_certificates c
                                   where c.project_id = p_project and c.status in ('approved','paid')), 0),
    'payable_approved', coalesce((select sum(amt) from pay), 0),
    'payable_overdue', coalesce((select sum(amt) from pay where d < v_today), 0),
    'supplier_invoices_overdue', (select count(*) from public.supplier_invoices s where s.project_id = p_project
                                   and s.status in ('submitted','checked','approved') and s.due_date < v_today),
    'petty_cash_in_hand', coalesce((select sum(app.petty_balance(f.id)) from public.petty_cash_floats f where f.project_id = p_project and f.is_active), 0)
  ) into r;
  return r;
end $$;

-- ---------------------------------------------------------------------------
-- D. Monthly tax report (all of the caller's projects when p_project is null)
--   wht_payable     withholding we deducted from suppliers / subcontractors (remit to MoR)
--   payroll_tax     tax withheld from daily labour
--   vat_output      VAT on certificates to the client (certified in the month)
--   vat_input       VAT on supplier invoices (invoice date) and subcontractor certificates (approved in the month)
--   wht_credit      withholding the client deducted from us (tax credit)
-- ---------------------------------------------------------------------------
create or replace function public.tax_report(p_project uuid, p_month date)
returns table (section text, project_id uuid, doc_type text, doc_id uuid, number text, party text, tin text, doc_date date,
               base numeric, rate numeric, amount numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_from date := date_trunc('month', p_month)::date; v_to date := (date_trunc('month', p_month) + interval '1 month')::date;
begin
  perform app.require_role_txt('finance', 'manager', 'coordinator', 'admin');
  if not app.can_see_prices() then raise exception 'The tax report needs access to prices' using errcode = '42501'; end if;
  if p_project is not null then perform app.require_member(p_project); end if;
  return query
  with prj as (select pj.id from public.projects pj where (p_project is null or pj.id = p_project) and app.is_member(pj.id))
  select 'wht_payable'::text, s.project_id, 'supplier_invoice'::text, s.id, s.number, sp.name, sp.tin, s.payment_date, s.subtotal, s.withholding_rate, s.withholding
  from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id
  where s.project_id in (select id from prj) and s.status = 'paid' and s.payment_date >= v_from and s.payment_date < v_to and s.withholding > 0
  union all
  select 'wht_payable', c.project_id, 'sc_certificate', c.id, c.number, sc.name, sc.tin, c.payment_date, c.gross_this, c.wht_pct, c.wht_this
  from public.sc_certificates c join public.subcontracts k on k.id = c.subcontract_id join public.subcontractors sc on sc.id = k.subcontractor_id
  where c.project_id in (select id from prj) and c.status = 'paid' and c.payment_date >= v_from and c.payment_date < v_to and c.wht_this > 0
  union all
  select 'payroll_tax', l.project_id, 'payroll', l.id, l.number, 'Daily labour (' || l.workers || ' workers)', null, l.payment_date, l.gross, l.tax_pct, l.tax
  from public.labour_payrolls l
  where l.project_id in (select id from prj) and l.status = 'paid' and l.payment_date >= v_from and l.payment_date < v_to and l.tax > 0
  union all
  select 'vat_output', i.project_id, 'client_ipc', i.id, 'IPC ' || i.ipc_no, coalesce(cc.client_name, 'Client'), null, i.certified_on,
         coalesce((i.certified ->> 'this_value')::numeric, (i.certified ->> 'this_net')::numeric, 0), (i.certified ->> 'vat_pct')::numeric,
         coalesce((i.certified ->> 'vat')::numeric, 0)
  from public.client_ipcs i left join public.client_contracts cc on cc.project_id = i.project_id
  where i.project_id in (select id from prj) and i.status in ('certified','paid') and i.certified_on >= v_from and i.certified_on < v_to
  union all
  select 'vat_input', s.project_id, 'supplier_invoice', s.id, s.number || ' / ' || s.invoice_no, sp.name, sp.tin, s.invoice_date, s.subtotal,
         case when s.subtotal > 0 then round(s.vat / s.subtotal * 100, 2) end, s.vat
  from public.supplier_invoices s join public.suppliers sp on sp.id = s.supplier_id
  where s.project_id in (select id from prj) and s.status in ('approved','paid') and s.invoice_date >= v_from and s.invoice_date < v_to and s.vat > 0
  union all
  select 'vat_input', c.project_id, 'sc_certificate', c.id, c.number, sc.name, sc.tin, app.eat_date(c.approved_at), c.gross_this, c.vat_pct, c.vat_this
  from public.sc_certificates c join public.subcontracts k on k.id = c.subcontract_id join public.subcontractors sc on sc.id = k.subcontractor_id
  where c.project_id in (select id from prj) and c.status in ('approved','paid') and c.approved_at >= v_from and c.approved_at < v_to and c.vat_this > 0
  union all
  select 'wht_credit', i.project_id, 'client_ipc', i.id, 'IPC ' || i.ipc_no, coalesce(cc.client_name, 'Client'), null, i.certified_on,
         coalesce((i.certified ->> 'this_value')::numeric, (i.certified ->> 'this_net')::numeric, 0), (i.certified ->> 'wht_pct')::numeric,
         coalesce((i.certified ->> 'wht')::numeric, 0)
  from public.client_ipcs i left join public.client_contracts cc on cc.project_id = i.project_id
  where i.project_id in (select id from prj) and i.status in ('certified','paid') and i.certified_on >= v_from and i.certified_on < v_to
    and coalesce((i.certified ->> 'wht')::numeric, 0) > 0
  order by 1, 8, 5;
end $$;

-- ---------------------------------------------------------------------------
-- E. Admin: what is waiting on a user (hand over before deactivating them)
-- ---------------------------------------------------------------------------
create or replace function public.user_pending_items(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql volatile security definer set search_path = public as $$
declare v_me text := current_setting('request.jwt.claim.sub', true);
begin
  perform app.require_role_txt('admin');
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'User not found'; end if;
  -- the inbox functions only answer for the signed-in user: evaluate them as p_user, then switch back
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  begin
    return query
      select * from app.approvals_for(p_user)
      union all select * from app.lookahead_approvals_for(p_user)
      union all select * from app.extra_approvals_for(p_user);
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(v_me, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_me, ''), true);
end $$;

revoke execute on function public.cash_flow_forecast(uuid, int), public.cash_flow_items(uuid), public.finance_overview(uuid),
  public.tax_report(uuid, date), public.user_pending_items(uuid) from public, anon;
grant execute on function public.cash_flow_forecast(uuid, int), public.cash_flow_items(uuid), public.finance_overview(uuid),
  public.tax_report(uuid, date), public.user_pending_items(uuid) to authenticated;
