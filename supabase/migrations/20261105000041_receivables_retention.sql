-- =============================================================================
-- Client receivables ageing and retention release (gap list #3, #4).
--
--  * client_contracts gets payment_days (client pays a certificate within N days of certification — check the
--    GCC/SCC; 28 by default), certify_days (consultant certifies within N days of submission), practical completion
--    date, defects liability period (months) and the share of retention released at practical completion (50 %).
--  * v_client_receivables  per IPC: submitted / certified / due date, payable, received, outstanding, days overdue
--                          and ageing bucket (not certified · not due · 1–30 · 31–60 · 61–90 · 90+).
--  * retention_releases    stage 'practical_completion' (part, usually half) and 'final' (rest after the DLP):
--                          requested → certified → received.
--  * v_retention_status    held (certified retention to date), released, due now per stage.
-- Price data: readable by members with price access (as the IPC tables). Re-runnable.
-- =============================================================================

alter table public.client_contracts add column if not exists payment_days int not null default 28;
alter table public.client_contracts add column if not exists certify_days int not null default 28;
alter table public.client_contracts add column if not exists practical_completion_on date;
alter table public.client_contracts add column if not exists dlp_months int not null default 12;
alter table public.client_contracts add column if not exists retention_pc_release_pct numeric(5,2) not null default 50;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_contracts_completion_terms') then
    alter table public.client_contracts add constraint client_contracts_completion_terms
      check (payment_days between 0 and 365 and certify_days between 0 and 365 and dlp_months between 0 and 60
             and retention_pc_release_pct between 0 and 100);
  end if;
end $$;

create table if not exists public.retention_releases (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  stage            text not null check (stage in ('practical_completion','final')),
  amount           numeric(18,2) not null check (amount >= 0),
  requested_on     date not null,
  certified_on     date,
  received_on      date,
  received_amount  numeric(18,2) not null default 0 check (received_amount >= 0),
  ref              text,
  status           text not null default 'requested' check (status in ('requested','certified','received')),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, stage)
);
alter table public.retention_releases enable row level security;
drop trigger if exists touch_updated_at on public.retention_releases;
create trigger touch_updated_at before update on public.retention_releases for each row execute function app.touch_updated_at();
drop trigger if exists audit on public.retention_releases;
create trigger audit after insert or update or delete on public.retention_releases for each row execute function app.audit();
drop policy if exists price_read on public.retention_releases;
create policy price_read on public.retention_releases for select to authenticated using (app.is_member(project_id) and app.can_see_prices());

create or replace view public.v_client_receivables with (security_invoker = true) as
with b as (
  select i.id, i.project_id, i.ipc_no, i.status, i.period_to, i.submitted_at::date as submitted_on, i.certified_on,
         coalesce((coalesce(i.certified, i.claimed) ->> 'payable')::numeric, 0) as payable, i.paid_amount, i.paid_on,
         c.payment_days, c.certify_days
  from public.client_ipcs i join public.client_contracts c on c.project_id = i.project_id
  where i.status in ('submitted','certified','paid'))
select b.*,
       case when b.status = 'submitted' then b.submitted_on + b.certify_days else b.certified_on + b.payment_days end as due_on,
       greatest(b.payable - b.paid_amount, 0) as outstanding,
       case when b.status = 'paid' or b.payable - b.paid_amount <= 0.005 then 0
            when b.status = 'submitted' then greatest(app.eat_date(now()) - (b.submitted_on + b.certify_days), 0)
            else greatest(app.eat_date(now()) - (b.certified_on + b.payment_days), 0) end as days_overdue,
       case when b.status = 'paid' or b.payable - b.paid_amount <= 0.005 then 'paid'
            when b.status = 'submitted' then 'not_certified'
            when app.eat_date(now()) <= b.certified_on + b.payment_days then 'not_due'
            when app.eat_date(now()) - (b.certified_on + b.payment_days) <= 30 then '1_30'
            when app.eat_date(now()) - (b.certified_on + b.payment_days) <= 60 then '31_60'
            when app.eat_date(now()) - (b.certified_on + b.payment_days) <= 90 then '61_90'
            else '90_plus' end as bucket
from b;
grant select on public.v_client_receivables to authenticated;

create or replace view public.v_retention_status with (security_invoker = true) as
with held as (
  select distinct on (i.project_id) i.project_id, coalesce((i.certified ->> 'retention_cum')::numeric, 0) as held, i.ipc_no
  from public.client_ipcs i where i.status in ('certified','paid') order by i.project_id, i.ipc_no desc),
rel as (
  select project_id,
         coalesce(sum(amount) filter (where stage = 'practical_completion'), 0) as pc_amount,
         max(status) filter (where stage = 'practical_completion') as pc_status,
         coalesce(sum(amount) filter (where stage = 'final'), 0) as final_amount,
         max(status) filter (where stage = 'final') as final_status,
         coalesce(sum(received_amount), 0) as received
  from public.retention_releases group by project_id)
