-- =============================================================================
-- Client experience metadata: expose the approving role (never the person's
-- name or contact details) so external readers know how each item was verified.
-- Re-runnable; base tables remain protected by the restrictive client policies.
-- =============================================================================

create or replace view public.v_client_photos with (security_barrier = true) as
select a.id, a.project_id, a.storage_path, a.mime_type, a.caption, a.tag,
       a.block_id, b.code as block_code, a.level_id, l.code as level_code,
       a.captured_at, a.client_approved_at, ap.role::text as approved_by_role
from public.attachments a
left join public.blocks b on b.id = a.block_id
left join public.levels l on l.id = a.level_id
left join public.profiles ap on ap.id = a.client_approved_by
where a.client_visible and a.deleted_at is null and coalesce(a.mime_type, '') like 'image/%'
  and app.my_role()::text = 'client' and app.is_member(a.project_id);

create or replace view public.v_client_risks with (security_barrier = true) as
select r.id, r.project_id, r.number, r.kind, r.category, r.client_summary as summary,
       r.client_mitigation as mitigation,
       case when r.score >= 15 then 'critical' when r.score >= 8 then 'attention' else 'watch' end as rating,
       r.status, r.review_by, r.updated_at, r.client_approved_at,
       ap.role::text as approved_by_role
from public.risks r
left join public.profiles ap on ap.id = r.client_approved_by
where r.client_visible
  and app.my_role()::text = 'client' and app.is_member(r.project_id);

create or replace view public.v_client_variations with (security_barrier = true) as
select v.id, v.project_id, v.number, v.title, v.instruction_ref, v.instruction_date,
       v.amount, v.client_ref, v.decided_at, v.completion_date_impact_days,
       v.revised_completion_date, ap.role::text as approved_by_role
from public.variations v
left join public.profiles ap on ap.id = v.approved_by
where v.status = 'approved'
  and app.my_role()::text = 'client' and app.is_member(v.project_id);

create or replace view public.v_client_milestones with (security_barrier = true) as
select row_number() over (partition by t.schedule_id order by t.sort_order, t.msp_uid, t.id)::int as milestone_no,
       t.id, t.project_id, t.schedule_id, t.name, t.wbs,
       coalesce(t.baseline_finish, t.planned_finish) as baseline_date,
       coalesce(t.forecast_finish, t.planned_finish) as forecast_date,
       case when coalesce(t.forecast_finish, t.planned_finish) is not null
                  and coalesce(t.baseline_finish, t.planned_finish) is not null
            then coalesce(t.forecast_finish, t.planned_finish) - coalesce(t.baseline_finish, t.planned_finish) end as variance_days,
       t.is_critical, t.actual_finish, t.client_recovery_action as recovery_action,
       t.client_recovery_updated_at, ap.role::text as recovery_updated_by_role
from public.schedule_tasks t
left join public.profiles ap on ap.id = t.client_recovery_updated_by
where t.is_milestone and t.deleted_at is null and t.source_state = 'active'
  and app.my_role()::text = 'client' and app.is_member(t.project_id);

grant select on public.v_client_photos, public.v_client_risks,
  public.v_client_variations, public.v_client_milestones to authenticated;

notify pgrst, 'reload schema';
