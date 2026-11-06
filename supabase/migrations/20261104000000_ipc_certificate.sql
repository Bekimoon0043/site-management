-- =============================================================================
-- Payment certificate in the company's layout (template "CCECC 2nd payment"):
--
--   1  value of work executed (and materials) to date
--   2  total previous payment            = value to date of the previous certificate
--   3  rebate         rebate % × (1 − 2)
--   4  retention      retention % × (1 − 2)   (cumulative capped at the limit; released on the final IPC)
--   5  penalty        6 material delivered (client-supplied materials)
--   7  total deduction = 2 + 3 + 4 + 5 + 6
--   8  net before advance repayment & VAT = 1 − 7
--   9  advance repayment (this certificate)      10 net after advance = 8 − 9
--  11  withholding    wht % × (1 − 2)          12 VAT  vat % × (1 − 2)
--      total to the contractor = 10 − 11 + 12
--
-- Contract summary adds a supplementary contract, the rebate % and the signing date; the company logo for printed
-- forms lives in app_settings. Re-runnable.
-- =============================================================================

alter table public.app_settings add column if not exists company_logo text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'app_settings_company_logo_size') then
    alter table public.app_settings add constraint app_settings_company_logo_size
      check (company_logo is null or (company_logo like 'data:image/%' and length(company_logo) <= 700000));
  end if;
end $$;

alter table public.client_contracts add column if not exists supplementary_sum numeric(18,2) not null default 0;
alter table public.client_contracts add column if not exists rebate_pct numeric(5,2) not null default 0;
alter table public.client_contracts add column if not exists signed_on date;
alter table public.client_ipcs add column if not exists penalty numeric(18,2) not null default 0;
alter table public.client_ipcs add column if not exists material_delivered numeric(18,2) not null default 0;