select c.project_id, coalesce(h.held, 0) as held, c.practical_completion_on, c.dlp_months, c.retention_pc_release_pct,
       (c.practical_completion_on + make_interval(months => c.dlp_months))::date as dlp_end,
       round(coalesce(h.held, 0) * c.retention_pc_release_pct / 100, 2) as pc_release_amount,
       coalesce(r.pc_amount, 0) as pc_requested, r.pc_status,
       coalesce(h.held, 0) - coalesce(r.pc_amount, 0) as final_release_amount,
       coalesce(r.final_amount, 0) as final_requested, r.final_status,
       coalesce(r.received, 0) as received,
       coalesce(h.held, 0) - coalesce(r.received, 0) as still_held,
       (c.practical_completion_on is not null and c.practical_completion_on <= app.eat_date(now()) and r.pc_status is null and coalesce(h.held, 0) > 0) as pc_release_due,
       (c.practical_completion_on is not null and (c.practical_completion_on + make_interval(months => c.dlp_months))::date <= app.eat_date(now())
         and r.final_status is null and coalesce(h.held, 0) - coalesce(r.pc_amount, 0) > 0) as final_release_due
from public.client_contracts c left join held h on h.project_id = c.project_id left join rel r on r.project_id = c.project_id;
grant select on public.v_retention_status to authenticated;

-- {project_id, payment_days?, certify_days?, practical_completion_on?, dlp_months?, retention_pc_release_pct?}
create or replace function public.save_contract_completion(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'coordinator', 'manager', 'admin');
  if not exists (select 1 from public.client_contracts where project_id = v_project) then raise exception 'Enter the contract terms first'; end if;
  update public.client_contracts set payment_days = coalesce((p ->> 'payment_days')::int, payment_days),
    certify_days = coalesce((p ->> 'certify_days')::int, certify_days),
    practical_completion_on = case when p ? 'practical_completion_on' then nullif(p ->> 'practical_completion_on', '')::date else practical_completion_on end,
    dlp_months = coalesce((p ->> 'dlp_months')::int, dlp_months),
    retention_pc_release_pct = coalesce((p ->> 'retention_pc_release_pct')::numeric, retention_pc_release_pct), updated_by = auth.uid()
  where project_id = v_project;
  return app.op_done(p, 'save_contract_completion', jsonb_build_object('ok', true));
end $$;

-- {id, project_id, stage, amount?, requested_on?, certified_on?, received_on?, received_amount?, ref?}
-- amount defaults to what v_retention_status says is due for the stage; receipts by finance / management.
create or replace function public.save_retention_release(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_stage text := p ->> 'stage'; r public.retention_releases;
  st record; v_amt numeric; v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
begin
  if v_seen is not null then return v_seen; end if;
  perform app.billing_guard(v_project, 'coordinator', 'manager', 'finance', 'admin');
  if v_stage not in ('practical_completion','final') then raise exception 'Stage: practical_completion or final'; end if;
  select * into st from public.v_retention_status where project_id = v_project;
  if not found or st.practical_completion_on is null then raise exception 'Record the practical completion date first'; end if;
  select * into r from public.retention_releases where project_id = v_project and stage = v_stage for update;
  if not found then
    if not app.has_role_txt('coordinator', 'manager', 'admin') then raise exception 'Coordinators and managers request retention' using errcode = '42501'; end if;
    if v_stage = 'final' and st.dlp_end > app.eat_date(now()) and not coalesce((p ->> 'early')::boolean, false) then
      raise exception 'The defects liability period ends on % — the final retention is due then', st.dlp_end;
    end if;
    v_amt := coalesce((p ->> 'amount')::numeric, case v_stage when 'practical_completion' then st.pc_release_amount else st.final_release_amount end);
    if v_amt <= 0 then raise exception 'No retention is held for this stage'; end if;
    if v_amt > st.held - (case v_stage when 'final' then st.pc_requested else st.final_requested end) + 0.005 then
      raise exception 'Cannot release more than the retention held (%)', st.held;
    end if;
    insert into public.retention_releases (id, project_id, stage, amount, requested_on, ref, created_by)
    values (v_id, v_project, v_stage, v_amt, coalesce(nullif(p ->> 'requested_on', '')::date, app.eat_date(now())), nullif(p ->> 'ref', ''), auth.uid());
    perform app.notify_roles_txt(v_project, '{finance,manager}', 'Retention release requested (' || replace(v_stage, '_', ' ') || ')',
      to_char(v_amt, 'FM999,999,999,990.00') || ' ETB', 'retention_release', v_id);
  else
    v_id := r.id;
    if (p ->> 'received_amount') is not null and not app.has_role_txt('finance', 'manager', 'admin') then
      raise exception 'Finance or the manager records money received' using errcode = '42501';
    end if;
    update public.retention_releases set certified_on = coalesce(nullif(p ->> 'certified_on', '')::date, certified_on),
      received_on = coalesce(nullif(p ->> 'received_on', '')::date, received_on),
      received_amount = received_amount + coalesce((p ->> 'received_amount')::numeric, 0), ref = coalesce(nullif(p ->> 'ref', ''), ref)
    where id = r.id;
    update public.retention_releases set status = case when received_amount >= amount - 0.005 then 'received'
                                                       when certified_on is not null then 'certified' else 'requested' end where id = r.id;
  end if;
  select * into r from public.retention_releases where id = v_id;
  return app.op_done(p, 'save_retention_release', jsonb_build_object('ok', true, 'id', r.id, 'status', r.status, 'amount', r.amount));
end $$;

notify pgrst, 'reload schema';
