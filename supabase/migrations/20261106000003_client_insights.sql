-- =============================================================================
-- Client insights: historical progress, approved photos, milestone recovery,
-- approved variations, client-safe risks and publication timestamps.
--
-- Base tables remain hidden from client accounts by the restrictive policies in
-- 20261106000001_client_portal.sql. Clients read only the narrow views/functions
-- below. Publication actions are restricted to office/management roles.
-- =============================================================================

alter table public.attachments add column if not exists client_visible boolean not null default false;
alter table public.attachments add column if not exists client_approved_at timestamptz;
alter table public.attachments add column if not exists client_approved_by uuid references public.profiles (id);

alter table public.risks add column if not exists client_visible boolean not null default false;
alter table public.risks add column if not exists client_summary text;
alter table public.risks add column if not exists client_mitigation text;
alter table public.risks add column if not exists client_approved_at timestamptz;
alter table public.risks add column if not exists client_approved_by uuid references public.profiles (id);

alter table public.schedule_tasks add column if not exists client_recovery_action text;
alter table public.schedule_tasks add column if not exists client_recovery_updated_at timestamptz;
alter table public.schedule_tasks add column if not exists client_recovery_updated_by uuid references public.profiles (id);

alter table public.variations add column if not exists completion_date_impact_days int;
alter table public.variations add column if not exists revised_completion_date date;

create index if not exists attachments_client_visible_idx
  on public.attachments (project_id, client_approved_at desc)
  where client_visible and deleted_at is null;
create index if not exists risks_client_visible_idx
  on public.risks (project_id, updated_at desc)
  where client_visible;

