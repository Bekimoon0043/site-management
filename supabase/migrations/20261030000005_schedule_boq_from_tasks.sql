-- =============================================================================
-- "The schedule IS the BoQ": create BoQ items, rates, task links, EV method and task budgets from an imported
-- MS Project schedule whose leaf tasks are BoQ items with Unit / Qty / Rate / Amount in custom fields
-- (e.g. Text1 "Unit", Number1 "Qty", Number2 "Rate" ex-VAT, Cost1 "Amount" incl. 15 % VAT).
-- See docs/research/progress-evm.md §2.3 ("The schedule IS the BoQ").
--
-- RPC public.create_boq_from_schedule(p jsonb) — called by the web wizard right after import_schedule.
--
-- VALUE CONTRACT
--   * Values are read from schedule_tasks.custom (what the client sent with import_schedule).
--   * Qty and Rate are taken as written. Rate is the ex-VAT unit rate.
--   * Amount: the web parser already divides custom Cost1..Cost10 by the MSPDI currency scale (100), so the
--     values in `custom` are in currency units and amount_scale defaults to 1. Pass amount_scale = 100 only for
--     schedules imported with raw (hundredths) custom cost values.
--   * vat_included: whether Amount includes VAT (null → detected: median Amount ÷ (Qty × Rate) > 1.01).
--     vat_pct: default tax_settings.vat_rate in force (else 15).
--   * Rate missing → derived from Amount: Amount ÷ amount_scale ÷ Qty ÷ (1 + VAT if included).
--   * BUDGET RULE: the EV value basis is EX-VAT — boq_rates.rate is the ex-VAT rate, so set_baseline's
--     bac_value = Σ qty_share × rate is ex-VAT (VAT is a pass-through tax, not earned value). Both figures are
--     stored on schedule_task_costs: budget_ex_vat (= Qty × Rate, the basis) and budget_incl_vat (the file's
--     Amount when it includes VAT, else ex-VAT × (1 + VAT)) for reconciliation with the MS Project Cost.
--   * Rates, budgets and totals are written / returned only when app.can_see_prices(); other roles
--     (office engineer) still get the items, quantities, links and EV method.
-- =============================================================================

alter table public.schedule_task_costs
  add column if not exists budget_ex_vat    numeric(18,2),
  add column if not exists budget_incl_vat  numeric(18,2),
  add column if not exists budget_vat_pct   numeric(5,2),
  add column if not exists budget_source    text check (budget_source in ('schedule_boq'));

-- Same rules as normalizeUnit (web/src/lib/msp/boq.ts): case, superscripts, '^' and common variants.
create or replace function app.norm_unit(p_u text) returns text
language sql immutable as $$
  with k as (
    select lower(regexp_replace(translate(btrim(p_u), '²³¹^', '231'), '\s+', ' ', 'g')) as k1),
  k2 as (select k1, regexp_replace(k1, '[\s.]', '', 'g') as k2 from k),
  m(k, v) as (values
    ('m2','m2'),('sqm','m2'),('sqmt','m2'),('msq','m2'),('sq m','m2'),('sq.m','m2'),('sq. m','m2'),
    ('m3','m3'),('cum','m3'),('cumt','m3'),('cu m','m3'),('cu.m','m3'),('cu. m','m3'),
    ('m','m'),('mt','m'),('mtr','m'),('meter','m'),('metre','m'),
    ('ml','ml'),('lm','ml'),('rm','ml'),('l.m','ml'),('m.l','ml'),('lin m','ml'),('lin.m','ml'),('running m','ml'),
    ('kg','kg'),('kgs','kg'),('kilogram','kg'),('ton','ton'),('tons','ton'),('tonne','ton'),('t','ton'),('qtl','qtl'),('quintal','qtl'),
    ('no','No'),('no.','No'),('nos','No'),('nos.','No'),('nr','No'),('number','No'),('pcs','pcs'),('pc','pcs'),('each','No'),('ea','No'),
    ('ls','LS'),('l.s','LS'),('l.s.','LS'),('lump sum','LS'),('lumpsum','LS'),('set','set'),('sets','set'),('pair','pair'),
    ('l','l'),('lt','l'),('ltr','l'),('litre','l'),('liter','l'),('hr','hr'),('hrs','hr'),('day','day'),('days','day'),('month','month'))
  select case when nullif(btrim(p_u), '') is null then null else coalesce(
    (select m.v from m, k2 where m.k = k2.k1), (select m.v from m, k2 where m.k = k2.k2),
    regexp_replace(btrim(p_u), '\s+', ' ', 'g')) end
$$;

