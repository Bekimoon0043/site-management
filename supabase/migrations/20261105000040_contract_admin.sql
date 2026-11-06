-- =============================================================================
-- Contract administration registers for the office (coordinator / planner, office engineer / QS, manager):
--
--  * contract_admin_settings  per project: RFI / SI / submittal response days, claim notice + particulars days,
--                             reminder lead time. Defaults: RFI 7 d, submittal 14 d, claim notice 28 d, particulars 42 d
--                             (FIDIC 20.1 style; check the project's GCC/SCC — Ethiopian PPA contracts vary).
--  * rfis                     RFIs (question to the consultant, ball in court, due date, answer, cost/time impact)
--                             and site instructions (SI received from the engineer/client, comply-by date), linked to
--                             a variation or an EOT claim; SIs can be registered from a site-diary instruction.
--  * project_documents /      drawing & document register with revisions; a new revision supersedes the previous one
--    document_revisions       and site roles are told which revision is current.
--  * submittals /             material approvals, shop drawings, method statements; each submission is a revision
--    submittal_revisions      answered with a review code A approved · B approved as noted · C revise & resubmit ·
--                             D rejected.
--  * meetings /               minutes with action items (owner, due date); actions can also stand alone.
--    meeting_actions
--  * risks                    risk & issue register (likelihood × impact 1–5, owner, response, review date).
--  * eot_claims               extension-of-time / delay claims: event, notice (late-notice warning), particulars,
--                             consultant decision; diary delays in the event window are the evidence
--                             (public.eot_delay_evidence); v_completion_dates = completion date + days granted.
--
-- Read: every project member (RLS app.is_member). Write: only through the RPCs below (security definer, role checks).
-- Inbox items: app.office_approvals_for (20261105000042). Re-runnable.
-- =============================================================================

create table if not exists public.contract_admin_settings (
  project_id               uuid primary key references public.projects (id) on delete cascade,
  rfi_response_days        int not null default 7 check (rfi_response_days between 1 and 90),
  si_response_days         int not null default 7 check (si_response_days between 1 and 90),
  submittal_response_days  int not null default 14 check (submittal_response_days between 1 and 90),
  claim_notice_days        int not null default 28 check (claim_notice_days between 1 and 180),
  claim_particulars_days   int not null default 42 check (claim_particulars_days between 1 and 365),
  reminder_days            int not null default 2 check (reminder_days between 0 and 30),
  updated_by               uuid references public.profiles (id),
  updated_at               timestamptz not null default now()
);

create or replace function app.ca_settings(p_project uuid) returns public.contract_admin_settings
language sql stable security definer set search_path = public as $$
  select coalesce((select s from public.contract_admin_settings s where s.project_id = p_project),
                  row(p_project, 7, 7, 14, 28, 42, 2, null, now())::public.contract_admin_settings)
$$;

-- Next register number per project: <prefix>-001 (serialised per project + prefix).
create or replace function app.ca_next_no(p_project uuid, p_table regclass, p_prefix text) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project::text || p_prefix, 0));
  execute format('select coalesce(max(nullif(regexp_replace(number, ''^.*-'', ''''), '''')::int), 0) from %s where project_id = $1 and number ~ $2', p_table)
    into n using p_project, '^' || p_prefix || '-[0-9]+$';
  return p_prefix || '-' || lpad((n + 1)::text, 3, '0');
end $$;
revoke execute on function app.ca_next_no(uuid, regclass, text) from public;