-- Publishing is deliberately separate from ordinary attachment editing so a
-- photo uploader cannot accidentally expose a file to the external client.
create or replace function public.set_attachment_client_visibility(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a public.attachments; v_visible boolean := coalesce((p ->> 'visible')::boolean, false);
begin
  select * into a from public.attachments where id = (p ->> 'id')::uuid for update;
  if not found or a.deleted_at is not null then raise exception 'Photo not found'; end if;
  perform app.require_member(a.project_id);
  perform app.require_role_txt('coordinator', 'manager', 'admin');
  if coalesce(a.mime_type, '') not like 'image/%' then raise exception 'Only photos can be published to the client'; end if;
  if v_visible and nullif(trim(a.caption), '') is null then raise exception 'Add a client-friendly caption before publishing'; end if;
  update public.attachments set client_visible = v_visible,
    client_approved_at = case when v_visible then now() else null end,
    client_approved_by = case when v_visible then auth.uid() else null end,
    updated_at = now()
  where id = a.id;
  return jsonb_build_object('ok', true, 'id', a.id, 'client_visible', v_visible);
end $$;
revoke execute on function public.set_attachment_client_visibility(jsonb) from public;
grant execute on function public.set_attachment_client_visibility(jsonb) to authenticated;

create or replace function public.set_risk_client_visibility(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.risks; v_visible boolean := coalesce((p ->> 'visible')::boolean, false);
begin
  select * into r from public.risks where id = (p ->> 'id')::uuid for update;
  if not found then raise exception 'Risk not found'; end if;
  perform app.require_member(r.project_id);
  perform app.require_role_txt('coordinator', 'manager', 'admin');
  if v_visible and nullif(trim(p ->> 'summary'), '') is null then
    raise exception 'Add a client-safe summary before publishing';
  end if;
  update public.risks set client_visible = v_visible,
    client_summary = case when p ? 'summary' then nullif(trim(p ->> 'summary'), '') else client_summary end,
    client_mitigation = case when p ? 'mitigation' then nullif(trim(p ->> 'mitigation'), '') else client_mitigation end,
    client_approved_at = case when v_visible then now() else null end,
    client_approved_by = case when v_visible then auth.uid() else null end
  where id = r.id;
  return jsonb_build_object('ok', true, 'id', r.id, 'client_visible', v_visible);
end $$;
revoke execute on function public.set_risk_client_visibility(jsonb) from public;
grant execute on function public.set_risk_client_visibility(jsonb) to authenticated;

create or replace function public.set_client_milestone_update(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t public.schedule_tasks; v_action text := nullif(trim(p ->> 'recovery_action'), '');
begin
  select * into t from public.schedule_tasks where id = (p ->> 'task_id')::uuid for update;
  if not found or t.deleted_at is not null or not t.is_milestone then raise exception 'Milestone not found'; end if;
  perform app.require_member(t.project_id);
  perform app.require_role_txt('office_engineer', 'coordinator', 'manager', 'admin');
  update public.schedule_tasks set client_recovery_action = v_action,
    client_recovery_updated_at = case when v_action is null then null else now() end,
    client_recovery_updated_by = case when v_action is null then null else auth.uid() end
  where id = t.id;
  return jsonb_build_object('ok', true, 'task_id', t.id, 'published', v_action is not null);
end $$;
revoke execute on function public.set_client_milestone_update(jsonb) from public;
grant execute on function public.set_client_milestone_update(jsonb) to authenticated;

create or replace function public.set_variation_client_impact(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.variations;
begin
  select * into v from public.variations where id = (p ->> 'variation_id')::uuid for update;
  if not found then raise exception 'Variation not found'; end if;
  perform app.billing_guard(v.project_id, 'office_engineer', 'coordinator', 'manager', 'admin');
  update public.variations set
    completion_date_impact_days = nullif(p ->> 'completion_date_impact_days', '')::int,
    revised_completion_date = nullif(p ->> 'revised_completion_date', '')::date
  where id = v.id;
  return jsonb_build_object('ok', true, 'id', v.id);
end $$;
revoke execute on function public.set_variation_client_impact(jsonb) from public;
grant execute on function public.set_variation_client_impact(jsonb) to authenticated;

-- Signed storage URLs for client photos are allowed only when the attachment
-- row was explicitly approved. Internal roles retain the existing entity rules.
create or replace function app.storage_path_visible(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare f text[] := storage.foldername(p_name); v_project uuid; v_entity text;
begin
  begin v_project := f[1]::uuid; exception when others then return false; end;
  v_entity := coalesce(f[2], '');
  if app.my_role()::text = 'client' then
    return exists (
      select 1 from public.attachments a
      where a.storage_path = p_name and a.project_id = v_project
        and a.client_visible and a.deleted_at is null and coalesce(a.mime_type, '') like 'image/%'
        and app.is_member(a.project_id)
    );
  end if;
  return app.attachment_visible(v_entity, v_project);
end $$;
revoke execute on function app.storage_path_visible(text) from public;
grant execute on function app.storage_path_visible(text) to authenticated;

-- Historical planned vs verified progress. It is calculated at the requested
-- daily or weekly cut-offs from verified task progress; no cost fields exist in
-- the return type. Limit prevents an accidental unbounded series.
create or replace function public.client_progress_history(
  p_schedule uuid, p_grain text default 'week', p_points int default 26
) returns table (
  period_end date, pct_planned numeric, pct_verified numeric, spi numeric,
  forecast_finish date, verified_through date
)
language plpgsql stable security definer set search_path = public as $$
declare sc public.schedules; v_step interval; v_points int := least(greatest(coalesce(p_points, 26), 2), 366);
begin
  select * into sc from public.schedules where id = p_schedule;
  if not found or app.my_role()::text <> 'client' or not app.is_member(sc.project_id) then return; end if;
  if p_grain not in ('day', 'week') then raise exception 'Grain must be day or week'; end if;
  v_step := case p_grain when 'day' then interval '1 day' else interval '7 days' end;
  return query
  select g.d::date, o.pct_planned, o.pct_earned, o.spi, o.forecast_finish,
         least(g.d::date, coalesce(sc.status_date, app.eat_date(now())))
  from generate_series(
         coalesce(sc.status_date, app.eat_date(now()))::timestamp - v_step * (v_points - 1),
         coalesce(sc.status_date, app.eat_date(now()))::timestamp,
         v_step
       ) g(d)
  cross join lateral app.progress_overview(sc.id, g.d::date) o
  where o.level = 'project'
  order by g.d;
end $$;
revoke execute on function public.client_progress_history(uuid, text, int) from public;
grant execute on function public.client_progress_history(uuid, text, int) to authenticated;

-- Drop before recreation so this migration remains replay-safe after later
-- migrations append client-safe metadata columns to these views.
drop view if exists public.v_client_photos;
create view public.v_client_photos with (security_barrier = true) as
select a.id, a.project_id, a.storage_path, a.mime_type, a.caption, a.tag,
       a.block_id, b.code as block_code, a.level_id, l.code as level_code,
       a.captured_at, a.client_approved_at
from public.attachments a
left join public.blocks b on b.id = a.block_id
left join public.levels l on l.id = a.level_id
where a.client_visible and a.deleted_at is null and coalesce(a.mime_type, '') like 'image/%'
  and app.my_role()::text = 'client' and app.is_member(a.project_id);

drop view if exists public.v_client_risks;
create view public.v_client_risks with (security_barrier = true) as
select r.id, r.project_id, r.number, r.kind, r.category, r.client_summary as summary,
       r.client_mitigation as mitigation,
       case when r.score >= 15 then 'critical' when r.score >= 8 then 'attention' else 'watch' end as rating,
       r.status, r.review_by, r.updated_at
from public.risks r
where r.client_visible
  and app.my_role()::text = 'client' and app.is_member(r.project_id);

drop view if exists public.v_client_variations;
create view public.v_client_variations with (security_barrier = true) as
select v.id, v.project_id, v.number, v.title, v.instruction_ref, v.instruction_date,
       v.amount, v.client_ref, v.decided_at, v.completion_date_impact_days,
       v.revised_completion_date
from public.variations v
where v.status = 'approved'
  and app.my_role()::text = 'client' and app.is_member(v.project_id);

drop view if exists public.v_client_milestones;
create view public.v_client_milestones with (security_barrier = true) as
select row_number() over (partition by t.schedule_id order by t.sort_order, t.msp_uid, t.id)::int as milestone_no,
       t.id, t.project_id, t.schedule_id, t.name, t.wbs,
       coalesce(t.baseline_finish, t.planned_finish) as baseline_date,
       coalesce(t.forecast_finish, t.planned_finish) as forecast_date,
       case when coalesce(t.forecast_finish, t.planned_finish) is not null
                  and coalesce(t.baseline_finish, t.planned_finish) is not null
            then coalesce(t.forecast_finish, t.planned_finish) - coalesce(t.baseline_finish, t.planned_finish) end as variance_days,
       t.is_critical, t.actual_finish, t.client_recovery_action as recovery_action,
       t.client_recovery_updated_at
from public.schedule_tasks t
where t.is_milestone and t.deleted_at is null and t.source_state = 'active'
  and app.my_role()::text = 'client' and app.is_member(t.project_id);

create or replace view public.v_client_publication_status with (security_barrier = true) as
select s.project_id, s.id as schedule_id,
       greatest(
         coalesce(s.updated_at, '-infinity'::timestamptz),
         coalesce((select max(d.updated_at) from public.site_diaries d where d.project_id = s.project_id and d.status in ('submitted','signed')), '-infinity'::timestamptz),
         coalesce((select max(a.client_approved_at) from public.attachments a where a.project_id = s.project_id and a.client_visible), '-infinity'::timestamptz),
         coalesce((select max(r.client_approved_at) from public.risks r where r.project_id = s.project_id and r.client_visible), '-infinity'::timestamptz),
         coalesce((select max(v.decided_at) from public.variations v where v.project_id = s.project_id and v.status = 'approved'), '-infinity'::timestamptz)
       ) as last_updated,
       coalesce((select max(t.progress_as_of) from public.schedule_tasks t where t.schedule_id = s.id and t.deleted_at is null), s.status_date) as verified_through
from public.schedules s
where s.status <> 'archived'
  and app.my_role()::text = 'client' and app.is_member(s.project_id);

grant select on public.v_client_photos, public.v_client_risks, public.v_client_variations,
  public.v_client_milestones, public.v_client_publication_status to authenticated;

comment on view public.v_client_photos is 'Only image attachments explicitly approved for the external client.';
comment on view public.v_client_risks is 'Only explicitly approved client wording; internal risk descriptions, owners and cost exposure are excluded.';
comment on view public.v_client_variations is 'Approved change orders and client-facing time/contract effects only.';

-- Supabase PostgREST normally notices DDL automatically, but an explicit reload
-- prevents a short-lived "function not found in schema cache" error immediately
-- after this migration is applied through the SQL editor or CLI.
notify pgrst, 'reload schema';
