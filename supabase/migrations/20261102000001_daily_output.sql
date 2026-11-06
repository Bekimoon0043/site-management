-- =============================================================================
-- Daily output: a site engineer picks a schedule task and records what was done that day — quantity (units
-- tasks) or percent / status (other EV methods), manpower, equipment, delay cause and remarks.
-- One entry =
--   * a task progress report (task_progress, cumulative to date → EVM / verification), and
--   * a line in that day's site diary (diary_activities); the diary is opened as a draft when missing.
-- Safe to run again (if not exists / drop if exists).
-- Quantities are entered as TODAY's output; the to-date figure is the task's latest reported (or verified)
-- quantity plus today's.
-- =============================================================================

create table if not exists public.diary_activities (
  id                uuid primary key,
  diary_id          uuid not null references public.site_diaries (id),
  project_id        uuid not null references public.projects (id),
  task_id           uuid not null references public.schedule_tasks (id),
  task_progress_id  uuid references public.task_progress (id),
  activity_date     date not null,
  method            text not null,
  -- units tasks: [{boq_item_id, item_no, unit, qty_today, qty_to_date}]
  output            jsonb not null default '[]'::jsonb,
  pct_to_date       numeric(5,2),
  headcount         int check (headcount >= 0),
  labour_hours      numeric(6,1) check (labour_hours >= 0),
  equipment         text,
  delay_cause       text,
  remarks           text,
  after_signoff     boolean not null default false,  -- added after the diary was signed (also written as an addendum)
  created_by        uuid not null references public.profiles (id),
  device_id         uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index if not exists diary_activities_diary_idx on public.diary_activities (diary_id);
create index if not exists diary_activities_day_idx on public.diary_activities (project_id, activity_date);
create index if not exists diary_activities_task_idx on public.diary_activities (task_id);
create index if not exists diary_activities_updated_at_idx on public.diary_activities (updated_at);
drop trigger if exists touch_updated_at on public.diary_activities;
create trigger touch_updated_at before update on public.diary_activities
  for each row execute function app.touch_updated_at();
drop trigger if exists audit on public.diary_activities;
create trigger audit after insert or update or delete on public.diary_activities
  for each row execute function app.audit();
drop trigger if exists no_delete on public.diary_activities;
create trigger no_delete before delete on public.diary_activities
  for each row execute function app.block_mutation();
alter table public.diary_activities enable row level security;
drop policy if exists member_read on public.diary_activities;
create policy member_read on public.diary_activities for select to authenticated using (app.is_member(project_id));

create or replace function public.report_daily_output(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p);
  v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid());
  v_tp uuid := gen_random_uuid();
  v_today date := app.eat_date(now());
  v_date date := coalesce((p ->> 'date')::date, v_today);
  v_block uuid := nullif(p ->> 'block_id', '')::uuid;
  v_remarks text := nullif(trim(p ->> 'remarks'), '');
  t public.schedule_tasks;
  d public.site_diaries;
  x record;
  v_inner jsonb;
  v_qty jsonb := '[]'::jsonb;
  v_out jsonb := '[]'::jsonb;
  v_sum numeric := 0;
  v_res jsonb;
  v_text text;
