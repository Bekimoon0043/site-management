-- =============================================================================
-- Client dashboard: plain-language EVM, commercial position and daily updates.
--
-- These security-definer views expose deliberately narrow, client-safe fields.
-- Contractor actual cost (AC), CPI, supplier rates, payroll, labour/equipment
-- details, draft diaries, internal notes and workflow metadata remain private.
-- =============================================================================

create or replace view public.v_client_dashboard_evm with (security_barrier = true) as
select s.project_id, s.id as schedule_id, p.status_date,
       coalesce(c.contract_sum, 0)::numeric as contract_value,
       p.pct_planned, p.pct_earned, p.spi, p.spi_status, p.spi_t, p.sv_t_days,
       p.forecast_finish, p.baseline_finish, p.late_tasks, p.critical_tasks,
       round(coalesce(c.contract_sum, 0) * coalesce(p.pct_planned, 0) / 100, 2) as planned_value,
       round(coalesce(c.contract_sum, 0) * coalesce(p.pct_earned, 0) / 100, 2) as earned_value,
       round(coalesce(c.contract_sum, 0) * (coalesce(p.pct_earned, 0) - coalesce(p.pct_planned, 0)) / 100, 2) as schedule_variance_value,
       round(coalesce(p.pct_earned, 0) - coalesce(p.pct_planned, 0), 2) as schedule_variance_points
from public.schedules s
cross join lateral app.progress_overview(s.id, s.status_date) p
left join public.client_contracts c on c.project_id = s.project_id
where p.level = 'project'
  and app.my_role()::text = 'client' and app.is_member(s.project_id)
  and s.status <> 'archived';

create or replace view public.v_client_financial_summary with (security_barrier = true) as
select c.project_id,
       c.contract_no,
       greatest(c.contract_sum - coalesce(v.approved_variations, 0), 0)::numeric as original_contract_value,
       coalesce(v.approved_variations, 0)::numeric as approved_variations,
       coalesce(v.approved_variation_count, 0)::int as approved_variation_count,
       c.contract_sum::numeric as current_contract_value,
       coalesce(cert.certified_to_date, 0)::numeric as certified_to_date,
       coalesce(pay.total_payable, 0)::numeric as total_payable,
       coalesce(pay.total_paid, 0)::numeric as total_paid,
       greatest(coalesce(pay.total_payable, 0) - coalesce(pay.total_paid, 0), 0)::numeric as payment_outstanding,
       cert.latest_ipc_no, cert.latest_certificate_date
from public.client_contracts c
left join lateral (
  select sum(x.amount) filter (where x.status = 'approved') as approved_variations,
         count(*) filter (where x.status = 'approved') as approved_variation_count
  from public.variations x where x.project_id = c.project_id
) v on true
left join lateral (
  select i.ipc_no as latest_ipc_no, coalesce(i.certified_on, i.period_to) as latest_certificate_date,
         coalesce((coalesce(i.certified, i.claimed) ->> 'value_cum')::numeric,
                  (coalesce(i.certified, i.claimed) ->> 'gross_cum')::numeric, 0) as certified_to_date
  from public.client_ipcs i
  where i.project_id = c.project_id and i.status in ('certified','paid')
  order by i.ipc_no desc limit 1
) cert on true
left join lateral (
  select sum(coalesce((coalesce(i.certified, i.claimed) ->> 'payable')::numeric,
                      (coalesce(i.certified, i.claimed) ->> 'total_incl_vat')::numeric, 0)) as total_payable,
         sum(coalesce(i.paid_amount, 0)) as total_paid
  from public.client_ipcs i
  where i.project_id = c.project_id and i.status in ('certified','paid')
) pay on true
where app.my_role()::text = 'client' and app.is_member(c.project_id);

create or replace view public.v_client_daily_updates with (security_barrier = true) as
select d.id, d.project_id, d.number, d.diary_date, b.code as block_code,
       d.weather_am, d.weather_pm, d.rain_hours, d.temp_min, d.temp_max,
       d.work_summary, d.status,
       coalesce(a.activities, 0)::int as activities,
       coalesce(x.delay_events, 0)::int as delay_events,
       coalesce(x.hours_lost, 0)::numeric as hours_lost
from public.site_diaries d
left join public.blocks b on b.id = d.block_id
left join lateral (
  select count(*) as activities from public.diary_activities a
  where a.diary_id = d.id and a.deleted_at is null
) a on true
left join lateral (
  select count(*) as delay_events, sum(coalesce(x.hours_lost, 0)) as hours_lost
  from public.diary_delays x where x.diary_id = d.id and x.deleted_at is null
) x on true
where d.status in ('submitted','signed')
  and app.my_role()::text = 'client' and app.is_member(d.project_id);

grant select on public.v_client_dashboard_evm, public.v_client_financial_summary,
  public.v_client_daily_updates to authenticated;

comment on view public.v_client_dashboard_evm is
  'Client-safe EVM using contract value and verified physical progress; contractor AC and CPI are intentionally excluded.';
comment on view public.v_client_daily_updates is
  'Submitted/signed client daily summary; internal notes, people and equipment details are intentionally excluded.';