-- ---------------------------------------------------------------------------
-- tables
-- ---------------------------------------------------------------------------
create table if not exists public.eot_claims (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null,
  title             text not null,
  cause             text not null check (cause in ('variation','late_information','late_possession','client_payment','suspension',
                      'weather','force_majeure','utility','permit','other')),
  description       text,
  event_from        date not null,
  event_to          date,                                   -- null = continuing
  notice_date       date,
  notice_ref        text,
  particulars_date  date,
  days_claimed      numeric(6,1) not null default 0 check (days_claimed >= 0),
  cost_claimed      numeric(18,2) not null default 0 check (cost_claimed >= 0),
  status            text not null default 'draft' check (status in ('draft','notice_sent','submitted','granted','partly_granted','rejected','withdrawn')),
  days_granted      numeric(6,1) check (days_granted >= 0),
  cost_granted      numeric(18,2) check (cost_granted >= 0),
  decided_on        date,
  consultant_ref    text,
  decision_comment  text,
  variation_id      uuid references public.variations (id),
  created_by        uuid not null references public.profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.rfis (
  id                    uuid primary key,
  project_id            uuid not null references public.projects (id),
  kind                  text not null default 'rfi' check (kind in ('rfi','si')),
  number                text not null,
  subject               text not null,
  description           text not null,                    -- the question (RFI) / the instruction (SI)
  discipline            text check (discipline in ('architectural','structural','electrical','sanitary','mechanical','civil','general')),
  location              text,
  drawing_refs          text,
  priority              text not null default 'normal' check (priority in ('normal','urgent')),
  addressed_to          text,                             -- RFI: consultant / designer
  issued_by             text,                             -- SI: who gave the instruction
  raised_on             date not null,
  due_date              date,                             -- RFI: answer due; SI: comply by
  ball_in_court         text not null default 'consultant' check (ball_in_court in ('contractor','consultant','client')),
  status                text not null default 'open' check (status in ('open','answered','closed','void')),
  answer                text,
  answered_on           date,
  answered_by           text,
  cost_impact           text not null default 'none' check (cost_impact in ('none','tbd','yes')),
  cost_amount           numeric(18,2),
  time_impact           text not null default 'none' check (time_impact in ('none','tbd','yes')),
  time_days             numeric(6,1),
  variation_id          uuid references public.variations (id),
  eot_claim_id          uuid references public.eot_claims (id),
  diary_instruction_id  uuid references public.diary_instructions (id),
  void_reason           text,
  created_by            uuid not null references public.profiles (id),
  closed_by             uuid references public.profiles (id),
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (project_id, number)
);
create unique index if not exists rfis_diary_instruction_uq on public.rfis (diary_instruction_id) where diary_instruction_id is not null and status <> 'void';

create table if not exists public.project_documents (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  doc_no       text not null,
  title        text not null,
  discipline   text check (discipline in ('architectural','structural','electrical','sanitary','mechanical','civil','general')),
  doc_type     text not null default 'drawing' check (doc_type in ('drawing','specification','report','calculation','schedule','other')),
  current_rev  text,
  current_status text,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  unique (project_id, doc_no)
);

create table if not exists public.document_revisions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references public.project_documents (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  rev              text not null,
  rev_date         date,
  status           text not null default 'for_construction' check (status in ('for_construction','for_approval','for_information','as_built')),
  received_on      date not null,
  transmittal_ref  text,
  notes            text,
  superseded_at    timestamptz,
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (document_id, rev)
);
create index if not exists document_revisions_doc_idx on public.document_revisions (document_id);

create table if not exists public.submittals (
  id                uuid primary key,
  project_id        uuid not null references public.projects (id),
  number            text not null,
  title             text not null,
  kind              text not null default 'material' check (kind in ('material','shop_drawing','method_statement','sample','test_report','other')),
  spec_section      text,
  material_spec_id  uuid references public.material_specs (id),
  supplier          text,
  required_by       date,                                    -- approval needed by (ordering / work start)
  status            text not null default 'draft' check (status in ('draft','submitted','approved','approved_as_noted','revise_resubmit','rejected','void')),
  current_rev       int,
  notes             text,
  created_by        uuid not null references public.profiles (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.submittal_revisions (
  id               uuid primary key default gen_random_uuid(),
  submittal_id     uuid not null references public.submittals (id) on delete cascade,
  project_id       uuid not null references public.projects (id),
  rev              int not null check (rev >= 0),
  submitted_on     date not null,
  response_due     date not null,
  transmittal_ref  text,
  code             text check (code in ('A','B','C','D')),
  responded_on     date,
  reviewer         text,
  comments         text,
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (submittal_id, rev)
);
create index if not exists submittal_revisions_sub_idx on public.submittal_revisions (submittal_id);

create table if not exists public.meetings (
  id               uuid primary key,
  project_id       uuid not null references public.projects (id),
  number           text not null,
  kind             text not null default 'progress' check (kind in ('progress','coordination','client','subcontractor','safety','kickoff','other')),
  title            text not null,
  held_on          date not null,
  location         text,
  chaired_by       text,
  attendees        text,
  agenda           text,
  minutes          text,
  next_meeting_on  date,
  status           text not null default 'draft' check (status in ('draft','issued')),
  issued_at        timestamptz,
  created_by       uuid not null references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (project_id, number)
);

create table if not exists public.meeting_actions (
  id           uuid primary key,
  project_id   uuid not null references public.projects (id),
  meeting_id   uuid references public.meetings (id) on delete cascade,
  seq          int not null default 1,
  description  text not null,
  owner_id     uuid references public.profiles (id),
  owner_name   text,                                       -- outside party (consultant, client, supplier)
  due_date     date,
  status       text not null default 'open' check (status in ('open','done','cancelled')),
  done_at      timestamptz,
  done_by      uuid references public.profiles (id),
  done_note    text,
  created_by   uuid not null references public.profiles (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists meeting_actions_meeting_idx on public.meeting_actions (meeting_id);
create index if not exists meeting_actions_owner_idx on public.meeting_actions (owner_id) where status = 'open';

create table if not exists public.risks (
  id                  uuid primary key,
  project_id          uuid not null references public.projects (id),
  number              text not null,
  kind                text not null default 'risk' check (kind in ('risk','issue')),
  title               text not null,
  description         text,
  category            text not null default 'other' check (category in ('design','ground','client','finance','procurement','labour','equipment',
                        'weather','safety','regulatory','subcontractor','other')),
  likelihood          int not null default 3 check (likelihood between 1 and 5),
  impact              int not null default 3 check (impact between 1 and 5),
  score               int generated always as (likelihood * impact) stored,
  owner_id            uuid references public.profiles (id),
  response_type       text check (response_type in ('avoid','reduce','transfer','accept')),
  response            text,
  cost_exposure       numeric(18,2),
  time_exposure_days  numeric(6,1),
  review_by           date,
  status              text not null default 'open' check (status in ('open','occurred','closed')),
  closed_at           timestamptz,
  created_by          uuid not null references public.profiles (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (project_id, number)
);

do $$
declare t text;
begin
  foreach t in array array['contract_admin_settings','eot_claims','rfis','project_documents','document_revisions','submittals',
                           'submittal_revisions','meetings','meeting_actions','risks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('create policy member_read on public.%I for select to authenticated using (app.is_member(project_id))', t);
  end loop;
  foreach t in array array['eot_claims','rfis','project_documents','submittals','meetings','risks'] loop
    execute format('drop trigger if exists audit on public.%I', t);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function app.audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function app.ca_guard(p_project uuid, variadic p_roles text[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform app.require_member(p_project);
  perform app.require_role_txt(variadic p_roles);
end $$;

create or replace function public.save_contract_admin_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_project uuid := (p ->> 'project_id')::uuid; d public.contract_admin_settings;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'coordinator', 'manager', 'admin');
  d := app.ca_settings(v_project);
  insert into public.contract_admin_settings (project_id, rfi_response_days, si_response_days, submittal_response_days, claim_notice_days,
    claim_particulars_days, reminder_days, updated_by)
  values (v_project, coalesce((p ->> 'rfi_response_days')::int, d.rfi_response_days), coalesce((p ->> 'si_response_days')::int, d.si_response_days),
    coalesce((p ->> 'submittal_response_days')::int, d.submittal_response_days), coalesce((p ->> 'claim_notice_days')::int, d.claim_notice_days),
    coalesce((p ->> 'claim_particulars_days')::int, d.claim_particulars_days), coalesce((p ->> 'reminder_days')::int, d.reminder_days), auth.uid())
  on conflict (project_id) do update set rfi_response_days = excluded.rfi_response_days, si_response_days = excluded.si_response_days,
    submittal_response_days = excluded.submittal_response_days, claim_notice_days = excluded.claim_notice_days,
    claim_particulars_days = excluded.claim_particulars_days, reminder_days = excluded.reminder_days, updated_by = auth.uid();
  return app.op_done(p, 'save_contract_admin_settings', jsonb_build_object('ok', true));
end $$;

-- ---------------------------------------------------------------------------
-- RFIs & site instructions
-- ---------------------------------------------------------------------------
-- {id, project_id, kind 'rfi'|'si', subject, description, discipline?, location?, drawing_refs?, priority?, addressed_to?,
--  issued_by?, raised_on?, due_date?, cost_impact?, cost_amount?, time_impact?, time_days?, diary_instruction_id?}
create or replace function public.save_rfi(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid;
  r public.rfis; v_kind text := coalesce(nullif(p ->> 'kind', ''), 'rfi'); v_raised date; s public.contract_admin_settings; di public.diary_instructions;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'subject'), '') is null then raise exception 'Give it a subject'; end if;
  if nullif(trim(p ->> 'description'), '') is null then
    raise exception '%', case v_kind when 'si' then 'Write the instruction as given' else 'Write the question' end;
  end if;
  s := app.ca_settings(v_project);
  v_raised := coalesce(nullif(p ->> 'raised_on', '')::date, app.eat_date(now()));
  select * into r from public.rfis where id = v_id for update;
  if found then
    if r.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    if r.status in ('closed','void') then raise exception '% is % and cannot be edited', r.number, r.status; end if;
    if r.created_by <> auth.uid() and not app.has_role_txt('office_engineer', 'coordinator', 'manager', 'admin') then
      raise exception 'Only the author or the office can edit %', r.number using errcode = '42501';
    end if;
    update public.rfis set subject = trim(p ->> 'subject'), description = trim(p ->> 'description'),
      discipline = nullif(p ->> 'discipline', ''), location = nullif(p ->> 'location', ''), drawing_refs = nullif(p ->> 'drawing_refs', ''),
      priority = coalesce(nullif(p ->> 'priority', ''), priority), addressed_to = nullif(p ->> 'addressed_to', ''), issued_by = nullif(p ->> 'issued_by', ''),
      raised_on = v_raised, due_date = coalesce(nullif(p ->> 'due_date', '')::date, due_date),
      cost_impact = coalesce(nullif(p ->> 'cost_impact', ''), cost_impact), cost_amount = nullif(p ->> 'cost_amount', '')::numeric,
      time_impact = coalesce(nullif(p ->> 'time_impact', ''), time_impact), time_days = nullif(p ->> 'time_days', '')::numeric
    where id = v_id;
  else
    if v_kind not in ('rfi','si') then raise exception 'Unknown kind %', v_kind; end if;
    if (p ->> 'diary_instruction_id') is not null then
      select * into di from public.diary_instructions where id = (p ->> 'diary_instruction_id')::uuid and project_id = v_project and deleted_at is null;
      if not found then raise exception 'Diary instruction not found in this project'; end if;
    end if;
    insert into public.rfis (id, project_id, kind, number, subject, description, discipline, location, drawing_refs, priority, addressed_to, issued_by,
      raised_on, due_date, ball_in_court, cost_impact, cost_amount, time_impact, time_days, diary_instruction_id, created_by)
    values (v_id, v_project, v_kind, app.ca_next_no(v_project, 'public.rfis', upper(v_kind)), trim(p ->> 'subject'), trim(p ->> 'description'),
      nullif(p ->> 'discipline', ''), nullif(p ->> 'location', ''), nullif(p ->> 'drawing_refs', ''), coalesce(nullif(p ->> 'priority', ''), 'normal'),
      nullif(p ->> 'addressed_to', ''), coalesce(nullif(p ->> 'issued_by', ''), di.given_by), v_raised,
      coalesce(nullif(p ->> 'due_date', '')::date, v_raised + case v_kind when 'si' then s.si_response_days else s.rfi_response_days end),
      case v_kind when 'si' then 'contractor' else 'consultant' end,
      coalesce(nullif(p ->> 'cost_impact', ''), 'none'), nullif(p ->> 'cost_amount', '')::numeric,
      coalesce(nullif(p ->> 'time_impact', ''), 'none'), nullif(p ->> 'time_days', '')::numeric, di.id, auth.uid());
    select * into r from public.rfis where id = v_id;
    if v_kind = 'si' then
      perform app.notify_roles_txt(v_project, '{coordinator,office_engineer,site_engineer}', 'Site instruction ' || r.number || ' received',
        r.subject || coalesce(' — comply by ' || to_char(r.due_date, 'DD Mon'), ''), 'rfi', v_id, r.priority = 'urgent');
    else
      perform app.notify_roles_txt(v_project, '{office_engineer,coordinator}', r.number || ' raised: ' || r.subject,
        'Answer due ' || to_char(r.due_date, 'DD Mon YYYY'), 'rfi', v_id, r.priority = 'urgent');
    end if;
  end if;
  if (select (cost_impact = 'yes' and cost_amount is null) or (time_impact = 'yes' and time_days is null) from public.rfis where id = v_id) then
    raise exception 'Enter the cost amount / days when the impact is "yes" (use "to be determined" if not known yet)';
  end if;
  select * into r from public.rfis where id = v_id;
  return app.op_done(p, 'save_rfi', jsonb_build_object('ok', true, 'id', v_id, 'number', r.number, 'status', r.status, 'due_date', r.due_date));
end $$;

-- {rfi_id, action: 'answer' (answer, answered_on?, answered_by?, cost_impact?, cost_amount?, time_impact?, time_days?) |
--  'close' | 'reopen' | 'void' (comment) | 'link' (variation_id? , eot_claim_id?) | 'ball' (ball_in_court)}
create or replace function public.decide_rfi(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); r public.rfis; a text := p ->> 'action'; c text := nullif(trim(p ->> 'comment'), '');
begin
  if v_seen is not null then return v_seen; end if;
  select * into r from public.rfis where id = (p ->> 'rfi_id')::uuid for update;
  if not found then raise exception 'RFI / instruction not found'; end if;
  perform app.ca_guard(r.project_id, 'office_engineer', 'coordinator', 'manager', 'admin');
  if a = 'answer' then
    if r.status not in ('open','answered') then raise exception '% is %', r.number, r.status; end if;
    if nullif(trim(p ->> 'answer'), '') is null then
      raise exception '%', case r.kind when 'si' then 'Say what was done to comply' else 'Enter the consultant''s answer' end;
    end if;
    update public.rfis set status = 'answered', answer = trim(p ->> 'answer'),
      answered_on = coalesce(nullif(p ->> 'answered_on', '')::date, app.eat_date(now())), answered_by = nullif(p ->> 'answered_by', ''),
      ball_in_court = 'contractor',
      cost_impact = coalesce(nullif(p ->> 'cost_impact', ''), cost_impact), cost_amount = coalesce(nullif(p ->> 'cost_amount', '')::numeric, cost_amount),
      time_impact = coalesce(nullif(p ->> 'time_impact', ''), time_impact), time_days = coalesce(nullif(p ->> 'time_days', '')::numeric, time_days)
    where id = r.id;
    perform app.notify_user(r.created_by, r.project_id, r.number || ' answered', left(trim(p ->> 'answer'), 200), 'rfi', r.id);
  elsif a = 'close' then
    if r.status = 'void' or r.status = 'closed' then raise exception '% is already %', r.number, r.status; end if;
    if r.kind = 'rfi' and r.status <> 'answered' then raise exception 'Record the answer before closing %', r.number; end if;
    update public.rfis set status = 'closed', closed_by = auth.uid(), closed_at = now() where id = r.id;
  elsif a = 'reopen' then
    if r.status not in ('answered','closed') then raise exception 'Only an answered or closed item can be reopened'; end if;
    update public.rfis set status = 'open', closed_by = null, closed_at = null,
      ball_in_court = case r.kind when 'rfi' then 'consultant' else 'contractor' end where id = r.id;
  elsif a = 'void' then
    if c is null then raise exception 'Say why it is void'; end if;
    if r.status = 'void' then raise exception '% is already void', r.number; end if;
    update public.rfis set status = 'void', void_reason = c where id = r.id;
  elsif a = 'link' then
    if (p ->> 'variation_id') is not null and not exists (select 1 from public.variations where id = (p ->> 'variation_id')::uuid and project_id = r.project_id) then
      raise exception 'Variation not in this project';
    end if;
    if (p ->> 'eot_claim_id') is not null and not exists (select 1 from public.eot_claims where id = (p ->> 'eot_claim_id')::uuid and project_id = r.project_id) then
      raise exception 'EOT claim not in this project';
    end if;
    update public.rfis set variation_id = case when p ? 'variation_id' then nullif(p ->> 'variation_id', '')::uuid else variation_id end,
      eot_claim_id = case when p ? 'eot_claim_id' then nullif(p ->> 'eot_claim_id', '')::uuid else eot_claim_id end where id = r.id;
  elsif a = 'ball' then
    if coalesce(p ->> 'ball_in_court', '') not in ('contractor','consultant','client') then raise exception 'Ball in court: contractor, consultant or client'; end if;
    update public.rfis set ball_in_court = p ->> 'ball_in_court' where id = r.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  select * into r from public.rfis where id = r.id;
  return app.op_done(p, 'decide_rfi', jsonb_build_object('ok', true, 'id', r.id, 'number', r.number, 'status', r.status));
end $$;

-- ---------------------------------------------------------------------------
-- Drawing / document register
-- ---------------------------------------------------------------------------
-- {id, project_id, doc_no, title, discipline?, doc_type?, revision?: {rev, rev_date?, status?, received_on?, transmittal_ref?, notes?}}
create or replace function public.save_document(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid;
  d public.project_documents; rv jsonb := p -> 'revision'; v_rev text; v_status text;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'doc_no'), '') is null or nullif(trim(p ->> 'title'), '') is null then raise exception 'Document no. and title are required'; end if;
  select * into d from public.project_documents where id = v_id for update;
  if found then
    if d.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    update public.project_documents set doc_no = trim(p ->> 'doc_no'), title = trim(p ->> 'title'), discipline = nullif(p ->> 'discipline', ''),
      doc_type = coalesce(nullif(p ->> 'doc_type', ''), doc_type), deleted_at = null where id = v_id;
  else
    if exists (select 1 from public.project_documents where project_id = v_project and doc_no = trim(p ->> 'doc_no')) then
      raise exception 'Document % is already in the register — add a revision to it', trim(p ->> 'doc_no');
    end if;
    insert into public.project_documents (id, project_id, doc_no, title, discipline, doc_type, created_by)
    values (v_id, v_project, trim(p ->> 'doc_no'), trim(p ->> 'title'), nullif(p ->> 'discipline', ''), coalesce(nullif(p ->> 'doc_type', ''), 'drawing'), auth.uid());
  end if;
  if rv is not null and nullif(trim(rv ->> 'rev'), '') is not null then
    v_rev := upper(trim(rv ->> 'rev'));
    v_status := coalesce(nullif(rv ->> 'status', ''), 'for_construction');
    if exists (select 1 from public.document_revisions where document_id = v_id and rev = v_rev) then
      raise exception 'Revision % of % is already registered', v_rev, trim(p ->> 'doc_no');
    end if;
    update public.document_revisions set superseded_at = now() where document_id = v_id and superseded_at is null;
    insert into public.document_revisions (document_id, project_id, rev, rev_date, status, received_on, transmittal_ref, notes, created_by)
    values (v_id, v_project, v_rev, nullif(rv ->> 'rev_date', '')::date, v_status,
      coalesce(nullif(rv ->> 'received_on', '')::date, app.eat_date(now())), nullif(rv ->> 'transmittal_ref', ''), nullif(rv ->> 'notes', ''), auth.uid());
    update public.project_documents set current_rev = v_rev, current_status = v_status where id = v_id;
    if v_status in ('for_construction','as_built') then
      perform app.notify_roles_txt(v_project, '{site_engineer,office_engineer,coordinator}',
        trim(p ->> 'doc_no') || ' rev ' || v_rev || ' issued for construction',
        trim(p ->> 'title') || ' — withdraw earlier revisions from site', 'document', v_id);
    end if;
  end if;
  select * into d from public.project_documents where id = v_id;
  return app.op_done(p, 'save_document', jsonb_build_object('ok', true, 'id', v_id, 'current_rev', d.current_rev));
end $$;

-- ---------------------------------------------------------------------------
-- Submittals
-- ---------------------------------------------------------------------------
-- {id, project_id, title, kind?, spec_section?, material_spec_id?, supplier?, required_by?, notes?}
create or replace function public.save_submittal(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid; s public.submittals;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin');
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the submittal a title'; end if;
  if (p ->> 'material_spec_id') is not null and not exists (select 1 from public.material_specs where id = (p ->> 'material_spec_id')::uuid) then
    raise exception 'Material not found';
  end if;
  select * into s from public.submittals where id = v_id for update;
  if found then
    if s.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    if s.status = 'void' then raise exception '% is void', s.number; end if;
    update public.submittals set title = trim(p ->> 'title'), kind = coalesce(nullif(p ->> 'kind', ''), kind), spec_section = nullif(p ->> 'spec_section', ''),
      material_spec_id = nullif(p ->> 'material_spec_id', '')::uuid, supplier = nullif(p ->> 'supplier', ''),
      required_by = nullif(p ->> 'required_by', '')::date, notes = nullif(p ->> 'notes', '') where id = v_id;
  else
    insert into public.submittals (id, project_id, number, title, kind, spec_section, material_spec_id, supplier, required_by, notes, created_by)
    values (v_id, v_project, app.ca_next_no(v_project, 'public.submittals', 'SUB'), trim(p ->> 'title'), coalesce(nullif(p ->> 'kind', ''), 'material'),
      nullif(p ->> 'spec_section', ''), nullif(p ->> 'material_spec_id', '')::uuid, nullif(p ->> 'supplier', ''),
      nullif(p ->> 'required_by', '')::date, nullif(p ->> 'notes', ''), auth.uid());
  end if;
  select * into s from public.submittals where id = v_id;
  return app.op_done(p, 'save_submittal', jsonb_build_object('ok', true, 'id', v_id, 'number', s.number, 'status', s.status));
end $$;

-- {submittal_id, action: 'submit' (submitted_on?, response_due?, transmittal_ref?) | 'respond' (code A|B|C|D, responded_on?, reviewer?, comments?)
--  | 'void' (comment)}
create or replace function public.decide_submittal(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); s public.submittals; a text := p ->> 'action'; v_rev int; v_on date; v_code text; v_status text;
  st public.contract_admin_settings;
begin
  if v_seen is not null then return v_seen; end if;
  select * into s from public.submittals where id = (p ->> 'submittal_id')::uuid for update;
  if not found then raise exception 'Submittal not found'; end if;
  perform app.ca_guard(s.project_id, 'office_engineer', 'coordinator', 'manager', 'admin');
  if a = 'submit' then
    if s.status not in ('draft','revise_resubmit','rejected') then
      raise exception '% is % — only a draft or a returned submittal can be (re)submitted', s.number, replace(s.status, '_', ' ');
    end if;
    st := app.ca_settings(s.project_id);
    v_rev := coalesce(s.current_rev + 1, 0);
    v_on := coalesce(nullif(p ->> 'submitted_on', '')::date, app.eat_date(now()));
    insert into public.submittal_revisions (submittal_id, project_id, rev, submitted_on, response_due, transmittal_ref, created_by)
    values (s.id, s.project_id, v_rev, v_on, coalesce(nullif(p ->> 'response_due', '')::date, v_on + st.submittal_response_days),
      nullif(p ->> 'transmittal_ref', ''), auth.uid());
    update public.submittals set status = 'submitted', current_rev = v_rev where id = s.id;
  elsif a = 'respond' then
    if s.status <> 'submitted' then raise exception '% is not waiting for a response', s.number; end if;
    v_code := upper(coalesce(p ->> 'code', ''));
    if v_code not in ('A','B','C','D') then raise exception 'Review code: A approved, B approved as noted, C revise & resubmit, D rejected'; end if;
    if v_code in ('B','C','D') and nullif(trim(p ->> 'comments'), '') is null then raise exception 'Enter the reviewer''s comments'; end if;
    update public.submittal_revisions set code = v_code, responded_on = coalesce(nullif(p ->> 'responded_on', '')::date, app.eat_date(now())),
      reviewer = nullif(p ->> 'reviewer', ''), comments = nullif(trim(p ->> 'comments'), '')
    where submittal_id = s.id and rev = s.current_rev;
    v_status := case v_code when 'A' then 'approved' when 'B' then 'approved_as_noted' when 'C' then 'revise_resubmit' else 'rejected' end;
    update public.submittals set status = v_status where id = s.id;
    perform app.notify_user(s.created_by, s.project_id, s.number || ' returned code ' || v_code, s.title, 'submittal', s.id);
    if v_code in ('A','B') and s.material_spec_id is not null then
      perform app.notify_roles_txt(s.project_id, '{procurement}', 'Material approved: ' || s.title,
        s.number || ' code ' || v_code || ' — it can be ordered', 'submittal', s.id);
    end if;
  elsif a = 'void' then
    if nullif(trim(p ->> 'comment'), '') is null then raise exception 'Say why it is void'; end if;
    update public.submittals set status = 'void', notes = coalesce(notes || E'\n', '') || 'Void: ' || trim(p ->> 'comment') where id = s.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  select * into s from public.submittals where id = s.id;
  return app.op_done(p, 'decide_submittal', jsonb_build_object('ok', true, 'id', s.id, 'number', s.number, 'status', s.status, 'rev', s.current_rev));
end $$;

-- ---------------------------------------------------------------------------
-- Meetings & actions
-- ---------------------------------------------------------------------------
-- {id, project_id, kind?, title, held_on, location?, chaired_by?, attendees?, agenda?, minutes?, next_meeting_on?,
--  actions?: [{id?, description, owner_id?, owner_name?, due_date?}], issue?: bool}
create or replace function public.save_meeting(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid;
  m public.meetings; x record; n int := 0; v_keep uuid[] := '{}'; v_aid uuid;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the meeting a title'; end if;
  if (p ->> 'held_on') is null then raise exception 'Enter the meeting date'; end if;
  select * into m from public.meetings where id = v_id for update;
  if found then
    if m.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    update public.meetings set kind = coalesce(nullif(p ->> 'kind', ''), kind), title = trim(p ->> 'title'), held_on = (p ->> 'held_on')::date,
      location = nullif(p ->> 'location', ''), chaired_by = nullif(p ->> 'chaired_by', ''), attendees = nullif(p ->> 'attendees', ''),
      agenda = nullif(p ->> 'agenda', ''), minutes = nullif(p ->> 'minutes', ''), next_meeting_on = nullif(p ->> 'next_meeting_on', '')::date
    where id = v_id;
  else
    insert into public.meetings (id, project_id, number, kind, title, held_on, location, chaired_by, attendees, agenda, minutes, next_meeting_on, created_by)
    values (v_id, v_project, app.ca_next_no(v_project, 'public.meetings', 'MOM'), coalesce(nullif(p ->> 'kind', ''), 'progress'), trim(p ->> 'title'),
      (p ->> 'held_on')::date, nullif(p ->> 'location', ''), nullif(p ->> 'chaired_by', ''), nullif(p ->> 'attendees', ''), nullif(p ->> 'agenda', ''),
      nullif(p ->> 'minutes', ''), nullif(p ->> 'next_meeting_on', '')::date, auth.uid());
  end if;
  if p ? 'actions' then
    for x in select * from jsonb_to_recordset(coalesce(p -> 'actions', '[]'::jsonb)) as y(id uuid, description text, owner_id uuid, owner_name text, due_date date) loop
      n := n + 1;
      if nullif(trim(x.description), '') is null then raise exception 'Action %: describe it', n; end if;
      if x.owner_id is null and nullif(trim(x.owner_name), '') is null then raise exception 'Action %: who owns it?', n; end if;
      if x.owner_id is not null and not exists (select 1 from public.project_members where project_id = v_project and user_id = x.owner_id) then
        raise exception 'Action %: the owner is not on this project', n;
      end if;
      v_aid := coalesce(x.id, gen_random_uuid());
      insert into public.meeting_actions (id, project_id, meeting_id, seq, description, owner_id, owner_name, due_date, created_by)
      values (v_aid, v_project, v_id, n, trim(x.description), x.owner_id, nullif(trim(x.owner_name), ''), x.due_date, auth.uid())
      on conflict (id) do update set seq = excluded.seq, description = excluded.description, owner_id = excluded.owner_id,
        owner_name = excluded.owner_name, due_date = excluded.due_date
      where meeting_actions.meeting_id = v_id;
      v_keep := v_keep || v_aid;
    end loop;
    delete from public.meeting_actions where meeting_id = v_id and status = 'open' and not (id = any (v_keep));
  end if;
  if coalesce((p ->> 'issue')::boolean, false) then
    select * into m from public.meetings where id = v_id;
    if m.status <> 'issued' then
      update public.meetings set status = 'issued', issued_at = now() where id = v_id;
      for x in select a.* from public.meeting_actions a where a.meeting_id = v_id and a.status = 'open' and a.owner_id is not null loop
        perform app.notify_user(x.owner_id, v_project, 'Action from ' || m.number || coalesce(' — due ' || to_char(x.due_date, 'DD Mon'), ''),
          x.description, 'meeting_action', x.id);
      end loop;
    end if;
  end if;
  select * into m from public.meetings where id = v_id;
  return app.op_done(p, 'save_meeting', jsonb_build_object('ok', true, 'id', v_id, 'number', m.number, 'status', m.status,
    'actions', (select count(*) from public.meeting_actions where meeting_id = v_id)));
end $$;

-- Standalone action or an edit of one: {id, project_id, description, owner_id?, owner_name?, due_date?, meeting_id?}
-- Status change: {id, project_id, action: 'done' | 'reopen' | 'cancel', note?} — owner or the office.
create or replace function public.save_action_item(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid;
  a public.meeting_actions; v_act text := p ->> 'action'; v_office boolean; v_exists boolean;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  v_office := app.has_role_txt('office_engineer', 'coordinator', 'manager', 'admin');
  select * into a from public.meeting_actions where id = v_id for update;
  v_exists := found;
  if v_act is not null then
    if not v_exists or a.project_id <> v_project then raise exception 'Action not found'; end if;
    if a.owner_id is distinct from auth.uid() and not v_office then
      raise exception 'Only the owner or the office can update this action' using errcode = '42501';
    end if;
    if v_act = 'done' then
      if a.status <> 'open' then raise exception 'The action is already %', a.status; end if;
      update public.meeting_actions set status = 'done', done_at = now(), done_by = auth.uid(), done_note = nullif(trim(p ->> 'note'), '') where id = v_id;
      if a.created_by is distinct from auth.uid() then
        perform app.notify_user(a.created_by, v_project, 'Action done', left(a.description, 120), 'meeting_action', v_id);
      end if;
    elsif v_act = 'reopen' then
      update public.meeting_actions set status = 'open', done_at = null, done_by = null where id = v_id;
    elsif v_act = 'cancel' then
      if not v_office then raise exception 'Only the office can cancel an action' using errcode = '42501'; end if;
      update public.meeting_actions set status = 'cancelled', done_note = nullif(trim(p ->> 'note'), '') where id = v_id;
    else
      raise exception 'Unknown action %', v_act;
    end if;
  else
    perform app.require_role_txt('site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin');
    if nullif(trim(p ->> 'description'), '') is null then raise exception 'Describe the action'; end if;
    if (p ->> 'owner_id') is null and nullif(trim(p ->> 'owner_name'), '') is null then raise exception 'Who owns the action?'; end if;
    if (p ->> 'owner_id') is not null and not exists (select 1 from public.project_members where project_id = v_project and user_id = (p ->> 'owner_id')::uuid) then
      raise exception 'The owner is not on this project';
    end if;
    if v_exists then
      if a.project_id <> v_project then raise exception 'Action not found'; end if;
      update public.meeting_actions set description = trim(p ->> 'description'), owner_id = nullif(p ->> 'owner_id', '')::uuid,
        owner_name = nullif(trim(p ->> 'owner_name'), ''), due_date = nullif(p ->> 'due_date', '')::date where id = v_id;
    else
      insert into public.meeting_actions (id, project_id, meeting_id, description, owner_id, owner_name, due_date, created_by)
      values (v_id, v_project, nullif(p ->> 'meeting_id', '')::uuid, trim(p ->> 'description'), nullif(p ->> 'owner_id', '')::uuid,
        nullif(trim(p ->> 'owner_name'), ''), nullif(p ->> 'due_date', '')::date, auth.uid());
      perform app.notify_user(nullif(p ->> 'owner_id', '')::uuid, v_project, 'New action for you' || coalesce(' — due ' || to_char(nullif(p ->> 'due_date', '')::date, 'DD Mon'), ''),
        trim(p ->> 'description'), 'meeting_action', v_id);
    end if;
  end if;
  select * into a from public.meeting_actions where id = v_id;
  return app.op_done(p, 'save_action_item', jsonb_build_object('ok', true, 'id', v_id, 'status', a.status));
end $$;

-- ---------------------------------------------------------------------------
-- Risks & issues
-- ---------------------------------------------------------------------------
-- {id, project_id, kind?, title, description?, category?, likelihood?, impact?, owner_id?, response_type?, response?, cost_exposure?,
--  time_exposure_days?, review_by?, status?}
create or replace function public.save_risk(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid; r public.risks;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.require_member(v_project);
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the risk a title'; end if;
  if (p ->> 'owner_id') is not null and not exists (select 1 from public.project_members where project_id = v_project and user_id = (p ->> 'owner_id')::uuid) then
    raise exception 'The owner is not on this project';
  end if;
  select * into r from public.risks where id = v_id for update;
  if found then
    if r.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    if r.owner_id is distinct from auth.uid() and not app.has_role_txt('office_engineer', 'coordinator', 'manager', 'admin') then
      raise exception 'Only the owner or the office can update %', r.number using errcode = '42501';
    end if;
    update public.risks set kind = coalesce(nullif(p ->> 'kind', ''), kind), title = trim(p ->> 'title'), description = nullif(p ->> 'description', ''),
      category = coalesce(nullif(p ->> 'category', ''), category), likelihood = coalesce((p ->> 'likelihood')::int, likelihood),
      impact = coalesce((p ->> 'impact')::int, impact), owner_id = nullif(p ->> 'owner_id', '')::uuid,
      response_type = nullif(p ->> 'response_type', ''), response = nullif(p ->> 'response', ''),
      cost_exposure = nullif(p ->> 'cost_exposure', '')::numeric, time_exposure_days = nullif(p ->> 'time_exposure_days', '')::numeric,
      review_by = nullif(p ->> 'review_by', '')::date, status = coalesce(nullif(p ->> 'status', ''), status),
      closed_at = case when coalesce(nullif(p ->> 'status', ''), status) = 'closed' then coalesce(closed_at, now()) else null end
    where id = v_id;
  else
    perform app.require_role_txt('site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin');
    insert into public.risks (id, project_id, number, kind, title, description, category, likelihood, impact, owner_id, response_type, response,
      cost_exposure, time_exposure_days, review_by, created_by)
    values (v_id, v_project, app.ca_next_no(v_project, 'public.risks', 'R'), coalesce(nullif(p ->> 'kind', ''), 'risk'), trim(p ->> 'title'),
      nullif(p ->> 'description', ''), coalesce(nullif(p ->> 'category', ''), 'other'), coalesce((p ->> 'likelihood')::int, 3), coalesce((p ->> 'impact')::int, 3),
      nullif(p ->> 'owner_id', '')::uuid, nullif(p ->> 'response_type', ''), nullif(p ->> 'response', ''), nullif(p ->> 'cost_exposure', '')::numeric,
      nullif(p ->> 'time_exposure_days', '')::numeric, nullif(p ->> 'review_by', '')::date, auth.uid());
    select * into r from public.risks where id = v_id;
    perform app.notify_user(r.owner_id, v_project, 'You own ' || r.number || ': ' || r.title, 'Score ' || r.score || ' — set a response', 'risk', v_id, r.score >= 15);
    if r.score >= 15 then
      perform app.notify_roles_txt(v_project, '{manager}', 'High ' || r.kind || ' ' || r.number || ': ' || r.title, 'Score ' || r.score, 'risk', v_id, true);
    end if;
  end if;
  select * into r from public.risks where id = v_id;
  return app.op_done(p, 'save_risk', jsonb_build_object('ok', true, 'id', v_id, 'number', r.number, 'score', r.score, 'status', r.status));
end $$;

-- ---------------------------------------------------------------------------
-- Extension of time (EOT) claims
-- ---------------------------------------------------------------------------
-- {id, project_id, title, cause, description?, event_from, event_to?, days_claimed?, cost_claimed?, variation_id?}
create or replace function public.save_eot_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); v_id uuid := coalesce((p ->> 'id')::uuid, gen_random_uuid()); v_project uuid := (p ->> 'project_id')::uuid; e public.eot_claims;
begin
  if v_seen is not null then return v_seen; end if;
  perform app.ca_guard(v_project, 'office_engineer', 'coordinator', 'manager', 'admin');
  if nullif(trim(p ->> 'title'), '') is null then raise exception 'Give the claim a title'; end if;
  if (p ->> 'event_from') is null then raise exception 'When did the delay event start?'; end if;
  if nullif(p ->> 'event_to', '')::date < (p ->> 'event_from')::date then raise exception 'The event cannot end before it starts'; end if;
  if (p ->> 'variation_id') is not null and not exists (select 1 from public.variations where id = (p ->> 'variation_id')::uuid and project_id = v_project) then
    raise exception 'Variation not in this project';
  end if;
  select * into e from public.eot_claims where id = v_id for update;
  if found then
    if e.project_id <> v_project then raise exception 'Belongs to another project'; end if;
    if e.status not in ('draft','notice_sent') then raise exception '% is % — it can no longer be edited', e.number, replace(e.status, '_', ' '); end if;
    update public.eot_claims set title = trim(p ->> 'title'), cause = coalesce(nullif(p ->> 'cause', ''), cause), description = nullif(p ->> 'description', ''),
      event_from = (p ->> 'event_from')::date, event_to = nullif(p ->> 'event_to', '')::date,
      days_claimed = coalesce((p ->> 'days_claimed')::numeric, days_claimed), cost_claimed = coalesce((p ->> 'cost_claimed')::numeric, cost_claimed),
      variation_id = nullif(p ->> 'variation_id', '')::uuid where id = v_id;
  else
    insert into public.eot_claims (id, project_id, number, title, cause, description, event_from, event_to, days_claimed, cost_claimed, variation_id, created_by)
    values (v_id, v_project, app.ca_next_no(v_project, 'public.eot_claims', 'EOT'), trim(p ->> 'title'), coalesce(nullif(p ->> 'cause', ''), 'other'),
      nullif(p ->> 'description', ''), (p ->> 'event_from')::date, nullif(p ->> 'event_to', '')::date, coalesce((p ->> 'days_claimed')::numeric, 0),
      coalesce((p ->> 'cost_claimed')::numeric, 0), nullif(p ->> 'variation_id', '')::uuid, auth.uid());
    perform app.notify_roles_txt(v_project, '{coordinator,manager}', 'Delay event ' || (select number from public.eot_claims where id = v_id) || ': ' || trim(p ->> 'title'),
      'Send the notice by ' || to_char((p ->> 'event_from')::date + (app.ca_settings(v_project)).claim_notice_days, 'DD Mon YYYY'), 'eot_claim', v_id, true);
  end if;
  select * into e from public.eot_claims where id = v_id;
  return app.op_done(p, 'save_eot_claim', jsonb_build_object('ok', true, 'id', v_id, 'number', e.number, 'status', e.status,
    'notice_due', e.event_from + (app.ca_settings(v_project)).claim_notice_days));
end $$;

-- {claim_id, action: 'send_notice' (notice_date?, notice_ref?) | 'submit' (particulars_date?, days_claimed?, cost_claimed?) |
--  'decide' (days_granted, cost_granted?, decided_on?, consultant_ref?, comment?) | 'withdraw' (comment)}
create or replace function public.decide_eot_claim(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_seen jsonb := app.op_seen(p); e public.eot_claims; a text := p ->> 'action'; v_days numeric; v_status text; v_late boolean := false;
begin
  if v_seen is not null then return v_seen; end if;
  select * into e from public.eot_claims where id = (p ->> 'claim_id')::uuid for update;
  if not found then raise exception 'Claim not found'; end if;
  perform app.ca_guard(e.project_id, 'coordinator', 'manager', 'admin');
  if a = 'send_notice' then
    if e.status <> 'draft' then raise exception 'The notice for % was already sent', e.number; end if;
    update public.eot_claims set status = 'notice_sent', notice_date = coalesce(nullif(p ->> 'notice_date', '')::date, app.eat_date(now())),
      notice_ref = nullif(p ->> 'notice_ref', '') where id = e.id;
    v_late := (select notice_date from public.eot_claims where id = e.id) > e.event_from + (app.ca_settings(e.project_id)).claim_notice_days;
  elsif a = 'submit' then
    if e.status <> 'notice_sent' then raise exception 'Send the notice before the detailed claim'; end if;
    update public.eot_claims set status = 'submitted', particulars_date = coalesce(nullif(p ->> 'particulars_date', '')::date, app.eat_date(now())),
      days_claimed = coalesce((p ->> 'days_claimed')::numeric, days_claimed), cost_claimed = coalesce((p ->> 'cost_claimed')::numeric, cost_claimed)
    where id = e.id;
    if (select days_claimed <= 0 and cost_claimed <= 0 from public.eot_claims where id = e.id) then
      raise exception 'Enter the days and/or cost claimed';
    end if;
  elsif a = 'decide' then
    if e.status <> 'submitted' then raise exception 'Only a submitted claim can be decided'; end if;
    v_days := (p ->> 'days_granted')::numeric;
    if v_days is null or v_days < 0 then raise exception 'Enter the days granted (0 if rejected)'; end if;
    v_status := case when v_days = 0 and coalesce((p ->> 'cost_granted')::numeric, 0) = 0 then 'rejected'
                     when v_days >= e.days_claimed and coalesce((p ->> 'cost_granted')::numeric, 0) >= e.cost_claimed then 'granted'
                     else 'partly_granted' end;
    update public.eot_claims set status = v_status, days_granted = v_days, cost_granted = coalesce((p ->> 'cost_granted')::numeric, 0),
      decided_on = coalesce(nullif(p ->> 'decided_on', '')::date, app.eat_date(now())), consultant_ref = nullif(p ->> 'consultant_ref', ''),
      decision_comment = nullif(trim(p ->> 'comment'), '') where id = e.id;
    perform app.notify_roles_txt(e.project_id, '{coordinator,manager,office_engineer}', e.number || ' ' || replace(v_status, '_', ' '),
      v_days || ' day(s) granted of ' || e.days_claimed, 'eot_claim', e.id);
  elsif a = 'withdraw' then
    if e.status in ('granted','partly_granted','rejected','withdrawn') then raise exception '% is already %', e.number, replace(e.status, '_', ' '); end if;
    update public.eot_claims set status = 'withdrawn', decision_comment = nullif(trim(p ->> 'comment'), '') where id = e.id;
  else
    raise exception 'Unknown action %', a;
  end if;
  select * into e from public.eot_claims where id = e.id;
  return app.op_done(p, 'decide_eot_claim', jsonb_build_object('ok', true, 'id', e.id, 'number', e.number, 'status', e.status, 'notice_late', v_late));
end $$;

-- Delay evidence from signed / submitted site diaries in a window: hours lost by cause (8 h = 1 day) and rain hours.
create or replace function public.eot_delay_evidence(p_project uuid, p_from date, p_to date)
returns table (cause text, diaries bigint, hours_lost numeric, days_lost numeric, first_date date, last_date date)
language sql stable security invoker set search_path = public as $$
  select x.cause, count(distinct d.id), coalesce(sum(x.hours_lost), 0), round(coalesce(sum(x.hours_lost), 0) / 8, 1), min(d.diary_date), max(d.diary_date)
  from public.diary_delays x join public.site_diaries d on d.id = x.diary_id
  where d.project_id = p_project and d.diary_date between p_from and coalesce(p_to, app.eat_date(now()))
    and x.deleted_at is null and d.status <> 'draft'
  group by x.cause order by 3 desc
$$;
grant execute on function public.eot_delay_evidence(uuid, date, date) to authenticated;

create or replace view public.v_completion_dates with (security_invoker = true) as
select pj.id as project_id, pj.start_date, pj.end_date as original_completion,
       coalesce(sum(e.days_granted) filter (where e.status in ('granted','partly_granted')), 0) as days_granted,
       coalesce(sum(e.days_claimed) filter (where e.status in ('notice_sent','submitted')), 0) as days_pending,
       pj.end_date + coalesce(sum(e.days_granted) filter (where e.status in ('granted','partly_granted')), 0)::int as revised_completion
from public.projects pj left join public.eot_claims e on e.project_id = pj.id
where app.is_member(pj.id)
group by pj.id;
grant select on public.v_completion_dates to authenticated;

-- RFI / submittal registers with the overdue figures the inbox and the pages use.
create or replace view public.v_rfi_register with (security_invoker = true) as
select r.*, case when r.status = 'open' and r.due_date < app.eat_date(now()) then app.eat_date(now()) - r.due_date else 0 end as days_overdue,
       coalesce(r.answered_on, app.eat_date(now())) - r.raised_on as days_open,
       v.number as variation_number, e.number as eot_number
from public.rfis r left join public.variations v on v.id = r.variation_id left join public.eot_claims e on e.id = r.eot_claim_id;
grant select on public.v_rfi_register to authenticated;

create or replace view public.v_submittal_register with (security_invoker = true) as
select s.*, r.submitted_on, r.response_due, r.code, r.responded_on, r.reviewer, r.comments, r.transmittal_ref,
       case when s.status = 'submitted' and r.response_due < app.eat_date(now()) then app.eat_date(now()) - r.response_due else 0 end as days_overdue,
       (s.required_by is not null and s.status not in ('approved','approved_as_noted','void') and s.required_by <= app.eat_date(now()) + 14) as at_risk
from public.submittals s left join public.submittal_revisions r on r.submittal_id = s.id and r.rev = s.current_rev;
grant select on public.v_submittal_register to authenticated;

notify pgrst, 'reload schema';