begin
  if v_seen is not null then return v_seen; end if;
  select * into t from public.schedule_tasks where id = (p ->> 'task_id')::uuid;
  if not found then raise exception 'Choose an activity from the schedule'; end if;
  perform app.require_member(t.project_id);
  perform app.require_role('site_engineer','office_engineer','coordinator','manager','admin');
  if v_date > v_today then raise exception 'Daily output cannot be dated in the future (%)', v_date; end if;
  if v_block is not null and not exists (select 1 from public.blocks where id = v_block and project_id = t.project_id) then
    raise exception 'Block does not belong to this project';
  end if;
  if (p ->> 'headcount')::numeric < 0 or (p ->> 'labour_hours')::numeric < 0 then raise exception 'Manpower cannot be negative'; end if;

  v_inner := jsonb_build_object('id', v_tp, 'task_id', t.id, 'status_date', v_date)
    || jsonb_strip_nulls(jsonb_build_object(
         'actual_start', nullif(p ->> 'actual_start', ''), 'actual_finish', nullif(p ->> 'actual_finish', ''),
         'remaining_days', p -> 'remaining_days', 'delay_cause', nullif(p ->> 'delay_cause', ''), 'remarks', v_remarks));

  if t.ev_method = 'units' then
    -- every linked item is sent (unchanged ones keep their to-date) so the task percent is computed on all of them
    for x in
      select l.boq_item_id, b.item_no, b.unit, greatest(l.reported_qty, l.verified_qty) as cur,
             coalesce((select (o ->> 'qty_today')::numeric from jsonb_array_elements(coalesce(p -> 'output', '[]'::jsonb)) o
                        where (o ->> 'boq_item_id')::uuid = l.boq_item_id limit 1), 0) as today
        from public.task_boq_links l join public.boq_items b on b.id = l.boq_item_id
       where l.task_id = t.id and l.deleted_at is null
       order by b.item_no
    loop
      if x.today < 0 then raise exception 'Today''s quantity for % cannot be negative', x.item_no; end if;
      v_sum := v_sum + x.today;
      v_qty := v_qty || jsonb_build_object('boq_item_id', x.boq_item_id, 'qty_to_date', x.cur + x.today);
      if x.today > 0 then
        v_out := v_out || jsonb_build_object('boq_item_id', x.boq_item_id, 'item_no', x.item_no, 'unit', x.unit,
                                             'qty_today', x.today, 'qty_to_date', x.cur + x.today);
      end if;
    end loop;
    if jsonb_array_length(v_qty) = 0 then
      raise exception 'Activity "%" has no BoQ items linked — ask the office engineer to create or link the BoQ', t.name;
    end if;
    if v_sum = 0 and nullif(p ->> 'actual_finish', '') is null then raise exception 'Enter the quantity done today'; end if;
    v_inner := v_inner || jsonb_build_object('qty', v_qty);
  elsif t.ev_method = 'steps' then
    v_inner := v_inner || jsonb_build_object('steps', p -> 'steps');
  else
    v_inner := v_inner || jsonb_build_object('pct_complete', p -> 'pct_complete');
  end if;

  v_res := public.report_task_progress(v_inner);

  select * into d from public.site_diaries
   where project_id = t.project_id and block_id is not distinct from v_block and diary_date = v_date;
  if not found then
    if nullif(p ->> 'diary_number', '') is null then raise exception 'diary_number is required to open the site diary for %', v_date; end if;
    insert into public.site_diaries (id, project_id, number, diary_date, block_id, created_by, device_id)
    values (gen_random_uuid(), t.project_id, p ->> 'diary_number', v_date, v_block, auth.uid(), app.device_id())
    on conflict do nothing;
    select * into d from public.site_diaries
     where project_id = t.project_id and block_id is not distinct from v_block and diary_date = v_date;
    if not found then raise exception 'Could not open the site diary for % — try again', v_date; end if;
  end if;

  insert into public.diary_activities (id, diary_id, project_id, task_id, task_progress_id, activity_date, method, output,
    pct_to_date, headcount, labour_hours, equipment, delay_cause, remarks, after_signoff, created_by, device_id)
  values (v_id, d.id, t.project_id, t.id, v_tp, v_date, t.ev_method, v_out, (v_res ->> 'pct_complete')::numeric,
    (p ->> 'headcount')::int, (p ->> 'labour_hours')::numeric, nullif(trim(p ->> 'equipment'), ''),
    nullif(p ->> 'delay_cause', ''), v_remarks, d.status = 'signed', auth.uid(), app.device_id());

  if d.status = 'signed' then
    select string_agg((o ->> 'qty_today') || ' ' || (o ->> 'unit'), ', ') into v_text from jsonb_array_elements(v_out) o;
    insert into public.diary_addenda (id, diary_id, project_id, text, created_by)
    values (gen_random_uuid(), d.id, t.project_id,
      'Daily output added after sign-off: ' || coalesce(t.wbs || ' ', '') || t.name || ' — '
        || coalesce(v_text, round((v_res ->> 'pct_complete')::numeric, 1) || '%') || coalesce(' (' || v_remarks || ')', ''),
      auth.uid());
  end if;

  return app.op_done(p, 'report_daily_output', jsonb_build_object('ok', true, 'id', v_id, 'task_progress_id', v_tp,
    'diary_id', d.id, 'diary_number', d.number, 'diary_status', d.status, 'status_date', v_res -> 'status_date',
    'pct_complete', v_res -> 'pct_complete', 'output', v_out, 'rolled_to_next_period', v_res -> 'rolled_to_next_period'));
end $$;
