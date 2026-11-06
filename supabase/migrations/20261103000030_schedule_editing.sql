-- =============================================================================
-- Schedule editing in the app (MS Project-like) + resources.
--
--  * edit_schedule(p): add task / milestone / summary, rename, duration, start (→ SNET), constraints, deadline,
--    notes, indent / outdent / move, delete (refused when the task carries progress, cost, BoQ links or
--    assignments), links (FS/SS/FF/SF, lag in days or % of the predecessor), "Predecessors" column
--    (set_predecessors). After every edit: renumber (outline numbers, sort order), re-plan with CPM
--    (planned dates of not-started tasks), forecast again, summaries rolled up.
--  * Every edit is logged in schedule_edits (who / when / what) with a snapshot of the schedule before it,
--    so undo_schedule_edit restores the last edit (until the next MS Project import).
--  * Resources: schedule_resources (labour / crew / equipment / material, max units, link to labour trade or
--    material spec) + price-restricted rates; task_assignments; v_task_resource_cost; get_resource_usage
--    (weekly demand vs capacity, over-allocation, tasks with float that could move); set_baseline with
--    cost_source 'resources' (task BAC cost = assignment cost, value-based where a task has none).
--
-- Re-import rule (MS Project stays the master): the file wins. Imported tasks take the file's values; tasks
-- and links created in the app that are not in the file are removed like any task missing from the file
-- (kept as "removed from schedule" when they carry progress). The import wizard warns about tasks edited or
-- created in the app since the last import. To keep in-app changes, export to MS Project XML (UIDs are kept),
-- open it in MS Project and import that file.
-- =============================================================================

alter table public.schedule_tasks add column if not exists origin text not null default 'import';
alter table public.schedule_tasks add column if not exists edited_at timestamptz;
alter table public.schedule_tasks add column if not exists edited_by uuid references public.profiles (id);
alter table public.schedule_links add column if not exists origin text not null default 'import';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schedule_tasks_origin_check') then
    alter table public.schedule_tasks add constraint schedule_tasks_origin_check check (origin in ('import','app'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schedule_links_origin_check') then
    alter table public.schedule_links add constraint schedule_links_origin_check check (origin in ('import','app'));
  end if;
end $$;

create table if not exists public.schedule_edits (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  schedule_id  uuid not null references public.schedules (id) on delete cascade,
  action       text not null,
  task_id      uuid references public.schedule_tasks (id),
  summary      text not null,
  detail       jsonb not null default '{}'::jsonb,
  snapshot     jsonb,                  -- schedule before the edit (undo); trimmed to the last 30 edits
  version_id   uuid references public.schedule_versions (id),
  moved        int not null default 0, -- tasks whose planned dates changed
  undone_at    timestamptz,
  undone_by    uuid references public.profiles (id),
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists schedule_edits_sched_idx on public.schedule_edits (schedule_id, created_at desc);

create table if not exists public.schedule_resources (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  code             text not null,
  name             text not null,
  kind             text not null check (kind in ('labour','crew','equipment','material')),
  unit             text not null default 'day',     -- labour/equipment: people or machines per day; material: quantity unit
  max_units        numeric(10,2) not null default 1 check (max_units > 0),
  labour_trade_id  uuid references public.labour_trades (id),
  material_spec_id uuid references public.material_specs (id),
  notes            text,
  is_active        boolean not null default true,
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (project_id, code)
);

-- Price data: only price roles read it (RLS), like boq_rates.
create table if not exists public.schedule_resource_rates (
  resource_id   uuid primary key references public.schedule_resources (id) on delete cascade,
  project_id    uuid not null references public.projects (id) on delete cascade,
  std_rate      numeric(18,2) not null default 0 check (std_rate >= 0),   -- per day (labour/equipment) or per unit (material)
  cost_per_use  numeric(18,2) not null default 0 check (cost_per_use >= 0),
  updated_at    timestamptz not null default now()
);

create table if not exists public.task_assignments (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  schedule_id  uuid not null references public.schedules (id) on delete cascade,
  task_id      uuid not null references public.schedule_tasks (id),
  resource_id  uuid not null references public.schedule_resources (id),
  units        numeric(12,3) not null check (units > 0),   -- per working day (labour/equipment) or total quantity (material)
  notes        text,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create unique index if not exists task_assignments_uniq on public.task_assignments (task_id, resource_id) where deleted_at is null;
create index if not exists task_assignments_sched_idx on public.task_assignments (schedule_id) where deleted_at is null;

do $$
declare t text;
begin
  foreach t in array array['schedule_edits','schedule_resources','schedule_resource_rates','task_assignments'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['schedule_resources','task_assignments'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
  end loop;
end $$;

drop policy if exists member_read on public.schedule_edits;
create policy member_read on public.schedule_edits for select to authenticated using (app.is_member(project_id));
drop policy if exists member_read on public.schedule_resources;
create policy member_read on public.schedule_resources for select to authenticated using (app.is_member(project_id));
drop policy if exists member_read on public.task_assignments;
create policy member_read on public.task_assignments for select to authenticated using (app.is_member(project_id));
drop policy if exists price_read on public.schedule_resource_rates;
create policy price_read on public.schedule_resource_rates for select to authenticated using (app.is_member(project_id) and app.can_see_prices());

-- Resource cost per assignment. Rates are RLS-restricted, so cost is null for roles without price access.
create or replace view public.v_task_resource_cost with (security_invoker = true) as
select a.id as assignment_id, a.project_id, a.schedule_id, a.task_id, a.resource_id, r.code, r.name, r.kind, r.unit, a.units,
       case when r.kind = 'material' then a.units else round(a.units * greatest(coalesce(t.duration_days, 0), 0), 3) end as work,
       rt.std_rate, rt.cost_per_use,
       case when rt.resource_id is null then null
            else round(case when r.kind = 'material' then a.units * rt.std_rate
                            else a.units * greatest(coalesce(t.duration_days, 0), 0) * rt.std_rate end + rt.cost_per_use, 2) end as cost
from public.task_assignments a
join public.schedule_resources r on r.id = a.resource_id
join public.schedule_tasks t on t.id = a.task_id and t.deleted_at is null
left join public.schedule_resource_rates rt on rt.resource_id = r.id
where a.deleted_at is null;
grant select on public.v_task_resource_cost to authenticated;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Schedule state an edit can change (tasks + links), for undo.
create or replace function app.schedule_snapshot(p_schedule uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'parent_id', t.parent_id, 'sort_order', t.sort_order,
        'outline_level', t.outline_level, 'outline_number', t.outline_number, 'wbs', t.wbs, 'name', t.name, 'notes', t.notes,
        'is_summary', t.is_summary, 'is_milestone', t.is_milestone, 'planned_start', t.planned_start, 'planned_finish', t.planned_finish,
        'duration_days', t.duration_days, 'constraint_type', t.constraint_type, 'constraint_date', t.constraint_date,
        'deadline', t.deadline, 'ev_method', t.ev_method, 'deleted_at', t.deleted_at, 'edited_at', t.edited_at, 'edited_by', t.edited_by))
      from public.schedule_tasks t where t.schedule_id = p_schedule), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'link_type', l.link_type, 'lag_days', l.lag_days,
        'lag_elapsed', l.lag_elapsed, 'deleted_at', l.deleted_at))
      from public.schedule_links l where l.schedule_id = p_schedule), '[]'::jsonb));
