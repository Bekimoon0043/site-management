-- =============================================================================
-- Project calendar: Ethiopian public holidays for any year, a work / no-work decision per project for every
-- upcoming holiday, and day-by-day calendar editing (rain days, shutdowns, overtime days, half days).
--
-- Holidays (public_holidays, country 'ET', Proclamation 1334/2024 arts. 4 and 6; memorial days in art. 5 stay open):
--   fixed in the Ethiopian calendar  Enkutatash (Meskerem 1), Meskel (Meskerem 17), Timket (Tir 11),
--                                    Adwa (Yekatit 23), Patriots' Victory (Miyazya 27)
--   fixed in the Gregorian calendar  Genna (7 Jan = Julian 25 Dec; Tahsas 28 in the year after a Pagume-6 year),
--                                    International Labour Day (1 May)
--   Orthodox Easter computus         Siklet (Good Friday) and Fasika (Julian Easter converted to Gregorian)
--   Hijri (tabular, tentative)       Eid al-Fitr (1 Shawwal), Eid al-Adha / Arafa (10 Dhu al-Hijja), Mawlid (12 Rabi I).
--                                    Ethiopia fixes these by moon sighting, often ±1 day: they stay is_tentative until
--                                    an admin confirms or moves them (save_public_holiday).
--   app.generate_et_holidays(from, to) fills any range of years; 2026–2035 are generated here.
--
-- Who decides (Labour Proclamation 1156/2019 art. 68: work on a public holiday is paid at 2.5× the hourly wage.
-- FIDIC 2017 clause 6.5 separately requires the Engineer's consent where that contract applies. The project MANAGER
-- records the project's operational decision; the planner side PROPOSES. External consent is not implied by this RPC):
--   view calendar                        every project member
--   propose work / no work on a holiday  site engineer, office engineer, coordinator (manager may decide directly)
--   decide a holiday                     manager, admin
--   edit ordinary days (rain day, client shutdown, overtime Sunday, half day, rename)
--                                        office engineer (planner), coordinator, manager, admin
--   working week / Saturday factor       coordinator, manager, admin
--   national holiday list (add / move / confirm lunar dates / generate years)   admin
-- Undecided holidays stay NON-working (the calendar default). Holidays on a non-working weekday need no decision.
--
-- Decisions and edits are calendar_exceptions (source 'project'); afterwards the not-started tasks whose
-- planned window covers a changed day are re-planned with the schedule CPM (app.replan_schedule) and the
-- forecast re-runs, so successors move too. Deciders are notified 30 days ahead (app.calendar_holiday_reminders,
-- run daily by pg_cron when available, and whenever the calendar page loads via calendar_sync); pending decisions
-- appear in the Approvals inbox (kind 'holiday') through app.approval_sources. Re-runnable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Holiday generator
-- ---------------------------------------------------------------------------
alter table public.public_holidays add column if not exists source text not null default 'seed';
alter table public.public_holidays add column if not exists confirmed_by uuid references public.profiles (id);
alter table public.public_holidays add column if not exists confirmed_at timestamptz;

-- Orthodox (Julian) Easter in the Gregorian calendar (Meeus). The Julian–Gregorian offset changes in century years.
create or replace function app.orthodox_easter(p_year int) returns date
language plpgsql immutable as $$
declare a int := p_year % 4; b int := p_year % 7; c int := p_year % 19; d int; e int; s int;
begin
  d := (19 * c + 15) % 30;
  e := (2 * a + 4 * b - d + 34) % 7;
  s := d + e + 114;
  return make_date(p_year, s / 31, s % 31 + 1) + (p_year / 100 - p_year / 400 - 2);
end $$;

-- Tabular (civil) Hijri date → Gregorian. Within a day of the sighted date; used as the tentative date.
create or replace function app.hijri_to_date(p_y int, p_m int, p_d int) returns date
language sql immutable as $$
  select to_date((p_d + (59 * (p_m - 1) + 1) / 2 + (p_y - 1) * 354 + (3 + 11 * p_y) / 30 + 1948439)::text, 'J')
$$;

-- Insert the Ethiopian public holidays of Gregorian years p_from..p_to. Existing rows (also the same holiday
-- moved by up to 5 days, e.g. a confirmed Eid) are kept. Returns the number of holidays added.
create or replace function app.generate_et_holidays(p_from int, p_to int) returns int
language plpgsql security definer set search_path = public as $$
declare g int; hy int; n int := 0; k int;
begin
  if p_to < p_from or p_to - p_from > 50 then raise exception 'Choose at most 50 years'; end if;
  for g in p_from .. p_to loop
    with c(on_date, name, name_am, kind, tentative) as (
      values
        (make_date(g, 1, 7), 'Genna (Ethiopian Christmas)', 'ገና', 'religious_orthodox', false),
        (app.from_ethiopian(g - 8, 5, 11), 'Timket (Epiphany)', 'ጥምቀት', 'religious_orthodox', false),
        (app.from_ethiopian(g - 8, 6, 23), 'Adwa Victory Day', 'የዓድዋ ድል በዓል', 'national', false),
        (app.orthodox_easter(g) - 2, 'Siklet (Good Friday)', 'ስቅለት', 'religious_orthodox', false),
        (app.orthodox_easter(g), 'Fasika (Easter)', 'ፋሲካ', 'religious_orthodox', false),
        (make_date(g, 5, 1), 'International Labour Day', 'የሠራተኞች ቀን', 'national', false),
        (app.from_ethiopian(g - 8, 8, 27), 'Patriots'' Victory Day', 'የአርበኞች ቀን', 'national', false),
        (app.from_ethiopian(g - 7, 1, 1), 'Enkutatash (New Year ' || (g - 7) || ' E.C.)', 'እንቁጣጣሽ', 'national', false),
        (app.from_ethiopian(g - 7, 1, 17), 'Meskel', 'መስቀል', 'religious_orthodox', false)
    )
    insert into public.public_holidays (country, on_date, name, name_am, kind, is_tentative, source)
    select 'ET', c.on_date, c.name, c.name_am, c.kind, c.tentative, 'generated' from c
    where not exists (select 1 from public.public_holidays h where h.country = 'ET' and h.name = c.name and abs(h.on_date - c.on_date) <= 5);
    get diagnostics k = row_count; n := n + k;

    for hy in (g - 622) * 33 / 32 - 1 .. (g - 622) * 33 / 32 + 2 loop
      with c(on_date, name, name_am) as (
        values
          (app.hijri_to_date(hy, 10, 1), 'Eid al-Fitr', 'ኢድ አልፈጥር'),
          (app.hijri_to_date(hy, 12, 10), 'Eid al-Adha (Arafa)', 'ኢድ አልአድሐ (አረፋ)'),
          (app.hijri_to_date(hy, 3, 12), 'Mawlid', 'መውሊድ')
      )
      insert into public.public_holidays (country, on_date, name, name_am, kind, is_tentative, source)
      select 'ET', c.on_date, c.name, c.name_am, 'religious_muslim', true, 'generated' from c
      where extract(year from c.on_date)::int = g
        and not exists (select 1 from public.public_holidays h where h.country = 'ET' and h.name = c.name and abs(h.on_date - c.on_date) <= 5);
      get diagnostics k = row_count; n := n + k;
    end loop;
  end loop;
  return n;
end $$;
revoke execute on function app.generate_et_holidays(int, int) from public;

-- ---------------------------------------------------------------------------
-- Decisions per project and calendar edits
-- ---------------------------------------------------------------------------
create table if not exists public.holiday_decisions (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  holiday_id       uuid not null references public.public_holidays (id) on delete cascade,
  on_date          date not null,
  status           text not null default 'pending' check (status in ('pending','proposed','decided')),
  proposed_choice  text check (proposed_choice in ('work','half_day','no_work')),
  proposed_note    text,
  proposed_by      uuid references public.profiles (id),
  proposed_at      timestamptz,
  decision         text check (decision in ('work','half_day','no_work')),
  decision_note    text,
  decided_by       uuid references public.profiles (id),
  decided_at       timestamptz,
  notified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, holiday_id)
);
create index if not exists holiday_decisions_project_date on public.holiday_decisions (project_id, on_date);
alter table public.holiday_decisions enable row level security;
drop policy if exists member_read on public.holiday_decisions;
create policy member_read on public.holiday_decisions for select to authenticated using (app.is_member(project_id));
drop trigger if exists touch_updated_at on public.holiday_decisions;
create trigger touch_updated_at before update on public.holiday_decisions for each row execute function app.touch_updated_at();
drop trigger if exists audit on public.holiday_decisions;
create trigger audit after insert or update or delete on public.holiday_decisions for each row execute function app.audit();

