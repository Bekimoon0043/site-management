-- =============================================================================
-- Site operations for site engineers / foremen (and the people who answer them):
--
-- * hse_incidents      Injuries, near misses, property damage, environmental, dangerous occurrences: reported by anyone
--                      on the project → investigated (root cause, corrective action, owner, due) → closed. Lost-time,
--                      serious and fatal cases must record the labour-inspection notification before closing
--                      (Labour Proclamation 1156/2019: employment accidents are registered and notified).
-- * toolbox_talks      Daily briefing: topic, hazards, attendance, PPE check.
-- * work_permits       Permits to work (hot work, height, excavation, confined space, lifting, electrical): requested
--                      on site with a precaution checklist → approved by coordinator / manager (not the requester, all
--                      precautions in place) → closed when the work ends. Approved past valid_to = expired.
-- * plant_items /      Plant & equipment register (owned / hired) and a daily log per machine: meter readings, hours
--   plant_logs         worked / idle / breakdown, fuel, operator. Meter readings may not go backwards; a breakdown
--                      puts the machine under repair and alerts the coordinator.
--
-- RFIs / site instructions live in the contract-administration register (20261105000040, save_rfi).
-- Writes only through the RPCs below (idempotent op_id). Read: project members. Inbox: app.approval_sources.
-- Photos attach through public.attachments (entity_type 'hse_incident' | 'toolbox_talk' | 'work_permit' |
-- 'plant_log'). Re-runnable.
-- =============================================================================

create table if not exists public.hse_incidents (
  id                     uuid primary key,
  project_id             uuid not null references public.projects (id),
  number                 text not null,
  kind                   text not null check (kind in ('injury','near_miss','property_damage','environmental','dangerous_occurrence')),
  severity               text not null default 'minor' check (severity in ('minor','moderate','serious','fatal')),
  occurred_at            timestamptz not null,
  location_text          text,
  element_id             uuid references public.elements (id),
  description            text not null,
  immediate_action       text,
  injured_name           text,
  injured_trade          text,
  injured_party          text check (injured_party in ('own','subcontractor','visitor','public')),
  body_part              text,
  first_aid              boolean not null default false,
  hospital               boolean not null default false,
  lost_time              boolean not null default false,
  days_lost              int not null default 0 check (days_lost >= 0),
  root_cause             text,
  corrective_action      text,
  action_owner           uuid references public.profiles (id),
  action_due             date,
  reported_to_authority  boolean not null default false,
  authority_ref          text,
  status                 text not null default 'reported' check (status in ('reported','action','closed')),
  close_note             text,
  reported_by            uuid not null references public.profiles (id),
  investigated_by        uuid references public.profiles (id),
  investigated_at        timestamptz,
  closed_by              uuid references public.profiles (id),
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.toolbox_talks (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null,
  held_on          date not null,
  topic            text not null,
  hazards          text,
  presenter_name   text,
  attendees_count  int not null check (attendees_count > 0),
  attendee_names   text,
  trades           text[] not null default '{}',
  duration_min     int check (duration_min > 0),
  ppe_checked      boolean not null default false,
  ppe_issues       text,
  notes            text,
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.work_permits (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null,
  permit_type      text not null check (permit_type in ('hot_work','work_at_height','excavation','confined_space','lifting','electrical','other')),
  description      text not null,
  location_text    text,
  element_id       uuid references public.elements (id),
  valid_from       timestamptz not null,
  valid_to         timestamptz not null,
  crew_size        int check (crew_size > 0),
  supervisor_name  text,
  precautions      jsonb not null default '[]'::jsonb,       -- [{text, done}]
  status           text not null default 'requested' check (status in ('requested','approved','rejected','closed','cancelled')),
  decision_comment text,
  requested_by     uuid not null references public.profiles (id),
  approved_by      uuid references public.profiles (id),
  approved_at      timestamptz,
  closed_by        uuid references public.profiles (id),
  closed_at        timestamptz,
  close_note       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, number),
  check (valid_to > valid_from)
);

create table if not exists public.plant_items (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  code         text not null,
  name         text not null,
  category     text not null default 'other' check (category in ('excavator','loader','crane','mixer','vibrator','generator',
                 'truck','pump','compactor','other')),
  ownership    text not null default 'owned' check (ownership in ('owned','hired')),
  supplier     text,
  plate_no     text,
  meter_unit   text not null default 'hours' check (meter_unit in ('hours','km','none')),
  last_meter   numeric(12,1),
  status       text not null default 'active' check (status in ('active','under_repair','off_hire')),
  on_site_from date,
  notes        text,
  created_by   uuid references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, code)
);