$$;

-- Outline numbers, levels, sort order and summary flags from the parent tree (siblings keep their order).
create or replace function app.renumber_schedule(p_schedule uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_lvl int;
begin
  with recursive sib as (
    select id, parent_id, row_number() over (partition by parent_id order by sort_order, msp_uid)::int as pos
    from public.schedule_tasks where schedule_id = p_schedule and deleted_at is null),
  tr as (
    select s.id, 1 as lvl, array[s.pos] as path from sib s where s.parent_id is null
    union all
    select s.id, tr.lvl + 1, tr.path || s.pos from sib s join tr on s.parent_id = tr.id),
  ord as (select id, lvl, path, row_number() over (order by path)::int as rn from tr)
  update public.schedule_tasks t set outline_level = o.lvl, outline_number = array_to_string(o.path, '.'), sort_order = o.rn
  from ord o where t.id = o.id
    and (t.outline_level, t.outline_number, t.sort_order) is distinct from (o.lvl, array_to_string(o.path, '.'), o.rn);
  -- tasks created in the app: WBS = parent's WBS (or outline number) + position among its siblings (parents first)
  for v_lvl in select distinct outline_level from public.schedule_tasks
               where schedule_id = p_schedule and deleted_at is null and origin = 'app' order by 1 loop
    update public.schedule_tasks t set wbs = coalesce(coalesce(pt.wbs, pt.outline_number) || '.', '') || x.pos
    from (select id, parent_id, row_number() over (partition by parent_id order by sort_order) as pos
          from public.schedule_tasks where schedule_id = p_schedule and deleted_at is null) x
    left join public.schedule_tasks pt on pt.id = x.parent_id
    where t.id = x.id and t.origin = 'app' and t.outline_level = v_lvl
      and t.wbs is distinct from coalesce(coalesce(pt.wbs, pt.outline_number) || '.', '') || x.pos;
  end loop;
  update public.schedule_tasks t set is_summary = x.has_kids,
         duration_days = case when not x.has_kids and t.is_summary then greatest(1, coalesce(app.la_wd(t.project_id, t.planned_start, t.planned_finish), 1)) else t.duration_days end
  from (select p.id, exists (select 1 from public.schedule_tasks c where c.parent_id = p.id and c.deleted_at is null) as has_kids
        from public.schedule_tasks p where p.schedule_id = p_schedule and p.deleted_at is null) x
  where t.id = x.id and t.is_summary is distinct from x.has_kids;
end $$;

-- Planned dates from the logic: CPM from the project start (no progress date), copied to the not-started tasks
-- driven by the edit (the seeds and everything after them through the links; all tasks when p_seeds is null),
-- so one edit does not re-date unrelated work whose imported dates differ from the app calendar (holidays);
-- summaries rolled up; then the forecast at the schedule's status date. Returns how many tasks moved.
create or replace function app.replan_schedule(p_schedule uuid, p_seeds uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  sc public.schedules; v_start date; v_before jsonb; v_moved int; v_lvl int; v_fc jsonb; v_status date; v_scope uuid[];
begin
  select * into sc from public.schedules where id = p_schedule;
  v_status := coalesce(sc.status_date, app.eat_date(now()));
  select coalesce(sc.planned_start, min(planned_start)) into v_start from public.schedule_tasks
   where schedule_id = p_schedule and deleted_at is null;
  v_start := coalesce(v_start, app.eat_date(now()));
  select coalesce(jsonb_object_agg(id, jsonb_build_array(planned_start, planned_finish)), '{}'::jsonb) into v_before
    from public.schedule_tasks where schedule_id = p_schedule and deleted_at is null and not is_summary;

  if p_seeds is not null then
    with recursive dn as (
      select x as id from unnest(p_seeds) x
      union
      select l.succ_task_id from public.schedule_links l join dn on l.pred_task_id = dn.id
       where l.schedule_id = p_schedule and l.deleted_at is null)
    select coalesce(array_agg(id), '{}') into v_scope from dn;
  end if;
  perform app.run_cpm(p_schedule, v_start - 1, true);
  update public.schedule_tasks set planned_start = forecast_start, planned_finish = forecast_finish
   where schedule_id = p_schedule and deleted_at is null and not is_summary and actual_start is null and pct_complete = 0
     and (v_scope is null or id = any (v_scope))
     and forecast_start is not null and (planned_start, planned_finish) is distinct from (forecast_start, forecast_finish);
  for v_lvl in select distinct outline_level from public.schedule_tasks
               where schedule_id = p_schedule and is_summary and deleted_at is null order by 1 desc loop
    update public.schedule_tasks s set planned_start = x.ps, planned_finish = x.pf,
           duration_days = app.la_wd(s.project_id, x.ps, x.pf)
    from (select c.parent_id, min(c.planned_start) ps, max(c.planned_finish) pf from public.schedule_tasks c
          where c.schedule_id = p_schedule and c.deleted_at is null and c.parent_id is not null group by c.parent_id) x
    where s.id = x.parent_id and s.outline_level = v_lvl and s.is_summary and s.deleted_at is null;
  end loop;
  update public.schedules s set planned_start = x.ps, planned_finish = x.pf
    from (select min(planned_start) ps, max(planned_finish) pf from public.schedule_tasks where schedule_id = p_schedule and deleted_at is null) x
   where s.id = p_schedule;
  v_fc := app.run_cpm(p_schedule, v_status, true);
  select count(*) into v_moved from public.schedule_tasks t
   where t.schedule_id = p_schedule and t.deleted_at is null and not t.is_summary
     and v_before ? t.id::text and (v_before -> t.id::text) <> jsonb_build_array(t.planned_start, t.planned_finish);
  return jsonb_build_object('moved', v_moved, 'planned_finish', (select planned_finish from public.schedules where id = p_schedule),
    'fc_finish', v_fc -> 'fc_finish', 'critical_count', v_fc -> 'critical_count');
end $$;

-- Why a task cannot become a summary (its links, progress, measurement and resources belong to detailed work).
create or replace function app.summary_blocker(p_task uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.task_progress where task_id = p_task and status <> 'rejected') or
         exists (select 1 from public.schedule_tasks where id = p_task and (pct_complete > 0 or actual_start is not null)) then 'it has progress'
    when exists (select 1 from public.task_boq_links where task_id = p_task and deleted_at is null) then 'it is linked to BoQ items'
    when exists (select 1 from public.task_element_links where task_id = p_task and (to_jsonb(task_element_links) ->> 'deleted_at') is null) then 'it is linked to elements'
    when exists (select 1 from public.task_assignments where task_id = p_task and deleted_at is null) then 'it has resources assigned'
    when exists (select 1 from public.schedule_links where (pred_task_id = p_task or succ_task_id = p_task) and deleted_at is null) then 'it has predecessors or successors'
  end;
$$;

create or replace function app.check_no_cycle(p_schedule uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.run_cpm(p_schedule, app.eat_date(now()), false);
exception when others then
  if sqlerrm like '%loop%' then raise exception 'That link would make a loop in the logic (%).', substring(sqlerrm from 'UIDs: (.*)$'); end if;
  raise;
end $$;

-- -----------------------------------------------------------------------------
-- RPC: edit_schedule
-- -----------------------------------------------------------------------------
create or replace function public.edit_schedule(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_act text := p ->> 'action';
  v_task uuid := nullif(p ->> 'task_id', '')::uuid;
  sc public.schedules; t public.schedule_tasks; a public.schedule_tasks; par public.schedule_tasks; nb public.schedule_tasks;
  v_new uuid; v_edit uuid := gen_random_uuid(); v_snap jsonb; v_summary text; v_plan jsonb; v_why text;
  v_kind text; v_uid int; v_dur numeric; v_start date; v_ids uuid[]; v_n int; v_pred public.schedule_tasks; v_succ public.schedule_tasks;
  v_type text; v_lag numeric; x jsonb; v_keep uuid[] := '{}'; v_link uuid; v_me uuid := auth.uid(); v_seeds uuid[] := '{}';
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules
   where id = coalesce(nullif(p ->> 'schedule_id', '')::uuid, (select schedule_id from public.schedule_tasks where id = v_task),
                       (select schedule_id from public.schedule_tasks where id = nullif(p ->> 'succ_task_id', '')::uuid))
   for update;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if sc.status = 'archived' then raise exception 'Schedule % is archived', sc.code; end if;
  if v_task is not null then
    select * into t from public.schedule_tasks where id = v_task and schedule_id = sc.id and deleted_at is null;
    if not found then raise exception 'Task not found in this schedule'; end if;
  end if;
  v_snap := app.schedule_snapshot(sc.id);

  if v_act = 'add_task' then
    v_kind := coalesce(nullif(p ->> 'kind', ''), 'task');
    if v_kind not in ('task','milestone','summary') then raise exception 'Unknown task kind %', v_kind; end if;
    if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Give the task a name'; end if;
    if nullif(p ->> 'after_task_id', '') is not null then
      select * into a from public.schedule_tasks where id = (p ->> 'after_task_id')::uuid and schedule_id = sc.id and deleted_at is null;
      if not found then raise exception 'Task to insert after not found'; end if;
    end if;
    if nullif(p ->> 'parent_id', '') is not null then
      select * into par from public.schedule_tasks where id = (p ->> 'parent_id')::uuid and schedule_id = sc.id and deleted_at is null;
      if not found then raise exception 'Parent task not found'; end if;
      if not par.is_summary then
        v_why := app.summary_blocker(par.id);
        if v_why is not null then raise exception '"%" cannot get sub-tasks: %', par.name, v_why; end if;
      end if;
    end if;
    select coalesce(max(msp_uid), 0) + 1 into v_uid from public.schedule_tasks where schedule_id = sc.id;
    v_dur := case v_kind when 'milestone' then 0 when 'summary' then null else greatest(coalesce((p ->> 'duration_days')::numeric, 1), 0) end;
    v_start := coalesce((p ->> 'start')::date, a.planned_start, par.planned_start, sc.planned_start, app.eat_date(now()));
    insert into public.schedule_tasks (project_id, schedule_id, msp_uid, parent_id, sort_order, outline_level, name, notes,
      is_summary, is_milestone, planned_start, planned_finish, duration_days, constraint_type, constraint_date, ev_method,
      origin, edited_at, edited_by, block_id, level_id)
    values (sc.project_id, sc.id, v_uid,
      case when par.id is not null then par.id else a.parent_id end,
      case when par.id is not null and a.id is null then 2000000000 else coalesce(a.sort_order, 2000000000) end,
      1, trim(p ->> 'name'), nullif(p ->> 'notes', ''), v_kind = 'summary', v_kind = 'milestone', v_start, v_start, v_dur,
      case when (p ->> 'start') is not null then 4 end, (p ->> 'start')::date,
      case when v_kind = 'milestone' then 'milestone' else 'pct' end, 'app', now(), v_me,
      coalesce(par.block_id, a.block_id), coalesce(par.level_id, a.level_id))
    returning id into v_new;
    v_summary := 'Added ' || v_kind || ' "' || trim(p ->> 'name') || '"';

  elsif v_act = 'update_task' then
    if p ? 'name' and coalesce(trim(p ->> 'name'), '') = '' then raise exception 'The task name cannot be empty'; end if;
    if t.is_summary and (p ? 'duration_days' or p ? 'start' or p ? 'milestone' or p ? 'constraint_type') then
      raise exception '"%" is a summary: its dates come from its sub-tasks', t.name;
    end if;
    if (p ->> 'duration_days')::numeric < 0 then raise exception 'Duration cannot be negative'; end if;
    if (p ->> 'constraint_type')::int not between 0 and 7 then raise exception 'Unknown constraint type'; end if;
    if (p ->> 'constraint_type')::int in (2,3,4,5,6,7) and coalesce(p ->> 'constraint_date', t.constraint_date::text) is null then
      raise exception 'This constraint needs a date';
    end if;
    update public.schedule_tasks set
      name = case when p ? 'name' then trim(p ->> 'name') else name end,
      notes = case when p ? 'notes' then nullif(p ->> 'notes', '') else notes end,
      deadline = case when p ? 'deadline' then (p ->> 'deadline')::date else deadline end,
      is_milestone = case when p ? 'milestone' then (p ->> 'milestone')::boolean else is_milestone end,
      duration_days = case when p ? 'milestone' and (p ->> 'milestone')::boolean then 0
                           when p ? 'milestone' and not (p ->> 'milestone')::boolean and coalesce(duration_days, 0) = 0 then greatest(coalesce((p ->> 'duration_days')::numeric, 1), 1)
                           when p ? 'duration_days' then (p ->> 'duration_days')::numeric else duration_days end,
      ev_method = case when p ? 'milestone' and (p ->> 'milestone')::boolean and ev_method = 'pct' and pct_complete = 0 then 'milestone'
                       when p ? 'milestone' and not (p ->> 'milestone')::boolean and ev_method = 'milestone' then 'pct' else ev_method end,
      constraint_type = case when p ? 'start' then case when p ->> 'start' is null then 0 else 4 end
                             when p ? 'constraint_type' then (p ->> 'constraint_type')::smallint else constraint_type end,
      constraint_date = case when p ? 'start' then (p ->> 'start')::date
                             when p ? 'constraint_type' and (p ->> 'constraint_type')::int in (0, 1) then null
                             when p ? 'constraint_date' then (p ->> 'constraint_date')::date else constraint_date end,
      planned_start = case when p ->> 'start' is not null then (p ->> 'start')::date else planned_start end,
      edited_at = now(), edited_by = v_me
    where id = t.id;
    v_summary := 'Edited "' || t.name || '"' || coalesce(' (' || (select string_agg(k, ', ') from jsonb_object_keys(p - 'op_id' - 'action' - 'task_id' - 'schedule_id') k) || ')', '');

  elsif v_act = 'delete_task' then
    with recursive sub as (select id from public.schedule_tasks where id = t.id
                           union all select c.id from public.schedule_tasks c join sub on c.parent_id = sub.id where c.deleted_at is null)
    select array_agg(id) into v_ids from sub;
    select string_agg(distinct x.why, '; ') into v_why from (
      select format('"%s" has progress', s.name) why from public.schedule_tasks s where s.id = any (v_ids)
        and (s.pct_complete > 0 or s.actual_start is not null or exists (select 1 from public.task_progress tp where tp.task_id = s.id and tp.status <> 'rejected'))
      union all select format('"%s" has cost entries', s.name) from public.schedule_tasks s where s.id = any (v_ids) and exists (select 1 from public.cost_entries ce where ce.task_id = s.id)
      union all select format('"%s" is linked to BoQ items', s.name) from public.schedule_tasks s where s.id = any (v_ids) and exists (select 1 from public.task_boq_links b where b.task_id = s.id and b.deleted_at is null)
      union all select format('"%s" has resources assigned', s.name) from public.schedule_tasks s where s.id = any (v_ids) and exists (select 1 from public.task_assignments ta where ta.task_id = s.id and ta.deleted_at is null)
      union all select format('"%s" is in a monthly look-ahead', s.name) from public.schedule_tasks s where s.id = any (v_ids) and exists (select 1 from public.lookahead_items li where li.schedule_task_id = s.id)
    ) x;
    if v_why is not null then raise exception 'Cannot delete: % — keep it, or remove that first', v_why; end if;
    select coalesce(array_agg(distinct succ_task_id), '{}') into v_seeds from public.schedule_links
     where deleted_at is null and pred_task_id = any (v_ids) and not (succ_task_id = any (v_ids));
    update public.schedule_links set deleted_at = now() where deleted_at is null and (pred_task_id = any (v_ids) or succ_task_id = any (v_ids));
    update public.schedule_tasks set deleted_at = now(), edited_at = now(), edited_by = v_me where id = any (v_ids);
    v_summary := 'Deleted "' || t.name || '"' || case when array_length(v_ids, 1) > 1 then ' and ' || (array_length(v_ids, 1) - 1) || ' sub-task(s)' else '' end;

  elsif v_act = 'indent' then
    select * into nb from public.schedule_tasks where schedule_id = sc.id and deleted_at is null
      and parent_id is not distinct from t.parent_id and sort_order < t.sort_order order by sort_order desc limit 1;
    if not found then raise exception 'There is no task above "%" at the same level to indent under', t.name; end if;
    if not nb.is_summary then
      v_why := app.summary_blocker(nb.id);
      if v_why is not null then raise exception '"%" would become a summary, but %', nb.name, v_why; end if;
    end if;
    update public.schedule_tasks set parent_id = nb.id, edited_at = now(), edited_by = v_me where id = t.id;
    v_summary := 'Indented "' || t.name || '" under "' || nb.name || '"';

  elsif v_act = 'outdent' then
    if t.parent_id is null then raise exception '"%" is already at the top level', t.name; end if;
    select * into par from public.schedule_tasks where id = t.parent_id;
    select array_agg(id) into v_ids from public.schedule_tasks
     where parent_id = t.parent_id and deleted_at is null and sort_order > t.sort_order;
    if v_ids is not null and not t.is_summary then
      v_why := app.summary_blocker(t.id);
      if v_why is not null then raise exception '"%" would take the tasks below it as sub-tasks, but %', t.name, v_why; end if;
    end if;
    update public.schedule_tasks set parent_id = t.id where id = any (coalesce(v_ids, '{}'));
    update public.schedule_tasks set parent_id = par.parent_id, edited_at = now(), edited_by = v_me where id = t.id;
    v_summary := 'Outdented "' || t.name || '"';

  elsif v_act = 'move' then
    if coalesce(p ->> 'direction', '') = 'up' then
      select * into nb from public.schedule_tasks where schedule_id = sc.id and deleted_at is null
        and parent_id is not distinct from t.parent_id and sort_order < t.sort_order order by sort_order desc limit 1;
    else
      select * into nb from public.schedule_tasks where schedule_id = sc.id and deleted_at is null
        and parent_id is not distinct from t.parent_id and sort_order > t.sort_order order by sort_order limit 1;
    end if;
    if not found then raise exception '"%" cannot move further %', t.name, coalesce(p ->> 'direction', 'down'); end if;
    update public.schedule_tasks set sort_order = nb.sort_order, edited_at = now(), edited_by = v_me where id = t.id;
    update public.schedule_tasks set sort_order = t.sort_order where id = nb.id;
    v_summary := 'Moved "' || t.name || '" ' || coalesce(p ->> 'direction', 'down');

  elsif v_act in ('add_link', 'update_link', 'delete_link') then
    select * into v_pred from public.schedule_tasks where id = (p ->> 'pred_task_id')::uuid and schedule_id = sc.id and deleted_at is null;
    select * into v_succ from public.schedule_tasks where id = (p ->> 'succ_task_id')::uuid and schedule_id = sc.id and deleted_at is null;
    if v_pred.id is null or v_succ.id is null then raise exception 'Both tasks must be in this schedule'; end if;
    v_type := upper(coalesce(nullif(p ->> 'link_type', ''), 'FS'));
    if v_act = 'delete_link' then
      update public.schedule_links set deleted_at = now() where pred_task_id = v_pred.id and succ_task_id = v_succ.id
        and deleted_at is null and (p ->> 'link_type' is null or link_type = v_type);
      get diagnostics v_n = row_count;
      if v_n = 0 then raise exception 'There is no such link'; end if;
      v_summary := 'Removed link ' || v_pred.msp_uid || ' → ' || v_succ.msp_uid;
    else
      if v_type not in ('FS','SS','FF','SF') then raise exception 'Link type must be FS, SS, FF or SF'; end if;
      if v_pred.id = v_succ.id then raise exception 'A task cannot be linked to itself'; end if;
      if v_pred.is_summary or v_succ.is_summary then raise exception 'Link the detailed tasks, not a summary'; end if;
      v_lag := case when p ? 'lag_pct' then round(greatest(coalesce(v_pred.duration_days, 0), 0) * (p ->> 'lag_pct')::numeric / 100, 2)
                    else coalesce((p ->> 'lag_days')::numeric, 0) end;
      if v_act = 'update_link' then
        update public.schedule_links set deleted_at = now() where pred_task_id = v_pred.id and succ_task_id = v_succ.id and deleted_at is null;
      end if;
      insert into public.schedule_links (project_id, schedule_id, pred_task_id, succ_task_id, link_type, lag_days, origin)
      values (sc.project_id, sc.id, v_pred.id, v_succ.id, v_type, v_lag, 'app')
      on conflict (pred_task_id, succ_task_id, link_type) do update set lag_days = excluded.lag_days, deleted_at = null, origin = 'app';
      perform app.check_no_cycle(sc.id);
      v_summary := 'Linked ' || v_pred.msp_uid || ' → ' || v_succ.msp_uid || ' ' || v_type
        || case when v_lag <> 0 then (case when v_lag > 0 then '+' else '' end) || trim(trailing '.' from trim(trailing '0' from v_lag::text)) || 'd' else '' end;
    end if;
    update public.schedule_tasks set edited_at = now(), edited_by = v_me where id = v_succ.id;
    v_task := v_succ.id;

  elsif v_act = 'set_predecessors' then
    if t.is_summary then raise exception 'Link the detailed tasks, not a summary'; end if;
    for x in select y from jsonb_array_elements(coalesce(p -> 'predecessors', '[]'::jsonb)) y loop
      select * into v_pred from public.schedule_tasks where schedule_id = sc.id and deleted_at is null
        and (id = nullif(x ->> 'pred_task_id', '')::uuid or msp_uid = (x ->> 'pred_uid')::int) limit 1;
      if v_pred.id is null then raise exception 'Predecessor % is not in this schedule', coalesce(x ->> 'pred_uid', x ->> 'pred_task_id'); end if;
      if v_pred.id = t.id then raise exception 'A task cannot be its own predecessor'; end if;
      if v_pred.is_summary then raise exception 'Predecessor % is a summary — link its detailed tasks', v_pred.msp_uid; end if;
      v_type := upper(coalesce(nullif(x ->> 'link_type', ''), 'FS'));
      if v_type not in ('FS','SS','FF','SF') then raise exception 'Link type must be FS, SS, FF or SF'; end if;
      v_lag := case when x ? 'lag_pct' then round(greatest(coalesce(v_pred.duration_days, 0), 0) * (x ->> 'lag_pct')::numeric / 100, 2)
                    else coalesce((x ->> 'lag_days')::numeric, 0) end;
      insert into public.schedule_links (project_id, schedule_id, pred_task_id, succ_task_id, link_type, lag_days, origin)
      values (sc.project_id, sc.id, v_pred.id, t.id, v_type, v_lag, 'app')
      on conflict (pred_task_id, succ_task_id, link_type) do update
        set lag_days = excluded.lag_days, deleted_at = null,
            origin = case when schedule_links.lag_days = excluded.lag_days and schedule_links.deleted_at is null then schedule_links.origin else 'app' end
      returning id into v_link;
      v_keep := v_keep || v_link;
    end loop;
    update public.schedule_links set deleted_at = now() where succ_task_id = t.id and deleted_at is null and not (id = any (v_keep));
    perform app.check_no_cycle(sc.id);
    update public.schedule_tasks set edited_at = now(), edited_by = v_me where id = t.id;
    v_summary := 'Set predecessors of "' || t.name || '" (' || coalesce(array_length(v_keep, 1), 0) || ')';
  else
    raise exception 'Unknown schedule edit %', coalesce(v_act, '(none)');
  end if;

  perform app.renumber_schedule(sc.id);
  if v_act <> 'delete_task' then v_seeds := v_seeds || coalesce(v_new, v_task); end if;
  v_plan := app.replan_schedule(sc.id, array_remove(v_seeds, null));
  insert into public.schedule_edits (id, project_id, schedule_id, action, task_id, summary, detail, snapshot, version_id, moved, created_by)
  values (v_edit, sc.project_id, sc.id, v_act, coalesce(v_new, v_task), v_summary, p - 'op_id', v_snap, sc.current_version_id,
          coalesce((v_plan ->> 'moved')::int, 0), v_me);
  update public.schedule_edits set snapshot = null where schedule_id = sc.id and snapshot is not null
    and id not in (select id from public.schedule_edits where schedule_id = sc.id order by created_at desc limit 30);
  return app.op_done(p, 'edit_schedule', jsonb_build_object('ok', true, 'edit_id', v_edit, 'task_id', coalesce(v_new, v_task),
    'summary', v_summary) || v_plan);
end $$;

-- -----------------------------------------------------------------------------
-- RPC: undo_schedule_edit — restores the schedule as it was before its latest edit.
-- -----------------------------------------------------------------------------
create or replace function public.undo_schedule_edit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  sc public.schedules; e public.schedule_edits; v_plan jsonb; v_lvl int;
begin
  if v_seen is not null then return v_seen; end if;
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid for update;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  select * into e from public.schedule_edits where schedule_id = sc.id and undone_at is null order by created_at desc limit 1;
  if not found then raise exception 'Nothing to undo'; end if;
  if e.snapshot is null then raise exception 'That edit is too old to undo'; end if;
  if e.version_id is distinct from sc.current_version_id then
    raise exception 'The schedule was imported from MS Project after "%" — it cannot be undone', e.summary;
  end if;

  update public.schedule_tasks t set parent_id = r.parent_id, sort_order = r.sort_order, outline_level = r.outline_level,
         outline_number = r.outline_number, wbs = r.wbs, name = r.name, notes = r.notes, is_summary = r.is_summary,
         is_milestone = r.is_milestone, planned_start = r.planned_start, planned_finish = r.planned_finish,
         duration_days = r.duration_days, constraint_type = r.constraint_type, constraint_date = r.constraint_date,
         deadline = r.deadline, ev_method = r.ev_method, deleted_at = r.deleted_at, edited_at = r.edited_at, edited_by = r.edited_by
  from jsonb_populate_recordset(null::public.schedule_tasks, e.snapshot -> 'tasks') r
  where t.id = r.id and t.schedule_id = sc.id;
  update public.schedule_tasks t set deleted_at = now()
   where t.schedule_id = sc.id and t.deleted_at is null
     and not exists (select 1 from jsonb_array_elements(e.snapshot -> 'tasks') s where (s ->> 'id')::uuid = t.id);
  update public.schedule_links l set link_type = r.link_type, lag_days = r.lag_days, lag_elapsed = r.lag_elapsed, deleted_at = r.deleted_at
  from jsonb_populate_recordset(null::public.schedule_links, e.snapshot -> 'links') r
  where l.id = r.id and l.schedule_id = sc.id;
  update public.schedule_links l set deleted_at = now()
   where l.schedule_id = sc.id and l.deleted_at is null
     and not exists (select 1 from jsonb_array_elements(e.snapshot -> 'links') s where (s ->> 'id')::uuid = l.id);
  update public.schedules s set planned_start = x.ps, planned_finish = x.pf
    from (select min(planned_start) ps, max(planned_finish) pf from public.schedule_tasks where schedule_id = sc.id and deleted_at is null) x
   where s.id = sc.id;
  v_plan := app.run_cpm(sc.id, coalesce(sc.status_date, app.eat_date(now())), true);
  update public.schedule_edits set undone_at = now(), undone_by = auth.uid() where id = e.id;
  return app.op_done(p, 'undo_schedule_edit', jsonb_build_object('ok', true, 'undone', e.summary, 'edit_id', e.id,
    'fc_finish', v_plan -> 'fc_finish'));
end $$;

-- -----------------------------------------------------------------------------
-- Resources
-- -----------------------------------------------------------------------------
create or replace function public.save_schedule_resource(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
  v_project uuid := (p ->> 'project_id')::uuid; v_old public.schedule_resources;
  v_kind text := coalesce(nullif(p ->> 'kind', ''), 'labour');
begin
  if v_seen is not null then return v_seen; end if;
  select * into v_old from public.schedule_resources where id = v_id;
  v_project := coalesce(v_old.project_id, v_project);
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if coalesce(trim(p ->> 'code'), '') = '' or coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Give the resource a code and a name'; end if;
  if v_kind not in ('labour','crew','equipment','material') then raise exception 'Unknown resource type %', v_kind; end if;
  if coalesce((p ->> 'max_units')::numeric, 1) <= 0 then raise exception 'Max units must be more than 0'; end if;
  if exists (select 1 from public.schedule_resources where project_id = v_project and lower(code) = lower(trim(p ->> 'code')) and id <> v_id and deleted_at is null) then
    raise exception 'Resource code % is already used', trim(p ->> 'code');
  end if;
  insert into public.schedule_resources (id, project_id, code, name, kind, unit, max_units, labour_trade_id, material_spec_id, notes, is_active, created_by)
  values (v_id, v_project, trim(p ->> 'code'), trim(p ->> 'name'), v_kind,
    coalesce(nullif(p ->> 'unit', ''), case v_kind when 'material' then 'unit' else 'day' end), coalesce((p ->> 'max_units')::numeric, 1),
    nullif(p ->> 'labour_trade_id', '')::uuid, nullif(p ->> 'material_spec_id', '')::uuid, nullif(p ->> 'notes', ''),
    coalesce((p ->> 'is_active')::boolean, true), auth.uid())
  on conflict (id) do update set code = excluded.code, name = excluded.name, kind = excluded.kind, unit = excluded.unit,
    max_units = excluded.max_units, labour_trade_id = excluded.labour_trade_id, material_spec_id = excluded.material_spec_id,
    notes = excluded.notes, is_active = excluded.is_active, deleted_at = null;
  if app.can_see_prices() and (p ? 'std_rate' or p ? 'cost_per_use') then
    insert into public.schedule_resource_rates (resource_id, project_id, std_rate, cost_per_use)
    values (v_id, v_project, coalesce((p ->> 'std_rate')::numeric, 0), coalesce((p ->> 'cost_per_use')::numeric, 0))
    on conflict (resource_id) do update set std_rate = excluded.std_rate, cost_per_use = excluded.cost_per_use;
  end if;
  return app.op_done(p, 'save_schedule_resource', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- Replace the resources assigned to a task: [{resource_id, units, notes}] (empty list = none).
create or replace function public.assign_resources(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  t public.schedule_tasks; r public.schedule_resources; x jsonb; v_keep uuid[] := '{}'; v_n int := 0;
begin
  if v_seen is not null then return v_seen; end if;
  select * into t from public.schedule_tasks where id = (p ->> 'task_id')::uuid and deleted_at is null;
  if not found then raise exception 'Task not found'; end if;
  perform app.require_member(t.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if t.is_summary then raise exception 'Assign resources to the detailed tasks, not to the summary "%"', t.name; end if;
  for x in select y from jsonb_array_elements(coalesce(p -> 'assignments', '[]'::jsonb)) y loop
    select * into r from public.schedule_resources where id = (x ->> 'resource_id')::uuid and project_id = t.project_id and deleted_at is null;
    if not found then raise exception 'Resource not found in this project'; end if;
    if coalesce((x ->> 'units')::numeric, 0) <= 0 then raise exception 'Units for % must be more than 0', r.code; end if;
    insert into public.task_assignments (project_id, schedule_id, task_id, resource_id, units, notes, created_by)
    values (t.project_id, t.schedule_id, t.id, r.id, (x ->> 'units')::numeric, nullif(x ->> 'notes', ''), auth.uid())
    on conflict (task_id, resource_id) where deleted_at is null do update set units = excluded.units, notes = excluded.notes;
    v_keep := v_keep || r.id; v_n := v_n + 1;
  end loop;
  update public.task_assignments set deleted_at = now() where task_id = t.id and deleted_at is null and not (resource_id = any (v_keep));
  update public.schedule_tasks set edited_at = now(), edited_by = auth.uid() where id = t.id;
  return app.op_done(p, 'assign_resources', jsonb_build_object('ok', true, 'task_id', t.id, 'assignments', v_n));
end $$;

-- Weekly resource demand vs capacity. basis 'plan' (planned dates) or 'forecast'. Labour/equipment demand in
-- unit-days (units × working days), capacity = max units × working days; peak = highest daily units in the week.
-- Over-allocated weeks list the tasks with their total float (the ones with float can move — levelling hint).
create or replace function public.get_resource_usage(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  sc public.schedules; v_from date; v_to date; v_fc boolean := coalesce(p ->> 'basis', 'plan') = 'forecast'; v_days date[]; v_out jsonb;
begin
  select * into sc from public.schedules where id = (p ->> 'schedule_id')::uuid;
  if not found then raise exception 'Schedule not found'; end if;
  perform app.require_member(sc.project_id);
  v_from := coalesce((p ->> 'from')::date, sc.planned_start, app.eat_date(now()));
  v_to := coalesce((p ->> 'to')::date, greatest(sc.planned_finish, sc.fc_finish), v_from + 180);
  if v_to - v_from > 1500 then v_to := v_from + 1500; end if;
  v_days := app.working_dates(sc.project_id, v_from, v_to);
  with dd as (select unnest(v_days) as d),
  asg as (
    select a.resource_id, a.task_id, a.units, t.name, t.msp_uid, t.total_float_days, r.kind,
           case when v_fc then coalesce(t.forecast_start, t.planned_start) else t.planned_start end as s,
           case when v_fc then coalesce(t.forecast_finish, t.planned_finish) else t.planned_finish end as f
    from public.task_assignments a join public.schedule_tasks t on t.id = a.task_id and t.deleted_at is null and not t.is_summary
    join public.schedule_resources r on r.id = a.resource_id
    where a.schedule_id = sc.id and a.deleted_at is null and (not v_fc or t.actual_finish is null)),
  ndays as (select a.task_id, a.resource_id, greatest(count(dd.d), 1) as n from asg a left join dd on dd.d between a.s and a.f group by 1, 2),
  daily as (
    select a.resource_id, dd.d, date_trunc('week', dd.d)::date as wk, a.task_id, a.name, a.msp_uid, a.total_float_days,
           case when a.kind = 'material' then a.units / nd.n else a.units end as u
    from asg a join dd on dd.d between a.s and a.f join ndays nd on nd.task_id = a.task_id and nd.resource_id = a.resource_id),
  perday as (select resource_id, wk, d, sum(u) as u from daily group by 1, 2, 3),
  wk as (
    select pd.resource_id, pd.wk, round(sum(pd.u), 2) as demand, round(max(pd.u), 2) as peak,
           (select count(*) from dd where date_trunc('week', dd.d)::date = pd.wk) as wd
    from perday pd group by 1, 2),
  rows as (
    select w.resource_id, w.wk, w.demand, w.peak, w.wd, round(r.max_units * w.wd, 2) as capacity,
           r.kind <> 'material' and w.peak > r.max_units as over,
           case when r.kind <> 'material' and w.peak > r.max_units then
             (select jsonb_agg(distinct jsonb_build_object('task_id', x.task_id, 'uid', x.msp_uid, 'name', x.name, 'units', x.u,
                     'total_float_days', x.total_float_days)) from daily x where x.resource_id = w.resource_id and x.wk = w.wk) end as tasks
    from wk w join public.schedule_resources r on r.id = w.resource_id)
  select jsonb_build_object('from', v_from, 'to', v_to, 'basis', case when v_fc then 'forecast' else 'plan' end,
    'resources', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'name', r.name, 'kind', r.kind, 'unit', r.unit,
        'max_units', r.max_units,
        'weeks', coalesce((select jsonb_agg(jsonb_build_object('week', x.wk, 'demand', x.demand, 'peak', x.peak, 'capacity', x.capacity,
                   'working_days', x.wd, 'over', x.over, 'tasks', x.tasks) order by x.wk) from rows x where x.resource_id = r.id), '[]'::jsonb))
      order by r.kind, r.code)
      from public.schedule_resources r where r.project_id = sc.project_id and r.deleted_at is null
        and exists (select 1 from rows x where x.resource_id = r.id)), '[]'::jsonb)) into v_out;
  return v_out;
end $$;

-- -----------------------------------------------------------------------------
-- Baseline with task cost from the resources (cost_source 'resources'): BAC cost = assignment cost of the
-- task; tasks without assignments (or without rates) keep the value-based cost.
-- -----------------------------------------------------------------------------
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.schedule_baselines'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%cost_source%';
  if c is not null then execute format('alter table public.schedule_baselines drop constraint %I', c); end if;
  alter table public.schedule_baselines add constraint schedule_baselines_cost_source_check
    check (cost_source in ('value','msp_baseline_cost','budget_lines','value_less_margin','resources'));
  if to_regprocedure('app.set_baseline_core(jsonb)') is null then
    alter function public.set_baseline(jsonb) set schema app;
    alter function app.set_baseline(jsonb) rename to set_baseline_core;
  end if;
end $$;
revoke execute on function app.set_baseline_core(jsonb) from public;

create or replace function public.set_baseline(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_res jsonb; v_id uuid; v_tot record;
begin
  if v_seen is not null then return v_seen; end if;
  if coalesce(p ->> 'cost_source', '') <> 'resources' then
    return app.op_done(p, 'set_baseline', app.set_baseline_core(p - 'op_id'));
  end if;
  if not app.can_see_prices() then raise exception 'Only price roles can cost a baseline from the resource rates'; end if;
  v_res := app.set_baseline_core((p - 'op_id') || jsonb_build_object('cost_source', 'value'));
  v_id := (v_res ->> 'id')::uuid;
  update public.schedule_baselines set cost_source = 'resources' where id = v_id;
  update public.schedule_baseline_task_costs c set bac_cost = x.cost
    from (select task_id, sum(cost) as cost from public.v_task_resource_cost where cost is not null group by task_id) x
   where c.baseline_id = v_id and c.task_id = x.task_id and x.cost > 0;
  select round(sum(bac_value), 2) bv, round(sum(bac_cost), 2) bc into v_tot from public.schedule_baseline_task_costs where baseline_id = v_id;
  return app.op_done(p, 'set_baseline', v_res || jsonb_build_object('bac_value', v_tot.bv, 'bac_cost', v_tot.bc, 'cost_source', 'resources'));
end $$;

revoke execute on function app.renumber_schedule(uuid) from public;
revoke execute on function app.replan_schedule(uuid, uuid[]) from public;
revoke execute on function app.schedule_snapshot(uuid) from public;
