-- =============================================================================
-- Progress workflow fixes found in the end-to-end test (TWR, real .mpp schedule).
--
-- 1. Rejected / adjusted reports left the "reported" figures on the task (schedule_tasks.reported_pct,
--    task_boq_links.reported_qty, task_steps.reported_pct) at the refused value. Daily output adds today's
--    quantity to the reported figure, so after a rejection (or a measurement cut from 450 to 420 m2) the next
--    day's output built on the refused quantity. Now, whenever a report is rejected or adjusted, the reported
--    figures are reset to the latest report that still stands (its verified figure when verified/adjusted),
--    or to the verified figures when no report stands.
-- =============================================================================

create or replace function app.resync_reported(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.task_progress;
begin
  select * into r from public.task_progress
   where task_id = p_task and status <> 'rejected'
   order by created_at desc limit 1;
  if not found then
    update public.schedule_tasks set reported_pct = pct_complete where id = p_task;
    update public.task_boq_links set reported_qty = verified_qty where task_id = p_task and deleted_at is null;
    update public.task_steps set reported_pct = verified_pct where task_id = p_task;
    return;
  end if;
  update public.schedule_tasks
     set reported_pct = coalesce(case when r.status in ('verified','adjusted') then r.verified_pct end, r.pct_complete, reported_pct)
   where id = p_task;
  update public.task_boq_links l set reported_qty = y.qty_to_date
    from jsonb_to_recordset(coalesce(case when r.status in ('verified','adjusted') then r.verified_qty end, r.qty, '[]'::jsonb))
         as y(boq_item_id uuid, qty_to_date numeric)
   where l.task_id = p_task and l.boq_item_id = y.boq_item_id and l.deleted_at is null;
  update public.task_steps s set reported_pct = y.done_pct
    from jsonb_to_recordset(coalesce(case when r.status in ('verified','adjusted') then r.verified_steps end, r.steps, '[]'::jsonb))
         as y(step_id uuid, done_pct numeric)
   where s.task_id = p_task and s.id = y.step_id;
end $$;
revoke execute on function app.resync_reported(uuid) from public;

create or replace function app.trg_task_progress_resync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'reported' and new.status in ('rejected', 'adjusted') then
    perform app.resync_reported(new.task_id);
  end if;
  return null;
end $$;

drop trigger if exists resync_reported on public.task_progress;
create trigger resync_reported after update of status on public.task_progress
  for each row execute function app.trg_task_progress_resync();

-- =============================================================================
-- 2. Daily output labour hours did not reach cost control: the hours were stored on the diary line only, so
--    "Estimate from site diary hours" (estimate_costs_from_usage, which reads resource_usage) found nothing and
--    task-level CPI had no actual cost from the site. Each daily output with labour hours now also records the
--    labour usage (man-hours on the task, linked to the diary; id = the diary line id, so it is written once),
--    and existing outputs are back-filled.
-- =============================================================================
create or replace function app.trg_diary_activity_usage() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.labour_hours, 0) > 0 then
    insert into public.resource_usage (id, project_id, usage_date, kind, task_id, boq_item_id, qty, uom, diary_id, remarks, created_by)
    values (new.id, new.project_id, new.activity_date, 'labour', new.task_id,
      (select case when count(*) = 1 then min(l.boq_item_id::text)::uuid end from public.task_boq_links l
        where l.task_id = new.task_id and l.deleted_at is null),
      new.labour_hours, 'man-hour', new.diary_id,
      'Daily output' || coalesce(' — ' || new.headcount || ' people', '') || coalesce(' · ' || new.remarks, ''), new.created_by)
    on conflict (id) do nothing;
  end if;
  return null;
end $$;

drop trigger if exists labour_usage on public.diary_activities;
create trigger labour_usage after insert on public.diary_activities
  for each row execute function app.trg_diary_activity_usage();

insert into public.resource_usage (id, project_id, usage_date, kind, task_id, boq_item_id, qty, uom, diary_id, remarks, created_by)
select a.id, a.project_id, a.activity_date, 'labour', a.task_id,
       (select case when count(*) = 1 then min(l.boq_item_id::text)::uuid end from public.task_boq_links l
         where l.task_id = a.task_id and l.deleted_at is null),
       a.labour_hours, 'man-hour', a.diary_id,
       'Daily output' || coalesce(' — ' || a.headcount || ' people', '') || coalesce(' · ' || a.remarks, ''), a.created_by
  from public.diary_activities a
 where coalesce(a.labour_hours, 0) > 0 and a.deleted_at is null
on conflict (id) do nothing;