create table if not exists public.plant_logs (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  plant_id         uuid not null references public.plant_items (id),
  log_date         date not null,
  operator_name    text,
  meter_start      numeric(12,1),
  meter_end        numeric(12,1),
  hours_worked     numeric(5,1) not null default 0 check (hours_worked >= 0),
  hours_idle       numeric(5,1) not null default 0 check (hours_idle >= 0),
  hours_breakdown  numeric(5,1) not null default 0 check (hours_breakdown >= 0),
  fuel_litres      numeric(8,1) not null default 0 check (fuel_litres >= 0),
  status           text not null default 'working' check (status in ('working','idle','breakdown')),
  idle_reason      text,
  breakdown_note   text,
  work_done        text,
  element_id       uuid references public.elements (id),
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (plant_id, log_date),
  check (hours_worked + hours_idle + hours_breakdown <= 24)
);

create index if not exists hse_incidents_project_idx on public.hse_incidents (project_id, status);
create index if not exists toolbox_talks_project_idx on public.toolbox_talks (project_id, held_on);
create index if not exists work_permits_project_idx on public.work_permits (project_id, status);
create index if not exists plant_logs_plant_idx on public.plant_logs (plant_id, log_date);

do $$
declare t text;
begin
  foreach t in array array['hse_incidents','toolbox_talks','work_permits','plant_items','plant_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
-- Document number: the client's (device numbering, offline) or <project code>-<prefix>-0001.
create or replace function app.site_doc_no(p_project uuid, p_prefix text, p_table text, p_given text) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if nullif(trim(p_given), '') is not null then return trim(p_given); end if;
  execute format('select count(*) from public.%I where project_id = $1', p_table) into n using p_project;
  return (select code from public.projects where id = p_project) || '-' || p_prefix || '-' || lpad((n + 1)::text, 4, '0');
end $$;
revoke execute on function app.site_doc_no(uuid, text, text, text) from public;

create or replace function app.site_guard(p_project uuid, variadic p_roles text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_member(p_project);
  perform app.require_role_txt(variadic p_roles);
end $$;
revoke execute on function app.site_guard(uuid, text[]) from public;

-- ---------------------------------------------------------------------------
-- HSE: incidents
-- ---------------------------------------------------------------------------
-- {id, project_id, number?, kind, severity?, occurred_at, location_text?, element_id?, description, immediate_action?,
--  injured_name?, injured_trade?, injured_party?, body_part?, first_aid?, hospital?, lost_time?, days_lost?}
create or replace function public.report_incident(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; v_project uuid := (p ->> 'project_id')::uuid;
  i public.hse_incidents; v_no text; v_crit boolean; v_new boolean;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  if nullif(trim(p ->> 'description'), '') is null then raise exception 'Describe what happened'; end if;
  if (p ->> 'occurred_at') is null then raise exception 'Enter when it happened'; end if;
  if (p ->> 'occurred_at')::timestamptz > now() + interval '10 minutes' then raise exception 'The time it happened is in the future'; end if;
  if (p ->> 'kind') = 'injury' and nullif(trim(p ->> 'injured_name'), '') is null then raise exception 'Enter the name of the injured person'; end if;
  select * into i from public.hse_incidents where id = v_id for update;
  if found then
    if i.project_id <> v_project then raise exception 'Incident belongs to another project'; end if;
    if i.status <> 'reported' then raise exception 'Incident % is under investigation — add details there', i.number; end if;
    if i.reported_by <> auth.uid() and not app.has_role_txt('coordinator', 'manager', 'admin') then
      raise exception 'Only the reporter can edit this report' using errcode = '42501';
    end if;
  end if;
  v_no := coalesce(i.number, app.site_doc_no(v_project, 'INC', 'hse_incidents', p ->> 'number'));
  insert into public.hse_incidents (id, project_id, number, kind, severity, occurred_at, location_text, element_id, description, immediate_action,
    injured_name, injured_trade, injured_party, body_part, first_aid, hospital, lost_time, days_lost, reported_by)
  values (v_id, v_project, v_no, p ->> 'kind', coalesce(nullif(p ->> 'severity', ''), 'minor'), (p ->> 'occurred_at')::timestamptz,
    nullif(p ->> 'location_text', ''), (p ->> 'element_id')::uuid, trim(p ->> 'description'), nullif(p ->> 'immediate_action', ''),
    nullif(p ->> 'injured_name', ''), nullif(p ->> 'injured_trade', ''), nullif(p ->> 'injured_party', ''), nullif(p ->> 'body_part', ''),
    coalesce((p ->> 'first_aid')::boolean, false), coalesce((p ->> 'hospital')::boolean, false), coalesce((p ->> 'lost_time')::boolean, false),
    coalesce((p ->> 'days_lost')::int, 0), auth.uid())
  on conflict (id) do update set kind = excluded.kind, severity = excluded.severity, occurred_at = excluded.occurred_at,
    location_text = excluded.location_text, element_id = excluded.element_id, description = excluded.description,
    immediate_action = excluded.immediate_action, injured_name = excluded.injured_name, injured_trade = excluded.injured_trade,
    injured_party = excluded.injured_party, body_part = excluded.body_part, first_aid = excluded.first_aid, hospital = excluded.hospital,
    lost_time = excluded.lost_time, days_lost = excluded.days_lost;
  v_new := i.id is null;
  select * into i from public.hse_incidents where id = v_id;
  v_crit := i.severity in ('serious','fatal') or i.lost_time or i.hospital;
  if v_new then
    perform app.notify_roles_txt(v_project, '{coordinator,manager}',
      (case i.kind when 'near_miss' then 'Near miss ' else 'Incident ' end) || i.number || ' reported',
      left(i.description, 200), 'hse_incident', v_id, v_crit);
  end if;
  return app.op_done(p, 'report_incident', jsonb_build_object('ok', true, 'id', v_id, 'number', i.number, 'status', i.status));
end $$;

-- {incident_id, action: investigate | close, root_cause?, corrective_action?, action_owner?, action_due?,
--  reported_to_authority?, authority_ref?, close_note?, days_lost?, lost_time?}
create or replace function public.incident_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); i public.hse_incidents; a text := p ->> 'action';
begin
  if v_seen is not null then return v_seen; end if;
  select * into i from public.hse_incidents where id = (p ->> 'incident_id')::uuid for update;
  if not found then raise exception 'Incident not found'; end if;
  perform app.site_guard(i.project_id, 'coordinator', 'manager', 'admin');
  update public.hse_incidents set
    reported_to_authority = coalesce((p ->> 'reported_to_authority')::boolean, reported_to_authority),
    authority_ref = coalesce(nullif(p ->> 'authority_ref', ''), authority_ref),
    days_lost = coalesce((p ->> 'days_lost')::int, days_lost), lost_time = coalesce((p ->> 'lost_time')::boolean, lost_time)
  where id = i.id;
  if a = 'investigate' then
    if i.status = 'closed' then raise exception 'Incident % is closed', i.number; end if;
    if nullif(trim(p ->> 'root_cause'), '') is null or nullif(trim(p ->> 'corrective_action'), '') is null then
      raise exception 'Enter the root cause and the corrective action';
    end if;
    if (p ->> 'action_owner') is not null and not exists (select 1 from public.project_members where project_id = i.project_id and user_id = (p ->> 'action_owner')::uuid) then
      raise exception 'The action owner is not on this project';
    end if;
    update public.hse_incidents set status = 'action', root_cause = trim(p ->> 'root_cause'), corrective_action = trim(p ->> 'corrective_action'),
      action_owner = (p ->> 'action_owner')::uuid, action_due = nullif(p ->> 'action_due', '')::date,
      investigated_by = auth.uid(), investigated_at = now()
    where id = i.id;
    if (p ->> 'action_owner') is not null then
      perform app.notify_user((p ->> 'action_owner')::uuid, i.project_id, 'Corrective action — ' || i.number, trim(p ->> 'corrective_action'), 'hse_incident', i.id);
    end if;
  elsif a = 'close' then
    if i.status <> 'action' then raise exception 'Investigate incident % (root cause, corrective action) before closing it', i.number; end if;
    select * into i from public.hse_incidents where id = i.id;
    if i.kind = 'injury' and (i.lost_time or i.severity in ('serious','fatal')) and not i.reported_to_authority then
      raise exception 'Lost-time, serious and fatal injuries must be notified to the labour inspection office — record the notification first';
    end if;
    update public.hse_incidents set status = 'closed', close_note = nullif(p ->> 'close_note', ''), closed_by = auth.uid(), closed_at = now()
    where id = i.id;
  elsif a is not null and a <> 'update' then
    raise exception 'Unknown action %', a;
  end if;
  select * into i from public.hse_incidents where id = i.id;
  return app.op_done(p, 'incident_action', jsonb_build_object('ok', true, 'id', i.id, 'number', i.number, 'status', i.status));
end $$;

-- ---------------------------------------------------------------------------
-- HSE: toolbox talks
-- ---------------------------------------------------------------------------
-- {id, project_id, number?, held_on, topic, hazards?, presenter_name?, attendees_count, attendee_names?, trades?,
--  duration_min?, ppe_checked?, ppe_issues?, notes?}
create or replace function public.save_toolbox_talk(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; v_project uuid := (p ->> 'project_id')::uuid;
  t public.toolbox_talks; v_no text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.site_guard(v_project, 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'topic'), '') is null then raise exception 'Enter the topic'; end if;
  if coalesce((p ->> 'attendees_count')::int, 0) <= 0 then raise exception 'Enter how many people attended'; end if;
  if (p ->> 'held_on')::date > app.local_date(now()) then raise exception 'A toolbox talk cannot be recorded for a future date'; end if;
  select * into t from public.toolbox_talks where id = v_id for update;
  if found then
    if t.project_id <> v_project then raise exception 'Toolbox talk belongs to another project'; end if;
    if t.created_by <> auth.uid() and not app.has_role_txt('coordinator', 'manager', 'admin') then
      raise exception 'Only the person who recorded it can edit this toolbox talk' using errcode = '42501';
    end if;
  end if;
  v_no := coalesce(t.number, app.site_doc_no(v_project, 'TBT', 'toolbox_talks', p ->> 'number'));
  insert into public.toolbox_talks (id, project_id, number, held_on, topic, hazards, presenter_name, attendees_count, attendee_names, trades,
    duration_min, ppe_checked, ppe_issues, notes, created_by)
  values (v_id, v_project, v_no, (p ->> 'held_on')::date, trim(p ->> 'topic'), nullif(p ->> 'hazards', ''), nullif(p ->> 'presenter_name', ''),
    (p ->> 'attendees_count')::int, nullif(p ->> 'attendee_names', ''),
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p -> 'trades', '[]'::jsonb)) x), '{}'),
    (p ->> 'duration_min')::int, coalesce((p ->> 'ppe_checked')::boolean, false), nullif(p ->> 'ppe_issues', ''), nullif(p ->> 'notes', ''), auth.uid())
  on conflict (id) do update set held_on = excluded.held_on, topic = excluded.topic, hazards = excluded.hazards,
    presenter_name = excluded.presenter_name, attendees_count = excluded.attendees_count, attendee_names = excluded.attendee_names,
    trades = excluded.trades, duration_min = excluded.duration_min, ppe_checked = excluded.ppe_checked, ppe_issues = excluded.ppe_issues,
    notes = excluded.notes;
  return app.op_done(p, 'save_toolbox_talk', jsonb_build_object('ok', true, 'id', v_id, 'number', v_no));
