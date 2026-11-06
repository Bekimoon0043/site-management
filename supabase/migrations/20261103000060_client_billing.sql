-- =============================================================================
-- Client billing: interim payment certificates (IPC) to the client and variations (change orders).
--
-- * client_contracts  one per project: contract sum, VAT, advance + its recovery rate, retention (+ limit),
--                     materials-on-site allowance, withholding tax deducted by the client.
-- * client_ipcs       IPC No. n for a period; quantities to date default to the VERIFIED BoQ progress of the
--                     project's schedules (app.boq_progress_raw) and can be re-measured per line.
--                     Workflow: draft → prepared (office engineer / QS) → checked (coordinator) → submitted to the
--                     consultant (manager) → certified (consultant figures recorded, may differ) → paid (finance).
--                     Returned at any step before certification goes back to draft.
-- * variations        VO-n with lines (new BoQ items or quantity changes of existing ones), internal approval by
--                     the manager, then client approval recorded; an approved VO updates the BoQ, so the work is
--                     measured and billed in the next IPC like any other item.
-- Amounts are price data: tables are readable only by members who can see prices (app.can_see_prices()).
-- Ethiopian practice used as defaults: VAT 15 %, retention 5 % (limit 5 % of the contract sum), advance up to
-- 30 % recovered pro rata (same %), withholding 3 % on the ex-VAT amount (Proclamation 1395/2025).
-- Inbox items via app.approval_sources (20261103000000).
-- =============================================================================