alter table public.calendar_exceptions add column if not exists category text;
alter table public.calendar_exceptions add column if not exists note text;
alter table public.calendar_exceptions add column if not exists holiday_decision_id uuid references public.holiday_decisions (id) on delete set null;
alter table public.calendar_exceptions add column if not exists updated_by uuid references public.profiles (id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'calendar_exceptions_category_check') then
    alter table public.calendar_exceptions add constraint calendar_exceptions_category_check
      check (category is null or category in ('rain','shutdown','overtime','half_day','holiday_work','holiday_off','other'));
  end if;
end $$;

-- Calendars change only through the RPCs below (they enforce who may do what); admin keeps direct access.
-- The national list is shared by every project, so only admins may write it (including direct table writes).
drop policy if exists master_write on public.project_calendars;
drop policy if exists master_write on public.calendar_exceptions;
drop policy if exists mgmt_write on public.public_holidays;
drop policy if exists admin_write on public.project_calendars;
drop policy if exists admin_write on public.calendar_exceptions;
drop policy if exists admin_write on public.public_holidays;
create policy admin_write on public.project_calendars for all to authenticated
  using (app.has_role_txt('admin')) with check (app.has_role_txt('admin'));
create policy admin_write on public.calendar_exceptions for all to authenticated
  using (app.has_role_txt('admin')) with check (app.has_role_txt('admin'));
