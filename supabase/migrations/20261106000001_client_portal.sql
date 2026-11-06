-- =============================================================================
-- Read-only client portal
--
-- Client accounts are project members so the normal project picker works, but
-- they must not inherit the broad internal visibility of ordinary members.
-- Restrictive policies below deny every base table by default and expose only:
--   * the client's own profile;
--   * projects assigned to the client;
--   * company identity from app_settings.
-- All project progress is published through narrow, owner-filtered views.
-- =============================================================================

-- A restrictive policy is ANDed with every existing permissive policy. This
-- makes the role safe even where older migrations grant all project members
-- read access.
do $$
declare
  r record;
  read_expr text;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
  loop
    execute format('drop policy if exists client_portal_read_guard on public.%I', r.relname);
    execute format('drop policy if exists client_portal_insert_guard on public.%I', r.relname);
    execute format('drop policy if exists client_portal_update_guard on public.%I', r.relname);
    execute format('drop policy if exists client_portal_delete_guard on public.%I', r.relname);

    read_expr := case r.relname
      when 'profiles' then '(app.my_role()::text <> ''client'' or id = auth.uid())'
      when 'projects' then '(app.my_role()::text <> ''client'' or app.is_member(id))'
      when 'app_settings' then 'true'
      else '(app.my_role()::text <> ''client'')'
    end;

    execute format('create policy client_portal_read_guard on public.%I as restrictive for select to authenticated using (%s)', r.relname, read_expr);
    execute format('create policy client_portal_insert_guard on public.%I as restrictive for insert to authenticated with check (app.my_role()::text <> ''client'')', r.relname);
    execute format('create policy client_portal_update_guard on public.%I as restrictive for update to authenticated using (app.my_role()::text <> ''client'') with check (app.my_role()::text <> ''client'')', r.relname);
    execute format('create policy client_portal_delete_guard on public.%I as restrictive for delete to authenticated using (app.my_role()::text <> ''client'')', r.relname);
  end loop;
end $$;

-- Safe schedule header. Deliberately omits import metadata, users and costs.
create or replace view public.v_client_schedules with (security_barrier = true) as
select s.id, s.project_id, s.code, s.name, s.status, s.planned_start, s.planned_finish,
       s.status_date, s.fc_finish, s.es_finish
from public.schedules s
where app.my_role()::text = 'client' and app.is_member(s.project_id)
  and s.status <> 'archived';

-- Public programme fields only. task_no is always a dense 1..N sequence for
-- the current rows of each schedule and is intentionally separate from WBS.
create or replace view public.v_client_schedule_tasks with (security_barrier = true) as
select row_number() over (
         partition by t.schedule_id
         order by t.sort_order, t.msp_uid, t.id
       )::int as task_no,
       t.id, t.project_id, t.schedule_id, t.wbs, t.outline_level, t.parent_id,
       t.name, t.is_summary, t.is_milestone,
       t.planned_start, t.planned_finish, t.baseline_start, t.baseline_finish,
       t.forecast_start, t.forecast_finish, t.actual_start, t.actual_finish,
       t.duration_days, t.pct_complete, t.is_critical, t.total_float_days
from public.schedule_tasks t
where app.my_role()::text = 'client' and app.is_member(t.project_id)
  and t.deleted_at is null and t.source_state = 'active';

-- Non-financial earned-value/progress measures. BAC, PV, EV, AC, costs and
-- rates are intentionally absent; clients receive percentage and schedule
-- performance only.
create or replace view public.v_client_progress_overview with (security_barrier = true) as
select s.project_id, s.id as schedule_id, m.*
from public.schedules s
cross join lateral app.progress_overview(s.id, s.status_date) m
where app.my_role()::text = 'client' and app.is_member(s.project_id)
  and s.status <> 'archived';

-- Element progress aggregated to block/level. No quantities, material usage,
-- requests, costs, people, remarks or audit data are exposed.
create or replace view public.v_client_progress_rollup with (security_barrier = true) as
select e.project_id, e.block_id, b.code as block_code, e.level_id, lv.code as level_code,
       count(*)::int as elements,
       count(*) filter (where e.status = 'completed')::int as completed,
       round(avg(e.progress_pct), 2) as avg_progress_pct,
       count(*) filter (where e.planned_finish < current_date and e.status <> 'completed')::int as delayed
from public.elements e
left join public.blocks b on b.id = e.block_id
left join public.levels lv on lv.id = e.level_id
where app.my_role()::text = 'client' and app.is_member(e.project_id)
  and e.deleted_at is null
group by e.project_id, e.block_id, b.code, e.level_id, lv.code;

grant select on public.v_client_schedules, public.v_client_schedule_tasks,
  public.v_client_progress_overview, public.v_client_progress_rollup to authenticated;

comment on view public.v_client_schedule_tasks is
  'Client-safe schedule rows. task_no is a dense 1..N display identifier; WBS remains the hierarchy identifier.';