-- Custom-field text → number ('1,234.50' → 1234.5); null when empty / not numeric.
create or replace function app.custom_num(p_v text) returns numeric
language plpgsql immutable as $$
declare s text := regexp_replace(coalesce(p_v, ''), '[^0-9.eE+-]', '', 'g');
begin
  if s = '' then return null; end if;
  return s::numeric;
exception when others then return null;
end $$;

create or replace function public.create_boq_from_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; t public.schedule_tasks; par public.schedule_tasks; bi public.boq_items;
  v_fields jsonb; v_prices boolean := app.can_see_prices();
  v_uf text; v_qf text; v_rf text; v_af text;
  v_scale numeric := coalesce(nullif(p ->> 'amount_scale', '')::numeric, 1);
  v_vat_inc boolean := (p ->> 'vat_included')::boolean;
  v_vat numeric := coalesce(nullif(p ->> 'vat_pct', '')::numeric, (app.tax_for(app.eat_date(now()))).vat_rate, 15);
  v_no_from text := coalesce(nullif(p ->> 'item_no_from', ''), 'wbs');
  v_desc_mode text := coalesce(nullif(p ->> 'description_mode', ''), 'auto');
  v_set_budget boolean := coalesce((p ->> 'set_budget')::boolean, true);
  v_set_ev boolean := coalesce((p ->> 'set_ev_method')::boolean, true);
  v_replace boolean := coalesce((p ->> 'replace_links')::boolean, true);
  v_qty numeric; v_rate numeric; v_amt numeric; v_unit text; v_no text; v_desc text; v_ex numeric; v_inc numeric;
  v_item uuid; v_used text[] := '{}'; v_warn jsonb := '[]'::jsonb; v_refresh uuid[] := '{}';
  v_created int := 0; v_updated int := 0; v_same int := 0; v_links int := 0; v_methods int := 0; v_rates int := 0; v_budgets int := 0;
  v_no_qty int := 0; v_summ int := 0; v_tot_ex numeric := 0; v_tot_inc numeric := 0; v_mismatch int := 0; v_no_rate int := 0;
  v_no_unit int := 0; v_kept_method int := 0; v_closed boolean;
  v_factor numeric;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if v_no_from not in ('wbs','outline_number') then raise exception 'item_no_from must be wbs or outline_number'; end if;
  if v_desc_mode not in ('auto','name','parent_and_name') then raise exception 'description_mode must be auto, name or parent_and_name'; end if;
  if v_scale <= 0 then raise exception 'amount_scale must be greater than zero'; end if;
  if v_vat < 0 or v_vat > 100 then raise exception 'vat_pct must be between 0 and 100'; end if;

  -- fields: FieldName (Text1) or alias (Unit), resolved against the custom-field list of the current version
  select coalesce(v.header -> 'custom_fields', '[]'::jsonb) into v_fields from public.schedule_versions v where v.id = sc.current_version_id;
  v_fields := coalesce(v_fields, '[]'::jsonb);
  select coalesce((select f ->> 'field_name' from jsonb_array_elements(v_fields) f
                   where lower(f ->> 'field_name') = lower(x.k) or lower(f ->> 'alias') = lower(x.k) limit 1), x.k)
    into v_qf from (select nullif(btrim(p ->> 'qty_field'), '') k) x;
  select coalesce((select f ->> 'field_name' from jsonb_array_elements(v_fields) f
                   where lower(f ->> 'field_name') = lower(x.k) or lower(f ->> 'alias') = lower(x.k) limit 1), x.k)
    into v_uf from (select nullif(btrim(p ->> 'unit_field'), '') k) x;
  select coalesce((select f ->> 'field_name' from jsonb_array_elements(v_fields) f
                   where lower(f ->> 'field_name') = lower(x.k) or lower(f ->> 'alias') = lower(x.k) limit 1), x.k)
    into v_rf from (select nullif(btrim(p ->> 'rate_field'), '') k) x;
  select coalesce((select f ->> 'field_name' from jsonb_array_elements(v_fields) f
                   where lower(f ->> 'field_name') = lower(x.k) or lower(f ->> 'alias') = lower(x.k) limit 1), x.k)
    into v_af from (select nullif(btrim(p ->> 'amount_field'), '') k) x;
  if v_qf is null then raise exception 'Choose the custom field that holds the quantity (e.g. Number1 "Qty")'; end if;
  if v_rf is null and v_af is null then
    v_warn := v_warn || to_jsonb('No rate or amount field chosen: BoQ items get quantities only'::text);
  end if;

  -- VAT in the amount (when not told): median Amount ÷ (Qty × Rate) over the leaves
  if v_vat_inc is null then
    if v_rf is not null and v_af is not null then
      select percentile_cont(0.5) within group (order by r) into v_factor from (
        select (app.custom_num(custom ->> v_af) / v_scale) / (app.custom_num(custom ->> v_qf) * app.custom_num(custom ->> v_rf)) r
        from public.schedule_tasks
        where schedule_id = sc.id and deleted_at is null and not is_summary
          and app.custom_num(custom ->> v_qf) > 0 and app.custom_num(custom ->> v_rf) > 0 and app.custom_num(custom ->> v_af) > 0) z;
      v_vat_inc := coalesce(v_factor > 1.01, false);
    else
      v_vat_inc := false;
    end if;
  end if;
  v_closed := exists (select 1 from public.evm_periods where project_id = sc.project_id and status = 'closed');

  for t in select * from public.schedule_tasks where schedule_id = sc.id and deleted_at is null and source_state = 'active'
           order by sort_order loop
    if t.is_summary then v_summ := v_summ + 1; continue; end if;     -- summaries carry rolled-up junk Qty / Rate
    v_qty := round(app.custom_num(t.custom ->> v_qf), 3);
    if v_qty is null or v_qty <= 0 then v_no_qty := v_no_qty + 1; continue; end if;
    v_rate := case when v_rf is not null then app.custom_num(t.custom ->> v_rf) end;
    v_amt := case when v_af is not null then round(app.custom_num(t.custom ->> v_af) / v_scale, 2) end;
    if (v_rate is null or v_rate <= 0) and v_amt is not null and v_amt > 0 then
      v_rate := v_amt / v_qty / (case when v_vat_inc then 1 + v_vat / 100 else 1 end);
    end if;
    v_rate := round(nullif(v_rate, 0), 2);
    if v_rate is null then v_no_rate := v_no_rate + 1; end if;
    v_ex := round(v_qty * v_rate, 2);
    v_inc := case when v_vat_inc and v_amt is not null then v_amt else round(v_ex * (1 + v_vat / 100), 2) end;
    if v_amt is not null and v_rf is not null and v_ex is not null and v_ex > 0
       and abs(v_amt / (v_ex * (case when v_vat_inc then 1 + v_vat / 100 else 1 end)) - 1) > 0.01 then
      v_mismatch := v_mismatch + 1;
      if v_mismatch <= 20 then
        v_warn := v_warn || to_jsonb(format('Task %s "%s": Amount %s ≠ Qty %s × Rate %s%s', t.msp_uid, t.name, v_amt, v_qty, v_rate,
                                            case when v_vat_inc then format(' × %s', 1 + v_vat / 100) else '' end));
      end if;
    end if;
    v_unit := app.norm_unit(case when v_uf is not null then t.custom ->> v_uf end);
    if v_unit is null then v_no_unit := v_no_unit + 1; v_unit := 'item'; end if;

    -- item number (unique in the project) and description
    v_no := btrim(coalesce(case when v_no_from = 'wbs' then coalesce(nullif(t.wbs, ''), nullif(t.outline_number, ''))
                                else coalesce(nullif(t.outline_number, ''), nullif(t.wbs, '')) end, 'T' || t.msp_uid));
    if lower(v_no) = any (v_used) then
      v_warn := v_warn || to_jsonb(format('Task %s "%s": item number %s used twice — saved as %s/%s', t.msp_uid, t.name, v_no, v_no, t.msp_uid));
      v_no := v_no || '/' || t.msp_uid;
    end if;
    v_used := v_used || lower(v_no);
    select * into par from public.schedule_tasks where id = t.parent_id;
    v_desc := btrim(t.name);
    if par.id is not null and (v_desc_mode = 'parent_and_name'
         or (v_desc_mode = 'auto' and t.name ~* '^\s*\(?([a-z]{1,2}|[ivx]{1,5}|[0-9]{1,2})\)\s*')) then
      v_desc := btrim(par.name) || ' – ' || v_desc;
    end if;

    -- BoQ item (idempotent by project + item number; a soft-deleted one is restored)
    select * into bi from public.boq_items where project_id = sc.project_id and item_no = v_no;
    if bi.id is null then
      insert into public.boq_items (project_id, item_no, description, unit, quantity)
      values (sc.project_id, v_no, v_desc, v_unit, v_qty) returning id into v_item;
      v_created := v_created + 1;
    else
      v_item := bi.id;
      if bi.description is distinct from v_desc or bi.unit is distinct from v_unit or bi.quantity is distinct from v_qty
         or bi.deleted_at is not null then
        update public.boq_items set description = v_desc, unit = v_unit, quantity = v_qty, deleted_at = null where id = bi.id;
        v_updated := v_updated + 1;
        if not exists (select 1 from public.task_boq_links where task_id = t.id and boq_item_id = bi.id) then
          v_warn := v_warn || to_jsonb(format('BoQ item %s already existed ("%s") and was updated from task %s', v_no, bi.description, t.msp_uid));
        end if;
      else
        v_same := v_same + 1;
      end if;
    end if;

    if v_prices and v_rate is not null then
      insert into public.boq_rates (boq_item_id, rate) values (v_item, v_rate)
      on conflict (boq_item_id) do update set rate = excluded.rate where public.boq_rates.rate is distinct from excluded.rate;
      v_rates := v_rates + 1;
    end if;

    -- link: the task delivers the whole item quantity
    insert into public.task_boq_links (project_id, task_id, boq_item_id, qty_share, source)
    values (sc.project_id, t.id, v_item, v_qty, 'file')
    on conflict (task_id, boq_item_id) do update set qty_share = excluded.qty_share, source = 'file', deleted_at = null
      where public.task_boq_links.qty_share is distinct from excluded.qty_share or public.task_boq_links.deleted_at is not null
         or public.task_boq_links.source <> 'file';
    v_links := v_links + 1;
    if v_replace then
      update public.task_boq_links set deleted_at = now() where task_id = t.id and boq_item_id <> v_item and deleted_at is null;
    end if;

    -- EV method → quantity done (kept when the task already has progress under another method)
    if v_set_ev and t.ev_method <> 'units' then
      if exists (select 1 from public.task_progress where task_id = t.id and status <> 'rejected') or (v_closed and t.pct_complete > 0) then
        v_kept_method := v_kept_method + 1;
      else
        update public.schedule_tasks set ev_method = 'units',
          setup_comment = coalesce(setup_comment, 'EV by BoQ quantity (BoQ created from the schedule)') where id = t.id;
        v_methods := v_methods + 1;
      end if;
    end if;
    v_refresh := v_refresh || t.id;

    -- task budget (price roles)
    if v_prices and v_set_budget and v_ex is not null then
      insert into public.schedule_task_costs (task_id, project_id, budget_ex_vat, budget_incl_vat, budget_vat_pct, budget_source)
      values (t.id, sc.project_id, v_ex, v_inc, v_vat, 'schedule_boq')
      on conflict (task_id) do update set budget_ex_vat = excluded.budget_ex_vat, budget_incl_vat = excluded.budget_incl_vat,
        budget_vat_pct = excluded.budget_vat_pct, budget_source = excluded.budget_source;
      v_budgets := v_budgets + 1;
    end if;
    v_tot_ex := v_tot_ex + coalesce(v_ex, 0); v_tot_inc := v_tot_inc + coalesce(v_inc, 0);
  end loop;

  foreach v_item in array v_refresh loop perform app.refresh_task_progress(v_item, false); end loop;
  perform app.rollup_summaries(sc.id);

  if v_mismatch > 20 then v_warn := v_warn || to_jsonb(format('…and %s more tasks where Amount ≠ Qty × Rate', v_mismatch - 20)); end if;
  if v_no_rate > 0 then v_warn := v_warn || to_jsonb(format('%s item(s) have no rate', v_no_rate)); end if;
  if v_no_unit > 0 then v_warn := v_warn || to_jsonb(format('%s item(s) have no unit — saved as "item"', v_no_unit)); end if;
  if v_kept_method > 0 then
    v_warn := v_warn || to_jsonb(format('%s task(s) already have progress — their EV method was not changed', v_kept_method));
  end if;
  if not v_prices and (v_rf is not null or v_af is not null) then
    v_warn := v_warn || to_jsonb('Rates and budgets were not saved: your role cannot see prices (ask a coordinator or manager to run this again)'::text);
  end if;

  return app.op_done(p, 'create_boq_from_schedule', jsonb_build_object('ok', true, 'schedule_id', sc.id,
    'items_created', v_created, 'items_updated', v_updated, 'items_unchanged', v_same, 'links', v_links,
    'ev_methods_set', v_methods, 'rates_saved', v_rates, 'budgets_saved', v_budgets,
    'skipped', jsonb_build_object('no_qty', v_no_qty, 'summaries', v_summ),
    'fields', jsonb_build_object('unit', v_uf, 'qty', v_qf, 'rate', v_rf, 'amount', v_af),
    'vat_included', v_vat_inc, 'vat_pct', v_vat, 'amount_scale', v_scale,
    'total_amount_ex_vat', case when v_prices then round(v_tot_ex, 2) end,
    'total_amount_incl_vat', case when v_prices then round(v_tot_inc, 2) end,
    'warnings', v_warn));
end $$;