create or replace function app.ipc_totals(p_ipc uuid, p_basis text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  i public.client_ipcs; c public.client_contracts; v_prev public.client_ipcs; pt jsonb;
  v_work numeric; v_prev_work numeric := 0; v_mos numeric; v_pa numeric; v_value numeric; v_prev_value numeric := 0; v_this numeric;
  v_prev_ret numeric := 0; v_prev_adv numeric := 0; v_limit numeric; v_ret numeric; v_rebate numeric; v_pen numeric; v_mat numeric;
  v_ded numeric; v_before numeric; v_adv_cum numeric; v_adv numeric; v_after numeric; v_vat numeric; v_wht numeric; v_sum numeric;
begin
  select * into i from public.client_ipcs where id = p_ipc;
  select * into c from public.client_contracts where project_id = i.project_id;
  select coalesce(sum(round(case when p_basis = 'certified' then coalesce(l.certified_cum_qty, l.cum_qty) else l.cum_qty end * l.rate, 2)), 0),
         coalesce(sum(round(l.prev_qty * l.rate, 2)), 0)
    into v_work, v_prev_work from public.client_ipc_lines l where l.ipc_id = p_ipc;
  v_mos := round(case when p_basis = 'certified' then coalesce(i.certified_mos_value, i.mos_value) else i.mos_value end
                 * coalesce(c.mos_pct, 0) / 100, 2);
  v_pa := case when p_basis = 'certified' then coalesce(i.certified_price_adjustment, i.price_adjustment) else i.price_adjustment end;
  v_value := v_work + v_mos + v_pa;

  select * into v_prev from public.client_ipcs
   where project_id = i.project_id and ipc_no < i.ipc_no and status <> 'cancelled' order by ipc_no desc limit 1;
  if found then
    pt := coalesce(v_prev.certified, v_prev.claimed);
    v_prev_value := coalesce((pt ->> 'value_cum')::numeric, (pt ->> 'gross_cum')::numeric, 0);
    v_prev_ret := coalesce((pt ->> 'retention_cum')::numeric, 0);
    v_prev_adv := coalesce((pt ->> 'advance_recovery_cum')::numeric, 0);
  end if;
  v_this := v_value - v_prev_value;
  v_sum := coalesce(c.contract_sum, 0) + coalesce(c.supplementary_sum, 0);

  v_rebate := round(v_this * coalesce(c.rebate_pct, 0) / 100, 2);
  v_ret := round(v_this * coalesce(c.retention_pct, 0) / 100, 2);
  if coalesce(c.retention_limit_pct, 0) > 0 and v_sum > 0 then
    v_limit := round(v_sum * c.retention_limit_pct / 100, 2);
    v_ret := least(v_ret, greatest(v_limit - v_prev_ret, 0));
  end if;
  if i.is_final then v_ret := -v_prev_ret; end if;             -- final certificate releases the retention
  v_pen := coalesce(i.penalty, 0);
  v_mat := coalesce(i.material_delivered, 0);
  v_ded := v_prev_value + v_rebate + v_ret + v_pen + v_mat;
  v_before := v_value - v_ded;
  v_adv_cum := round(least(coalesce(c.advance_amount, 0), v_work * coalesce(c.advance_recovery_pct, 0) / 100), 2);
  v_adv := v_adv_cum - v_prev_adv;
  v_after := v_before - v_adv;
  v_wht := round(greatest(v_this, 0) * coalesce(c.wht_pct, 0) / 100, 2);
  v_vat := round(v_this * coalesce(c.vat_pct, 15) / 100, 2);

  return jsonb_build_object(
    -- template lines
    'value_cum', v_value, 'previous_value', v_prev_value, 'this_value', v_this,
    'rebate', v_rebate, 'retention_this', v_ret, 'penalty', v_pen, 'material_delivered', v_mat,
    'total_deduction', v_ded, 'net_before_advance', v_before, 'advance_this', v_adv, 'net_after_advance', v_after,
    'wht', v_wht, 'vat', v_vat, 'payable', v_after - v_wht + v_vat,
    -- breakdown / cumulative
    'work_cum', v_work, 'work_prev', v_prev_work, 'work_this', v_work - v_prev_work,
    'mos', v_mos, 'price_adjustment', v_pa, 'gross_cum', v_value,
    'retention_cum', v_prev_ret + v_ret, 'advance_recovery_cum', v_adv_cum,
    'net_cum', v_value - (v_prev_ret + v_ret) - v_adv_cum, 'previous_net', v_prev_value,
    'this_net', v_after, 'total_incl_vat', v_after + v_vat,
    'rebate_pct', coalesce(c.rebate_pct, 0), 'retention_pct', c.retention_pct, 'advance_recovery_pct', c.advance_recovery_pct,
    'vat_pct', coalesce(c.vat_pct, 15), 'wht_pct', c.wht_pct, 'mos_pct', c.mos_pct, 'contract_sum', c.contract_sum,
    'progress_pct', case when v_sum > 0 then round(v_work / v_sum * 100, 2) end);
end $$;
revoke execute on function app.ipc_totals(uuid, text) from public;

create or replace function public.save_client_contract(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_adv_pct numeric;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'coordinator', 'manager', 'admin');
  v_adv_pct := nullif(p ->> 'advance_recovery_pct', '')::numeric;
  insert into public.client_contracts (project_id, contract_no, client_name, consultant_name, contract_sum, vat_pct, advance_amount,
    advance_recovery_pct, retention_pct, retention_limit_pct, mos_pct, wht_pct, supplementary_sum, rebate_pct, signed_on, updated_by)
  values (v_project, nullif(p ->> 'contract_no', ''), nullif(p ->> 'client_name', ''), nullif(p ->> 'consultant_name', ''),
    coalesce((p ->> 'contract_sum')::numeric, 0), coalesce((p ->> 'vat_pct')::numeric, 15), coalesce((p ->> 'advance_amount')::numeric, 0),
    coalesce(v_adv_pct, case when coalesce((p ->> 'contract_sum')::numeric, 0) > 0
                             then round(coalesce((p ->> 'advance_amount')::numeric, 0) / (p ->> 'contract_sum')::numeric * 100, 2) else 0 end),
    coalesce((p ->> 'retention_pct')::numeric, 5), coalesce((p ->> 'retention_limit_pct')::numeric, 5),
    coalesce((p ->> 'mos_pct')::numeric, 0), coalesce((p ->> 'wht_pct')::numeric, 3),
    coalesce(nullif(p ->> 'supplementary_sum', '')::numeric, 0), coalesce(nullif(p ->> 'rebate_pct', '')::numeric, 0),
    nullif(p ->> 'signed_on', '')::date, auth.uid())
  on conflict (project_id) do update set contract_no = excluded.contract_no, client_name = excluded.client_name,
    consultant_name = excluded.consultant_name, contract_sum = excluded.contract_sum, vat_pct = excluded.vat_pct,
    advance_amount = excluded.advance_amount, advance_recovery_pct = excluded.advance_recovery_pct,
    retention_pct = excluded.retention_pct, retention_limit_pct = excluded.retention_limit_pct, mos_pct = excluded.mos_pct,
    wht_pct = excluded.wht_pct, supplementary_sum = excluded.supplementary_sum, rebate_pct = excluded.rebate_pct,
    signed_on = excluded.signed_on, updated_by = auth.uid();
  if (select advance_amount > contract_sum and contract_sum > 0 from public.client_contracts where project_id = v_project) then
    raise exception 'The advance cannot be more than the contract sum';
  end if;
  if (select supplementary_sum < 0 or rebate_pct not between 0 and 100 from public.client_contracts where project_id = v_project) then
    raise exception 'Supplementary contract cannot be negative and the rebate must be 0–100 %%';
  end if;
  return app.op_done(p, 'save_client_contract', jsonb_build_object('ok', true, 'project_id', v_project));
end $$;

-- As 20261103000060 plus penalty and material_delivered (client-supplied materials) per certificate.
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
    insert into public.client_ipcs (id, project_id, ipc_no, period_from, period_to, mos_value, price_adjustment, penalty, material_delivered,
      remarks, is_final, created_by)
    values (v_id, v_project, v_no, coalesce((p ->> 'period_from')::date, v_prev.period_to + 1), (p ->> 'period_to')::date,
      coalesce((p ->> 'mos_value')::numeric, 0), coalesce((p ->> 'price_adjustment')::numeric, 0),
      coalesce((p ->> 'penalty')::numeric, 0), coalesce((p ->> 'material_delivered')::numeric, 0), nullif(p ->> 'remarks', ''),
      coalesce((p ->> 'is_final')::boolean, false), auth.uid());
    perform app.ipc_build_lines(v_id);
  else
    if i.project_id <> v_project then raise exception 'IPC belongs to another project'; end if;
    if i.status <> 'draft' then raise exception 'IPC % is % — return it to draft to change it', i.ipc_no, i.status; end if;
    update public.client_ipcs set
      period_from = coalesce((p ->> 'period_from')::date, period_from), period_to = coalesce((p ->> 'period_to')::date, period_to),
      mos_value = coalesce((p ->> 'mos_value')::numeric, mos_value), price_adjustment = coalesce((p ->> 'price_adjustment')::numeric, price_adjustment),
      penalty = coalesce((p ->> 'penalty')::numeric, penalty), material_delivered = coalesce((p ->> 'material_delivered')::numeric, material_delivered),
      remarks = coalesce(nullif(p ->> 'remarks', ''), remarks), is_final = coalesce((p ->> 'is_final')::boolean, is_final)
    where id = v_id;
    if coalesce((p ->> 'refresh')::boolean, false) or (p ->> 'period_to') is not null then perform app.ipc_build_lines(v_id); end if;
  end if;
  if (select mos_value < 0 or penalty < 0 or material_delivered < 0 from public.client_ipcs where id = v_id) then
    raise exception 'Materials on site, penalty and materials delivered cannot be negative';
  end if;
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

-- Recalculate open certificates with the new layout's figures.
update public.client_ipcs set claimed = app.ipc_totals(id, 'claimed') where status in ('draft','prepared','checked');