end $$;

-- ---------------------------------------------------------------------------
-- HSE: permits to work
-- ---------------------------------------------------------------------------
-- {id, project_id, number?, permit_type, description, location_text?, element_id?, valid_from, valid_to, crew_size?,
--  supervisor_name?, precautions: [{text, done}]}
create or replace function public.request_permit(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; v_project uuid := (p ->> 'project_id')::uuid;
  w public.work_permits; v_no text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.site_guard(v_project, 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'description'), '') is null then raise exception 'Describe the work'; end if;
  if (p ->> 'valid_from') is null or (p ->> 'valid_to') is null then raise exception 'Enter when the permit starts and ends'; end if;
  if (p ->> 'valid_to')::timestamptz <= (p ->> 'valid_from')::timestamptz then raise exception 'The permit must end after it starts'; end if;
  if (p ->> 'valid_to')::timestamptz - (p ->> 'valid_from')::timestamptz > interval '7 days' then
    raise exception 'A permit is valid for at most 7 days — request a new one for longer work';
  end if;
  if jsonb_typeof(coalesce(p -> 'precautions', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'precautions', '[]'::jsonb)) = 0 then
    raise exception 'List the precautions';
  end if;
  select * into w from public.work_permits where id = v_id for update;
  if found then
    if w.project_id <> v_project then raise exception 'Permit belongs to another project'; end if;
    if w.status <> 'requested' then raise exception 'Permit % is % and cannot be edited', w.number, w.status; end if;
    if w.requested_by <> auth.uid() and not app.has_role_txt('coordinator', 'manager', 'admin') then
      raise exception 'Only the requester can edit this permit' using errcode = '42501';
    end if;
  end if;
  v_no := coalesce(w.number, app.site_doc_no(v_project, 'PTW', 'work_permits', p ->> 'number'));
  insert into public.work_permits (id, project_id, number, permit_type, description, location_text, element_id, valid_from, valid_to,
    crew_size, supervisor_name, precautions, requested_by)
  values (v_id, v_project, v_no, p ->> 'permit_type', trim(p ->> 'description'), nullif(p ->> 'location_text', ''), (p ->> 'element_id')::uuid,
    (p ->> 'valid_from')::timestamptz, (p ->> 'valid_to')::timestamptz, (p ->> 'crew_size')::int, nullif(p ->> 'supervisor_name', ''),
    p -> 'precautions', auth.uid())
  on conflict (id) do update set permit_type = excluded.permit_type, description = excluded.description, location_text = excluded.location_text,
    element_id = excluded.element_id, valid_from = excluded.valid_from, valid_to = excluded.valid_to, crew_size = excluded.crew_size,
    supervisor_name = excluded.supervisor_name, precautions = excluded.precautions;
  if w.id is null then
    perform app.notify_roles_txt(v_project, '{coordinator,manager}', 'Permit to work ' || v_no || ' to approve',
      replace(p ->> 'permit_type', '_', ' ') || ': ' || left(trim(p ->> 'description'), 150), 'work_permit', v_id);
  end if;
  return app.op_done(p, 'request_permit', jsonb_build_object('ok', true, 'id', v_id, 'number', v_no, 'status', 'requested'));
