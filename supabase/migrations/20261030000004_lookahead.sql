-- =============================================================================
-- Monthly Tasks Window — look-ahead planning, make-ready and weekly PPC
-- (docs/research/procurement-lookahead.md §8–§9, schedule-ux.md §8).
--
--   lookahead_plans        one per project × calendar mode × month (Gregorian or Ethiopian)
--   lookahead_weeks        Mon–Sat planning weeks of the month + 2 make-ready buffer weeks
--   lookahead_items        schedule tasks in the window, classified starting/ongoing/
--                          finishing/starting_next/late, with last planner + readiness
--   lookahead_constraints  constraint log (Koskela's 7 preconditions + approval + inspection);
--                          auto-detected ones are refreshed, manual ones kept
--   constraint_events      append-only log of every constraint change
--   weekly_commitments     weekly work plan (Last Planner): commit only ready work,
--                          outcome + reason for non-completion (RNC), roll-forward
--   rnc_reasons            LCI 12 standard reasons + local ones
--
-- Material needs are computed live (app.la_material_calc): take-off × wastage ×
-- remaining %, spread over the window by working days, allocated against
-- available-to-issue stock + open POs by need-by date (greedy, earliest need first).
--
-- Depends on 20261030000003_schedule_evm.sql (schedule_tasks, schedule_links,
-- task_element_links, task_boq_links, app.is_working_day, app.working_days) and
-- 20261030000002_mr_flows.sql (request_type, save_mr with request_type). Every
-- function that touches schedule objects is PL/pgSQL (bodies resolve at run time),
-- FKs to schedule tables are added only when they exist, and request_type is read
-- through to_jsonb(), so this file also applies on a database without them.
--
-- "Today" for planning maths is app.la_today(): EAT date, or the GUC
-- app.lookahead_today when set (tests / back-dated what-if runs).
--
-- pg_cron (times in UTC; EAT = UTC+3):
--   select cron.schedule('generate-lookahead', '0 3 25 * *', $$select app.cron_generate_lookaheads()$$);  -- 25th 06:00 EAT, next month, draft
--   select cron.schedule('refresh-lookahead',  '0 23 * * *', $$select app.cron_refresh_lookaheads()$$);   -- nightly 02:00 EAT
--   select cron.schedule('lookahead-reminders', '0 12 * * 5', $$select app.cron_lookahead_reminders()$$); -- Friday 15:00 EAT
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Settings and links on existing tables
-- -----------------------------------------------------------------------------

alter table public.project_settings
  add column if not exists lookahead_calendar_mode text not null default 'gregorian'
      check (lookahead_calendar_mode in ('gregorian','ethiopian')),
  add column if not exists lookahead_horizon_weeks int not null default 2 check (lookahead_horizon_weeks between 0 and 6),
  add column if not exists ppc_target numeric(5,2) not null default 80;

-- Normally added by 20261030000002_mr_flows.sql; repeated (no-op) so this file stands alone.
alter table public.material_requests add column if not exists lookahead_plan_id uuid;
alter table public.mr_lines add column if not exists lookahead_item_id uuid;

create or replace function app.la_today() returns date
language sql stable as $$
  select coalesce(nullif(current_setting('app.lookahead_today', true), '')::date, app.eat_date(now()))
$$;

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

create table public.lookahead_plans (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id),
  calendar_mode   text not null default 'gregorian' check (calendar_mode in ('gregorian','ethiopian')),
  period_year     int not null,                      -- Gregorian or E.C. year
  period_month    int not null check (period_month between 1 and 12),
  period_label    text not null,                     -- '2026-11' or 'Hidar 2019'
  period_label_am text,
  period_start    date not null,
  period_end      date not null,
  horizon_end     date not null,
  working_days    numeric(5,1) not null default 0,   -- in the period (project calendar)
  status          text not null default 'draft' check (status in ('draft','published','closed')),
  schedule_id     uuid,                              -- schedule used (FK below when present)
  schedule_version_id uuid,
  generated_at    timestamptz, generated_by uuid references public.profiles (id),
  refreshed_at    timestamptz,
  published_at    timestamptz, published_by uuid references public.profiles (id),
  closed_at       timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, calendar_mode, period_start),
  check (period_end >= period_start and horizon_end >= period_end)
);

create table public.lookahead_weeks (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.lookahead_plans (id) on delete cascade,
  project_id      uuid not null references public.projects (id),
  week_no         int not null,
  week_start      date not null,
  week_end        date not null,
  working_days    numeric(4,1) not null,
  in_buffer       boolean not null default false,    -- the make-ready weeks after the period
  status          text not null default 'open' check (status in ('open','committed','closed')),
  committed_count int, completed_count int,
  ppc             numeric(5,2),                      -- completed / committed × 100
  pcr             numeric(5,2),                      -- constraints removed on time / due × 100
  ta              numeric(5,2),                      -- tasks anticipated (in look-ahead ≥ 2 weeks earlier) %
  closed_by       uuid references public.profiles (id),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (plan_id, week_start),
  check (week_end >= week_start)
);

