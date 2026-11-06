-- =============================================================================
-- Office inbox items (kind 'office' in v_my_approvals, entity_type tells them apart) for the registers of
-- 20261105000040 and the receivables of 20261105000041, plus a portfolio view across the caller's projects.
--
--   rfi              RFI overdue with the consultant → office engineer, coordinator ("chase")
--                    site instruction open → coordinator, site engineer ("act / comply")
--                    answered with a cost / time impact but no variation / EOT linked → coordinator, manager
--   submittal        response overdue → office engineer, coordinator; code C / D → the author (resubmit);
--                    approval needed within 14 days and not approved → coordinator
--   meeting_action   my open actions due within the reminder days (or overdue) → the owner (any role)
--   risk             my open risks whose review date has come → the owner
--   eot_claim        draft claim whose notice deadline is within 7 days (or passed) → coordinator, manager;
--                    detailed claim not sent N days after the notice → coordinator, manager
--   client_ipc_due   certified IPC unpaid after the payment days → coordinator, manager, finance (price roles)
--   retention_release  practical completion / end of DLP reached and nothing requested → coordinator, manager
-- Re-runnable.
-- =============================================================================

create or replace function app.office_approvals_for(p_user uuid)
returns table (kind text, entity_type text, entity_id uuid, project_id uuid, number text, title text, status text,
               requested_by uuid, requested_at timestamptz, is_urgent boolean, actions text[], age_hours numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_role text; v_prices boolean; v_today date := app.eat_date(now());
begin
  select pr.role::text into v_role from public.profiles pr where pr.id = p_user and pr.is_active;
  if v_role is null then return; end if;
  v_prices := v_role = 'admin' or v_role = any (coalesce((select s.price_roles::text[] from public.app_settings s where s.id = 1), '{}'));
  return query
  with mem as (
    select pm.project_id as pid from public.project_members pm where pm.user_id = p_user
    union select pj.id from public.projects pj where v_role = 'admin'),
  st as (select m.pid, (app.ca_settings(m.pid)).* from mem m)
  -- RFIs overdue with the consultant
  select 'office'::text, 'rfi'::text, r.id, r.project_id, r.number,
         'Chase the answer to ' || r.number || ': ' || r.subject || ' (' || (v_today - r.due_date) || ' d overdue)',
         r.status, r.created_by, r.created_at, r.priority = 'urgent' or v_today - r.due_date > 7, array['open'],
         round((extract(epoch from now() - r.created_at) / 3600)::numeric, 1)
  from public.rfis r join mem on mem.pid = r.project_id
  where r.kind = 'rfi' and r.status = 'open' and r.ball_in_court <> 'contractor' and r.due_date < v_today
    and v_role in ('office_engineer','coordinator','admin')
  union all
  -- site instructions to act on
  select 'office', 'rfi', r.id, r.project_id, r.number,
         'Act on site instruction ' || r.number || ': ' || r.subject || coalesce(' (comply by ' || to_char(r.due_date, 'DD Mon') || ')', ''),
         r.status, r.created_by, r.created_at, r.priority = 'urgent' or r.due_date < v_today, array['open'],
         round((extract(epoch from now() - r.created_at) / 3600)::numeric, 1)
  from public.rfis r join mem on mem.pid = r.project_id
  where r.kind = 'si' and r.status = 'open' and v_role in ('coordinator','site_engineer','admin')
  union all
  -- answered with an impact, nothing raised yet
  select 'office', 'rfi', r.id, r.project_id, r.number,
         'Raise a variation / EOT for ' || r.number || ' (' ||
           concat_ws(', ', case when r.cost_impact <> 'none' then 'cost impact' end, case when r.time_impact <> 'none' then 'time impact' end) || ')',
         r.status, r.created_by, coalesce(r.answered_on::timestamptz, r.updated_at), false, array['open'],
         round((extract(epoch from now() - r.updated_at) / 3600)::numeric, 1)
  from public.rfis r join mem on mem.pid = r.project_id
  where r.status in ('answered','closed') and (r.cost_impact <> 'none' or r.time_impact <> 'none')
    and ((r.cost_impact = 'none' or r.variation_id is not null) and (r.time_impact = 'none' or r.eot_claim_id is not null)) is false
    and v_role in ('coordinator','manager','admin')
  union all
  -- submittals: response overdue
  select 'office', 'submittal', s.id, s.project_id, s.number,
         'Chase the review of ' || s.number || ' rev ' || s.current_rev || ': ' || s.title || ' (' || (v_today - sr.response_due) || ' d overdue)',
         s.status, s.created_by, sr.created_at, s.required_by is not null and s.required_by <= v_today + 7, array['open'],
         round((extract(epoch from now() - sr.created_at) / 3600)::numeric, 1)
  from public.submittals s join mem on mem.pid = s.project_id
  join public.submittal_revisions sr on sr.submittal_id = s.id and sr.rev = s.current_rev
  where s.status = 'submitted' and sr.response_due < v_today and v_role in ('office_engineer','coordinator','admin')
  union all
  -- submittals returned C / D
  select 'office', 'submittal', s.id, s.project_id, s.number,
         'Revise and resubmit ' || s.number || ': ' || s.title || ' (code ' || case s.status when 'rejected' then 'D' else 'C' end || ')',
         s.status, s.created_by, s.updated_at, s.required_by is not null and s.required_by <= v_today + 7, array['open'],
         round((extract(epoch from now() - s.updated_at) / 3600)::numeric, 1)
  from public.submittals s join mem on mem.pid = s.project_id
  where s.status in ('revise_resubmit','rejected') and (s.created_by = p_user or v_role in ('coordinator','admin'))
    and v_role in ('office_engineer','coordinator','manager','procurement','admin')
  union all
  -- approval needed soon (draft not yet sent)
  select 'office', 'submittal', s.id, s.project_id, s.number,
         'Approval needed by ' || to_char(s.required_by, 'DD Mon') || ' — ' || s.number || ' ' || s.title || ' is still a draft',
         s.status, s.created_by, s.created_at, s.required_by <= v_today, array['open'],
         round((extract(epoch from now() - s.created_at) / 3600)::numeric, 1)
  from public.submittals s join mem on mem.pid = s.project_id
  where s.status = 'draft' and s.required_by is not null and s.required_by <= v_today + 14 and v_role in ('office_engineer','coordinator','admin')
  union all
  -- my action items
  select 'office', 'meeting_action', a.id, a.project_id, coalesce(m.number, 'Action'),
         'Action: ' || left(a.description, 120) || coalesce(' (due ' || to_char(a.due_date, 'DD Mon') || ')', ''),
         a.status, a.created_by, a.created_at, a.due_date < v_today, array['done'],
         round((extract(epoch from now() - a.created_at) / 3600)::numeric, 1)
  from public.meeting_actions a join mem on mem.pid = a.project_id join st on st.pid = a.project_id
  left join public.meetings m on m.id = a.meeting_id
  where a.status = 'open' and a.owner_id = p_user and (m.id is null or m.status = 'issued')
    and (a.due_date is null or a.due_date <= v_today + st.reminder_days)
  union all
  -- my risks to review
  select 'office', 'risk', k.id, k.project_id, k.number,
         'Review ' || k.kind || ' ' || k.number || ': ' || k.title || ' (score ' || k.score || ')',
         k.status, k.created_by, k.updated_at, k.score >= 15, array['open'],
         round((extract(epoch from now() - k.updated_at) / 3600)::numeric, 1)
  from public.risks k join mem on mem.pid = k.project_id
  where k.status <> 'closed' and k.owner_id = p_user and k.review_by is not null and k.review_by <= v_today
  union all
  -- EOT notice deadline
  select 'office', 'eot_claim', e.id, e.project_id, e.number,
         'Send the delay notice for ' || e.number || ': ' || e.title || ' — deadline ' || to_char(e.event_from + st.claim_notice_days, 'DD Mon YYYY'),
         e.status, e.created_by, e.created_at, e.event_from + st.claim_notice_days <= v_today, array['open'],
         round((extract(epoch from now() - e.created_at) / 3600)::numeric, 1)
  from public.eot_claims e join mem on mem.pid = e.project_id join st on st.pid = e.project_id
  where e.status = 'draft' and e.event_from + st.claim_notice_days <= v_today + 7 and v_role in ('coordinator','manager','admin')
  union all
  -- EOT detailed claim due after the notice
  select 'office', 'eot_claim', e.id, e.project_id, e.number,
         'Submit the detailed claim ' || e.number || ' — due ' || to_char(e.notice_date + st.claim_particulars_days, 'DD Mon YYYY'),
         e.status, e.created_by, e.updated_at, e.notice_date + st.claim_particulars_days <= v_today, array['open'],
         round((extract(epoch from now() - e.updated_at) / 3600)::numeric, 1)
  from public.eot_claims e join mem on mem.pid = e.project_id join st on st.pid = e.project_id
  where e.status = 'notice_sent' and e.notice_date + st.claim_particulars_days <= v_today + 7 and v_role in ('coordinator','manager','admin')
  union all
  -- client payment overdue
  select 'office', 'client_ipc_due', i.id, i.project_id, 'IPC ' || i.ipc_no,
         'Client payment overdue: IPC ' || i.ipc_no || ' — ' || to_char(coalesce((i.certified ->> 'payable')::numeric, 0) - i.paid_amount, 'FM999,999,999,990') || ' ETB, '
           || (v_today - (i.certified_on + c.payment_days)) || ' d late',
         i.status, i.prepared_by, i.certified_on::timestamptz, v_today - (i.certified_on + c.payment_days) > 30, array['open'],
         round((extract(epoch from now() - i.certified_on::timestamptz) / 3600)::numeric, 1)
  from public.client_ipcs i join mem on mem.pid = i.project_id join public.client_contracts c on c.project_id = i.project_id
  where v_prices and v_role in ('coordinator','manager','finance','admin') and i.status = 'certified'
    and i.certified_on + c.payment_days < v_today and coalesce((i.certified ->> 'payable')::numeric, 0) - i.paid_amount > 0.005
  union all
  -- retention release due
  select 'office', 'retention_release', c.project_id, c.project_id, 'Retention',
         case when rs.pc_release_due then 'Request the retention release at practical completion (' || to_char(rs.pc_release_amount, 'FM999,999,999,990') || ' ETB)'
              else 'Request the final retention release — DLP ended ' || to_char(rs.dlp_end, 'DD Mon YYYY') || ' (' || to_char(rs.final_release_amount, 'FM999,999,999,990') || ' ETB)' end,
         'due', null::uuid, coalesce(rs.dlp_end, rs.practical_completion_on)::timestamptz, rs.final_release_due, array['open'], 0::numeric
  from public.client_contracts c join mem on mem.pid = c.project_id
  join lateral (select * from public.v_retention_status v where v.project_id = c.project_id) rs on true
  where v_prices and v_role in ('coordinator','manager','admin') and (rs.pc_release_due or rs.final_release_due);
end $$;
revoke execute on function app.office_approvals_for(uuid) from public;
insert into app.approval_sources (fn) values ('app.office_approvals_for') on conflict do nothing;

-- One row per project the caller belongs to: registers at a glance (progress / money come from v_progress_overview,
-- v_client_receivables on the page, so price rules stay with those views).
create or replace view public.v_office_portfolio with (security_invoker = true) as
select pj.id as project_id, pj.code, pj.name, pj.client, pj.start_date, pj.end_date, pj.is_active,
       cd.revised_completion, cd.days_granted, cd.days_pending,
       (select count(*) from public.rfis r where r.project_id = pj.id and r.kind = 'rfi' and r.status = 'open') as rfis_open,
       (select count(*) from public.rfis r where r.project_id = pj.id and r.kind = 'rfi' and r.status = 'open' and r.due_date < app.eat_date(now())) as rfis_overdue,
       (select count(*) from public.rfis r where r.project_id = pj.id and r.kind = 'si' and r.status = 'open') as sis_open,
       (select count(*) from public.submittals s where s.project_id = pj.id and s.status in ('draft','submitted','revise_resubmit','rejected')) as submittals_pending,
       (select count(*) from public.meeting_actions a where a.project_id = pj.id and a.status = 'open' and a.due_date < app.eat_date(now())) as actions_overdue,
       (select count(*) from public.risks k where k.project_id = pj.id and k.status <> 'closed' and k.score >= 15) as risks_high,
       (select count(*) from public.eot_claims e where e.project_id = pj.id and e.status in ('draft','notice_sent','submitted')) as claims_open
from public.projects pj left join public.v_completion_dates cd on cd.project_id = pj.id
where app.is_member(pj.id);
grant select on public.v_office_portfolio to authenticated;

notify pgrst, 'reload schema';