end $$;

-- {permit_id, action: approve | reject | close | cancel, precautions?, comment?}
create or replace function public.permit_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); w public.work_permits; a text := p ->> 'action'; c text := nullif(trim(p ->> 'comment'), '');
begin
  if v_seen is not null then return v_seen; end if;
  select * into w from public.work_permits where id = (p ->> 'permit_id')::uuid for update;
  if not found then raise exception 'Permit not found'; end if;
  if a in ('approve','reject') then
    perform app.site_guard(w.project_id, 'coordinator', 'manager', 'admin');
    if w.status <> 'requested' then raise exception 'Permit % is % — only a requested permit can be %', w.number, w.status, a || 'd'; end if;
    if w.requested_by = auth.uid() and not app.has_role_txt('admin') then
      raise exception 'You cannot approve your own permit' using errcode = '42501';
    end if;
    if a = 'reject' then
      if c is null then raise exception 'Say why the permit is rejected'; end if;
      update public.work_permits set status = 'rejected', decision_comment = c, approved_by = auth.uid(), approved_at = now() where id = w.id;
      perform app.notify_user(w.requested_by, w.project_id, 'Permit ' || w.number || ' rejected', c, 'work_permit', w.id);
    else
      if p ? 'precautions' then update public.work_permits set precautions = p -> 'precautions' where id = w.id; end if;
      if exists (select 1 from public.work_permits x, jsonb_array_elements(x.precautions) e
                 where x.id = w.id and coalesce((e ->> 'done')::boolean, false) = false) then
        raise exception 'Not all precautions are in place — tick each one after checking it on site';
      end if;
      if w.valid_to <= now() then raise exception 'The permit period has already ended — ask for new dates'; end if;
      update public.work_permits set status = 'approved', decision_comment = c, approved_by = auth.uid(), approved_at = now() where id = w.id;
      perform app.notify_user(w.requested_by, w.project_id, 'Permit ' || w.number || ' approved', 'Work may start', 'work_permit', w.id);
    end if;
  elsif a = 'close' then
    perform app.require_member(w.project_id);
    if w.requested_by <> auth.uid() and not app.has_role_txt('site_engineer', 'coordinator', 'manager', 'admin') then
      raise exception 'Only the site team can close a permit' using errcode = '42501';
    end if;
    if w.status <> 'approved' then raise exception 'Only an approved permit can be closed'; end if;
    update public.work_permits set status = 'closed', close_note = c, closed_by = auth.uid(), closed_at = now() where id = w.id;
  elsif a = 'cancel' then
    perform app.require_member(w.project_id);
    if w.requested_by <> auth.uid() and not app.has_role_txt('coordinator', 'manager', 'admin') then
      raise exception 'Only the requester can cancel this permit' using errcode = '42501';
    end if;
    if w.status <> 'requested' then raise exception 'Only a requested permit can be cancelled'; end if;
    update public.work_permits set status = 'cancelled', decision_comment = c where id = w.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  select * into w from public.work_permits where id = w.id;
  return app.op_done(p, 'permit_action', jsonb_build_object('ok', true, 'id', w.id, 'number', w.number, 'status', w.status));