create policy admin_write on public.public_holidays for all to authenticated
  using (app.has_role_txt('admin')) with check (app.has_role_txt('admin'));

-- Decision rows for every active project whose calendar uses public holidays: holidays from a month ago to
-- 400 days ahead that fall on a working weekday. Moved holidays carry their decision along; undecided rows for
-- days that no longer need one are dropped.
create or replace function app.ensure_holiday_decisions(p_project uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_today date := app.eat_date(now());
begin
  insert into public.holiday_decisions (project_id, holiday_id, on_date)
  select pc.project_id, h.id, h.on_date
  from public.project_calendars pc
  join public.projects pj on pj.id = pc.project_id and pj.is_active
  join public.public_holidays h on h.country = pc.holiday_country and h.deleted_at is null
   and h.on_date between v_today - 31 and v_today + 400
   and extract(isodow from h.on_date)::int = any (pc.working_weekdays)
  where pc.is_default and pc.deleted_at is null and pc.use_public_holidays
    and (p_project is null or pc.project_id = p_project)
  on conflict (project_id, holiday_id) do update set on_date = excluded.on_date
    where public.holiday_decisions.on_date is distinct from excluded.on_date;

  delete from public.holiday_decisions d
  where d.status <> 'decided' and (p_project is null or d.project_id = p_project)
    and not exists (
      select 1 from public.project_calendars pc join public.public_holidays h on h.id = d.holiday_id
      where pc.project_id = d.project_id and pc.is_default and pc.deleted_at is null and pc.use_public_holidays
        and h.deleted_at is null and h.country = pc.holiday_country and extract(isodow from h.on_date)::int = any (pc.working_weekdays));
end $$;
revoke execute on function app.ensure_holiday_decisions(uuid) from public;

-- Write the calendar exception of a decision (or remove it when the decision is reopened / the holiday moved).
create or replace function app.apply_holiday_decision(p_decision uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.holiday_decisions; v_cal uuid; v_name text;
begin
  select * into d from public.holiday_decisions where id = p_decision;
  if not found then return; end if;
  v_cal := app.project_calendar(d.project_id);
  if v_cal is null then return; end if;
  update public.calendar_exceptions set deleted_at = now(), updated_by = auth.uid()
   where holiday_decision_id = d.id and deleted_at is null and (d.status <> 'decided' or on_date <> d.on_date);
  if d.status = 'decided' then
    select name into v_name from public.public_holidays where id = d.holiday_id;
    insert into public.calendar_exceptions (calendar_id, project_id, on_date, is_working, factor, name, source, category, note, holiday_decision_id, updated_by)
    values (v_cal, d.project_id, d.on_date, d.decision <> 'no_work', case when d.decision = 'half_day' then 0.5 end,
      v_name || case d.decision when 'work' then ' — working' when 'half_day' then ' — half day' else '' end, 'project',
      case when d.decision = 'no_work' then 'holiday_off' else 'holiday_work' end, d.decision_note, d.id, auth.uid())
    on conflict (calendar_id, on_date) do update set is_working = excluded.is_working, factor = excluded.factor, name = excluded.name,
      source = 'project', category = excluded.category, note = excluded.note, holiday_decision_id = excluded.holiday_decision_id,
      updated_by = excluded.updated_by, deleted_at = null;
  end if;
end $$;
revoke execute on function app.apply_holiday_decision(uuid) from public;

-- Re-date the project's active schedules after calendar days changed: not-started tasks whose planned window
-- covers a changed day are re-planned (successors follow through the links); all of them when p_dates is null.
-- The forecast is re-run either way. Returns {moved, schedules}.
create or replace function app.calendar_redate(p_project uuid, p_dates date[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; v_seeds uuid[]; v_moved int := 0; v_n int := 0; r jsonb;
begin
  for s in select id, status_date from public.schedules where project_id = p_project and status = 'active' loop
    v_n := v_n + 1;
    if p_dates is null then
      v_seeds := null;
    else
      select coalesce(array_agg(t.id), '{}') into v_seeds from public.schedule_tasks t
       where t.schedule_id = s.id and t.deleted_at is null and not t.is_summary and t.actual_start is null and coalesce(t.pct_complete, 0) = 0
         and exists (select 1 from unnest(p_dates) x where x between t.planned_start and t.planned_finish);
    end if;
    if v_seeds is null or cardinality(v_seeds) > 0 then
      r := app.replan_schedule(s.id, v_seeds);
      v_moved := v_moved + coalesce((r ->> 'moved')::int, 0);
    else
      perform app.run_cpm(s.id, coalesce(s.status_date, app.eat_date(now())), true);
    end if;
  end loop;
  return jsonb_build_object('moved', v_moved, 'schedules', v_n);
end $$;
revoke execute on function app.calendar_redate(uuid, date[]) from public;

-- Holidays within 30 days that are not decided yet: notify once (manager decides; coordinator / office engineer
-- propose). Returns how many decisions were notified.
create or replace function app.calendar_holiday_reminders() returns int
language plpgsql security definer set search_path = public as $$
declare d record; n int := 0; v_today date := app.eat_date(now());
begin
  perform app.ensure_holiday_decisions(null);
  for d in select hd.id, hd.project_id, hd.on_date, hd.status, h.name, h.is_tentative from public.holiday_decisions hd
           join public.public_holidays h on h.id = hd.holiday_id
           where hd.status <> 'decided' and hd.notified_at is null and hd.on_date between v_today and v_today + 30 loop
    perform app.notify_roles_txt(d.project_id, '{manager,coordinator,office_engineer}',
      'Public holiday: work or not? — ' || d.name,
      to_char(d.on_date, 'Dy DD Mon YYYY') || ' (' || app.to_ethiopian(d.on_date) || ')' ||
      case when d.is_tentative then ' · date not yet confirmed' else '' end ||
      ' · confirm in the project calendar. Undecided = no work.', 'holiday_decision', d.id);
    update public.holiday_decisions set notified_at = now() where id = d.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function app.calendar_holiday_reminders() from public;

-- New / re-dated holidays and calendar changes keep the decision rows complete.
create or replace function app.trg_holiday_decisions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.ensure_holiday_decisions(null);
  return null;
end $$;
drop trigger if exists ensure_decisions on public.public_holidays;
create trigger ensure_decisions after insert on public.public_holidays
  for each statement execute function app.trg_holiday_decisions();
drop trigger if exists ensure_decisions on public.project_calendars;
create trigger ensure_decisions after insert or update of use_public_holidays, holiday_country, working_weekdays on public.project_calendars
  for each statement execute function app.trg_holiday_decisions();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
-- {project_id}: make sure upcoming holidays have decision rows and reminders went out (called by the calendar page).
create or replace function public.calendar_sync(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_project uuid := (p ->> 'project_id')::uuid;
begin
  perform app.require_member(v_project);
  return jsonb_build_object('ok', true, 'notified', app.calendar_holiday_reminders());
end $$;

-- {project_id, from, to}: the days of a range (≤ 100) with Ethiopian date, working / capacity, holiday, exception and
-- decision, plus the calendar settings and the holiday decisions from today to 120 days ahead.
create or replace function public.get_project_calendar(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_project uuid := (p ->> 'project_id')::uuid; v_from date := (p ->> 'from')::date; v_to date := (p ->> 'to')::date;
  v_cal public.project_calendars; v_today date := app.eat_date(now());
begin
  perform app.require_member(v_project);
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 100 then raise exception 'Choose a range of at most 100 days'; end if;
  select * into v_cal from public.project_calendars where project_id = v_project and is_default and deleted_at is null limit 1;
  return jsonb_build_object(
    'calendar', case when v_cal.id is null then null else jsonb_build_object('id', v_cal.id, 'name', v_cal.name, 'working_weekdays', v_cal.working_weekdays,
      'saturday_factor', v_cal.saturday_factor, 'hours_per_day', v_cal.hours_per_day, 'use_public_holidays', v_cal.use_public_holidays,
      'holiday_country', v_cal.holiday_country, 'source', v_cal.source) end,
    'today', v_today,
    'days', (select coalesce(jsonb_agg(jsonb_build_object(
        'date', g.d, 'isodow', extract(isodow from g.d)::int,
        'eth_y', e.y, 'eth_m', e.m, 'eth_d', e.d,
        'working', app.is_working_day(v_project, g.d), 'capacity', app.day_capacity(v_project, g.d),
        'holiday', (select jsonb_build_object('id', h.id, 'name', h.name, 'name_am', h.name_am, 'kind', h.kind, 'is_tentative', h.is_tentative)
                    from public.public_holidays h
                    where h.country = coalesce(v_cal.holiday_country, 'ET') and h.on_date = g.d and h.deleted_at is null
                    order by h.kind = 'national' desc limit 1),
        'exception', (select jsonb_build_object('id', x.id, 'is_working', x.is_working, 'factor', x.factor, 'name', x.name, 'category', x.category,
                        'note', x.note, 'source', x.source, 'holiday_decision_id', x.holiday_decision_id)
                      from public.calendar_exceptions x where x.calendar_id = v_cal.id and x.on_date = g.d and x.deleted_at is null),
        'decision_id', (select hd.id from public.holiday_decisions hd where hd.project_id = v_project and hd.on_date = g.d limit 1)
      ) order by g.d), '[]'::jsonb)
      from generate_series(v_from, v_to, interval '1 day') as g0(t)
      cross join lateral (select g0.t::date as d) g
      cross join lateral app.ethiopian_parts(g.d) e),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', hd.id, 'holiday_id', hd.holiday_id, 'on_date', hd.on_date, 'status', hd.status,
        'name', h.name, 'name_am', h.name_am, 'kind', h.kind, 'is_tentative', h.is_tentative,
        'proposed_choice', hd.proposed_choice, 'proposed_note', hd.proposed_note, 'proposed_by', hd.proposed_by, 'proposed_at', hd.proposed_at,
        'decision', hd.decision, 'decision_note', hd.decision_note, 'decided_by', hd.decided_by, 'decided_at', hd.decided_at,
        'days_to_go', hd.on_date - v_today) order by hd.on_date), '[]'::jsonb)
      from public.holiday_decisions hd join public.public_holidays h on h.id = hd.holiday_id
      where hd.project_id = v_project and (hd.on_date between v_today and v_today + 120 or hd.on_date between v_from and v_to)));
end $$;

-- {decision_id, choice: work|half_day|no_work, note?}: suggest what the site does on a holiday; the manager decides.
create or replace function public.propose_holiday_decision(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); d public.holiday_decisions; v_choice text := p ->> 'choice'; v_name text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into d from public.holiday_decisions where id = (p ->> 'decision_id')::uuid for update;
  if not found then raise exception 'Holiday not found for this project'; end if;
  perform app.require_member(d.project_id);
  perform app.require_role_txt('site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if v_choice is null or v_choice not in ('work','half_day','no_work') then raise exception 'Choose work, half day or no work'; end if;
  if d.status = 'decided' then raise exception 'The manager already decided this holiday — ask them to reopen it'; end if;
  update public.holiday_decisions set status = 'proposed', proposed_choice = v_choice, proposed_note = nullif(trim(p ->> 'note'), ''),
    proposed_by = auth.uid(), proposed_at = now() where id = d.id;
  select name into v_name from public.public_holidays where id = d.holiday_id;
  perform app.notify_roles_txt(d.project_id, '{manager}', 'Holiday to decide — ' || v_name,
    'Proposed: ' || replace(v_choice, '_', ' ') || ' on ' || to_char(d.on_date, 'DD Mon YYYY') || coalesce(' · ' || nullif(trim(p ->> 'note'), ''), ''),
    'holiday_decision', d.id);
  return app.op_done(p, 'propose_holiday_decision', jsonb_build_object('ok', true, 'id', d.id, 'status', 'proposed'));
end $$;

-- {decision_id, choice: work|half_day|no_work | action: reopen, note?}: the project manager's decision; the
-- calendar and the schedule follow.
create or replace function public.decide_holiday(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); d public.holiday_decisions; v_choice text := p ->> 'choice'; v_r jsonb; v_name text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into d from public.holiday_decisions where id = (p ->> 'decision_id')::uuid for update;
  if not found then raise exception 'Holiday not found for this project'; end if;
  perform app.require_member(d.project_id);
  if not app.has_role_txt('manager', 'admin') then
    raise exception 'Only the project manager records the project decision (2.5× pay; obtain Engineer consent when the contract requires it) — propose it instead'
      using errcode = '42501';
  end if;
  if p ->> 'action' = 'reopen' then
    update public.holiday_decisions set status = case when proposed_choice is null then 'pending' else 'proposed' end,
      decision = null, decision_note = null, decided_by = null, decided_at = null where id = d.id;
  else
    if v_choice is null or v_choice not in ('work','half_day','no_work') then raise exception 'Choose work, half day or no work'; end if;
    update public.holiday_decisions set status = 'decided', decision = v_choice, decision_note = nullif(trim(p ->> 'note'), ''),
      decided_by = auth.uid(), decided_at = now() where id = d.id;
  end if;
  perform app.apply_holiday_decision(d.id);
  v_r := app.calendar_redate(d.project_id, array[d.on_date]);
  if d.proposed_by is not null and p ->> 'action' is distinct from 'reopen' then
    select name into v_name from public.public_holidays where id = d.holiday_id;
    perform app.notify_user(d.proposed_by, d.project_id, 'Holiday decided — ' || v_name,
      replace(v_choice, '_', ' ') || ' on ' || to_char(d.on_date, 'DD Mon YYYY'), 'holiday_decision', d.id);
  end if;
  return app.op_done(p, 'decide_holiday', jsonb_build_object('ok', true, 'id', d.id,
    'status', (select status from public.holiday_decisions where id = d.id), 'moved', v_r -> 'moved'));
end $$;

-- {project_id, dates: [date…] (≤ 366), kind: normal|non_working|working|half_day, category?, name?, note?}
-- normal = back to the working-week pattern. On a public holiday the change is the holiday decision (manager only).
create or replace function public.edit_calendar_days(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_kind text := p ->> 'kind';
  v_cal public.project_calendars; v_dates date[]; x date; v_dec uuid; v_cat text; v_name text := nullif(trim(p ->> 'name'), '');
  v_note text := nullif(trim(p ->> 'note'), ''); v_r jsonb; v_hol boolean;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('office_engineer', 'coordinator', 'manager', 'admin');
  if v_kind is null or v_kind not in ('normal','non_working','working','half_day') then raise exception 'Unknown day type %', v_kind; end if;
  select array_agg(distinct (v)::date order by (v)::date) into v_dates from jsonb_array_elements_text(coalesce(p -> 'dates', '[]'::jsonb)) v;
  if v_dates is null then raise exception 'Pick at least one day'; end if;
  if cardinality(v_dates) > 366 then raise exception 'Pick at most 366 days at a time'; end if;
  v_cat := coalesce(nullif(p ->> 'category', ''), case v_kind when 'non_working' then 'other' when 'working' then 'overtime' when 'half_day' then 'half_day' end);
  if v_cat is not null and v_cat not in ('rain','shutdown','overtime','half_day','other') then raise exception 'Unknown reason %', v_cat; end if;
  select * into v_cal from public.project_calendars where project_id = v_project and is_default and deleted_at is null limit 1;
  if v_cal.id is null then raise exception 'This project has no calendar'; end if;

  foreach x in array v_dates loop
    v_hol := v_cal.use_public_holidays and exists (select 1 from public.public_holidays h
              where h.country = v_cal.holiday_country and h.on_date = x and h.deleted_at is null);
    select id into v_dec from public.holiday_decisions where project_id = v_project and on_date = x limit 1;
    if v_hol then
      if not app.has_role_txt('manager', 'admin') then
        raise exception '% is a public holiday — propose work / no work from the holiday list; the project manager decides', to_char(x, 'DD Mon YYYY')
          using errcode = '42501';
      end if;
      if v_dec is null then
        perform app.ensure_holiday_decisions(v_project);
        select id into v_dec from public.holiday_decisions where project_id = v_project and on_date = x limit 1;
      end if;
      if v_dec is not null then
        if v_kind = 'normal' then
          update public.holiday_decisions set status = case when proposed_choice is null then 'pending' else 'proposed' end,
            decision = null, decision_note = null, decided_by = null, decided_at = null where id = v_dec;
        else
          update public.holiday_decisions set status = 'decided', decided_by = auth.uid(), decided_at = now(), decision_note = coalesce(v_note, decision_note),
            decision = case v_kind when 'non_working' then 'no_work' when 'working' then 'work' else 'half_day' end where id = v_dec;
        end if;
        perform app.apply_holiday_decision(v_dec);
        continue;
      end if;
      -- holiday on a non-working weekday: a plain exception below
    end if;
    if v_kind = 'normal' then
      update public.calendar_exceptions set deleted_at = now(), updated_by = auth.uid()
       where calendar_id = v_cal.id and on_date = x and deleted_at is null;
    else
      insert into public.calendar_exceptions (calendar_id, project_id, on_date, is_working, factor, name, source, category, note, holiday_decision_id, updated_by)
      values (v_cal.id, v_project, x, v_kind <> 'non_working', case when v_kind = 'half_day' then 0.5 end,
        coalesce(v_name, case v_cat when 'rain' then 'Rain day' when 'shutdown' then 'Site shutdown' when 'overtime' then 'Overtime working day'
                                     when 'half_day' then 'Half day' else case when v_kind = 'non_working' then 'Non-working day' else 'Working day' end end),
        'project', v_cat, v_note, null, auth.uid())
      on conflict (calendar_id, on_date) do update set is_working = excluded.is_working, factor = excluded.factor, name = excluded.name,
        source = 'project', category = excluded.category, note = excluded.note, holiday_decision_id = null, updated_by = excluded.updated_by, deleted_at = null;
    end if;
  end loop;
  v_r := app.calendar_redate(v_project, v_dates);
  return app.op_done(p, 'edit_calendar_days', jsonb_build_object('ok', true, 'days', cardinality(v_dates), 'moved', v_r -> 'moved'));
end $$;

-- {project_id, working_weekdays[], saturday_factor?, hours_per_day?, use_public_holidays?, name?}
create or replace function public.save_project_calendar(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; v_wd int[]; v_r jsonb;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  perform app.require_role_txt('coordinator', 'manager', 'admin');
  if p ? 'working_weekdays' then
    select array_agg(distinct v::int order by v::int) into v_wd from jsonb_array_elements_text(p -> 'working_weekdays') v;
    if v_wd is null or not (v_wd <@ '{1,2,3,4,5,6,7}'::int[]) then raise exception 'Pick the working days of the week'; end if;
  end if;
  if not exists (select 1 from public.project_calendars where project_id = v_project and is_default and deleted_at is null) then
    insert into public.project_calendars (project_id) values (v_project);
  end if;
  update public.project_calendars set
    working_weekdays = coalesce(v_wd, working_weekdays),
    saturday_factor = coalesce((p ->> 'saturday_factor')::numeric, saturday_factor),
    hours_per_day = coalesce((p ->> 'hours_per_day')::numeric, hours_per_day),
    use_public_holidays = coalesce((p ->> 'use_public_holidays')::boolean, use_public_holidays),
    name = coalesce(nullif(trim(p ->> 'name'), ''), name)
  where project_id = v_project and is_default and deleted_at is null;
  if (p ->> 'use_public_holidays')::boolean is false then
    update public.calendar_exceptions set deleted_at = now(), updated_by = auth.uid()
     where project_id = v_project and deleted_at is null and holiday_decision_id in
       (select id from public.holiday_decisions where project_id = v_project);
    delete from public.holiday_decisions where project_id = v_project;
  end if;
  v_r := app.calendar_redate(v_project, null);
  return app.op_done(p, 'save_project_calendar', jsonb_build_object('ok', true, 'moved', v_r -> 'moved'));
end $$;

-- {id?, on_date, name, name_am?, kind?, is_tentative?, delete?: bool} (admin): add a holiday, confirm or
-- move a lunar date, or remove one. Decisions follow the holiday; affected projects re-date.
create or replace function public.save_public_holiday(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; h public.public_holidays; v_old date; d record; v_new date := (p ->> 'on_date')::date;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_role_txt('admin');
  if v_id is not null then
    select * into h from public.public_holidays where id = v_id for update;
    if not found then raise exception 'Holiday not found'; end if;
    v_old := h.on_date;
    if coalesce((p ->> 'delete')::boolean, false) then
      update public.public_holidays set deleted_at = now() where id = v_id;
      for d in select id, project_id from public.holiday_decisions where holiday_id = v_id loop
        update public.calendar_exceptions set deleted_at = now(), updated_by = auth.uid() where holiday_decision_id = d.id and deleted_at is null;
        delete from public.holiday_decisions where id = d.id;
        perform app.calendar_redate(d.project_id, array[v_old]);
      end loop;
      return app.op_done(p, 'save_public_holiday', jsonb_build_object('ok', true, 'id', v_id, 'deleted', true));
    end if;
    update public.public_holidays set on_date = coalesce(v_new, on_date), name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      name_am = coalesce(nullif(trim(p ->> 'name_am'), ''), name_am), kind = coalesce(nullif(p ->> 'kind', ''), kind),
      is_tentative = coalesce((p ->> 'is_tentative')::boolean, false),
      confirmed_by = case when coalesce((p ->> 'is_tentative')::boolean, false) then confirmed_by else auth.uid() end,
      confirmed_at = case when coalesce((p ->> 'is_tentative')::boolean, false) then confirmed_at else now() end
    where id = v_id;
  else
    if v_new is null or nullif(trim(p ->> 'name'), '') is null then raise exception 'Enter the date and the name'; end if;
    insert into public.public_holidays (country, on_date, name, name_am, kind, is_tentative, source, confirmed_by, confirmed_at)
    values (coalesce(nullif(p ->> 'country', ''), 'ET'), v_new, trim(p ->> 'name'), nullif(trim(p ->> 'name_am'), ''),
      coalesce(nullif(p ->> 'kind', ''), 'other'), coalesce((p ->> 'is_tentative')::boolean, false), 'manual',
      case when coalesce((p ->> 'is_tentative')::boolean, false) then null else auth.uid() end,
      case when coalesce((p ->> 'is_tentative')::boolean, false) then null else now() end)
    returning id into v_id;
  end if;
  perform app.ensure_holiday_decisions(null);
  select * into h from public.public_holidays where id = v_id;
  for d in select id, project_id from public.holiday_decisions where holiday_id = v_id loop
    perform app.apply_holiday_decision(d.id);
    perform app.calendar_redate(d.project_id, array_remove(array[v_old, h.on_date], null));
  end loop;
  return app.op_done(p, 'save_public_holiday', jsonb_build_object('ok', true, 'id', v_id, 'on_date', h.on_date));
end $$;

-- {from_year, to_year} (admin): add the holidays of more years.
create or replace function public.generate_public_holidays(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform app.require_role_txt('admin');
  return jsonb_build_object('ok', true, 'added', app.generate_et_holidays((p ->> 'from_year')::int, (p ->> 'to_year')::int));
end $$;

-- ---------------------------------------------------------------------------
-- Approvals inbox: holidays within 30 days that still need a decision.
-- ---------------------------------------------------------------------------
create or replace function app.calendar_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_today date := app.eat_date(now());
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null or v_role not in ('manager','admin','coordinator','office_engineer') then return; end if;
  return query
  select 'holiday'::text, 'holiday_decision'::text, hd.id, hd.project_id, to_char(hd.on_date, 'DD Mon YYYY'),
         case when v_role in ('manager','admin') then 'Decide: work on ' else 'Propose: work on ' end || h.name || '?'
           || case when hd.proposed_choice is not null then ' (proposed: ' || replace(hd.proposed_choice, '_', ' ') || ')' else '' end,
         hd.status, hd.proposed_by, coalesce(hd.proposed_at, (hd.on_date - 30)::timestamptz), hd.on_date - v_today <= 7,
         case when v_role in ('manager','admin') then array['work','half_day','no_work'] else array['propose'] end,
         round((extract(epoch from now() - coalesce(hd.proposed_at, (hd.on_date - 30)::timestamptz)) / 3600)::numeric, 1)
  from public.holiday_decisions hd
  join public.public_holidays h on h.id = hd.holiday_id
  where hd.on_date between v_today and v_today + 30
    and (v_role = 'admin' or exists (select 1 from public.project_members m where m.project_id = hd.project_id and m.user_id = p_user))
    and ((v_role in ('manager','admin') and hd.status in ('pending','proposed'))
      or (v_role in ('coordinator','office_engineer') and hd.status = 'pending'));
end $$;
revoke execute on function app.calendar_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.calendar_approvals_for') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Data: holidays 2026–2035, decision rows, daily reminders (pg_cron when the project has it)
-- ---------------------------------------------------------------------------
update public.public_holidays set source = 'seed' where source is null;

-- Proclamation 1334/2024 (effective 14 Aug 2024) replaced the former list and does not make 28 May a day off.
-- Retire seeded/generated Derg rows, remove their decisions and re-date schedules that used the old calendar.
do $$
declare d record;
begin
  for d in select pc.project_id, h.id as holiday_id, h.on_date
           from public.public_holidays h join public.project_calendars pc on pc.holiday_country = h.country
           where h.country = 'ET' and h.name = 'Downfall of the Derg' and h.on_date >= '2024-08-14' and h.deleted_at is null
             and pc.is_default and pc.deleted_at is null and pc.use_public_holidays loop
    update public.public_holidays set deleted_at = now() where id = d.holiday_id;
    update public.calendar_exceptions set deleted_at = now()
     where project_id = d.project_id and deleted_at is null and holiday_decision_id in
       (select id from public.holiday_decisions where project_id = d.project_id and holiday_id = d.holiday_id);
    delete from public.holiday_decisions where project_id = d.project_id and holiday_id = d.holiday_id;
    perform app.calendar_redate(d.project_id, array[d.on_date]);
  end loop;
  -- Also retire rows on a fresh installation, before any project has been created.
  update public.public_holidays set deleted_at = now()
   where country = 'ET' and name = 'Downfall of the Derg' and on_date >= '2024-08-14' and deleted_at is null;
end $$;

select app.generate_et_holidays(2026, 2035);
select app.ensure_holiday_decisions(null);

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $c$select cron.schedule('sm-holiday-reminders', '0 4 * * *', 'select app.calendar_holiday_reminders()')$c$;
  end if;
exception when others then
  raise notice 'Holiday reminders not scheduled (%): they still run when the calendar page opens', sqlerrm;
end $$;