create table public.lookahead_items (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid not null references public.lookahead_plans (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  schedule_task_id uuid,                              -- null = manually added
  element_id       uuid references public.elements (id),   -- primary linked element
  wbs              text,
  group_name       text,                              -- parent summary task (group header)
  name             text not null,
  window_role      text not null check (window_role in ('starting','ongoing','finishing','starting_next','late','manual')),
  is_milestone     boolean not null default false,
  is_critical      boolean not null default false,
  total_float_days numeric(8,2),
  planned_start    date,                              -- snapshot: forecast else planned
  planned_finish   date,
  pct_at_generation numeric(5,2) not null default 0,
  pct_complete     numeric(5,2) not null default 0,   -- live (refresh)
  target_pct_end_of_period numeric(5,2),              -- expected % at period end (linear on working days)
  week_days        jsonb not null default '{}'::jsonb,   -- {week_start: working days of the task in that week}
  responsible_id   uuid references public.profiles (id), -- last planner
  readiness        text not null default 'not_ready' check (readiness in ('ready','at_risk','not_ready')),
  status           text not null default 'active' check (status in ('active','dropped','done')),
  first_seen_on    date not null default current_date, -- first time the task entered any look-ahead (TA metric)
  sort_key         text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (plan_id, schedule_task_id)
);
create index lookahead_items_task_idx on public.lookahead_items (schedule_task_id);
create index lookahead_items_responsible_idx on public.lookahead_items (responsible_id) where responsible_id is not null;

create table public.lookahead_constraints (
  id               uuid primary key default gen_random_uuid(),
  item_id          uuid not null references public.lookahead_items (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  ctype            text not null check (ctype in ('predecessor','material','approval','inspection','information',
                                                  'labour','equipment','space','external')),
  description      text not null,
  auto             boolean not null default false,
  advisory         boolean not null default false,   -- e.g. Kiremt weather: never makes the item not_ready
  source_type      text,                              -- schedule_task / material_spec / material_request / element_activity / ...
  source_id        uuid,
  material_spec_id uuid references public.material_specs (id),
  qty_short        numeric(16,3),
  linked_mr_id     uuid references public.material_requests (id),
  owner_id         uuid references public.profiles (id),
  owner_role       text,
  due_date         date,
  status           text not null default 'open' check (status in ('open','in_progress','cleared','blocked','waived')),
  cleared_at       timestamptz,
  cleared_on       date,                              -- planning date of clearing (PCR)
  cleared_by       uuid references public.profiles (id),   -- null + cleared = auto-cleared
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index lookahead_constraints_auto_key on public.lookahead_constraints (item_id, ctype, source_type, source_id)
  nulls not distinct where auto;
create index lookahead_constraints_item_idx on public.lookahead_constraints (item_id);
create index lookahead_constraints_owner_idx on public.lookahead_constraints (owner_id) where owner_id is not null;

create table public.constraint_events (
  id            uuid primary key default gen_random_uuid(),
  constraint_id uuid not null references public.lookahead_constraints (id) on delete cascade,
  project_id    uuid not null references public.projects (id),
  action        text not null,      -- created / auto_created / auto_cleared / auto_reopened / status / owner / due / comment / pr_raised
  from_status   text,
  to_status     text,
  comment       text,
  payload       jsonb,
  actor         uuid references public.profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index constraint_events_constraint_idx on public.constraint_events (constraint_id);

create table public.rnc_reasons (
  code       text primary key,
  label      text not null,
  label_am   text,
  category   text not null,          -- Koskela precondition / LCI group
  is_lci     boolean not null default true,
  sort       int not null default 0,
  updated_at timestamptz not null default now()
);
insert into public.rnc_reasons (code, label, label_am, category, is_lci, sort) values
  ('materials',          'Materials not available',          'የግብዓት እጥረት',            'materials',    true, 1),
  ('prerequisite_work',  'Prerequisite work not complete',   'ቀዳሚ ሥራ አልተጠናቀቀም',      'predecessor',  true, 2),
  ('design_info',        'Design / information missing',     'የዲዛይን ወይም የመረጃ ችግር',   'information',  true, 3),
  ('failed_inspection',  'Failed or pending inspection',     'ፍተሻ አላለፈም',             'inspection',   true, 4),
  ('labour',             'Labour / crew not available',      'የሰው ኃይል እጥረት',          'labour',       true, 5),
  ('equipment',          'Equipment not available',          'የመሣሪያ ችግር',             'equipment',    true, 6),
  ('weather',            'Weather',                          'የአየር ሁኔታ',              'external',     true, 7),
  ('space_access',       'Space / access not available',     'ቦታ ወይም መዳረሻ አልተገኘም',   'space',        true, 8),
  ('approvals',          'Approval / permit late',           'ፈቃድ ወይም ማጽደቅ ዘግይቷል',   'approval',     true, 9),
  ('client_change',      'Client / design change',           'የአሠሪ ለውጥ',              'information',  true, 10),
  ('bad_planning',       'Over-commitment / poor planning',  'ከአቅም በላይ ዕቅድ',          'planning',     true, 11),
  ('subcontractor',      'Subcontractor did not perform',    'ንዑስ ተቋራጭ',              'labour',       true, 12),
  ('power_water_outage', 'Power or water outage',            'የመብራት ወይም የውሃ መቋረጥ',   'external',     false, 13),
  ('other',              'Other',                            'ሌላ',                     'other',        false, 99)
on conflict (code) do nothing;

create table public.weekly_commitments (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid not null references public.lookahead_items (id) on delete cascade,
  week_id             uuid not null references public.lookahead_weeks (id) on delete cascade,
  plan_id             uuid not null references public.lookahead_plans (id) on delete cascade,
  project_id          uuid not null references public.projects (id),
  kind                text not null default 'commitment' check (kind in ('commitment','candidate')),  -- candidate = rolled forward, not yet re-committed
  description         text not null,                 -- the assignment, e.g. "Cast columns C1–C8 level 3"
  target_pct          numeric(5,2) check (target_pct between 0 and 100),
  target_qty          numeric(16,3),
  target_uom          text,
  committed_by        uuid not null references public.profiles (id),
  committed_at        timestamptz not null default now(),
  readiness_at_commit text not null check (readiness_at_commit in ('ready','at_risk','not_ready')),
  override_reason     text,
  outcome             text not null default 'pending' check (outcome in ('pending','completed','not_completed')),
  actual_pct          numeric(5,2),
  actual_qty          numeric(16,3),
  rnc_code            text references public.rnc_reasons (code),
  rnc_note            text,
  reported_by         uuid references public.profiles (id),
  reported_at         timestamptz,
  rolled_from_id      uuid references public.weekly_commitments (id),
  rolled_to_id        uuid references public.weekly_commitments (id),
  closed_by           uuid references public.profiles (id),
  closed_at           timestamptz,
  device_id           uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (outcome <> 'not_completed' or rnc_code is not null),
  check (readiness_at_commit = 'ready' or override_reason is not null)
);
create index weekly_commitments_week_idx on public.weekly_commitments (week_id);
create index weekly_commitments_item_idx on public.weekly_commitments (item_id);

-- FKs to procurement flow columns and to the schedule (when present).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'material_requests_lookahead_fk') then
    alter table public.material_requests add constraint material_requests_lookahead_fk
      foreign key (lookahead_plan_id) references public.lookahead_plans (id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mr_lines_lookahead_item_fk') then
    alter table public.mr_lines add constraint mr_lines_lookahead_item_fk
      foreign key (lookahead_item_id) references public.lookahead_items (id);
  end if;
  if to_regclass('public.schedule_tasks') is not null then
    alter table public.lookahead_items add constraint lookahead_items_task_fk
      foreign key (schedule_task_id) references public.schedule_tasks (id);
  end if;
  if to_regclass('public.schedules') is not null then
    alter table public.lookahead_plans add constraint lookahead_plans_schedule_fk
      foreign key (schedule_id) references public.schedules (id);
  end if;
end $$;
create index if not exists mr_lines_lookahead_item_idx on public.mr_lines (lookahead_item_id) where lookahead_item_id is not null;

-- Triggers, RLS
do $$
declare t text;
begin
  foreach t in array array['lookahead_plans','lookahead_weeks','lookahead_items','lookahead_constraints',
    'constraint_events','rnc_reasons','weekly_commitments'] loop
    execute format('create trigger touch_updated_at before update on public.%I
                    for each row execute function app.touch_updated_at()', t);
    execute format('create index %I on public.%I (updated_at)', t || '_updated_at_idx', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['lookahead_plans','lookahead_items','lookahead_constraints','weekly_commitments','rnc_reasons'] loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function app.audit()', t);
  end loop;
  foreach t in array array['lookahead_plans','weekly_commitments'] loop
    execute format('create trigger no_delete before delete on public.%I
                    for each row execute function app.block_mutation()', t);
  end loop;
  foreach t in array array['lookahead_plans','lookahead_weeks','lookahead_items','lookahead_constraints',
    'constraint_events','weekly_commitments'] loop
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;
create trigger immutable before update or delete on public.constraint_events
  for each row execute function app.block_mutation();
create policy read_all on public.rnc_reasons for select to authenticated using (app.is_active_user());

-- -----------------------------------------------------------------------------
-- Calendar maths (wrappers over the schedule migration's calendar functions)
-- -----------------------------------------------------------------------------

-- Working days between two dates, inclusive; 0 when the range is empty.
create or replace function app.la_wd(p_project uuid, p_from date, p_to date) returns numeric
language plpgsql stable as $$
begin
  if p_from is null or p_to is null or p_from > p_to then return 0; end if;
  return coalesce(app.working_days(p_project, p_from, p_to), 0)::numeric;
end $$;

-- Shift a date by n working days (negative = earlier), always landing on a working day when n <> 0.
create or replace function app.la_shift(p_project uuid, p_date date, p_n int) returns date
language plpgsql stable as $$
declare d date := p_date; k int := 0; v_step int := case when p_n < 0 then -1 else 1 end; v_guard int := 0;
begin
  if p_date is null then return null; end if;
  if coalesce(p_n, 0) = 0 then return p_date; end if;
  while k < abs(p_n) loop
    d := d + v_step;
    v_guard := v_guard + 1;
    if app.is_working_day(p_project, d) then k := k + 1; end if;
    exit when v_guard > 3660;
  end loop;
  return d;
end $$;

-- Period of a planning month. Ethiopian: 30-day month; Pagume (5/6 days) is merged into Meskerem's plan.
create or replace function app.la_period(p_mode text, p_year int, p_month int,
  out period_start date, out period_end date, out label text, out label_am text)
language plpgsql immutable as $$
declare a record; b record;
begin
  if p_month is null or p_year is null then raise exception 'Choose a year and month'; end if;
  if p_mode = 'ethiopian' then
    if p_month = 13 then
      raise exception 'Pagume is planned together with Meskerem: choose Meskerem %', p_year + 1;
    end if;
    if p_month < 1 or p_month > 12 then raise exception 'Invalid Ethiopian month %', p_month; end if;
    period_start := case when p_month = 1 then app.from_ethiopian(p_year - 1, 13, 1) else app.from_ethiopian(p_year, p_month, 1) end;
    period_end := app.from_ethiopian(p_year, p_month, 30);
    label := app.ethiopian_month_name(p_month) || ' ' || p_year;
    label_am := app.ethiopian_month_name(p_month, 'am') || ' ' || p_year;
  elsif p_mode = 'gregorian' then
    if p_month < 1 or p_month > 12 then raise exception 'Invalid month %', p_month; end if;
    period_start := make_date(p_year, p_month, 1);
    period_end := (period_start + interval '1 month')::date - 1;
    label := to_char(period_start, 'YYYY-MM');
    select * into a from app.ethiopian_parts(period_start);
    select * into b from app.ethiopian_parts(period_end);
    label_am := app.ethiopian_month_name(a.m, 'am') || case when a.m <> b.m then '–' || app.ethiopian_month_name(b.m, 'am') else '' end
                || ' ' || b.y;
  else
    raise exception 'Unknown calendar mode %', p_mode;
  end if;
end $$;

-- The planning month after p_date (used by the 25th-of-month job and as RPC default).
create or replace function app.la_next_month(p_mode text, p_date date, out y int, out m int)
language plpgsql immutable as $$
declare e record; d date;
begin
  if p_mode = 'ethiopian' then
    select * into e from app.ethiopian_parts(p_date);
    if e.m >= 12 then y := e.y + 1; m := 1; else y := e.y; m := e.m + 1; end if;
  else
    d := (date_trunc('month', p_date) + interval '1 month')::date;
    y := extract(year from d)::int; m := extract(month from d)::int;
  end if;
end $$;

create type app.la_week as (week_no int, week_start date, week_end date, working_days numeric, in_buffer boolean);

-- Mon–Sat weeks from period start (a leading Sunday is skipped) to the horizon; each clipped to the window.
create or replace function app.la_weeks(p_project uuid, p_start date, p_end date, p_horizon date)
returns setof app.la_week language plpgsql stable as $$
declare d date := p_start; v_we date; n int := 0; r app.la_week;
begin
  if extract(isodow from d) = 7 then d := d + 1; end if;
  while d <= p_horizon loop
    v_we := least(d + ((6 - extract(isodow from d)::int + 7) % 7), p_horizon);
    n := n + 1;
    r.week_no := n; r.week_start := d; r.week_end := v_we;
    r.working_days := app.la_wd(p_project, d, v_we);
    r.in_buffer := d > p_end;
    return next r;
    d := v_we + 1;
    if extract(isodow from d) = 7 then d := d + 1; end if;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Candidates from the schedule
-- -----------------------------------------------------------------------------

-- Active schedule of a project (status active/current/published preferred, newest first).
create or replace function app.la_pick_schedule(p_project uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select s.id into v from public.schedules s
  where s.project_id = p_project and (to_jsonb(s) ->> 'deleted_at') is null
  order by (lower(coalesce(s.status::text, '')) in ('active','current','published','approved','baseline')) desc,
           (lower(coalesce(s.status::text, '')) in ('archived','superseded','deleted','cancelled')) asc,
           (s.current_version_id is not null) desc,
           (to_jsonb(s) ->> 'updated_at') desc nulls last, s.id
  limit 1;
  return v;
end $$;

create type app.la_candidate as (
  task_id uuid, parent_id uuid, group_name text, wbs text, name text, is_milestone boolean, is_critical boolean,
  total_float_days numeric, s date, f date, pct numeric, window_role text, sort_key text, expected_pct numeric,
  week_days jsonb, element_id uuid, preds_open int);

-- Non-summary tasks < 100 % that overlap [start, horizon] by forecast (else planned) dates, plus overdue ones.
create or replace function app.lookahead_candidates(p_project uuid, p_schedule uuid, p_start date, p_end date, p_horizon date)
returns setof app.la_candidate language plpgsql stable security definer set search_path = public as $$
declare v_weeks jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('ws', w.week_start, 'we', w.week_end) order by w.week_start), '[]'::jsonb)
    into v_weeks from app.la_weeks(p_project, p_start, p_end, p_horizon) w;

  return query
  with t as (
    select st.id, st.parent_id, st.wbs::text as wbs, st.name::text as name,
           coalesce(st.is_milestone, false) as mil, coalesce(st.is_critical, false) as crit,
           st.total_float_days::numeric as tf,
           coalesce(st.forecast_start, st.planned_start)::date as s0,
           coalesce(st.forecast_finish, st.planned_finish, st.forecast_start, st.planned_start)::date as f0,
           least(greatest(coalesce(st.pct_complete, 0), 0), 100)::numeric as pct, st.sort_order
    from public.schedule_tasks st
    where st.schedule_id = p_schedule and st.project_id = p_project and st.deleted_at is null
      and not coalesce(st.is_summary, false) and coalesce(st.pct_complete, 0) < 100 and st.actual_finish is null
      and coalesce(st.forecast_start, st.planned_start) is not null
  ), t2 as (
    select t.*, greatest(t.f0, t.s0) as f1 from t
  ), sel as (
    select t2.* from t2 where (t2.s0 <= p_horizon and t2.f1 >= p_start) or t2.f1 < p_start
  )
  select sel.id, sel.parent_id, par.name::text, sel.wbs, sel.name, sel.mil, sel.crit, sel.tf, sel.s0, sel.f1, sel.pct,
    (case when sel.f1 < p_start then 'late'
          when sel.s0 > p_end then 'starting_next'
          when sel.s0 >= p_start then 'starting'
          when sel.f1 <= p_end then 'finishing'
          else 'ongoing' end)::text,
    lpad(coalesce(sel.sort_order, 0)::text, 8, '0')::text,
    (case when sel.f1 <= p_end then 100
          when sel.s0 > p_end then 0
          else round(100 * app.la_wd(p_project, sel.s0, p_end) / nullif(app.la_wd(p_project, sel.s0, sel.f1), 0), 1) end)::numeric,
    coalesce((select jsonb_object_agg(w ->> 'ws', app.la_wd(p_project, greatest(sel.s0, (w ->> 'ws')::date), least(sel.f1, (w ->> 'we')::date)))
              from jsonb_array_elements(v_weeks) w
              where sel.s0 <= (w ->> 'we')::date and sel.f1 >= (w ->> 'ws')::date), '{}'::jsonb),
    (select l.element_id from public.task_element_links l
      where l.task_id = sel.id and (to_jsonb(l) ->> 'deleted_at') is null order by l.element_id limit 1),
    (select count(*)::int from public.schedule_links sl join public.schedule_tasks p on p.id = sl.pred_task_id
      where sl.succ_task_id = sel.id and (to_jsonb(sl) ->> 'deleted_at') is null and p.deleted_at is null
        and coalesce(p.pct_complete, 0) < 100 and p.actual_finish is null)
  from sel
  left join public.schedule_tasks par on par.id = sel.parent_id
  order by sel.sort_order nulls last, sel.s0;
end $$;

-- -----------------------------------------------------------------------------
-- Material needs (live)
-- -----------------------------------------------------------------------------

-- Request type with a fallback for databases without the procurement-flow migration.
create or replace function app.la_mr_kind(r public.material_requests) returns text
language sql stable as $$
  select coalesce(to_jsonb(r) ->> 'request_type',
                  case when r.purpose = 'Reorder' or r.purpose like 'Look-ahead purchase%' then 'purchase' else 'site_use' end)
$$;

create type app.la_material_row as (
  plan_id uuid, project_id uuid, item_id uuid, material_spec_id uuid, element_ids uuid[],
  total_need numeric, remaining numeric, window_need numeric, weekly_need jsonb,
  need_by date, order_by date, lead_time_days int, safety_days int, pack_size numeric,
  ati_before numeric, from_stock numeric, from_po numeric, from_po_late numeric, from_procurement numeric, from_pending_pr numeric,
  short_firm numeric, to_order numeric, suggested_qty numeric,
  raise_pr_now boolean, late_order boolean, arrives_late boolean, suggest_sur boolean,
  next_po_eta date, late_po_eta date, po_numbers text[], mr_numbers text[]);

-- Per item × spec. Supply per project × spec: ATI (available − reserved for approved site-use requests not
-- belonging to this plan), open PO outstanding by ETA, approved-not-ordered PR qty, pending PR qty;
-- allocated greedily in need-by order. short_firm = not covered by stock + POs on time ("bought and promised").
create or replace function app.la_material_calc(p_plan uuid) returns setof app.la_material_row
language plpgsql stable set search_path = public as $$
declare
  v_today date := app.la_today();
  v_project uuid; v_start date; v_end date; v_hor date;
  v_items uuid[];
  d record;
  r app.la_material_row;
  v_spec uuid := null;
  v_ati numeric; v_proc numeric; v_pend numeric; v_mrs text[];
  v_po_eta date[]; v_po_qty numeric[]; v_po_no text[];
  v_rem numeric; v_take numeric; v_share numeric; k int; v_pos text[];
begin
  select project_id, period_start, period_end, horizon_end into v_project, v_start, v_end, v_hor
    from public.lookahead_plans where id = p_plan;
  if v_project is null then return; end if;
  select coalesce(array_agg(id), '{}') into v_items from public.lookahead_items where plan_id = p_plan;

  for d in
    with it as materialized (
      select i.id, i.schedule_task_id, i.sort_key, x.s, x.f, x.pct,
             app.la_wd(v_project, greatest(x.s, v_today), x.f) as den,
             app.la_wd(v_project, greatest(x.s, v_today, v_start), least(x.f, v_hor)) as num,
             coalesce((select jsonb_object_agg(w.week_start::text,
                         app.la_wd(v_project, greatest(x.s, v_today, w.week_start), least(x.f, w.week_end)))
                       from public.lookahead_weeks w where w.plan_id = p_plan), '{}'::jsonb) as wk,
             (select min(w.week_start) from public.lookahead_weeks w where w.plan_id = p_plan and w.week_end >= greatest(x.s, v_start)) as first_ws
      from public.lookahead_items i
      cross join lateral (select coalesce(i.planned_start, v_start) as s,
                                 greatest(coalesce(i.planned_finish, i.planned_start, v_start), coalesce(i.planned_start, v_start)) as f,
                                 least(greatest(coalesce(i.pct_complete, 0), 0), 100) as pct) x
      where i.plan_id = p_plan and i.status = 'active' and i.schedule_task_id is not null and not i.is_milestone
    ),
    links as (
      select it.id as item_id, l.element_id
      from it join public.task_element_links l on l.task_id = it.schedule_task_id
      where (to_jsonb(l) ->> 'deleted_at') is null
    ),
    rows_direct as (
      select lk.item_id, t.element_id, t.material_spec_id, t.planned_qty * (1 + ms.wastage_pct / 100) as need, 1::numeric as share
      from links lk
      join public.element_takeoffs t on t.element_id = lk.element_id and t.deleted_at is null
      join public.material_specs ms on ms.id = t.material_spec_id
    ),
    rows_boq as (
      select it.id as item_id, t.element_id, t.material_spec_id, t.planned_qty * (1 + ms.wastage_pct / 100) as need, sh.share
      from it
      join public.task_boq_links b on b.task_id = it.schedule_task_id and (to_jsonb(b) ->> 'deleted_at') is null
      join public.boq_items bq on bq.id = b.boq_item_id
      -- qty_share = BoQ quantity (item unit) delivered by this task → share of the item's take-off.
      cross join lateral (select coalesce((to_jsonb(b) ->> 'qty_share')::numeric, (to_jsonb(b) ->> 'planned_qty')::numeric) as raw) r0
      cross join lateral (select case when r0.raw is null or bq.quantity <= 0 then 1
                                      else least(greatest(r0.raw, 0) / bq.quantity, 1) end as share) sh
      join public.element_takeoffs t on t.boq_item_id = b.boq_item_id and t.deleted_at is null and t.project_id = v_project
      join public.material_specs ms on ms.id = t.material_spec_id
      where not exists (select 1 from links lk where lk.item_id = it.id and lk.element_id = t.element_id)
    ),
    rws as (select * from rows_direct union all select * from rows_boq),
    agg as (
      select rw.item_id, rw.material_spec_id, array_agg(distinct rw.element_id) as els,
             sum(rw.need * rw.share) as total_need,
             sum(greatest(rw.need * rw.share - greatest(rw.need * rw.share * it.pct / 100, coalesce(iss.qty, 0) * rw.share), 0)) as remaining
      from rws rw
      join it on it.id = rw.item_id
      left join lateral (select -sum(sl.qty) as qty from public.stock_ledger sl
                         where sl.element_id = rw.element_id and sl.material_spec_id = rw.material_spec_id
                           and sl.doc_type in ('miv','mrn')) iss on true
      group by rw.item_id, rw.material_spec_id
    )
    select a.item_id, a.material_spec_id, a.els, a.total_need, a.remaining, it.s, it.f, it.den, it.num, it.wk, it.first_ws,
           it.sort_key, ms.lead_time_days, ms.safety_days, ms.pack_size
    from agg a join it on it.id = a.item_id join public.material_specs ms on ms.id = a.material_spec_id
    where a.remaining > 0.0005
    order by a.material_spec_id, greatest(it.s, v_start), it.sort_key, a.item_id
  loop
    v_share := case when d.den > 0 then least(d.num / d.den, 1) else 1 end;
    if round(d.remaining * v_share, 3) <= 0.0005 then continue; end if;

    if v_spec is distinct from d.material_spec_id then
      v_spec := d.material_spec_id;
      select coalesce(sum(sl.qty), 0) into v_ati from public.stock_ledger sl
        where sl.project_id = v_project and sl.material_spec_id = v_spec and sl.stock_status = 'available';
      v_ati := greatest(v_ati - coalesce((
        select sum(greatest(coalesce(ml.approved_qty, 0) - coalesce(x.issued, 0), 0))
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        left join lateral (select sum(vl.qty) as issued from public.miv_lines vl
                           join public.mivs mv on mv.id = vl.miv_id and mv.status <> 'reversed' where vl.mr_line_id = ml.id) x on true
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'site_use' and mr.status::text in ('approved','sourced','ordered','partially_issued')
          and (ml.lookahead_item_id is null or not (ml.lookahead_item_id = any (v_items)))), 0), 0);
      select coalesce(array_agg(ps.expected_date order by ps.expected_date nulls last, ps.po_number), '{}'),
             coalesce(array_agg(ps.outstanding_qty order by ps.expected_date nulls last, ps.po_number), '{}'),
             coalesce(array_agg(ps.po_number::text order by ps.expected_date nulls last, ps.po_number), '{}')
        into v_po_eta, v_po_qty, v_po_no
        from public.v_po_line_status ps
        where ps.project_id = v_project and ps.material_spec_id = v_spec
          and ps.po_status in ('approved','sent','partially_received') and ps.outstanding_qty > 0;
      select coalesce(sum(greatest(coalesce(ml.approved_qty, ml.qty) - coalesce(pp.ordered_qty, 0), 0)), 0) into v_proc
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        left join public.v_mr_line_procurement pp on pp.mr_line_id = ml.id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('approved','approved_by_management','with_procurement','sourced');
      select coalesce(sum(ml.qty), 0) into v_pend
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('draft','submitted','reviewed','reviewed_by_coordinator','returned')
          and (mr.status::text <> 'draft' or mr.lookahead_plan_id = p_plan or ml.lookahead_item_id = any (v_items));
      select coalesce(array_agg(distinct mr.number), '{}') into v_mrs
        from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
        where mr.project_id = v_project and ml.material_spec_id = v_spec and ml.deleted_at is null
          and app.la_mr_kind(mr) = 'purchase'
          and mr.status::text in ('draft','submitted','reviewed','reviewed_by_coordinator','returned',
                                  'approved','approved_by_management','with_procurement','sourced')
          and (mr.status::text <> 'draft' or mr.lookahead_plan_id = p_plan or ml.lookahead_item_id = any (v_items));
    end if;

    r := null;
    r.plan_id := p_plan; r.project_id := v_project; r.item_id := d.item_id; r.material_spec_id := d.material_spec_id;
    r.element_ids := d.els;
    r.total_need := round(d.total_need, 3);
    r.remaining := round(d.remaining, 3);
    r.window_need := round(d.remaining * v_share, 3);
    r.lead_time_days := d.lead_time_days; r.safety_days := d.safety_days; r.pack_size := d.pack_size;
    r.need_by := app.la_shift(v_project, greatest(d.s, v_start), -d.safety_days);
    r.order_by := app.la_shift(v_project, r.need_by, -d.lead_time_days);
    if d.den > 0 then
      select coalesce(jsonb_object_agg(e.key, round(d.remaining * e.value::numeric / d.den, 3)) filter (where e.value::numeric > 0), '{}'::jsonb)
        into r.weekly_need from jsonb_each_text(d.wk) e;
    else
      r.weekly_need := case when d.first_ws is not null then jsonb_build_object(d.first_ws::text, r.window_need) else '{}'::jsonb end;
    end if;

    -- allocation
    v_rem := r.window_need;
    r.ati_before := round(v_ati, 3);
    r.from_stock := least(v_rem, v_ati); v_ati := v_ati - r.from_stock; v_rem := v_rem - r.from_stock;
    r.from_po := 0; r.from_po_late := 0; v_pos := '{}';
    for k in 1 .. coalesce(array_length(v_po_eta, 1), 0) loop
      exit when v_rem <= 0.0005;
      if v_po_qty[k] > 0.0005 and v_po_eta[k] is not null and v_po_eta[k] <= r.need_by then
        v_take := least(v_rem, v_po_qty[k]);
        v_po_qty[k] := v_po_qty[k] - v_take; v_rem := v_rem - v_take; r.from_po := r.from_po + v_take;
        v_pos := v_pos || v_po_no[k];
        r.next_po_eta := coalesce(r.next_po_eta, v_po_eta[k]);
      end if;
    end loop;
    r.short_firm := round(greatest(v_rem, 0), 3);
    for k in 1 .. coalesce(array_length(v_po_eta, 1), 0) loop
      exit when v_rem <= 0.0005;
      if v_po_qty[k] > 0.0005 then
        v_take := least(v_rem, v_po_qty[k]);
        v_po_qty[k] := v_po_qty[k] - v_take; v_rem := v_rem - v_take; r.from_po_late := r.from_po_late + v_take;
        v_pos := v_pos || v_po_no[k];
        r.late_po_eta := coalesce(r.late_po_eta, v_po_eta[k]);
      end if;
    end loop;
    r.from_procurement := least(greatest(v_rem, 0), v_proc); v_proc := v_proc - r.from_procurement; v_rem := v_rem - r.from_procurement;
    r.from_pending_pr := least(greatest(v_rem, 0), v_pend); v_pend := v_pend - r.from_pending_pr; v_rem := v_rem - r.from_pending_pr;
    r.from_stock := round(r.from_stock, 3); r.from_po := round(r.from_po, 3); r.from_po_late := round(r.from_po_late, 3);
    r.from_procurement := round(r.from_procurement, 3); r.from_pending_pr := round(r.from_pending_pr, 3);
    r.to_order := round(greatest(v_rem, 0), 3);
    r.suggested_qty := case when r.to_order > 0.0005 then ceil(r.to_order / r.pack_size) * r.pack_size else 0 end;
    r.raise_pr_now := r.to_order > 0.0005 and r.order_by <= v_today + 7;
    r.late_order := r.to_order > 0.0005 and r.order_by < v_today;
    r.arrives_late := r.from_po_late > 0.0005;
    r.suggest_sur := r.from_stock > 0.0005 and r.need_by <= v_today + 14;
    r.po_numbers := (select coalesce(array_agg(distinct x), '{}') from unnest(v_pos) x);
    r.mr_numbers := case when r.from_procurement + r.from_pending_pr > 0 then v_mrs else '{}' end;
    return next r;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Constraint detection, refresh and readiness
-- -----------------------------------------------------------------------------

create type app.la_detected as (
  item_id uuid, ctype text, source_type text, source_id uuid, description text, material_spec_id uuid,
  qty_short numeric, owner_id uuid, owner_role text, due_date date, hint_status text, advisory boolean, linked_mr_id uuid);

create or replace function app.la_detect_constraints(p_plan uuid) returns setof app.la_detected
language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := app.la_today();
  v_project uuid; v_start date;
  m record;
  r app.la_detected;
begin
  select project_id, period_start into v_project, v_start from public.lookahead_plans where id = p_plan;
  if v_project is null then return; end if;

  -- predecessor: FS/FF need the predecessor complete; SS/SF need it started.
  return query
  select i.id, 'predecessor'::text, 'schedule_task'::text, p.id,
    format('Predecessor "%s" is %s%% complete (finish %s)', p.name, round(coalesce(p.pct_complete, 0)),
           to_char(coalesce(p.forecast_finish, p.planned_finish), 'DD Mon YYYY')),
    null::uuid, null::numeric, pi.responsible_id, 'site_engineer'::text,
    app.la_shift(v_project, greatest(coalesce(i.planned_start, v_start), v_start), -2), 'open'::text, false, null::uuid
  from public.lookahead_items i
  join public.schedule_links sl on sl.succ_task_id = i.schedule_task_id and (to_jsonb(sl) ->> 'deleted_at') is null
  join public.schedule_tasks p on p.id = sl.pred_task_id and p.deleted_at is null
  left join public.lookahead_items pi on pi.plan_id = p_plan and pi.schedule_task_id = p.id
  where i.plan_id = p_plan and i.status = 'active'
    and case when upper(coalesce(sl.link_type::text, 'FS')) in ('SS','SF','2','3')
             then p.actual_start is null and coalesce(p.pct_complete, 0) <= 0
             else coalesce(p.pct_complete, 0) < 100 and p.actual_finish is null end;

  -- material: not covered by stock + POs arriving by the need-by date.
  for m in
    select c.*, sp.label, sp.uom, i.responsible_id
    from app.la_material_calc(p_plan) c
    join public.v_specs sp on sp.id = c.material_spec_id
    join public.lookahead_items i on i.id = c.item_id
    where c.short_firm > 0.0005
  loop
    r := null;
    r.item_id := m.item_id; r.ctype := 'material'; r.source_type := 'material_spec'; r.source_id := m.material_spec_id;
    r.material_spec_id := m.material_spec_id; r.qty_short := m.short_firm; r.due_date := m.need_by; r.advisory := false;
    r.description := format('%s: short %s %s by %s', m.label, trim(to_char(m.short_firm, 'FM999999990.###')), m.uom,
                            to_char(m.need_by, 'DD Mon YYYY'))
      || case when m.from_po_late > 0 then format(' — %s arrives %s (late)', array_to_string(m.po_numbers, ', '),
                                                   coalesce(to_char(m.late_po_eta, 'DD Mon YYYY'), 'without ETA')) else '' end
      || case when m.from_procurement + m.from_pending_pr > 0 then ' — purchase request ' || array_to_string(m.mr_numbers, ', ') else '' end
      || case when m.late_order then ' — order date passed' else '' end;
    r.hint_status := case when m.from_po_late + m.from_procurement + m.from_pending_pr >= m.short_firm - 0.0005 then 'in_progress' else 'open' end;
    r.owner_role := case when m.from_po_late + m.from_procurement > 0 then 'procurement' else 'office_engineer' end;
    r.linked_mr_id := (select ml.mr_id from public.mr_lines ml join public.material_requests mr on mr.id = ml.mr_id
                       where ml.lookahead_item_id = m.item_id and ml.material_spec_id = m.material_spec_id and ml.deleted_at is null
                         and app.la_mr_kind(mr) = 'purchase' and mr.status::text not in ('rejected','cancelled')
                       order by ml.created_at desc limit 1);
    return next r;
  end loop;

  -- approval: a request raised for the item is waiting for approval.
  return query
  select z.iid, 'approval'::text, 'material_request'::text, z.mrid,
    format('%s %s awaiting approval (%s)', case when z.kind = 'purchase' then 'Purchase request' else 'Site-use request' end,
           z.number, replace(z.st, '_', ' ')),
    null::uuid, null::numeric, null::uuid, 'coordinator'::text,
    least(min(z.rd), app.la_shift(v_project, greatest(coalesce(z.planned_start, v_start), v_start), -2)),
    'open'::text, false, z.mrid
  from (
    select i.id as iid, i.planned_start, mr.id as mrid, mr.number::text as number, mr.status::text as st,
           app.la_mr_kind(mr) as kind, coalesce(ml.required_date, mr.required_date) as rd
    from public.lookahead_items i
    join public.mr_lines ml on ml.lookahead_item_id = i.id and ml.deleted_at is null
    join public.material_requests mr on mr.id = ml.mr_id
    where i.plan_id = p_plan and i.status = 'active'
      and mr.status::text in ('submitted','reviewed','reviewed_by_coordinator','returned')
  ) z
  group by z.iid, z.planned_start, z.mrid, z.number, z.st, z.kind;

  -- inspection: unverified hold point before the activity the task performs on a linked element.
  return query
  select i.id, 'inspection'::text, 'element_activity'::text, a.id,
    format('Hold point "%s" on %s not passed%s', a.name, e.code,
           coalesce(' (last inspection: ' || li.result || ')', ' (not inspected)')),
    null::uuid, null::numeric, null::uuid, 'office_engineer'::text,
    app.la_shift(v_project, greatest(coalesce(i.planned_start, v_start), v_start), -2), 'open'::text, false, null::uuid
  from public.lookahead_items i
  join public.task_element_links l on l.task_id = i.schedule_task_id and (to_jsonb(l) ->> 'deleted_at') is null
  join public.elements e on e.id = l.element_id
  cross join lateral (
    select min(c.seq) as tgt from public.element_activities c
    where c.element_id = e.id and not c.is_hold_point
      and ((i.name ~* '(cast|concret|pour)' and (c.name ilike 'cast%' or c.name ilike 'concret%'))
           or position(lower(c.name) in lower(i.name)) > 0)) tg
  join public.element_activities a on a.element_id = e.id and a.is_hold_point and a.verified_pct < 100 and a.seq < tg.tgt
  left join lateral (select ins.result from public.inspections ins where ins.element_activity_id = a.id and ins.status = 'completed'
                     order by ins.inspected_at desc nulls last, ins.created_at desc limit 1) li on true
  where i.plan_id = p_plan and i.status = 'active' and tg.tgt is not null;

  -- information: drawing not issued for construction, or a recent site instruction on a linked element.
  return query
  select i.id, 'information'::text, 'element_drawing'::text, e.id,
    format('Drawing %s for %s is not issued for construction', e.drawing_ref, e.code),
    null::uuid, null::numeric, null::uuid, 'office_engineer'::text,
    app.la_shift(v_project, greatest(coalesce(i.planned_start, v_start), v_start), -2), 'open'::text, false, null::uuid
  from public.lookahead_items i
  join public.task_element_links l on l.task_id = i.schedule_task_id and (to_jsonb(l) ->> 'deleted_at') is null
  join public.elements e on e.id = l.element_id
  where i.plan_id = p_plan and i.status = 'active'
    and e.drawing_ref ~* '(draft|prelim|tender|comment|not for construction|\mnfc\M)';

  return query
  select i.id, 'information'::text, 'diary_instruction'::text, di.id,
    'Site instruction on ' || e.code || ': ' || left(di.instruction, 140),
    null::uuid, null::numeric, null::uuid, 'office_engineer'::text,
    app.la_shift(v_project, greatest(coalesce(i.planned_start, v_start), v_start), -2), 'open'::text, false, null::uuid
  from public.lookahead_items i
  join public.task_element_links l on l.task_id = i.schedule_task_id and (to_jsonb(l) ->> 'deleted_at') is null
  join public.elements e on e.id = l.element_id
  join public.diary_instructions di on di.element_id = e.id and di.deleted_at is null
  join public.site_diaries sd on sd.id = di.diary_id and sd.diary_date between v_today - 14 and v_today
  where i.plan_id = p_plan and i.status = 'active';

  -- external (advisory): Kiremt rains for weather-sensitive work.
  return query
  select i.id, 'external'::text, 'kiremt'::text, null::uuid,
    'Kiremt rains (mid-Jun – mid-Sep): plan weather protection, dewatering and pour windows'::text,
    null::uuid, null::numeric, i.responsible_id, 'site_engineer'::text,
    app.la_shift(v_project, greatest(coalesce(i.planned_start, v_start), v_start), -2), 'open'::text, true, null::uuid
  from public.lookahead_items i
  where i.plan_id = p_plan and i.status = 'active' and i.planned_start is not null
    and i.name ~* '(excavat|earth|backfill|foundation|footing|concret|cast|pour|roof|asphalt|grading|compaction|screed)'
    and exists (select 1 from generate_series(extract(year from i.planned_start)::int,
                                              extract(year from coalesce(i.planned_finish, i.planned_start))::int) y
                where i.planned_start <= make_date(y, 9, 15) and coalesce(i.planned_finish, i.planned_start) >= make_date(y, 6, 15));
end $$;

create or replace function app.la_log(p_constraint uuid, p_project uuid, p_action text, p_from text, p_to text,
  p_comment text default null, p_payload jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into public.constraint_events (constraint_id, project_id, action, from_status, to_status, comment, payload, actor)
  values (p_constraint, p_project, p_action, p_from, p_to, p_comment, p_payload, auth.uid())
$$;

-- Insert new auto constraints, update existing ones, auto-clear those no longer detected.
-- Manually cleared / waived auto constraints stay closed; auto-cleared ones reopen if detected again.
create or replace function app.la_refresh_constraints(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d app.la_detected;
  c public.lookahead_constraints;
  v_project uuid;
  v_today date := app.la_today();
  v_keys text[] := '{}';
  v_key text;
  v_new int := 0; v_cleared int := 0; v_reopened int := 0;
  v_status text;
begin
  select project_id into v_project from public.lookahead_plans where id = p_plan;
  for d in select * from app.la_detect_constraints(p_plan) loop
    v_key := d.item_id || '|' || d.ctype || '|' || coalesce(d.source_type, '') || '|' || coalesce(d.source_id::text, '');
    if v_key = any (v_keys) then continue; end if;
    v_keys := v_keys || v_key;
    select * into c from public.lookahead_constraints lc
      where lc.auto and lc.item_id = d.item_id and lc.ctype = d.ctype
        and lc.source_type is not distinct from d.source_type and lc.source_id is not distinct from d.source_id;
    if not found then
      insert into public.lookahead_constraints (item_id, project_id, ctype, description, auto, advisory, source_type, source_id,
        material_spec_id, qty_short, linked_mr_id, owner_id, owner_role, due_date, status)
      values (d.item_id, v_project, d.ctype, d.description, true, coalesce(d.advisory, false), d.source_type, d.source_id,
        d.material_spec_id, d.qty_short, d.linked_mr_id, d.owner_id, d.owner_role, d.due_date, d.hint_status)
      returning * into c;
      perform app.la_log(c.id, v_project, 'auto_created', null, c.status, null, jsonb_build_object('description', d.description));
      v_new := v_new + 1;
    elsif c.status in ('cleared','waived') and (c.cleared_by is not null or c.status = 'waived') then
      update public.lookahead_constraints set description = d.description, qty_short = d.qty_short, due_date = d.due_date,
        linked_mr_id = coalesce(d.linked_mr_id, linked_mr_id)
      where id = c.id and (description, qty_short, due_date) is distinct from (d.description, d.qty_short, d.due_date);
    elsif c.status = 'cleared' then
      update public.lookahead_constraints set status = d.hint_status, cleared_at = null, cleared_on = null, cleared_by = null,
        description = d.description, qty_short = d.qty_short, due_date = d.due_date,
        linked_mr_id = coalesce(d.linked_mr_id, linked_mr_id), owner_id = coalesce(owner_id, d.owner_id)
      where id = c.id;
      perform app.la_log(c.id, v_project, 'auto_reopened', 'cleared', d.hint_status, null, jsonb_build_object('description', d.description));
      v_reopened := v_reopened + 1;
    else
      v_status := case when c.status = 'blocked' then 'blocked' when d.hint_status = 'in_progress' then 'in_progress' else c.status end;
      update public.lookahead_constraints set description = d.description, qty_short = d.qty_short, due_date = d.due_date,
        material_spec_id = d.material_spec_id, linked_mr_id = coalesce(d.linked_mr_id, linked_mr_id),
        owner_id = coalesce(owner_id, d.owner_id), owner_role = coalesce(owner_role, d.owner_role), status = v_status
      where id = c.id
        and (description, qty_short, due_date, linked_mr_id, owner_id, status)
            is distinct from (d.description, d.qty_short, d.due_date, coalesce(d.linked_mr_id, c.linked_mr_id),
                              coalesce(c.owner_id, d.owner_id), v_status);
      if v_status <> c.status then
        perform app.la_log(c.id, v_project, 'status', c.status, v_status, 'Auto: ' || d.description);
      end if;
    end if;
  end loop;

  for c in
    select lc.* from public.lookahead_constraints lc join public.lookahead_items i on i.id = lc.item_id
    where i.plan_id = p_plan and lc.auto and lc.status in ('open','in_progress','blocked')
      and not ((lc.item_id || '|' || lc.ctype || '|' || coalesce(lc.source_type, '') || '|' || coalesce(lc.source_id::text, '')) = any (v_keys))
  loop
    update public.lookahead_constraints set status = 'cleared', cleared_at = now(), cleared_on = v_today, cleared_by = null,
      qty_short = case when ctype = 'material' then 0 else qty_short end
    where id = c.id;
    perform app.la_log(c.id, v_project, 'auto_cleared', c.status, 'cleared');
    v_cleared := v_cleared + 1;
  end loop;
  return jsonb_build_object('new', v_new, 'auto_cleared', v_cleared, 'reopened', v_reopened);
end $$;

-- ready: no open constraint · not_ready: blocked, or an open (non-advisory) constraint past its due date · else at_risk.
create or replace function app.la_readiness_of(p_item uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.lookahead_constraints c where c.item_id = p_item and c.status in ('open','in_progress','blocked'))
      then 'ready'
    when exists (select 1 from public.lookahead_constraints c where c.item_id = p_item and not c.advisory
                 and (c.status = 'blocked' or (c.status in ('open','in_progress') and c.due_date < app.la_today())))
      then 'not_ready'
    else 'at_risk' end
$$;

create or replace function app.la_refresh_readiness(p_plan uuid) returns void
language sql security definer set search_path = public as $$
  update public.lookahead_items i set readiness = app.la_readiness_of(i.id)
  where i.plan_id = p_plan and i.readiness is distinct from app.la_readiness_of(i.id)
$$;

-- Live progress from the schedule; finished / deleted tasks leave the active list.
create or replace function app.la_sync_progress(p_plan uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.lookahead_items i set
    pct_complete = least(greatest(coalesce(st.pct_complete, 0), 0), 100),
    status = case when st.deleted_at is not null then 'dropped'
                  when coalesce(st.pct_complete, 0) >= 100 or st.actual_finish is not null then 'done'
                  else i.status end
  from public.schedule_tasks st
  where i.plan_id = p_plan and st.id = i.schedule_task_id and i.status = 'active'
    and (i.pct_complete is distinct from least(greatest(coalesce(st.pct_complete, 0), 0), 100)
         or st.deleted_at is not null or coalesce(st.pct_complete, 0) >= 100 or st.actual_finish is not null);
end $$;

create or replace function app.la_refresh(p_plan uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  perform app.la_sync_progress(p_plan);
  v := app.la_refresh_constraints(p_plan);
  perform app.la_refresh_readiness(p_plan);
  update public.lookahead_plans set refreshed_at = now() where id = p_plan;
  return v;
end $$;

-- Summary counts returned by generate / refresh.
create or replace function app.la_summary(p_plan uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; m jsonb;
begin
  select jsonb_build_object(
    'items', count(*) filter (where i.status = 'active'),
    'ready', count(*) filter (where i.status = 'active' and i.readiness = 'ready'),
    'at_risk', count(*) filter (where i.status = 'active' and i.readiness = 'at_risk'),
    'not_ready', count(*) filter (where i.status = 'active' and i.readiness = 'not_ready'),
    'constraints_open', (select count(*) from public.lookahead_constraints c join public.lookahead_items i2 on i2.id = c.item_id
                         where i2.plan_id = p_plan and i2.status = 'active' and c.status in ('open','in_progress','blocked')))
    into v from public.lookahead_items i where i.plan_id = p_plan;
  select jsonb_build_object(
    'material_shortfalls', count(distinct material_spec_id) filter (where short_firm > 0.0005),
    'raise_pr_now', count(distinct material_spec_id) filter (where raise_pr_now),
    'late_order', count(distinct material_spec_id) filter (where late_order))
    into m from app.la_material_calc(p_plan);
  return v || m;
end $$;

-- -----------------------------------------------------------------------------
-- Generation (shared by the RPC and pg_cron)
-- -----------------------------------------------------------------------------

create or replace function app.la_generate(p_project uuid, p_mode text, p_year int, p_month int,
  p_plan_id uuid default null, p_schedule uuid default null, p_horizon_weeks int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := app.la_today();
  per record;
  pl public.lookahead_plans;
  v_hor date;
  v_weeks int;
  v_schedule uuid := coalesce(p_schedule, app.la_pick_schedule(p_project));
  c app.la_candidate;
  w app.la_week;
  v_keep uuid[] := '{}';
  v_week_starts date[] := '{}';
  v_item uuid;
  v_new int := 0; v_dropped int := 0;
  v_prev record;
  v_ref jsonb;
begin
  if v_schedule is null then raise exception 'No schedule has been imported for this project'; end if;
  select * into per from app.la_period(p_mode, p_year, p_month);
  select coalesce(p_horizon_weeks, s.lookahead_horizon_weeks, 2) into v_weeks
    from public.projects pj left join public.project_settings s on s.project_id = pj.id where pj.id = p_project;
  v_hor := per.period_end + 7 * coalesce(v_weeks, 2);

  select * into pl from public.lookahead_plans
    where (p_plan_id is not null and id = p_plan_id)
       or (project_id = p_project and calendar_mode = p_mode and period_start = per.period_start)
    order by (id = p_plan_id) desc nulls last limit 1
    for update;
  if found then
    if pl.project_id <> p_project then raise exception 'Plan belongs to another project'; end if;
    if pl.status = 'closed' then raise exception 'Look-ahead % is closed and cannot be regenerated', pl.period_label; end if;
    update public.lookahead_plans set horizon_end = v_hor, schedule_id = v_schedule,
      schedule_version_id = (select s.current_version_id from public.schedules s where s.id = v_schedule),
      working_days = app.la_wd(p_project, per.period_start, per.period_end),
      generated_at = now(), generated_by = auth.uid(),
      notes = case when pl.status = 'published'
                   then coalesce(notes || E'\n', '') || 'Regenerated ' || to_char(v_today, 'DD Mon YYYY') || ' after a schedule update'
                   else notes end
    where id = pl.id returning * into pl;
  else
    insert into public.lookahead_plans (id, project_id, calendar_mode, period_year, period_month, period_label, period_label_am,
      period_start, period_end, horizon_end, working_days, schedule_id, schedule_version_id, generated_at, generated_by)
    values (coalesce(p_plan_id, gen_random_uuid()), p_project, p_mode, p_year, p_month, per.label, per.label_am,
      per.period_start, per.period_end, v_hor, app.la_wd(p_project, per.period_start, per.period_end), v_schedule,
      (select s.current_version_id from public.schedules s where s.id = v_schedule), now(), auth.uid())
    returning * into pl;
  end if;

  -- weeks
  for w in select * from app.la_weeks(p_project, pl.period_start, pl.period_end, pl.horizon_end) loop
    v_week_starts := v_week_starts || w.week_start;
    insert into public.lookahead_weeks (plan_id, project_id, week_no, week_start, week_end, working_days, in_buffer)
    values (pl.id, p_project, w.week_no, w.week_start, w.week_end, w.working_days, w.in_buffer)
    on conflict (plan_id, week_start) do update set week_no = excluded.week_no, week_end = excluded.week_end,
      working_days = excluded.working_days, in_buffer = excluded.in_buffer
    where (lookahead_weeks.week_no, lookahead_weeks.week_end, lookahead_weeks.working_days, lookahead_weeks.in_buffer)
          is distinct from (excluded.week_no, excluded.week_end, excluded.working_days, excluded.in_buffer);
  end loop;
  delete from public.lookahead_weeks wk where wk.plan_id = pl.id and not (wk.week_start = any (v_week_starts))
    and not exists (select 1 from public.weekly_commitments wc where wc.week_id = wk.id);

  -- items
  for c in select * from app.lookahead_candidates(p_project, v_schedule, pl.period_start, pl.period_end, pl.horizon_end) loop
    v_keep := v_keep || c.task_id;
    select id into v_item from public.lookahead_items where plan_id = pl.id and schedule_task_id = c.task_id;
    if v_item is null then
      select i2.responsible_id, i2.first_seen_on into v_prev
        from public.lookahead_items i2 join public.lookahead_plans p2 on p2.id = i2.plan_id
        where i2.schedule_task_id = c.task_id and i2.plan_id <> pl.id
        order by (i2.responsible_id is not null) desc, p2.period_start desc limit 1;
      insert into public.lookahead_items (plan_id, project_id, schedule_task_id, element_id, wbs, group_name, name, window_role,
        is_milestone, is_critical, total_float_days, planned_start, planned_finish, pct_at_generation, pct_complete,
        target_pct_end_of_period, week_days, responsible_id, sort_key, first_seen_on)
      values (pl.id, p_project, c.task_id, c.element_id, c.wbs, c.group_name, c.name, c.window_role, c.is_milestone, c.is_critical,
        c.total_float_days, c.s, c.f, c.pct, c.pct, c.expected_pct, c.week_days, v_prev.responsible_id, c.sort_key,
        least(coalesce((select min(i3.first_seen_on) from public.lookahead_items i3 where i3.schedule_task_id = c.task_id), v_today), v_today));
      v_new := v_new + 1;
    else
      update public.lookahead_items set element_id = coalesce(c.element_id, element_id), wbs = c.wbs, group_name = c.group_name,
        name = c.name, window_role = c.window_role, is_milestone = c.is_milestone, is_critical = c.is_critical,
        total_float_days = c.total_float_days, planned_start = c.s, planned_finish = c.f, pct_at_generation = c.pct,
        pct_complete = c.pct, target_pct_end_of_period = c.expected_pct, week_days = c.week_days, sort_key = c.sort_key,
        status = 'active'
      where id = v_item;
    end if;
  end loop;

  with x as (
    update public.lookahead_items i set status = case
        when exists (select 1 from public.schedule_tasks st where st.id = i.schedule_task_id and st.deleted_at is null
                     and (coalesce(st.pct_complete, 0) >= 100 or st.actual_finish is not null)) then 'done'
        else 'dropped' end
    where i.plan_id = pl.id and i.schedule_task_id is not null and i.status = 'active' and not (i.schedule_task_id = any (v_keep))
    returning 1)
  select count(*) into v_dropped from x;

  v_ref := app.la_refresh(pl.id);
  return jsonb_build_object('ok', true, 'plan_id', pl.id, 'status', pl.status, 'period_label', pl.period_label,
    'period_start', pl.period_start, 'period_end', pl.period_end, 'horizon_end', pl.horizon_end,
    'weeks', cardinality(v_week_starts), 'new', v_new, 'dropped', v_dropped, 'constraints', v_ref) || app.la_summary(pl.id);
end $$;

-- Year/month from the payload: {year, month} or {month:'YYYY-MM'}; default = the next planning month.
create or replace function app.la_payload_month(p jsonb, p_mode text, out y int, out m int)
language plpgsql stable as $$
declare n record;
begin
  if jsonb_typeof(p -> 'month') = 'string' and (p ->> 'month') ~ '^\d{4}-\d{1,2}$' then
    y := split_part(p ->> 'month', '-', 1)::int; m := split_part(p ->> 'month', '-', 2)::int;
  elsif p ? 'month' and p ? 'year' then
    y := (p ->> 'year')::int; m := (p ->> 'month')::int;
  else
    select * into n from app.la_next_month(p_mode, app.la_today());
    y := n.y; m := n.m;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

create or replace function public.generate_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_project uuid := (p ->> 'project_id')::uuid;
  v_plan public.lookahead_plans;
  v_mode text;
  ym record;
begin
  if v_seen is not null then return v_seen; end if;
  if p ->> 'plan_id' is not null then
    select * into v_plan from public.lookahead_plans where id = (p ->> 'plan_id')::uuid;
    if found then v_project := v_plan.project_id; end if;
  end if;
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','admin');
  if v_plan.id is not null then
    v_mode := v_plan.calendar_mode;
    return app.op_done(p, 'generate_lookahead', app.la_generate(v_project, v_mode, v_plan.period_year, v_plan.period_month,
      v_plan.id, (p ->> 'schedule_id')::uuid, (p ->> 'horizon_weeks')::int));
  end if;
  v_mode := coalesce(nullif(p ->> 'calendar_mode', ''),
                     (select lookahead_calendar_mode from public.project_settings where project_id = v_project), 'gregorian');
  select * into ym from app.la_payload_month(p, v_mode);
  return app.op_done(p, 'generate_lookahead', app.la_generate(v_project, v_mode, ym.y, ym.m,
    (p ->> 'plan_id')::uuid, (p ->> 'schedule_id')::uuid, (p ->> 'horizon_weeks')::int));
end $$;

create or replace function public.refresh_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  pl public.lookahead_plans;
  v jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pl from public.lookahead_plans where id = (p ->> 'plan_id')::uuid;
  if not found then raise exception 'Look-ahead plan not found'; end if;
  perform app.require_member(pl.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','procurement','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  v := app.la_refresh(pl.id);
  return app.op_done(p, 'refresh_lookahead', jsonb_build_object('ok', true, 'plan_id', pl.id, 'constraints', v) || app.la_summary(pl.id));
end $$;

create or replace function public.publish_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  pl public.lookahead_plans;
  s jsonb;
  u record;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pl from public.lookahead_plans where id = (p ->> 'plan_id')::uuid for update;
  if not found then raise exception 'Look-ahead plan not found'; end if;
  perform app.require_member(pl.project_id);
  perform app.require_role('office_engineer','coordinator','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  if pl.status = 'published' then
    return app.op_done(p, 'publish_lookahead', jsonb_build_object('ok', true, 'plan_id', pl.id, 'status', pl.status));
  end if;
  perform app.la_refresh(pl.id);
  update public.lookahead_plans set status = 'published', published_at = now(), published_by = auth.uid() where id = pl.id;
  s := app.la_summary(pl.id);

  for u in select i.responsible_id, count(*) n from public.lookahead_items i
           where i.plan_id = pl.id and i.status = 'active' and i.responsible_id is not null group by i.responsible_id loop
    perform app.notify_user(u.responsible_id, pl.project_id, 'Look-ahead ' || pl.period_label || ' published',
      u.n || ' task(s) assigned to you. Commit ready work for next week.', 'lookahead_plan', pl.id);
  end loop;
  if not exists (select 1 from public.lookahead_items i where i.plan_id = pl.id and i.responsible_id is not null) then
    perform app.notify_roles(pl.project_id, '{site_engineer}', 'Look-ahead ' || pl.period_label || ' published',
      (s ->> 'items') || ' tasks in the window', 'lookahead_plan', pl.id);
  end if;
  if (s ->> 'material_shortfalls')::int > 0 then
    perform app.notify_roles(pl.project_id, '{office_engineer}', 'Look-ahead ' || pl.period_label || ': material shortfalls',
      (s ->> 'material_shortfalls') || ' material(s) not covered by stock or POs on time', 'lookahead_plan', pl.id);
  end if;
  if (s ->> 'raise_pr_now')::int > 0 then
    perform app.notify_roles(pl.project_id, '{procurement}', 'Look-ahead ' || pl.period_label || ': order now',
      (s ->> 'raise_pr_now') || ' material(s) must be ordered within 7 days', 'lookahead_plan', pl.id, true);
  end if;
  return app.op_done(p, 'publish_lookahead', jsonb_build_object('ok', true, 'plan_id', pl.id, 'status', 'published') || s);
end $$;

create or replace function public.assign_lookahead_item(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_ids uuid[];
  v_user uuid := (p ->> 'responsible_id')::uuid;
  v_project uuid;
  v_n int;
  v_label text;
begin
  if v_seen is not null then return v_seen; end if;
  v_ids := case when p ? 'item_ids' then (select array_agg(x::uuid) from jsonb_array_elements_text(p -> 'item_ids') x)
                else array[(p ->> 'item_id')::uuid] end;
  select min(i.project_id::text)::uuid, count(distinct i.project_id), min(pl.period_label) into v_project, v_n, v_label
    from public.lookahead_items i join public.lookahead_plans pl on pl.id = i.plan_id
    where i.id = any (v_ids) and pl.status <> 'closed';
  if v_project is null then raise exception 'Look-ahead item not found (or plan closed)'; end if;
  if v_n > 1 then raise exception 'Items belong to different projects'; end if;
  perform app.require_member(v_project);
  perform app.require_role('office_engineer','coordinator','admin');
  if v_user is not null and not exists (
      select 1 from public.profiles pr where pr.id = v_user and pr.is_active
        and (pr.role = 'admin' or exists (select 1 from public.project_members m where m.project_id = v_project and m.user_id = v_user))) then
    raise exception 'The responsible person must be an active member of this project';
  end if;
  update public.lookahead_items set responsible_id = v_user where id = any (v_ids);
  -- default owners of open auto constraints that follow the last planner
  update public.lookahead_constraints c set owner_id = v_user
    where c.auto and c.owner_id is null and c.status in ('open','in_progress','blocked') and c.owner_role = 'site_engineer'
      and (c.item_id = any (v_ids)
           or (c.ctype = 'predecessor' and c.source_id in (select schedule_task_id from public.lookahead_items where id = any (v_ids))
               and c.item_id in (select i2.id from public.lookahead_items i2
                                 where i2.plan_id in (select plan_id from public.lookahead_items where id = any (v_ids)))));
  perform app.notify_user(v_user, v_project, 'Look-ahead tasks assigned',
    cardinality(v_ids) || ' task(s) in ' || v_label || ' assigned to you', 'lookahead_item', v_ids[1]);
  return app.op_done(p, 'assign_lookahead_item', jsonb_build_object('ok', true, 'items', cardinality(v_ids), 'responsible_id', v_user));
end $$;

create or replace function public.update_constraint(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  c public.lookahead_constraints;
  i public.lookahead_items;
  pl public.lookahead_plans;
  v_status text := nullif(p ->> 'status', '');
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_owner uuid;
  v_new boolean := false;
  v_old text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into c from public.lookahead_constraints where id = v_id for update;
  if found then
    select * into i from public.lookahead_items where id = c.item_id;
  else
    select * into i from public.lookahead_items where id = (p ->> 'item_id')::uuid;
    if not found then raise exception 'Look-ahead item not found'; end if;
    v_new := true;
  end if;
  select * into pl from public.lookahead_plans where id = i.plan_id;
  perform app.require_member(i.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','procurement','manager','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  if v_status is not null and v_status not in ('open','in_progress','cleared','blocked','waived') then
    raise exception 'Unknown constraint status %', v_status;
  end if;
  if p ? 'owner_id' and (p ->> 'owner_id') is not null then
    v_owner := (p ->> 'owner_id')::uuid;
    if not exists (select 1 from public.profiles pr where pr.id = v_owner and pr.is_active
                   and (pr.role = 'admin' or exists (select 1 from public.project_members m where m.project_id = i.project_id and m.user_id = v_owner))) then
      raise exception 'The owner must be an active member of this project';
    end if;
  end if;

  if v_new then
    if coalesce(p ->> 'ctype', '') not in ('predecessor','material','approval','inspection','information','labour','equipment','space','external') then
      raise exception 'Choose a constraint type';
    end if;
    if coalesce(trim(p ->> 'description'), '') = '' then raise exception 'Describe the constraint'; end if;
    insert into public.lookahead_constraints (id, item_id, project_id, ctype, description, auto, material_spec_id, qty_short,
      owner_id, owner_role, due_date, status, created_by,
      cleared_at, cleared_on, cleared_by)
    values (v_id, i.id, i.project_id, p ->> 'ctype', trim(p ->> 'description'), false, (p ->> 'material_spec_id')::uuid,
      (p ->> 'qty_short')::numeric, v_owner, nullif(p ->> 'owner_role', ''),
      coalesce((p ->> 'due_date')::date, app.la_shift(i.project_id, greatest(coalesce(i.planned_start, pl.period_start), pl.period_start), -2)),
      coalesce(v_status, 'open'), auth.uid(),
      case when v_status in ('cleared','waived') then now() end, case when v_status in ('cleared','waived') then app.la_today() end,
      case when v_status in ('cleared','waived') then auth.uid() end)
    returning * into c;
    perform app.la_log(c.id, c.project_id, 'created', null, c.status, v_comment, jsonb_build_object('ctype', c.ctype));
  else
    v_old := c.status;
    if c.auto and (p ? 'ctype' and p ->> 'ctype' <> c.ctype) then
      raise exception 'The type of an automatic constraint cannot be changed';
    end if;
    if v_status = 'waived' and v_comment is null then raise exception 'A reason is required to waive a constraint'; end if;
    if c.auto and c.ctype = 'material' and v_status = 'cleared' and v_comment is null then
      raise exception 'Clearing a material constraint by hand needs a comment (e.g. delivery confirmed by phone)';
    end if;
    update public.lookahead_constraints set
      description = case when not c.auto and coalesce(trim(p ->> 'description'), '') <> '' then trim(p ->> 'description') else description end,
      owner_id = case when p ? 'owner_id' then v_owner else owner_id end,
      owner_role = coalesce(nullif(p ->> 'owner_role', ''), owner_role),
      due_date = coalesce((p ->> 'due_date')::date, due_date),
      status = coalesce(v_status, status),
      cleared_at = case when v_status in ('cleared','waived') then now() when v_status is not null then null else cleared_at end,
      cleared_on = case when v_status in ('cleared','waived') then app.la_today() when v_status is not null then null else cleared_on end,
      cleared_by = case when v_status in ('cleared','waived') then auth.uid() when v_status is not null then null else cleared_by end
    where id = c.id returning * into c;
    if v_status is not null then
      perform app.la_log(c.id, c.project_id, 'status', v_old, c.status, v_comment);
    elsif p ? 'owner_id' or p ? 'due_date' then
      perform app.la_log(c.id, c.project_id, case when p ? 'owner_id' then 'owner' else 'due' end, c.status, c.status, v_comment,
        jsonb_build_object('owner_id', c.owner_id, 'due_date', c.due_date));
    elsif v_comment is not null then
      perform app.la_log(c.id, c.project_id, 'comment', c.status, c.status, v_comment);
    end if;
  end if;

  if v_owner is not null then
    perform app.notify_user(v_owner, c.project_id, 'Constraint assigned to you',
      i.name || ': ' || c.description || coalesce(' (due ' || to_char(c.due_date, 'DD Mon') || ')', ''), 'lookahead_constraint', c.id);
  end if;
  perform app.la_refresh_readiness(i.plan_id);
  return app.op_done(p, 'update_constraint', jsonb_build_object('ok', true, 'id', c.id, 'status', c.status,
    'readiness', (select readiness from public.lookahead_items where id = i.id)));
end $$;

create or replace function public.commit_lookahead_item(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_today date := app.la_today();
  c public.weekly_commitments;
  i public.lookahead_items;
  w public.lookahead_weeks;
  pl public.lookahead_plans;
  v_reason text := nullif(trim(coalesce(p ->> 'override_reason', '')), '');
  v_ready text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into c from public.weekly_commitments where id = v_id for update;
  select * into i from public.lookahead_items where id = coalesce((p ->> 'item_id')::uuid, c.item_id);
  if i.id is null then raise exception 'Look-ahead item not found'; end if;
  select * into pl from public.lookahead_plans where id = i.plan_id;
  perform app.require_member(i.project_id);
  perform app.require_role('site_engineer','coordinator','admin');
  if pl.status <> 'published' then raise exception 'Commitments can be made once the look-ahead is published (status: %)', pl.status; end if;
  if i.status <> 'active' then raise exception 'Task "%" is no longer in the look-ahead (%)', i.name, i.status; end if;
  if app.has_role('site_engineer') and i.responsible_id is not null and i.responsible_id <> auth.uid() then
    raise exception 'Only the responsible site engineer (or the coordinator) can commit "%"', i.name;
  end if;

  select * into w from public.lookahead_weeks
    where plan_id = i.plan_id and (id = (p ->> 'week_id')::uuid or week_start = (p ->> 'week_start')::date or id = c.week_id)
    order by (id = (p ->> 'week_id')::uuid) desc nulls last limit 1;
  if w.id is null then raise exception 'Week not found in this look-ahead'; end if;
  if w.status <> 'open' then raise exception 'Week % is % and no longer takes commitments', w.week_no, w.status; end if;
  if not (w.week_start > v_today or (app.has_role('coordinator','admin') and w.week_start >= v_today)) then
    raise exception 'Commitments for week % (starting %) are locked', w.week_no, to_char(w.week_start, 'DD Mon');
  end if;
  if c.id is not null and c.item_id <> i.id then raise exception 'Commitment belongs to another task'; end if;

  v_ready := app.la_readiness_of(i.id);
  if v_ready <> 'ready' and v_reason is null then
    raise exception 'Task "%" is not ready (%): resolve its constraints or give a reason to commit anyway', i.name, replace(v_ready, '_', ' ');
  end if;
  if coalesce(trim(p ->> 'description'), '') = '' and c.id is null then
    p := p || jsonb_build_object('description', i.name);
  end if;

  if c.id is null then
    insert into public.weekly_commitments (id, item_id, week_id, plan_id, project_id, kind, description, target_pct, target_qty, target_uom,
      committed_by, readiness_at_commit, override_reason, device_id)
    values (v_id, i.id, w.id, i.plan_id, i.project_id, 'commitment', trim(p ->> 'description'), (p ->> 'target_pct')::numeric,
      (p ->> 'target_qty')::numeric, nullif(p ->> 'target_uom', ''), auth.uid(), v_ready,
      case when v_ready <> 'ready' then v_reason end, app.device_id())
    returning * into c;
  else
    if c.outcome <> 'pending' then raise exception 'This commitment already has an outcome'; end if;
    update public.weekly_commitments set kind = 'commitment', week_id = w.id,
      description = coalesce(nullif(trim(p ->> 'description'), ''), description),
      target_pct = coalesce((p ->> 'target_pct')::numeric, target_pct), target_qty = coalesce((p ->> 'target_qty')::numeric, target_qty),
      target_uom = coalesce(nullif(p ->> 'target_uom', ''), target_uom),
      committed_by = auth.uid(), committed_at = now(), readiness_at_commit = v_ready,
      override_reason = case when v_ready <> 'ready' then v_reason end
    where id = c.id returning * into c;
  end if;
  update public.lookahead_items set readiness = v_ready where id = i.id and readiness is distinct from v_ready;
  return app.op_done(p, 'commit_lookahead_item', jsonb_build_object('ok', true, 'id', c.id, 'week_id', w.id,
    'readiness_at_commit', c.readiness_at_commit));
end $$;

create or replace function public.report_commitment(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  c public.weekly_commitments;
  w public.lookahead_weeks;
  i public.lookahead_items;
  v_outcome text := p ->> 'outcome';
begin
  if v_seen is not null then return v_seen; end if;
  select * into c from public.weekly_commitments where id = (p ->> 'commitment_id')::uuid for update;
  if not found then raise exception 'Commitment not found'; end if;
  select * into w from public.lookahead_weeks where id = c.week_id;
  select * into i from public.lookahead_items where id = c.item_id;
  perform app.require_member(c.project_id);
  perform app.require_role('site_engineer','coordinator','admin');
  if app.has_role('site_engineer') and c.committed_by <> auth.uid() and i.responsible_id is distinct from auth.uid() then
    raise exception 'Only the engineer who committed this work can report it';
  end if;
  if c.kind <> 'commitment' then raise exception 'Commit the rolled-forward task before reporting it'; end if;
  if w.status = 'closed' then raise exception 'Week % is closed', w.week_no; end if;
  if app.la_today() < w.week_start then raise exception 'Week % has not started yet', w.week_no; end if;
  if v_outcome not in ('completed','not_completed','pending') then raise exception 'Outcome must be completed or not completed'; end if;
  if v_outcome = 'not_completed' and coalesce(p ->> 'rnc_code', '') = '' then
    raise exception 'Choose the reason the work was not completed';
  end if;
  if p ->> 'rnc_code' is not null and not exists (select 1 from public.rnc_reasons where code = p ->> 'rnc_code') then
    raise exception 'Unknown reason code %', p ->> 'rnc_code';
  end if;
  update public.weekly_commitments set outcome = v_outcome,
    actual_pct = coalesce((p ->> 'actual_pct')::numeric, actual_pct), actual_qty = coalesce((p ->> 'actual_qty')::numeric, actual_qty),
    rnc_code = case when v_outcome = 'not_completed' then p ->> 'rnc_code' end,
    rnc_note = case when v_outcome = 'not_completed' then nullif(p ->> 'rnc_note', '') end,
    reported_by = auth.uid(), reported_at = now()
  where id = c.id;
  return app.op_done(p, 'report_commitment', jsonb_build_object('ok', true, 'id', c.id, 'outcome', v_outcome));
end $$;

create or replace function public.close_week(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_today date := app.la_today();
  w public.lookahead_weeks;
  pl public.lookahead_plans;
  r jsonb;
  c public.weekly_commitments;
  v_roll uuid[] := '{}';
  v_noroll uuid[] := '{}';
  v_next public.lookahead_weeks;
  v_new uuid;
  v_committed int; v_completed int; v_ppc numeric; v_pcr numeric; v_ta numeric;
  v_due int; v_on_time int; v_rolled int := 0; v_pending int;
  v_missing text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into w from public.lookahead_weeks where id = (p ->> 'week_id')::uuid for update;
  if not found then raise exception 'Week not found'; end if;
  select * into pl from public.lookahead_plans where id = w.plan_id;
  perform app.require_member(w.project_id);
  perform app.require_role('coordinator','manager','admin');
  if w.status = 'closed' then raise exception 'Week % is already closed', w.week_no; end if;
  if pl.status <> 'published' then raise exception 'Only weeks of a published look-ahead can be closed'; end if;
  if v_today < w.week_end then
    raise exception 'Week % can be closed from % (its last day)', w.week_no, to_char(w.week_end, 'Dy DD Mon');
  end if;

  for r in select * from jsonb_array_elements(coalesce(p -> 'results', '[]'::jsonb)) loop
    select * into c from public.weekly_commitments where id = (r ->> 'commitment_id')::uuid and week_id = w.id for update;
    if not found then raise exception 'Commitment % is not part of week %', r ->> 'commitment_id', w.week_no; end if;
    if c.kind <> 'commitment' then continue; end if;
    if (r ->> 'outcome') not in ('completed','not_completed') then raise exception 'Outcome must be completed or not completed'; end if;
    if r ->> 'outcome' = 'not_completed' and coalesce(r ->> 'rnc_code', c.rnc_code, '') = '' then
      raise exception '"%" was not completed: choose a reason', c.description;
    end if;
    if r ->> 'rnc_code' is not null and not exists (select 1 from public.rnc_reasons where code = r ->> 'rnc_code') then
      raise exception 'Unknown reason code %', r ->> 'rnc_code';
    end if;
    update public.weekly_commitments set outcome = r ->> 'outcome',
      actual_pct = coalesce((r ->> 'actual_pct')::numeric, actual_pct), actual_qty = coalesce((r ->> 'actual_qty')::numeric, actual_qty),
      rnc_code = case when r ->> 'outcome' = 'not_completed' then coalesce(r ->> 'rnc_code', rnc_code) end,
      rnc_note = case when r ->> 'outcome' = 'not_completed' then coalesce(nullif(r ->> 'rnc_note', ''), rnc_note) end
    where id = c.id;
    if r ->> 'outcome' = 'not_completed' and coalesce((r ->> 'roll_forward')::boolean, true) = false then
      v_noroll := v_noroll || c.id;
    end if;
  end loop;

  select count(*), min(description) into v_pending, v_missing from public.weekly_commitments
    where week_id = w.id and kind = 'commitment' and outcome = 'pending';
  if v_pending > 0 then
    raise exception '% commitment(s) still need an outcome (e.g. "%")', v_pending, v_missing;
  end if;

  update public.weekly_commitments set closed_by = auth.uid(), closed_at = now() where week_id = w.id and kind = 'commitment';

  -- roll not-completed work forward as candidates in the next open week (this plan, else the next plan).
  select * into v_next from public.lookahead_weeks wk where wk.plan_id = w.plan_id and wk.week_start > w.week_start and wk.status <> 'closed'
    order by wk.week_start limit 1;
  if v_next.id is null then
    select wk.* into v_next from public.lookahead_weeks wk join public.lookahead_plans p2 on p2.id = wk.plan_id
      where p2.project_id = w.project_id and p2.calendar_mode = pl.calendar_mode and p2.status <> 'closed' and p2.id <> pl.id
        and wk.week_start > w.week_end and wk.status <> 'closed'
      order by wk.week_start limit 1;
  end if;
  if v_next.id is not null then
    for c in select wc.* from public.weekly_commitments wc join public.lookahead_items i on i.id = wc.item_id
             where wc.week_id = w.id and wc.kind = 'commitment' and wc.outcome = 'not_completed' and wc.rolled_to_id is null
               and not (wc.id = any (v_noroll)) loop
      v_new := gen_random_uuid();
      insert into public.weekly_commitments (id, item_id, week_id, plan_id, project_id, kind, description, target_pct, target_qty, target_uom,
        committed_by, readiness_at_commit, override_reason, rolled_from_id)
      select v_new, coalesce(i2.id, c.item_id), v_next.id, v_next.plan_id, c.project_id, 'candidate', c.description, c.target_pct,
        c.target_qty, c.target_uom, c.committed_by, coalesce(i2.readiness, 'not_ready'),
        case when coalesce(i2.readiness, 'not_ready') <> 'ready' then 'Rolled forward from week ' || w.week_no end, c.id
      from public.lookahead_items i1
      left join public.lookahead_items i2 on i2.plan_id = v_next.plan_id and i2.schedule_task_id = i1.schedule_task_id
      where i1.id = c.item_id;
      update public.weekly_commitments set rolled_to_id = v_new where id = c.id;
      v_rolled := v_rolled + 1;
    end loop;
  end if;

  select count(*), count(*) filter (where outcome = 'completed') into v_committed, v_completed
    from public.weekly_commitments where week_id = w.id and kind = 'commitment';
  v_ppc := case when v_committed > 0 then round(100.0 * v_completed / v_committed, 2) end;

  select count(*), count(*) filter (where lc.status in ('cleared','waived') and lc.cleared_on <= lc.due_date)
    into v_due, v_on_time
    from public.lookahead_constraints lc join public.lookahead_items i on i.id = lc.item_id
    where i.plan_id = w.plan_id and not lc.advisory and lc.due_date between w.week_start and w.week_end;
  v_pcr := case when v_due > 0 then round(100.0 * v_on_time / v_due, 2) end;

  select case when count(*) > 0 then round(100.0 * count(*) filter (where i.first_seen_on <= w.week_start - 14) / count(*), 2) end
    into v_ta
    from public.weekly_commitments wc join public.lookahead_items i on i.id = wc.item_id
    where wc.week_id = w.id and wc.kind = 'commitment';

  update public.lookahead_weeks set status = 'closed', committed_count = v_committed, completed_count = v_completed,
    ppc = v_ppc, pcr = v_pcr, ta = v_ta, closed_by = auth.uid(), closed_at = now()
  where id = w.id;
  if not exists (select 1 from public.lookahead_weeks where plan_id = w.plan_id and status <> 'closed') then
    update public.lookahead_plans set status = 'closed', closed_at = now() where id = w.plan_id;
  end if;

  perform app.notify_roles(w.project_id, '{manager,coordinator}',
    'PPC week ' || w.week_no || ' (' || pl.period_label || '): ' || coalesce(round(v_ppc)::text || '%', 'no commitments'),
    v_completed || ' of ' || v_committed || ' commitments completed' || coalesce(' · PCR ' || round(v_pcr) || '%', ''),
    'lookahead_week', w.id);
  return app.op_done(p, 'close_week', jsonb_build_object('ok', true, 'week_id', w.id, 'committed', v_committed,
    'completed', v_completed, 'ppc', v_ppc, 'pcr', v_pcr, 'ta', v_ta, 'rolled', v_rolled,
    'plan_status', (select status from public.lookahead_plans where id = w.plan_id)));
end $$;

-- Next look-ahead document number: <CODE>-PR-LA2611-0001 / <CODE>-SR-LA2611-0001.
create or replace function app.la_doc_number(p_project uuid, p_type text, p_period date) returns text
language plpgsql security definer set search_path = public as $$
declare v_prefix text; v_n int;
begin
  v_prefix := (select code from public.projects where id = p_project) || '-' || p_type || '-LA' || to_char(p_period, 'YYMM') || '-';
  select coalesce(max(substring(number from length(v_prefix) + 1)::int), 0) + 1 into v_n
    from public.material_requests where number like v_prefix || '%' and substring(number from length(v_prefix) + 1) ~ '^\d+$';
  return v_prefix || lpad(v_n::text, 4, '0');
end $$;

create or replace function public.create_prs_from_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  pl public.lookahead_plans;
  v_today date := app.la_today();
  v_store uuid;
  v_lines jsonb := '[]'::jsonb;
  v_mr_lines jsonb := '[]'::jsonb;
  l record;
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_number text;
  v_req date;
  v_urgent boolean := false;
  v_line_id uuid;
  v_items uuid[];
  v_res jsonb;
  v_block uuid;
  v_cnt int;
begin
  if v_seen is not null then return v_seen; end if;
  select * into pl from public.lookahead_plans where id = (p ->> 'plan_id')::uuid;
  if not found then raise exception 'Look-ahead plan not found'; end if;
  perform app.require_member(pl.project_id);
  perform app.require_role('office_engineer','coordinator','manager','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  v_store := coalesce((p ->> 'store_id')::uuid,
    (select id from public.stores where project_id = pl.project_id and deleted_at is null order by (store_type = 'main') desc, created_at limit 1));
  perform app.require_store(pl.project_id, v_store);

  for l in
    with src as (
      select (x ->> 'material_spec_id')::uuid as spec, (x ->> 'qty')::numeric as qty, (x ->> 'need_by')::date as need_by,
             coalesce((select array_agg(y::uuid) from jsonb_array_elements_text(x -> 'item_ids') y), '{}') as item_ids, false as late
      from jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x
      where jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) > 0
      union all
      select c.material_spec_id, sum(c.to_order), min(c.need_by), array_agg(c.item_id order by c.need_by, c.item_id), bool_or(c.late_order)
      from app.la_material_calc(pl.id) c
      where jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 and c.to_order > 0.0005
        and (not coalesce((p ->> 'only_urgent')::boolean, false) or c.raise_pr_now)
      group by c.material_spec_id
    )
    select src.*, ms.pack_size, sp.label from src
    join public.material_specs ms on ms.id = src.spec join public.v_specs sp on sp.id = src.spec
    where src.qty > 0
    order by src.need_by nulls last, sp.label
  loop
    v_line_id := gen_random_uuid();
    v_req := least(coalesce(v_req, l.need_by), coalesce(l.need_by, v_req));
    v_urgent := v_urgent or l.late;
    v_mr_lines := v_mr_lines || jsonb_build_object('id', v_line_id, 'material_spec_id', l.spec,
      'qty', ceil(l.qty / l.pack_size) * l.pack_size,
      'required_date', greatest(coalesce(l.need_by, v_today), v_today),
      'lookahead_item_id', l.item_ids[1],
      'remarks', 'Look-ahead ' || pl.period_label || coalesce(': ' || (select string_agg(i.name, '; ' order by i.sort_key)
                    from public.lookahead_items i where i.id = any (l.item_ids)), ''));
    v_lines := v_lines || jsonb_build_object('mr_line_id', v_line_id, 'material_spec_id', l.spec, 'label', l.label,
      'qty', ceil(l.qty / l.pack_size) * l.pack_size, 'need_by', l.need_by, 'item_ids', to_jsonb(l.item_ids));
  end loop;
  if jsonb_array_length(v_mr_lines) = 0 then raise exception 'Nothing to order: all look-ahead needs are covered'; end if;

  select e.block_id into v_block from public.lookahead_items i join public.elements e on e.id = i.element_id
    where i.plan_id = pl.id and e.block_id is not null group by e.block_id order by count(*) desc limit 1;
  v_number := coalesce(nullif(p ->> 'number', ''), app.la_doc_number(pl.project_id, 'PR', pl.period_start));
  v_res := public.save_mr(jsonb_build_object('id', v_id, 'project_id', pl.project_id, 'number', v_number,
    'request_type', 'purchase', 'block_id', coalesce((p ->> 'block_id')::uuid, v_block),
    'priority', case when v_urgent then 'urgent' else 'normal' end,
    'required_date', greatest(coalesce(v_req, v_today), v_today),
    'delivery_location', (select name from public.stores where id = v_store), 'store_id', v_store,
    'purpose', 'Look-ahead purchase ' || pl.period_label, 'is_lookahead', true, 'lookahead_plan_id', pl.id,
    'submit', coalesce((p ->> 'submit')::boolean, false), 'lines', v_mr_lines));

  -- keep links even where save_mr predates the look-ahead columns
  update public.material_requests set lookahead_plan_id = pl.id, is_lookahead = true where id = v_id and lookahead_plan_id is distinct from pl.id;
  update public.mr_lines ml set lookahead_item_id = (x ->> 'lookahead_item_id')::uuid
    from jsonb_array_elements(v_mr_lines) x
    where ml.id = (x ->> 'id')::uuid and ml.lookahead_item_id is distinct from (x ->> 'lookahead_item_id')::uuid;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'material_requests'
             and column_name = 'request_type') then
    execute 'update public.material_requests set request_type = ''purchase'' where id = $1 and request_type <> ''purchase'' and status = ''draft'''
      using v_id;
  end if;

  -- material constraints now have a purchase request in progress
  for l in select (x ->> 'material_spec_id')::uuid as spec, (select array_agg(y::uuid) from jsonb_array_elements_text(x -> 'item_ids') y) as items
           from jsonb_array_elements(v_lines) x loop
    v_items := l.items;
    with u as (
      update public.lookahead_constraints c set linked_mr_id = v_id,
        status = case when c.status = 'open' then 'in_progress' else c.status end
      where c.auto and c.ctype = 'material' and c.material_spec_id = l.spec and c.item_id = any (coalesce(v_items, '{}'))
        and c.status in ('open','in_progress','blocked')
      returning c.id, c.project_id, c.status)
    select count(*) into v_cnt from (select app.la_log(u.id, u.project_id, 'pr_raised', null, u.status, v_number) from u) z;
  end loop;
  perform app.la_refresh(pl.id);
  return app.op_done(p, 'create_prs_from_lookahead', jsonb_build_object('ok', true, 'id', v_id, 'number', v_number,
    'status', v_res ->> 'status', 'store_id', v_store, 'lines', v_lines));
end $$;

create or replace function public.create_sur_from_lookahead(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  i public.lookahead_items;
  pl public.lookahead_plans;
  w public.lookahead_weeks;
  v_today date := app.la_today();
  v_store uuid;
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_number text;
  v_mr_lines jsonb := '[]'::jsonb;
  v_els jsonb;
  l record;
  e record;
  v_qty numeric; v_left numeric; v_part numeric; v_tot numeric; v_n int; v_k int;
  v_req date;
  v_block uuid;
  v_res jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  select * into i from public.lookahead_items where id = (p ->> 'item_id')::uuid;
  if not found then raise exception 'Look-ahead item not found'; end if;
  select * into pl from public.lookahead_plans where id = i.plan_id;
  perform app.require_member(i.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','admin');
  if pl.status = 'closed' then raise exception 'Look-ahead % is closed', pl.period_label; end if;
  if app.has_role('site_engineer') and i.responsible_id is not null and i.responsible_id <> auth.uid() then
    raise exception 'Only the responsible site engineer can request materials for "%"', i.name;
  end if;
  if p ->> 'week_id' is not null then
    select * into w from public.lookahead_weeks where id = (p ->> 'week_id')::uuid and plan_id = pl.id;
    if not found then raise exception 'Week not found in this look-ahead'; end if;
  end if;
  v_store := coalesce((p ->> 'store_id')::uuid,
    (select id from public.stores where project_id = i.project_id and deleted_at is null order by (store_type = 'main') desc, created_at limit 1));
  perform app.require_store(i.project_id, v_store);

  for l in
    select c.material_spec_id as spec, c.need_by, c.element_ids, c.from_stock,
           case when w.id is not null then coalesce((c.weekly_need ->> w.week_start::text)::numeric, 0) else c.window_need end as need,
           (x ->> 'qty')::numeric as asked
    from app.la_material_calc(pl.id) c
    left join jsonb_array_elements(coalesce(p -> 'lines', '[]'::jsonb)) x on (x ->> 'material_spec_id')::uuid = c.material_spec_id
    where c.item_id = i.id
      and (jsonb_array_length(coalesce(p -> 'lines', '[]'::jsonb)) = 0 or x is not null)
  loop
    v_qty := round(coalesce(l.asked, least(l.need, l.from_stock)), 3);
    if v_qty <= 0 then continue; end if;
    v_req := least(coalesce(v_req, l.need_by), l.need_by);
    -- element split proportional to the elements' take-off of this spec
    select coalesce(sum(t.planned_qty), 0), count(*) into v_tot, v_n from public.element_takeoffs t
      where t.element_id = any (l.element_ids) and t.material_spec_id = l.spec and t.deleted_at is null;
    v_els := '[]'::jsonb; v_left := v_qty; v_k := 0;
    for e in select t.element_id, t.planned_qty from public.element_takeoffs t
             where t.element_id = any (l.element_ids) and t.material_spec_id = l.spec and t.deleted_at is null
             order by t.planned_qty desc, t.element_id loop
      v_k := v_k + 1;
      v_part := case when v_k = v_n then v_left else round(v_qty * e.planned_qty / nullif(v_tot, 0), 3) end;
      if v_part > 0 then
        v_els := v_els || jsonb_build_object('id', gen_random_uuid(), 'element_id', e.element_id, 'qty', v_part);
        v_left := v_left - v_part;
      end if;
    end loop;
    v_mr_lines := v_mr_lines || jsonb_build_object('id', gen_random_uuid(), 'material_spec_id', l.spec, 'qty', v_qty,
      'required_date', greatest(l.need_by, v_today), 'lookahead_item_id', i.id, 'elements', v_els,
      'remarks', 'Look-ahead ' || pl.period_label || ': ' || i.name);
  end loop;
  if jsonb_array_length(v_mr_lines) = 0 then
    raise exception 'Nothing in stock to request for "%" (order it with a purchase request first)', i.name;
  end if;

  select el.block_id into v_block from public.elements el where el.id = i.element_id;
  v_number := coalesce(nullif(p ->> 'number', ''), app.la_doc_number(i.project_id, 'SR', pl.period_start));
  v_res := public.save_mr(jsonb_build_object('id', v_id, 'project_id', i.project_id, 'number', v_number,
    'request_type', 'site_use', 'block_id', coalesce((p ->> 'block_id')::uuid, v_block), 'priority', 'normal',
    'required_date', coalesce((p ->> 'required_date')::date, greatest(coalesce(v_req, v_today), v_today)),
    'delivery_location', (select name from public.stores where id = v_store), 'store_id', v_store,
    'purpose', 'Look-ahead site use: ' || i.name, 'is_lookahead', true, 'lookahead_plan_id', pl.id,
    'submit', coalesce((p ->> 'submit')::boolean, false), 'lines', v_mr_lines));
  update public.material_requests set lookahead_plan_id = pl.id, is_lookahead = true where id = v_id and lookahead_plan_id is distinct from pl.id;
  update public.mr_lines set lookahead_item_id = i.id where mr_id = v_id and lookahead_item_id is distinct from i.id;
  return app.op_done(p, 'create_sur_from_lookahead', jsonb_build_object('ok', true, 'id', v_id, 'number', v_number,
    'status', v_res ->> 'status', 'lines', v_mr_lines));
end $$;

create or replace function public.get_lookahead_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid := (p ->> 'project_id')::uuid;
  v_mode text;
  ym record;
  per record;
  v_hor date;
  v_schedule uuid;
  v_weeks jsonb;
  v_items jsonb;
begin
  perform app.require_member(v_project);
  v_mode := coalesce(nullif(p ->> 'calendar_mode', ''),
                     (select lookahead_calendar_mode from public.project_settings where project_id = v_project), 'gregorian');
  select * into ym from app.la_payload_month(p, v_mode);
  select * into per from app.la_period(v_mode, ym.y, ym.m);
  v_hor := per.period_end + 7 * coalesce((p ->> 'horizon_weeks')::int,
             (select lookahead_horizon_weeks from public.project_settings where project_id = v_project), 2);
  v_schedule := coalesce((p ->> 'schedule_id')::uuid, app.la_pick_schedule(v_project));
  select coalesce(jsonb_agg(to_jsonb(w) order by w.week_start), '[]'::jsonb) into v_weeks
    from app.la_weeks(v_project, per.period_start, per.period_end, v_hor) w;
  if v_schedule is not null then
    select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_items
      from app.lookahead_candidates(v_project, v_schedule, per.period_start, per.period_end, v_hor) c;
  end if;
  return jsonb_build_object('project_id', v_project, 'calendar_mode', v_mode, 'year', ym.y, 'month', ym.m,
    'period_label', per.label, 'period_label_am', per.label_am, 'period_start', per.period_start, 'period_end', per.period_end,
    'horizon_end', v_hor, 'working_days', app.la_wd(v_project, per.period_start, per.period_end), 'schedule_id', v_schedule,
    'weeks', v_weeks, 'items', coalesce(v_items, '[]'::jsonb),
    'plan_id', (select id from public.lookahead_plans where project_id = v_project and calendar_mode = v_mode
                and period_start = per.period_start));
end $$;

-- -----------------------------------------------------------------------------
-- pg_cron jobs (see header for the cron.schedule calls)
-- -----------------------------------------------------------------------------

-- 25th of the month: draft plan for next month for every active project with a schedule.
create or replace function app.cron_generate_lookaheads(p_on date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_on date := coalesce(p_on, app.la_today());
  pj record; ym record; per record;
  v_done int := 0; v_skipped int := 0; v_errors jsonb := '[]'::jsonb;
  v_status text;
begin
  for pj in select p.id, p.code, coalesce(s.lookahead_calendar_mode, 'gregorian') as mode
            from public.projects p left join public.project_settings s on s.project_id = p.id
            where p.is_active loop
    begin
      if app.la_pick_schedule(pj.id) is null then v_skipped := v_skipped + 1; continue; end if;
      select * into ym from app.la_next_month(pj.mode, v_on);
      select * into per from app.la_period(pj.mode, ym.y, ym.m);
      select status into v_status from public.lookahead_plans
        where project_id = pj.id and calendar_mode = pj.mode and period_start = per.period_start;
      if v_status is not null and v_status <> 'draft' then v_skipped := v_skipped + 1; continue; end if;
      perform app.la_generate(pj.id, pj.mode, ym.y, ym.m);
      perform app.notify_roles(pj.id, '{coordinator,office_engineer}', 'Look-ahead ' || per.label || ' generated',
        'Review constraints and material needs, then publish', 'lookahead_plan',
        (select id from public.lookahead_plans where project_id = pj.id and calendar_mode = pj.mode and period_start = per.period_start));
      v_done := v_done + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('project', pj.code, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('ok', true, 'generated', v_done, 'skipped', v_skipped, 'errors', v_errors);
end $$;

-- Nightly: progress, auto constraints, readiness; lock weeks that have started.
create or replace function app.cron_refresh_lookaheads() returns jsonb
language plpgsql security definer set search_path = public as $$
declare pl record; v_n int := 0; v_errors jsonb := '[]'::jsonb;
begin
  for pl in select id, period_label from public.lookahead_plans
            where status in ('draft','published') and horizon_end >= app.la_today() - 7 loop
    begin
      perform app.la_refresh(pl.id);
      v_n := v_n + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_object('plan', pl.period_label, 'error', sqlerrm);
    end;
  end loop;
  update public.lookahead_weeks set status = 'committed' where status = 'open' and week_start <= app.la_today();
  return jsonb_build_object('ok', true, 'refreshed', v_n, 'errors', v_errors);
end $$;

-- Friday: uncommitted ready work for next week, constraints due within 3 days, materials to order now.
create or replace function app.cron_lookahead_reminders() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today date := app.la_today();
  r record; v_n int := 0;
begin
  for r in
    select i.responsible_id, i.project_id, count(*) n, min(pl.id::text)::uuid plan_id
    from public.lookahead_items i
    join public.lookahead_plans pl on pl.id = i.plan_id and pl.status = 'published'
    join public.lookahead_weeks wk on wk.plan_id = pl.id and wk.status = 'open' and wk.week_start between v_today + 1 and v_today + 7
    where i.status = 'active' and i.readiness = 'ready' and i.responsible_id is not null and i.week_days ? wk.week_start::text
      and not exists (select 1 from public.weekly_commitments wc where wc.item_id = i.id and wc.week_id = wk.id and wc.kind = 'commitment')
    group by i.responsible_id, i.project_id
  loop
    perform app.notify_user(r.responsible_id, r.project_id, 'Commit next week''s work', r.n || ' ready task(s) not yet committed',
      'lookahead_plan', r.plan_id);
    v_n := v_n + 1;
  end loop;
  for r in
    select c.owner_id, c.project_id, count(*) n, min(c.id::text)::uuid cid
    from public.lookahead_constraints c join public.lookahead_items i on i.id = c.item_id
    join public.lookahead_plans pl on pl.id = i.plan_id and pl.status <> 'closed'
    where c.status in ('open','in_progress','blocked') and c.owner_id is not null and not c.advisory and c.due_date <= v_today + 3
    group by c.owner_id, c.project_id
  loop
    perform app.notify_user(r.owner_id, r.project_id, 'Constraints due', r.n || ' constraint(s) due within 3 days',
      'lookahead_constraint', r.cid, true);
    v_n := v_n + 1;
  end loop;
  for r in select pl.id, pl.project_id, pl.period_label, (app.la_summary(pl.id) ->> 'raise_pr_now')::int n
           from public.lookahead_plans pl where pl.status = 'published' loop
    if r.n > 0 then
      perform app.notify_roles(r.project_id, '{office_engineer,procurement}', 'Order now: look-ahead ' || r.period_label,
        r.n || ' material(s) must be ordered within 7 days', 'lookahead_plan', r.id, true);
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'notifications', v_n);
end $$;

-- -----------------------------------------------------------------------------
-- Inbox: constraints assigned to me, weeks to close
-- -----------------------------------------------------------------------------

create or replace function app.lookahead_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_role text; v_today date := app.la_today();
begin
  if p_user is distinct from auth.uid()
     and (auth.uid() is not null or coalesce(auth.role(), '') in ('anon','authenticated')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin'
  )
  select x.kind, x.entity_type, x.entity_id, x.project_id, x.number, x.title, x.status, x.requested_by, x.requested_at,
         x.is_urgent, x.actions, round((extract(epoch from now() - coalesce(x.requested_at, now())) / 3600)::numeric, 1)
  from (
    select 'lookahead_constraint'::text as kind, 'lookahead_constraint'::text as entity_type, c.id as entity_id, c.project_id,
           pl.period_label as number, (i.name || ': ' || c.description) as title, c.status, c.created_by as requested_by,
           c.created_at as requested_at, coalesce(c.due_date < v_today, false) as is_urgent,
           array['clear','update']::text[] as actions
    from public.lookahead_constraints c
    join public.lookahead_items i on i.id = c.item_id and i.status = 'active'
    join public.lookahead_plans pl on pl.id = i.plan_id and pl.status <> 'closed'
    where c.project_id in (select pid from mem) and c.status in ('open','in_progress','blocked') and not c.advisory
      and (c.owner_id = p_user or (c.owner_id is null and c.owner_role = v_role))
      and coalesce(c.due_date, v_today) <= v_today + 7
    union all
    select 'lookahead_week_close', 'lookahead_week', w.id, w.project_id, pl.period_label || ' W' || w.week_no,
           'Close week ' || w.week_no || ' (' || to_char(w.week_start, 'DD Mon') || '–' || to_char(w.week_end, 'DD Mon') || ')',
           w.status, pl.published_by, w.week_end::timestamptz, false, array['close']::text[]
    from public.lookahead_weeks w join public.lookahead_plans pl on pl.id = w.plan_id and pl.status = 'published'
    where w.project_id in (select pid from mem) and v_role in ('coordinator','manager','admin') and w.status <> 'closed'
      and w.week_end <= v_today and exists (select 1 from public.weekly_commitments wc where wc.week_id = w.id and wc.kind = 'commitment')
  ) x;
end $$;

do $$
begin
  execute 'create or replace view public.v_my_approvals as
           select * from app.approvals_for(auth.uid())
           union all
           select * from app.lookahead_approvals_for(auth.uid())';
exception when others then
  raise notice 'v_my_approvals not extended with look-ahead items: %', sqlerrm;
end $$;
grant select on public.v_my_approvals to authenticated;

-- -----------------------------------------------------------------------------
-- Views (security_invoker)
-- -----------------------------------------------------------------------------

-- The Monthly Tasks Window: persisted items + readiness + constraint counts + commitments per week.
create or replace view public.v_monthly_lookahead with (security_invoker = true) as
select i.id, i.plan_id, i.project_id, pl.calendar_mode, pl.period_label, pl.period_label_am, pl.period_start, pl.period_end,
       pl.horizon_end, pl.status as plan_status, i.schedule_task_id, i.element_id, el.code as element_code, el.block_id, el.level_id,
       i.wbs, i.group_name, i.name, i.window_role, i.is_milestone, i.is_critical, i.total_float_days,
       i.planned_start, i.planned_finish, i.pct_at_generation, i.pct_complete, i.target_pct_end_of_period, i.week_days,
       i.responsible_id, pr.full_name as responsible_name, i.readiness, i.status, i.sort_key,
       coalesce(cc.open_count, 0) as open_constraints, cc.open_types, cc.worst_ctype, cc.earliest_due, cc.worst_description,
       coalesce(wc.commitments, '[]'::jsonb) as commitments,
       i.updated_at
from public.lookahead_items i
join public.lookahead_plans pl on pl.id = i.plan_id
left join public.elements el on el.id = i.element_id
left join public.profiles pr on pr.id = i.responsible_id
left join lateral (
  select count(*) as open_count, array_agg(distinct c.ctype) as open_types, min(c.due_date) as earliest_due,
         (array_agg(c.ctype order by (c.status = 'blocked') desc, c.advisory, c.due_date nulls last))[1] as worst_ctype,
         (array_agg(c.description order by (c.status = 'blocked') desc, c.advisory, c.due_date nulls last))[1] as worst_description
  from public.lookahead_constraints c where c.item_id = i.id and c.status in ('open','in_progress','blocked')
) cc on true
left join lateral (
  select jsonb_agg(jsonb_build_object('id', w.id, 'week_id', w.week_id, 'week_start', wk.week_start, 'week_no', wk.week_no,
           'kind', w.kind, 'description', w.description, 'target_pct', w.target_pct, 'outcome', w.outcome,
           'rnc_code', w.rnc_code, 'committed_by', w.committed_by) order by wk.week_start, w.committed_at) as commitments
  from public.weekly_commitments w join public.lookahead_weeks wk on wk.id = w.week_id where w.item_id = i.id
) wc on true;

-- Material needs per plan × item × spec (no prices).
create or replace view public.v_lookahead_material_needs with (security_invoker = true) as
select c.plan_id, c.project_id, pl.period_label, c.item_id, i.name as item_name, i.window_role, i.planned_start, i.planned_finish,
       i.responsible_id, c.material_spec_id, sp.label, sp.category, sp.uom, c.element_ids,
       c.total_need, c.remaining, c.window_need, c.weekly_need, c.need_by, c.lead_time_days, c.safety_days, c.order_by, c.pack_size,
       c.ati_before, c.from_stock, c.from_po, c.from_po_late, c.from_procurement, c.from_pending_pr,
       c.short_firm, c.to_order, c.suggested_qty, c.raise_pr_now, c.late_order, c.arrives_late, c.suggest_sur,
       c.next_po_eta, c.late_po_eta, c.po_numbers, c.mr_numbers,
       case when c.late_order then 'late_order' when c.raise_pr_now then 'raise_pr_now' when c.to_order > 0 then 'to_order'
            when c.arrives_late then 'arrives_late' when c.from_procurement + c.from_pending_pr > 0 then 'in_procurement'
            else 'covered' end as need_status
from public.lookahead_plans pl
cross join lateral app.la_material_calc(pl.id) c
join public.lookahead_items i on i.id = c.item_id
join public.v_specs sp on sp.id = c.material_spec_id;

-- Per plan × spec (× delivery store = main store): what the "Material needs this month" table shows.
create or replace view public.v_lookahead_material_summary with (security_invoker = true) as
select n.plan_id, n.project_id, n.period_label, n.material_spec_id, n.label, n.category, n.uom,
       (select s.id from public.stores s where s.project_id = n.project_id and s.deleted_at is null
         order by (s.store_type = 'main') desc, s.created_at limit 1) as store_id,
       count(distinct n.item_id) as items, sum(n.window_need) as window_need, max(n.ati_before) as ati,
       sum(n.from_stock) as from_stock, sum(n.from_po) as open_po_by_need_date, sum(n.from_po_late) as open_po_late,
       sum(n.from_procurement) as in_procurement, sum(n.from_pending_pr) as pending_pr,
       sum(n.short_firm) as shortfall, sum(n.to_order) as to_order,
       case when sum(n.to_order) > 0.0005 then ceil(sum(n.to_order) / max(n.pack_size)) * max(n.pack_size) else 0 end as suggested_qty,
       max(n.pack_size) as pack_size, min(n.need_by) as need_by, min(n.order_by) filter (where n.to_order > 0) as order_by,
       max(n.lead_time_days) as lead_time_days,
       bool_or(n.raise_pr_now) as raise_pr_now, bool_or(n.late_order) as late_order, bool_or(n.arrives_late) as arrives_late,
       bool_or(n.suggest_sur) as suggest_sur, min(n.next_po_eta) as next_po_eta, min(n.late_po_eta) as late_po_eta,
       (select coalesce(array_agg(distinct t), '{}') from unnest(string_to_array(string_agg(nullif(array_to_string(n.po_numbers, ','), ''), ','), ',')) t) as po_numbers,
       (select coalesce(array_agg(distinct t), '{}') from unnest(string_to_array(string_agg(nullif(array_to_string(n.mr_numbers, ','), ''), ','), ',')) t) as mr_numbers,
       jsonb_agg(jsonb_build_object('item_id', n.item_id, 'name', n.item_name, 'need', n.window_need, 'need_by', n.need_by)
                 order by n.need_by) as by_item
from public.v_lookahead_material_needs n
group by n.plan_id, n.project_id, n.period_label, n.material_spec_id, n.label, n.category, n.uom;

-- Readiness per item: open constraints by type, earliest due, live readiness.
create or replace view public.v_lookahead_readiness with (security_invoker = true) as
select i.id as item_id, i.plan_id, i.project_id, i.name, i.window_role, i.responsible_id, i.status,
       count(c.id) filter (where c.status in ('open','in_progress','blocked')) as open_total,
       count(c.id) filter (where c.status = 'blocked') as blocked,
       count(c.id) filter (where c.status in ('open','in_progress') and c.due_date < app.la_today() and not c.advisory) as overdue,
       count(c.id) filter (where c.ctype = 'predecessor' and c.status in ('open','in_progress','blocked')) as predecessor_open,
       count(c.id) filter (where c.ctype = 'material' and c.status in ('open','in_progress','blocked')) as material_open,
       count(c.id) filter (where c.ctype = 'approval' and c.status in ('open','in_progress','blocked')) as approval_open,
       count(c.id) filter (where c.ctype = 'inspection' and c.status in ('open','in_progress','blocked')) as inspection_open,
       count(c.id) filter (where c.ctype = 'information' and c.status in ('open','in_progress','blocked')) as information_open,
       count(c.id) filter (where c.ctype in ('labour','equipment','space','external') and c.status in ('open','in_progress','blocked')) as other_open,
       count(c.id) filter (where c.status in ('cleared','waived')) as cleared_total,
       min(c.due_date) filter (where c.status in ('open','in_progress','blocked')) as earliest_due,
       i.readiness,
       case when count(c.id) filter (where c.status in ('open','in_progress','blocked')) = 0 then 'ready'
            when count(c.id) filter (where not c.advisory and (c.status = 'blocked'
                   or (c.status in ('open','in_progress') and c.due_date < app.la_today()))) > 0 then 'not_ready'
            else 'at_risk' end as readiness_live
from public.lookahead_items i
left join public.lookahead_constraints c on c.item_id = i.id
group by i.id;

-- PPC per week with a project-level rolling 4-week PPC (closed weeks).
create or replace view public.v_ppc with (security_invoker = true) as
with wk as (
  select w.id as week_id, w.plan_id, w.project_id, pl.period_label, pl.calendar_mode, w.week_no, w.week_start, w.week_end,
         w.working_days, w.in_buffer, w.status,
         count(c.id) filter (where c.kind = 'commitment') as committed,
         count(c.id) filter (where c.kind = 'commitment' and c.outcome = 'completed') as completed,
         count(c.id) filter (where c.kind = 'commitment' and c.outcome = 'not_completed') as not_completed,
         count(c.id) filter (where c.kind = 'commitment' and c.outcome = 'pending') as pending,
         count(c.id) filter (where c.kind = 'candidate') as candidates,
         count(c.id) filter (where c.kind = 'commitment' and c.readiness_at_commit <> 'ready') as overrides,
         w.ppc as ppc_closed, w.pcr, w.ta
  from public.lookahead_weeks w
  join public.lookahead_plans pl on pl.id = w.plan_id
  left join public.weekly_commitments c on c.week_id = w.id
  group by w.id, pl.period_label, pl.calendar_mode
)
select wk.week_id, wk.plan_id, wk.project_id, wk.period_label, wk.calendar_mode, wk.week_no, wk.week_start, wk.week_end,
       wk.working_days, wk.in_buffer, wk.status, wk.committed, wk.completed, wk.not_completed, wk.pending, wk.candidates, wk.overrides,
       coalesce(wk.ppc_closed, case when wk.committed > 0 then round(100.0 * wk.completed / wk.committed, 2) end) as ppc,
       wk.pcr, wk.ta,
       round(100.0 * sum(case when wk.status = 'closed' then wk.completed else 0 end)
               over (partition by wk.project_id, wk.calendar_mode order by wk.week_start rows between 3 preceding and current row)
             / nullif(sum(case when wk.status = 'closed' then wk.committed else 0 end)
               over (partition by wk.project_id, wk.calendar_mode order by wk.week_start rows between 3 preceding and current row), 0), 2)
         as ppc_rolling_4w,
       (select s.ppc_target from public.project_settings s where s.project_id = wk.project_id) as ppc_target
from wk;

-- PPC per week × last planner.
create or replace view public.v_ppc_by_responsible with (security_invoker = true) as
select w.id as week_id, w.plan_id, w.project_id, w.week_no, w.week_start, c.committed_by, pr.full_name,
       count(*) as committed, count(*) filter (where c.outcome = 'completed') as completed,
       round(100.0 * count(*) filter (where c.outcome = 'completed') / nullif(count(*) filter (where c.outcome <> 'pending'), 0), 2) as ppc
from public.weekly_commitments c
join public.lookahead_weeks w on w.id = c.week_id
left join public.profiles pr on pr.id = c.committed_by
where c.kind = 'commitment'
group by w.id, c.committed_by, pr.full_name;

-- Reasons for non-completion (Pareto): all time and last 8 weeks.
create or replace view public.v_rnc_pareto with (security_invoker = true) as
with x as (
  select c.project_id, c.rnc_code, count(*) as total,
         count(*) filter (where w.week_start >= app.la_today() - 56) as last_8_weeks
  from public.weekly_commitments c join public.lookahead_weeks w on w.id = c.week_id
  where c.kind = 'commitment' and c.outcome = 'not_completed' and c.rnc_code is not null
  group by c.project_id, c.rnc_code
)
select x.project_id, x.rnc_code, r.label, r.label_am, r.category, x.total, x.last_8_weeks,
       round(100.0 * x.total / sum(x.total) over (partition by x.project_id), 2) as pct,
       round(100.0 * sum(x.total) over (partition by x.project_id order by x.total desc, r.sort rows unbounded preceding)
             / sum(x.total) over (partition by x.project_id), 2) as cumulative_pct,
       row_number() over (partition by x.project_id order by x.total desc, r.sort) as rank
from x join public.rnc_reasons r on r.code = x.rnc_code;

-- Percent constraint removal (PCR) and ageing by owner × type.
create or replace view public.v_constraint_removal with (security_invoker = true) as
select c.project_id, i.plan_id, pl.period_label, c.ctype, c.owner_id, pr.full_name as owner_name, c.owner_role,
       count(*) as total,
       count(*) filter (where c.status in ('open','in_progress','blocked')) as open,
       count(*) filter (where c.due_date <= app.la_today()) as due,
       count(*) filter (where c.due_date <= app.la_today() and c.status in ('cleared','waived') and c.cleared_on <= c.due_date) as cleared_on_time,
       count(*) filter (where c.status in ('cleared','waived') and c.cleared_on > c.due_date) as cleared_late,
       count(*) filter (where c.status in ('open','in_progress','blocked') and c.due_date < app.la_today()) as overdue,
       round(100.0 * count(*) filter (where c.due_date <= app.la_today() and c.status in ('cleared','waived') and c.cleared_on <= c.due_date)
             / nullif(count(*) filter (where c.due_date <= app.la_today()), 0), 2) as pcr,
       round(avg(app.la_today() - app.eat_date(c.created_at)) filter (where c.status in ('open','in_progress','blocked')), 1) as avg_open_age_days,
       max(app.la_today() - app.eat_date(c.created_at)) filter (where c.status in ('open','in_progress','blocked')) as max_open_age_days
from public.lookahead_constraints c
join public.lookahead_items i on i.id = c.item_id
join public.lookahead_plans pl on pl.id = i.plan_id
left join public.profiles pr on pr.id = c.owner_id
where not c.advisory
group by c.project_id, i.plan_id, pl.period_label, c.ctype, c.owner_id, pr.full_name, c.owner_role;

grant select on public.v_monthly_lookahead, public.v_lookahead_material_needs, public.v_lookahead_material_summary,
  public.v_lookahead_readiness, public.v_ppc, public.v_ppc_by_responsible, public.v_rnc_pareto, public.v_constraint_removal
  to authenticated;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array['generate_lookahead','refresh_lookahead','publish_lookahead','assign_lookahead_item','update_constraint',
    'commit_lookahead_item','report_commitment','close_week','create_prs_from_lookahead','create_sur_from_lookahead',
    'get_lookahead_preview'] loop
    execute format('revoke execute on function public.%I(jsonb) from public, anon', f);
    execute format('grant execute on function public.%I(jsonb) to authenticated', f);
  end loop;
end $$;
revoke execute on function app.cron_generate_lookaheads(date) from public;
revoke execute on function app.cron_refresh_lookaheads() from public;
revoke execute on function app.cron_lookahead_reminders() from public;
revoke execute on function app.la_generate(uuid, text, int, int, uuid, uuid, int) from public;
revoke execute on function app.la_refresh(uuid) from public;
revoke execute on function app.la_refresh_constraints(uuid) from public;