end $$;

-- ---------------------------------------------------------------------------
-- Plant & equipment
-- ---------------------------------------------------------------------------
-- {id, project_id, code, name, category?, ownership?, supplier?, plate_no?, meter_unit?, last_meter?, status?, on_site_from?, notes?}
create or replace function public.save_plant(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; v_project uuid := (p ->> 'project_id')::uuid; x public.plant_items;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.site_guard(v_project, 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'code'), '') is null or nullif(trim(p ->> 'name'), '') is null then raise exception 'Enter the plant code and name'; end if;
  select * into x from public.plant_items where id = v_id;
  if found and x.project_id <> v_project then raise exception 'Plant belongs to another project'; end if;
  if exists (select 1 from public.plant_items where project_id = v_project and code = trim(p ->> 'code') and id <> v_id) then
    raise exception 'Plant code % is already used', trim(p ->> 'code');
  end if;
  insert into public.plant_items (id, project_id, code, name, category, ownership, supplier, plate_no, meter_unit, last_meter, status, on_site_from, notes, created_by)
  values (v_id, v_project, trim(p ->> 'code'), trim(p ->> 'name'), coalesce(nullif(p ->> 'category', ''), 'other'),
    coalesce(nullif(p ->> 'ownership', ''), 'owned'), nullif(p ->> 'supplier', ''), nullif(p ->> 'plate_no', ''),
    coalesce(nullif(p ->> 'meter_unit', ''), 'hours'), (p ->> 'last_meter')::numeric, coalesce(nullif(p ->> 'status', ''), 'active'),
    nullif(p ->> 'on_site_from', '')::date, nullif(p ->> 'notes', ''), auth.uid())
  on conflict (id) do update set code = excluded.code, name = excluded.name, category = excluded.category, ownership = excluded.ownership,
    supplier = excluded.supplier, plate_no = excluded.plate_no, meter_unit = excluded.meter_unit,
    last_meter = coalesce(excluded.last_meter, public.plant_items.last_meter), status = excluded.status,
    on_site_from = excluded.on_site_from, notes = excluded.notes;
  return app.op_done(p, 'save_plant', jsonb_build_object('ok', true, 'id', v_id));