create table if not exists public.client_contracts (
  project_id              uuid primary key references public.projects (id) on delete cascade,
  contract_no             text,
  client_name             text,
  consultant_name         text,
  contract_sum            numeric(18,2) not null default 0 check (contract_sum >= 0),   -- ex VAT
  vat_pct                 numeric(5,2) not null default 15 check (vat_pct between 0 and 100),
  advance_amount          numeric(18,2) not null default 0 check (advance_amount >= 0),
  advance_recovery_pct    numeric(5,2) not null default 0 check (advance_recovery_pct between 0 and 100),
  retention_pct           numeric(5,2) not null default 5 check (retention_pct between 0 and 100),
  retention_limit_pct     numeric(5,2) not null default 5 check (retention_limit_pct between 0 and 100),
  mos_pct                 numeric(5,2) not null default 0 check (mos_pct between 0 and 100),   -- share of materials on site paid
  wht_pct                 numeric(5,2) not null default 3 check (wht_pct between 0 and 100),
  updated_by              uuid references public.profiles (id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists public.variations (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null,
  title            text not null,
  instruction_ref  text,
  instruction_date date,
  reason           text,
  status           text not null default 'draft' check (status in ('draft','pending','submitted','approved','rejected','cancelled')),
  amount           numeric(18,2) not null default 0,     -- ex VAT, from the lines (approved amount once approved)
  client_ref       text,
  decided_at       timestamptz,
  decision_comment text,
  created_by       uuid not null references public.profiles (id),
  approved_by      uuid references public.profiles (id),   -- internal (manager) approval
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.variation_lines (
  id            uuid primary key,
  variation_id  uuid not null references public.variations (id) on delete cascade,
  project_id    uuid not null references public.projects (id),
  line_no       int not null,
  boq_item_id   uuid references public.boq_items (id),    -- existing item whose quantity changes; null = new item
  item_no       text not null,
  description   text not null,
  unit          text not null,
  qty           numeric(16,3) not null,                  -- change (may be negative for omissions)
  rate          numeric(18,2) not null check (rate >= 0),
  amount        numeric(18,2) generated always as (round(qty * rate, 2)) stored,
  created_boq_item_id uuid references public.boq_items (id),
  updated_at    timestamptz not null default now()
);

create table if not exists public.client_ipcs (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  ipc_no           int not null check (ipc_no > 0),
  period_from      date,
  period_to        date not null,
  status           text not null default 'draft' check (status in ('draft','prepared','checked','submitted','certified','paid','cancelled')),
  is_final         boolean not null default false,
  mos_value        numeric(18,2) not null default 0 check (mos_value >= 0),          -- materials on site at period end (claimed)
  price_adjustment numeric(18,2) not null default 0,                                 -- cumulative price adjustment claimed
  claimed          jsonb not null default '{}'::jsonb,                               -- totals (app.ipc_totals)
  certified        jsonb,                                                            -- consultant's totals
  certified_mos_value        numeric(18,2),
  certified_price_adjustment numeric(18,2),
  consultant_ref   text,
  certified_on     date,
  paid_amount      numeric(18,2) not null default 0,
  paid_on          date,
  payment_ref      text,
  remarks          text,
  return_comment   text,
  prepared_by      uuid references public.profiles (id),
  prepared_at      timestamptz,
  checked_by       uuid references public.profiles (id),
  checked_at       timestamptz,
  submitted_by     uuid references public.profiles (id),
  submitted_at     timestamptz,
  certified_by     uuid references public.profiles (id),
  paid_by          uuid references public.profiles (id),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, ipc_no)
);

create table if not exists public.client_ipc_lines (
  id               uuid primary key default gen_random_uuid(),
  ipc_id           uuid not null references public.client_ipcs (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  boq_item_id      uuid not null references public.boq_items (id),
  item_no          text not null,
  description      text not null,
  unit             text not null,
  contract_qty     numeric(16,3) not null default 0,
  rate             numeric(18,2) not null default 0,
  verified_qty     numeric(16,3) not null default 0,     -- verified site progress to date (reference)
  prev_qty         numeric(16,3) not null default 0,     -- cumulative of the previous IPC (certified when certified)
  cum_qty          numeric(16,3) not null default 0,     -- claimed cumulative
  certified_cum_qty numeric(16,3),                       -- consultant's cumulative
  remeasured       boolean not null default false,
  updated_at       timestamptz not null default now(),
  unique (ipc_id, boq_item_id)
);

create index if not exists client_ipc_lines_ipc_idx on public.client_ipc_lines (ipc_id);
create index if not exists variation_lines_var_idx on public.variation_lines (variation_id);
create index if not exists client_ipcs_project_idx on public.client_ipcs (project_id, ipc_no);

do $$
declare t text;
begin
  foreach t in array array['client_contracts','variations','variation_lines','client_ipcs','client_ipc_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('drop policy if exists price_read on public.%I', t);
    execute format('create policy price_read on public.%I for select to authenticated using (app.is_member(project_id) and app.can_see_prices())', t);
  end loop;
  foreach t in array array['client_contracts','variations','client_ipcs'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function app.billing_guard(p_project uuid, variadic p_roles text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_member(p_project);
  perform app.require_role_txt(variadic p_roles);
  if not app.can_see_prices() then
    raise exception 'Client billing needs access to prices — ask the admin to add your role to the price roles' using errcode = '42501';
  end if;
end $$;

-- Verified quantity to date per BoQ item over the project's active schedules.
create or replace function app.billing_verified_qty(p_project uuid, p_date date)
returns table (boq_item_id uuid, qty numeric)
language sql stable security definer set search_path = public as $$
  select r.boq_item_id, sum(r.qty_to_date)
  from public.schedules s cross join lateral app.boq_progress_raw(s.id, p_date) r
  where s.project_id = p_project and s.status = 'active'
  group by r.boq_item_id
$$;

-- Totals of an IPC on the claimed or certified figures:
-- work, materials on site, price adjustment, gross, retention, advance recovery, net (all cumulative),
-- previous net, this period net (ex VAT), VAT, withholding, payable.
create or replace function app.ipc_totals(p_ipc uuid, p_basis text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  i public.client_ipcs; c public.client_contracts; v_prev public.client_ipcs;
  v_work numeric; v_mos numeric; v_pa numeric; v_gross numeric; v_ret numeric; v_adv numeric; v_net numeric;
  v_prev_net numeric := 0; v_this numeric; v_vat numeric; v_wht numeric; v_prev_work numeric := 0;
begin
  select * into i from public.client_ipcs where id = p_ipc;
  select * into c from public.client_contracts where project_id = i.project_id;
  select coalesce(sum(round(case when p_basis = 'certified' then coalesce(l.certified_cum_qty, l.cum_qty) else l.cum_qty end * l.rate, 2)), 0),
         coalesce(sum(round(l.prev_qty * l.rate, 2)), 0)
    into v_work, v_prev_work from public.client_ipc_lines l where l.ipc_id = p_ipc;
  v_mos := round(case when p_basis = 'certified' then coalesce(i.certified_mos_value, i.mos_value) else i.mos_value end
                 * coalesce(c.mos_pct, 0) / 100, 2);
  v_pa := case when p_basis = 'certified' then coalesce(i.certified_price_adjustment, i.price_adjustment) else i.price_adjustment end;
  v_gross := v_work + v_mos + v_pa;
  v_ret := round(least(v_work * coalesce(c.retention_pct, 0) / 100,
                       case when coalesce(c.retention_limit_pct, 0) > 0 and coalesce(c.contract_sum, 0) > 0
                            then c.contract_sum * c.retention_limit_pct / 100 else v_work end), 2);
  if i.is_final then v_ret := 0; end if;                     -- final account releases retention (on final IPC)
  v_adv := round(least(coalesce(c.advance_amount, 0), v_work * coalesce(c.advance_recovery_pct, 0) / 100), 2);
  v_net := v_gross - v_ret - v_adv;
  select * into v_prev from public.client_ipcs
   where project_id = i.project_id and ipc_no < i.ipc_no and status <> 'cancelled' order by ipc_no desc limit 1;
  if found then v_prev_net := coalesce((coalesce(v_prev.certified, v_prev.claimed) ->> 'net_cum')::numeric, 0); end if;
  v_this := v_net - v_prev_net;
  v_vat := round(v_this * coalesce(c.vat_pct, 15) / 100, 2);
  v_wht := round(greatest(v_this, 0) * coalesce(c.wht_pct, 0) / 100, 2);
  return jsonb_build_object(
    'work_cum', v_work, 'work_prev', v_prev_work, 'work_this', v_work - v_prev_work,
    'mos', v_mos, 'price_adjustment', v_pa, 'gross_cum', v_gross,
    'retention_cum', v_ret, 'advance_recovery_cum', v_adv, 'net_cum', v_net,
    'previous_net', v_prev_net, 'this_net', v_this, 'vat', v_vat, 'total_incl_vat', v_this + v_vat,
    'wht', v_wht, 'payable', v_this + v_vat - v_wht,
    'retention_pct', c.retention_pct, 'advance_recovery_pct', c.advance_recovery_pct, 'vat_pct', coalesce(c.vat_pct, 15),
    'wht_pct', c.wht_pct, 'mos_pct', c.mos_pct, 'contract_sum', c.contract_sum,
    'progress_pct', case when coalesce(c.contract_sum, 0) > 0 then round(v_work / c.contract_sum * 100, 2) end);
end $$;
revoke execute on function app.ipc_totals(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- contract terms
-- ---------------------------------------------------------------------------
create or replace function public.save_client_contract(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_adv_pct numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'coordinator', 'manager', 'admin');
  v_adv_pct := nullif(p ->> 'advance_recovery_pct', '')::numeric;
  insert into public.client_contracts (project_id, contract_no, client_name, consultant_name, contract_sum, vat_pct, advance_amount,
    advance_recovery_pct, retention_pct, retention_limit_pct, mos_pct, wht_pct, updated_by)
  values (v_project, nullif(p ->> 'contract_no', ''), nullif(p ->> 'client_name', ''), nullif(p ->> 'consultant_name', ''),
    coalesce((p ->> 'contract_sum')::numeric, 0), coalesce((p ->> 'vat_pct')::numeric, 15), coalesce((p ->> 'advance_amount')::numeric, 0),
    coalesce(v_adv_pct, case when coalesce((p ->> 'contract_sum')::numeric, 0) > 0
                             then round(coalesce((p ->> 'advance_amount')::numeric, 0) / (p ->> 'contract_sum')::numeric * 100, 2) else 0 end),
    coalesce((p ->> 'retention_pct')::numeric, 5), coalesce((p ->> 'retention_limit_pct')::numeric, 5),
    coalesce((p ->> 'mos_pct')::numeric, 0), coalesce((p ->> 'wht_pct')::numeric, 3), auth.uid())
  on conflict (project_id) do update set contract_no = excluded.contract_no, client_name = excluded.client_name,
    consultant_name = excluded.consultant_name, contract_sum = excluded.contract_sum, vat_pct = excluded.vat_pct,
    advance_amount = excluded.advance_amount, advance_recovery_pct = excluded.advance_recovery_pct,
    retention_pct = excluded.retention_pct, retention_limit_pct = excluded.retention_limit_pct, mos_pct = excluded.mos_pct,
    wht_pct = excluded.wht_pct, updated_by = auth.uid();
  if (select advance_amount > contract_sum and contract_sum > 0 from public.client_contracts where project_id = v_project) then
    raise exception 'The advance cannot be more than the contract sum';
  end if;
  return app.op_done(p, 'save_client_contract', jsonb_build_object('ok', true, 'project_id', v_project));
end $$;

-- ---------------------------------------------------------------------------
-- variations
-- ---------------------------------------------------------------------------
create or replace function public.save_variation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_project uuid := (p ->> 'project_id')::uuid; v public.variations; x record; n int := 0; v_no text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the variation a title'; end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one line'; end if;
  select * into v from public.variations where id = v_id for update;
  if found then
    if v.project_id <> v_project then raise exception 'Variation belongs to another project'; end if;
    if v.status not in ('draft') then raise exception 'Variation % is % and cannot be edited', v.number, v.status; end if;
    update public.variations set title = trim(p ->> 'title'), instruction_ref = nullif(p ->> 'instruction_ref', ''),
      instruction_date = nullif(p ->> 'instruction_date', '')::date, reason = nullif(p ->> 'reason', '') where id = v_id;
    delete from public.variation_lines where variation_id = v_id;
  else
    v_no := coalesce(nullif(p ->> 'number', ''), 'VO-' || lpad((coalesce((select count(*) from public.variations where project_id = v_project), 0) + 1)::text, 3, '0'));
    insert into public.variations (id, project_id, number, title, instruction_ref, instruction_date, reason, created_by)
    values (v_id, v_project, v_no, trim(p ->> 'title'), nullif(p ->> 'instruction_ref', ''), nullif(p ->> 'instruction_date', '')::date,
      nullif(p ->> 'reason', ''), auth.uid());
  end if;
  for x in select * from jsonb_to_recordset(p -> 'lines') as y(boq_item_id uuid, item_no text, description text, unit text, qty numeric, rate numeric) loop
    n := n + 1;
    if x.boq_item_id is not null then
      select coalesce(nullif(x.item_no, ''), b.item_no), coalesce(nullif(x.description, ''), b.description), coalesce(nullif(x.unit, ''), b.unit),
             coalesce(x.rate, (select r.rate from public.boq_rates r where r.boq_item_id = b.id))
        into x.item_no, x.description, x.unit, x.rate
        from public.boq_items b where b.id = x.boq_item_id and b.project_id = v_project;
      if not found then raise exception 'Line %: BoQ item is not in this project', n; end if;
    end if;
    if nullif(trim(x.item_no), '') is null or nullif(trim(x.description), '') is null or nullif(trim(x.unit), '') is null then
      raise exception 'Line %: item no., description and unit are required', n;
    end if;
    if x.qty is null or x.qty = 0 then raise exception 'Line %: enter the quantity (negative for an omission)', n; end if;
    if x.rate is null or x.rate < 0 then raise exception 'Line %: enter the rate', n; end if;
    if x.boq_item_id is null and x.qty < 0 then raise exception 'Line %: a new item cannot have a negative quantity', n; end if;
    if x.boq_item_id is null and exists (select 1 from public.boq_items where project_id = v_project and item_no = trim(x.item_no) and deleted_at is null) then
      raise exception 'Line %: item no. % already exists in the BoQ — pick the item to change its quantity', n, trim(x.item_no);
    end if;
    insert into public.variation_lines (id, variation_id, project_id, line_no, boq_item_id, item_no, description, unit, qty, rate)
    values (gen_random_uuid(), v_id, v_project, n, x.boq_item_id, trim(x.item_no), trim(x.description), trim(x.unit), x.qty, x.rate);
  end loop;
  update public.variations set amount = (select coalesce(sum(amount), 0) from public.variation_lines where variation_id = v_id) where id = v_id;
  if coalesce((p ->> 'submit')::boolean, false) then
    update public.variations set status = 'pending' where id = v_id;
    perform app.notify_roles(v_project, '{manager}', 'Variation to approve', (select number || ' ' || title from public.variations where id = v_id), 'variation', v_id);
  end if;
  return app.op_done(p, 'save_variation', jsonb_build_object('ok', true, 'id', v_id,
    'number', (select number from public.variations where id = v_id), 'status', (select status from public.variations where id = v_id),
    'amount', (select amount from public.variations where id = v_id)));
end $$;

-- action: approve (manager, pending → submitted to client), return (→ draft), client_approve / client_reject
-- (coordinator / manager, submitted → approved | rejected), cancel (draft/pending)
create or replace function public.decide_variation(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v public.variations; a text := p ->> 'action'; c text := nullif(trim(p ->> 'comment'), '');
  l record; v_item uuid;
begin
  if v_seen is not null then return v_seen; end if;
  select * into v from public.variations where id = (p ->> 'variation_id')::uuid for update;
  if not found then raise exception 'Variation not found'; end if;
  if a in ('approve','return') then
    perform app.billing_guard(v.project_id, 'manager', 'admin');
    if v.status <> 'pending' then raise exception 'Only a variation waiting for approval can be %', case a when 'approve' then 'approved' else 'returned' end; end if;
    if a = 'return' and c is null then raise exception 'Say what needs changing'; end if;
    if a = 'approve' then
      update public.variations set status = 'submitted', approved_by = auth.uid(), approved_at = now(), decision_comment = c where id = v.id;
    else
      update public.variations set status = 'draft', decision_comment = c where id = v.id;
      perform app.notify_user(v.created_by, v.project_id, 'Variation ' || v.number || ' returned', c, 'variation', v.id);
    end if;
  elsif a in ('client_approve','client_reject') then
    perform app.billing_guard(v.project_id, 'coordinator', 'manager', 'admin');
    if v.status <> 'submitted' then raise exception 'Only a variation submitted to the client can be decided'; end if;
    if a = 'client_reject' then
      update public.variations set status = 'rejected', decided_at = now(), decision_comment = c, client_ref = nullif(p ->> 'client_ref', '') where id = v.id;
    else
      -- approved: new items enter the BoQ, changed items get the quantity change
      for l in select * from public.variation_lines where variation_id = v.id order by line_no loop
        if l.boq_item_id is null then
          insert into public.boq_items (project_id, item_no, description, unit, quantity)
          values (v.project_id, l.item_no, l.description || ' [' || v.number || ']', l.unit, l.qty)
          on conflict (project_id, item_no) do update set quantity = public.boq_items.quantity + excluded.quantity, deleted_at = null
          returning id into v_item;
          insert into public.boq_rates (boq_item_id, rate) values (v_item, l.rate) on conflict (boq_item_id) do nothing;
          update public.variation_lines set created_boq_item_id = v_item where id = l.id;
        else
          update public.boq_items set quantity = greatest(quantity + l.qty, 0) where id = l.boq_item_id;
          insert into public.boq_rates (boq_item_id, rate) values (l.boq_item_id, l.rate) on conflict (boq_item_id) do nothing;
        end if;
      end loop;
      update public.variations set status = 'approved', decided_at = now(), decision_comment = c,
        client_ref = nullif(p ->> 'client_ref', '') where id = v.id;
      update public.client_contracts set contract_sum = contract_sum + v.amount where project_id = v.project_id;
    end if;
  elsif a = 'cancel' then
    perform app.billing_guard(v.project_id, 'office_engineer', 'coordinator', 'manager', 'admin');
    if v.status not in ('draft','pending') then raise exception 'Only a draft or pending variation can be cancelled'; end if;
    update public.variations set status = 'cancelled', decision_comment = c where id = v.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  return app.op_done(p, 'decide_variation', jsonb_build_object('ok', true, 'id', v.id, 'status', (select status from public.variations where id = v.id)));
end $$;

-- ---------------------------------------------------------------------------
-- IPC
-- ---------------------------------------------------------------------------
-- (Re)build the lines of a draft IPC: every BoQ item with work to date or billed before; quantities to date
-- default to verified progress at period_to (re-measured lines keep their claimed quantity).
create or replace function app.ipc_build_lines(p_ipc uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i public.client_ipcs; v_prev uuid;
begin
  select * into i from public.client_ipcs where id = p_ipc;
  select id into v_prev from public.client_ipcs
   where project_id = i.project_id and ipc_no < i.ipc_no and status <> 'cancelled' order by ipc_no desc limit 1;
  with v as (select * from app.billing_verified_qty(i.project_id, i.period_to)),
  pr as (select boq_item_id, coalesce(certified_cum_qty, cum_qty) as q from public.client_ipc_lines where ipc_id = v_prev),
  items as (
    select b.id, b.item_no, b.description, b.unit, b.quantity, coalesce(r.rate, 0) as rate,
           coalesce(v.qty, 0) as vq, coalesce(pr.q, 0) as pq
    from public.boq_items b
    left join public.boq_rates r on r.boq_item_id = b.id
    left join v on v.boq_item_id = b.id
    left join pr on pr.boq_item_id = b.id
    where b.project_id = i.project_id and b.deleted_at is null and (coalesce(v.qty, 0) > 0 or coalesce(pr.q, 0) > 0))
  insert into public.client_ipc_lines (ipc_id, project_id, boq_item_id, item_no, description, unit, contract_qty, rate, verified_qty, prev_qty, cum_qty)
  select p_ipc, i.project_id, id, item_no, description, unit, quantity, rate, round(vq, 3), round(pq, 3), round(greatest(vq, pq), 3) from items
  on conflict (ipc_id, boq_item_id) do update set item_no = excluded.item_no, description = excluded.description, unit = excluded.unit,
    contract_qty = excluded.contract_qty, rate = excluded.rate, verified_qty = excluded.verified_qty, prev_qty = excluded.prev_qty,
    cum_qty = case when public.client_ipc_lines.remeasured then public.client_ipc_lines.cum_qty else excluded.cum_qty end;
end $$;
revoke execute on function app.ipc_build_lines(uuid) from public;

-- Create or update a draft: {id, project_id, period_to, period_from?, mos_value?, price_adjustment?, remarks?, is_final?,
--   lines?: [{boq_item_id, cum_qty}] (re-measured cumulative), refresh?: bool, prepare?: bool (send to the coordinator)}
create or replace function public.save_client_ipc(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_project uuid := (p ->> 'project_id')::uuid; i public.client_ipcs; v_prev public.client_ipcs; x record; v_no int;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'office_engineer', 'coordinator', 'manager', 'admin');
  if not exists (select 1 from public.client_contracts where project_id = v_project) then
    raise exception 'Enter the contract terms first (contract sum, retention, advance)';
  end if;
  select * into i from public.client_ipcs where id = v_id for update;
  if not found then
    if exists (select 1 from public.client_ipcs where project_id = v_project and status in ('draft','prepared','checked')) then
      raise exception 'IPC % is still being prepared — finish or cancel it first',
        (select ipc_no from public.client_ipcs where project_id = v_project and status in ('draft','prepared','checked') order by ipc_no limit 1);
    end if;
    select * into v_prev from public.client_ipcs where project_id = v_project and status <> 'cancelled' order by ipc_no desc limit 1;
    v_no := coalesce(v_prev.ipc_no, 0) + 1;
    if (p ->> 'period_to') is null then raise exception 'Enter the period end (measurement date)'; end if;
    if v_prev.id is not null and (p ->> 'period_to')::date <= v_prev.period_to then
      raise exception 'The period must end after IPC % (%)', v_prev.ipc_no, v_prev.period_to;
    end if;
    insert into public.client_ipcs (id, project_id, ipc_no, period_from, period_to, mos_value, price_adjustment, remarks, is_final, created_by)
    values (v_id, v_project, v_no, coalesce((p ->> 'period_from')::date, v_prev.period_to + 1), (p ->> 'period_to')::date,
      coalesce((p ->> 'mos_value')::numeric, 0), coalesce((p ->> 'price_adjustment')::numeric, 0), nullif(p ->> 'remarks', ''),
      coalesce((p ->> 'is_final')::boolean, false), auth.uid());
    perform app.ipc_build_lines(v_id);
  else
    if i.project_id <> v_project then raise exception 'IPC belongs to another project'; end if;
    if i.status <> 'draft' then raise exception 'IPC % is % — return it to draft to change it', i.ipc_no, i.status; end if;
    update public.client_ipcs set
      period_from = coalesce((p ->> 'period_from')::date, period_from), period_to = coalesce((p ->> 'period_to')::date, period_to),
      mos_value = coalesce((p ->> 'mos_value')::numeric, mos_value), price_adjustment = coalesce((p ->> 'price_adjustment')::numeric, price_adjustment),
      remarks = coalesce(nullif(p ->> 'remarks', ''), remarks), is_final = coalesce((p ->> 'is_final')::boolean, is_final)
    where id = v_id;
    if coalesce((p ->> 'refresh')::boolean, false) or (p ->> 'period_to') is not null then perform app.ipc_build_lines(v_id); end if;
  end if;
  if (select mos_value < 0 from public.client_ipcs where id = v_id) then raise exception 'Materials on site cannot be negative'; end if;
  for x in select * from jsonb_to_recordset(coalesce(p -> 'lines', '[]'::jsonb)) as y(boq_item_id uuid, cum_qty numeric) loop
    if x.cum_qty is null or x.cum_qty < 0 then raise exception 'Quantity to date must be zero or more'; end if;
    if not exists (select 1 from public.client_ipc_lines where ipc_id = v_id and boq_item_id = x.boq_item_id) then
      insert into public.client_ipc_lines (ipc_id, project_id, boq_item_id, item_no, description, unit, contract_qty, rate, cum_qty, remeasured)
      select v_id, v_project, b.id, b.item_no, b.description, b.unit, b.quantity, coalesce(r.rate, 0), x.cum_qty, true
        from public.boq_items b left join public.boq_rates r on r.boq_item_id = b.id where b.id = x.boq_item_id and b.project_id = v_project;
      if not found then raise exception 'BoQ item is not in this project'; end if;
    else
      update public.client_ipc_lines set cum_qty = x.cum_qty, remeasured = (x.cum_qty <> verified_qty)
       where ipc_id = v_id and boq_item_id = x.boq_item_id;
    end if;
    if (select cum_qty < prev_qty from public.client_ipc_lines where ipc_id = v_id and boq_item_id = x.boq_item_id)
       and nullif(p ->> 'remarks', '') is null and (select remarks from public.client_ipcs where id = v_id) is null then
      raise exception 'Quantity to date is less than the previous certificate — add a remark explaining the correction';
    end if;
  end loop;
  update public.client_ipcs set claimed = app.ipc_totals(v_id, 'claimed') where id = v_id;
  if coalesce((p ->> 'prepare')::boolean, false) then
    if not exists (select 1 from public.client_ipc_lines where ipc_id = v_id and cum_qty > 0) and (select mos_value = 0 from public.client_ipcs where id = v_id) then
      raise exception 'Nothing to bill: no verified progress and no materials on site';
    end if;
    update public.client_ipcs set status = 'prepared', prepared_by = auth.uid(), prepared_at = now(), return_comment = null where id = v_id;
    perform app.notify_roles(v_project, '{coordinator}', 'IPC ' || (select ipc_no from public.client_ipcs where id = v_id) || ' to check',
      'Payment certificate to the client', 'client_ipc', v_id);
  end if;
  select * into i from public.client_ipcs where id = v_id;
  return app.op_done(p, 'save_client_ipc', jsonb_build_object('ok', true, 'id', v_id, 'ipc_no', i.ipc_no, 'status', i.status, 'claimed', i.claimed));
end $$;

-- action: check (coordinator: prepared → checked), submit (manager: checked → submitted), return (→ draft, comment),
-- certify (coordinator/manager: submitted → certified; certified_lines [{boq_item_id, cum_qty}], certified_mos_value,
-- certified_price_adjustment, consultant_ref, certified_on), pay (finance/manager/admin: certified → paid),
-- cancel (draft/prepared)
create or replace function public.decide_client_ipc(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); i public.client_ipcs; a text := p ->> 'action'; c text := nullif(trim(p ->> 'comment'), '');
  x record; v_cert jsonb; v_amt numeric;
begin
  if v_seen is not null then return v_seen; end if;
  select * into i from public.client_ipcs where id = (p ->> 'ipc_id')::uuid for update;
  if not found then raise exception 'IPC not found'; end if;
  if a = 'check' then
    perform app.billing_guard(i.project_id, 'coordinator', 'admin');
    if i.status <> 'prepared' then raise exception 'IPC % is % — only a prepared IPC can be checked', i.ipc_no, i.status; end if;
    if i.prepared_by = auth.uid() and not app.has_role_txt('admin') then raise exception 'The preparer cannot check their own IPC' using errcode = '42501'; end if;
    update public.client_ipcs set status = 'checked', checked_by = auth.uid(), checked_at = now() where id = i.id;
    perform app.notify_roles(i.project_id, '{manager}', 'IPC ' || i.ipc_no || ' to approve', 'Checked by the coordinator', 'client_ipc', i.id);
  elsif a = 'submit' then
    perform app.billing_guard(i.project_id, 'manager', 'admin');
    if i.status <> 'checked' then raise exception 'IPC % must be checked by the coordinator before it is submitted', i.ipc_no; end if;
    update public.client_ipcs set status = 'submitted', submitted_by = auth.uid(), submitted_at = now(),
      claimed = app.ipc_totals(i.id, 'claimed') where id = i.id;
  elsif a = 'return' then
    perform app.billing_guard(i.project_id, 'coordinator', 'manager', 'admin');
    if i.status not in ('prepared','checked','submitted') then raise exception 'IPC % is % and cannot be returned', i.ipc_no, i.status; end if;
    if c is null then raise exception 'Say what needs correcting'; end if;
    update public.client_ipcs set status = 'draft', return_comment = c where id = i.id;
    if i.prepared_by is not null then
      perform app.notify_user(i.prepared_by, i.project_id, 'IPC ' || i.ipc_no || ' returned', c, 'client_ipc', i.id);
    end if;
  elsif a = 'certify' then
    perform app.billing_guard(i.project_id, 'coordinator', 'manager', 'admin');
    if i.status <> 'submitted' then raise exception 'Only a submitted IPC can be certified'; end if;
    update public.client_ipc_lines set certified_cum_qty = null where ipc_id = i.id;
    for x in select * from jsonb_to_recordset(coalesce(p -> 'certified_lines', '[]'::jsonb)) as y(boq_item_id uuid, cum_qty numeric) loop
      if x.cum_qty is null or x.cum_qty < 0 then raise exception 'Certified quantity must be zero or more'; end if;
      update public.client_ipc_lines set certified_cum_qty = x.cum_qty where ipc_id = i.id and boq_item_id = x.boq_item_id;
    end loop;
    update public.client_ipcs set certified_mos_value = coalesce((p ->> 'certified_mos_value')::numeric, mos_value),
      certified_price_adjustment = coalesce((p ->> 'certified_price_adjustment')::numeric, price_adjustment),
      consultant_ref = nullif(p ->> 'consultant_ref', ''), certified_on = coalesce((p ->> 'certified_on')::date, app.local_date(now())),
      certified_by = auth.uid()
    where id = i.id;
    v_cert := app.ipc_totals(i.id, 'certified');
    update public.client_ipcs set certified = v_cert, status = 'certified' where id = i.id;
    perform app.notify_roles(i.project_id, '{manager,coordinator}', 'IPC ' || i.ipc_no || ' certified',
      'Payable ' || to_char((v_cert ->> 'payable')::numeric, 'FM999,999,999,990.00'), 'client_ipc', i.id);
  elsif a = 'pay' then
    perform app.billing_guard(i.project_id, 'finance', 'manager', 'admin');
    if i.status not in ('certified','paid') then raise exception 'Only a certified IPC can be marked paid'; end if;
    v_amt := (p ->> 'amount')::numeric;
    if v_amt is null or v_amt <= 0 then raise exception 'Enter the amount received'; end if;
    update public.client_ipcs set paid_amount = paid_amount + v_amt, paid_on = coalesce((p ->> 'paid_on')::date, app.local_date(now())),
      payment_ref = coalesce(nullif(p ->> 'payment_ref', ''), payment_ref), paid_by = auth.uid(),
      status = case when paid_amount + v_amt >= coalesce((certified ->> 'payable')::numeric, 0) - 0.005 then 'paid' else 'certified' end
    where id = i.id;
  elsif a = 'cancel' then
    perform app.billing_guard(i.project_id, 'coordinator', 'manager', 'admin');
    if i.status not in ('draft','prepared') then raise exception 'Only a draft IPC can be cancelled'; end if;
    if exists (select 1 from public.client_ipcs where project_id = i.project_id and ipc_no > i.ipc_no and status <> 'cancelled') then
      raise exception 'A later IPC exists';
    end if;
    update public.client_ipcs set status = 'cancelled', return_comment = c where id = i.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  select * into i from public.client_ipcs where id = i.id;
  return app.op_done(p, 'decide_client_ipc', jsonb_build_object('ok', true, 'id', i.id, 'status', i.status,
    'claimed', i.claimed, 'certified', i.certified, 'paid_amount', i.paid_amount));
end $$;

-- ---------------------------------------------------------------------------
-- approvals inbox
-- ---------------------------------------------------------------------------
create or replace function app.billing_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_prices boolean;
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  v_prices := v_role = 'admin' or v_role = any (coalesce((select s.price_roles::text[] from public.app_settings s where s.id = 1), '{}'));
  if not v_prices then return; end if;
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin')
  select 'client_ipc'::text, 'client_ipc'::text, i.id, i.project_id, 'IPC ' || i.ipc_no,
         case i.status when 'prepared' then 'Check payment certificate ' when 'checked' then 'Approve & submit payment certificate '
                       when 'submitted' then 'Record consultant certification — IPC ' else 'Record client payment — IPC ' end
           || case when i.status in ('prepared','checked') then i.ipc_no::text else i.ipc_no::text end
           || ' (' || to_char(coalesce((coalesce(i.certified, i.claimed) ->> 'payable')::numeric, 0), 'FM999,999,999,990') || ' ETB)',
         i.status, coalesce(i.prepared_by, i.created_by), coalesce(i.checked_at, i.prepared_at, i.submitted_at, i.created_at), false,
         array['open'], round((extract(epoch from now() - coalesce(i.checked_at, i.prepared_at, i.created_at)) / 3600)::numeric, 1)
  from public.client_ipcs i
  where i.project_id in (select pid from mem)
    and ((i.status = 'prepared' and v_role in ('coordinator','admin') and i.prepared_by is distinct from p_user)
      or (i.status = 'checked' and v_role in ('manager','admin'))
      or (i.status = 'certified' and v_role in ('finance','admin') and i.paid_amount < coalesce((i.certified ->> 'payable')::numeric, 0)))
  union all
  select 'variation'::text, 'variation'::text, v.id, v.project_id, v.number,
         case v.status when 'pending' then 'Approve variation ' else 'Record client decision — ' end || v.title
           || ' (' || to_char(v.amount, 'FM999,999,999,990') || ' ETB)',
         v.status, v.created_by, v.updated_at, false, array['open'],
         round((extract(epoch from now() - v.updated_at) / 3600)::numeric, 1)
  from public.variations v
  where v.project_id in (select pid from mem)
    and ((v.status = 'pending' and v_role in ('manager','admin')));
end $$;
revoke execute on function app.billing_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.billing_approvals_for') on conflict do nothing;