end $$;

-- {id, plant_id, log_date, operator_name?, meter_start?, meter_end?, hours_worked?, hours_idle?, hours_breakdown?, fuel_litres?,
--  status?, idle_reason?, breakdown_note?, work_done?, element_id?}
create or replace function public.log_plant(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := (p ->> 'id')::uuid; x public.plant_items; l public.plant_logs;
  v_prev numeric; v_next numeric; v_start numeric := (p ->> 'meter_start')::numeric; v_end numeric := (p ->> 'meter_end')::numeric;
  v_worked numeric; v_status text := coalesce(nullif(p ->> 'status', ''), 'working'); v_date date := (p ->> 'log_date')::date;
begin
  if v_seen is not null then return v_seen; end if;
  select * into x from public.plant_items where id = (p ->> 'plant_id')::uuid;
  if not found then raise exception 'Plant not found'; end if;
  perform app.site_guard(x.project_id, 'site_engineer', 'store_keeper', 'office_engineer', 'coordinator', 'manager', 'admin');
  if v_date is null then raise exception 'Enter the date'; end if;
  if v_date > app.local_date(now()) then raise exception 'Cannot log a future day'; end if;
  select * into l from public.plant_logs where plant_id = x.id and log_date = v_date;
  if found and l.id <> v_id then raise exception '% is already logged for % — edit that entry', x.code, v_date; end if;
  if v_start is not null and v_end is not null and v_end < v_start then raise exception 'The closing meter reading is lower than the opening one'; end if;
  select meter_end into v_prev from public.plant_logs where plant_id = x.id and log_date < v_date and meter_end is not null order by log_date desc limit 1;
  if v_start is not null and v_prev is not null and v_start < v_prev then
    raise exception 'Opening meter % is lower than the last reading % — check the meter', v_start, v_prev;
  end if;
  select meter_start into v_next from public.plant_logs where plant_id = x.id and log_date > v_date and meter_start is not null order by log_date limit 1;
  if v_end is not null and v_next is not null and v_end > v_next then
    raise exception 'Closing meter % is higher than the next day''s opening reading %', v_end, v_next;
  end if;
  v_worked := coalesce((p ->> 'hours_worked')::numeric, case when x.meter_unit = 'hours' and v_start is not null and v_end is not null then v_end - v_start end, 0);
  if v_status = 'breakdown' and nullif(trim(p ->> 'breakdown_note'), '') is null then raise exception 'Describe the breakdown'; end if;
  insert into public.plant_logs (id, project_id, plant_id, log_date, operator_name, meter_start, meter_end, hours_worked, hours_idle, hours_breakdown,
    fuel_litres, status, idle_reason, breakdown_note, work_done, element_id, created_by)
  values (v_id, x.project_id, x.id, v_date, nullif(p ->> 'operator_name', ''), v_start, v_end, v_worked,
    coalesce((p ->> 'hours_idle')::numeric, 0), coalesce((p ->> 'hours_breakdown')::numeric, 0), coalesce((p ->> 'fuel_litres')::numeric, 0),
    v_status, nullif(p ->> 'idle_reason', ''), nullif(p ->> 'breakdown_note', ''), nullif(p ->> 'work_done', ''), (p ->> 'element_id')::uuid, auth.uid())
  on conflict (id) do update set log_date = excluded.log_date, operator_name = excluded.operator_name, meter_start = excluded.meter_start,
    meter_end = excluded.meter_end, hours_worked = excluded.hours_worked, hours_idle = excluded.hours_idle, hours_breakdown = excluded.hours_breakdown,
    fuel_litres = excluded.fuel_litres, status = excluded.status, idle_reason = excluded.idle_reason, breakdown_note = excluded.breakdown_note,
    work_done = excluded.work_done, element_id = excluded.element_id;
  update public.plant_items set
    last_meter = greatest(coalesce(last_meter, 0), coalesce(v_end, v_start, last_meter, 0)),
    status = case when v_status = 'breakdown' then 'under_repair' when status = 'under_repair' and v_status = 'working' then 'active' else status end
  where id = x.id;
  if v_status = 'breakdown' and (l.id is null or l.status <> 'breakdown') then
    perform app.notify_roles_txt(x.project_id, '{coordinator,manager}', x.code || ' ' || x.name || ' broke down',
      left(trim(p ->> 'breakdown_note'), 200), 'plant_log', v_id);
  end if;
  return app.op_done(p, 'log_plant', jsonb_build_object('ok', true, 'id', v_id, 'hours_worked', v_worked));
end $$;

-- Utilisation over a period: worked / (worked + idle + breakdown); fuel per working hour.
create or replace function public.plant_utilisation(p_project uuid, p_from date, p_to date)
returns table (plant_id uuid, code text, name text, category text, ownership text, status text, days_logged int, hours_worked numeric,
               hours_idle numeric, hours_breakdown numeric, fuel_litres numeric, utilisation_pct numeric, litres_per_hour numeric)
language sql stable security definer set search_path = public as $$
  select x.id, x.code, x.name, x.category, x.ownership, x.status, count(l.id)::int,
         coalesce(sum(l.hours_worked), 0), coalesce(sum(l.hours_idle), 0), coalesce(sum(l.hours_breakdown), 0), coalesce(sum(l.fuel_litres), 0),
         case when coalesce(sum(l.hours_worked + l.hours_idle + l.hours_breakdown), 0) > 0
              then round(100 * sum(l.hours_worked) / sum(l.hours_worked + l.hours_idle + l.hours_breakdown), 1) end,
         case when coalesce(sum(l.hours_worked), 0) > 0 then round(sum(l.fuel_litres) / sum(l.hours_worked), 2) end
  from public.plant_items x
  left join public.plant_logs l on l.plant_id = x.id and l.log_date between p_from and p_to
  where x.project_id = p_project and app.is_member(p_project)
  group by x.id
  order by x.code
$$;
revoke execute on function public.plant_utilisation(uuid, date, date) from public;
grant execute on function public.plant_utilisation(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Approvals inbox (kind 'site_ops')
-- ---------------------------------------------------------------------------
create or replace function app.site_ops_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_today date := app.local_date(now());
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin')
  -- incidents: investigate (management), corrective action (owner)
  select 'site_ops'::text, 'hse_incident'::text, i.id, i.project_id, i.number,
         case when i.status = 'reported' then 'Investigate ' || replace(i.kind, '_', ' ') || ' — ' else 'Corrective action — ' end || left(i.description, 80),
         i.status, i.reported_by, coalesce(i.investigated_at, i.created_at),
         i.severity in ('serious','fatal') or i.lost_time or (i.status = 'action' and i.action_due < v_today),
         array[case i.status when 'reported' then 'investigate' else 'action' end],
         round((extract(epoch from now() - coalesce(i.investigated_at, i.created_at)) / 3600)::numeric, 1)
  from public.hse_incidents i
  where i.project_id in (select pid from mem)
    and ((i.status = 'reported' and v_role in ('coordinator','manager','admin'))
      or (i.status = 'action' and (i.action_owner = p_user or (i.action_owner is null and v_role in ('coordinator','manager','admin')))))
  union all
  -- permits: approve (management, not own), close when expired (requester)
  select 'site_ops', 'work_permit', w.id, w.project_id, w.number,
         case when w.status = 'requested' then 'Approve permit to work — ' else 'Permit expired — close it: ' end
           || replace(w.permit_type, '_', ' ') || ', ' || left(w.description, 60),
         w.status, w.requested_by, case when w.status = 'requested' then w.created_at else w.valid_to end,
         w.status = 'requested' and w.valid_from <= now() + interval '2 hours',
         array[case w.status when 'requested' then 'approve' else 'close' end],
         round((extract(epoch from now() - case when w.status = 'requested' then w.created_at else w.valid_to end) / 3600)::numeric, 1)
  from public.work_permits w
  where w.project_id in (select pid from mem)
    and ((w.status = 'requested' and v_role in ('coordinator','manager','admin') and (w.requested_by <> p_user or v_role = 'admin'))
      or (w.status = 'approved' and w.valid_to < now() and w.requested_by = p_user));
end $$;
revoke execute on function app.site_ops_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.site_ops_approvals_for') on conflict do nothing;
