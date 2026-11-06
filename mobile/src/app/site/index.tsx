// Safety & plant hub: the foreman's daily briefing, high-risk work controls,
// incident follow-up and machine logging. Everything works offline (outbox).
import React from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { list } from '../../lib/db';
import { fmtDateTime, fmtQty, today } from '../../lib/format';
import { personName } from '../../lib/queries';
import {
  INCIDENT_KIND_LABELS, INCIDENT_STATUS_LABELS, PERMIT_TYPE_LABELS, PLANT_STATUS_LABELS, canSite, permitExpired, permitLive,
  type HseIncident, type PlantItem, type PlantLog, type ToolboxTalk, type WorkPermit,
} from '../../lib/contract-site';
import { space } from '../../theme';
import { ActionTile, Banner, Card, EmptyState, Grid, HeroAction, KpiTile, ListRow, Screen, Section } from '../../components/ui';

export default function SiteOpsHub() {
  const { profile, project } = useSession();
  const role = profile.role;
  const d = useData(() => {
    const permits = list<WorkPermit>('work_permits', { project: project.id });
    const incidents = list<HseIncident>('hse_incidents', { project: project.id });
    const plant = list<PlantItem>('plant_items', { project: project.id }).filter((p) => p.status !== 'off_hire');
    const logs = list<PlantLog>('plant_logs', { project: project.id }).filter((l) => l.log_date === today());
    const talks = list<ToolboxTalk>('toolbox_talks', { project: project.id });
    return {
      permits: permits.filter((w) => w.status === 'requested' || w.status === 'approved').sort((a, b) => a.valid_from.localeCompare(b.valid_from)),
      live: permits.filter((w) => permitLive(w)).length,
      openIncidents: incidents.filter((i) => i.status !== 'closed').sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)),
      myActions: incidents.filter((i) => i.status === 'action' && i.action_owner === profile.id),
      plant, logs,
      plantLogged: plant.filter((p) => logs.some((l) => l.plant_id === p.id)).length,
      talkToday: talks.some((t) => t.held_on === today()),
    };
  }, [project.id, profile.id]);
  const worked = d.logs.reduce((s, l) => s + Number(l.hours_worked), 0);
  return (
    <Screen gap={space[4]}>
      <Stack.Screen options={{ title: 'Safety & plant' }} />
      {canSite(role, 'incident.report') ? (
        <HeroAction icon="alert-octagon-outline" label="Report incident or near miss" hint="Straight away — photos help the investigation" onPress={() => router.push('/site/incident')} />
      ) : null}
      <Grid columns={3}>
        {canSite(role, 'toolbox.record') ? <ActionTile compact icon="account-group-outline" label="Toolbox talk" badge={d.talkToday ? undefined : 1} onPress={() => router.push('/site/toolbox')} /> : null}
        {canSite(role, 'permit.request') ? <ActionTile compact icon="fire" label="Permit to work" onPress={() => router.push('/site/permit')} /> : null}
        {canSite(role, 'plant.log') ? <ActionTile compact icon="excavator" label="Plant log" badge={d.plant.length - d.plantLogged || undefined} onPress={() => router.push('/site/plant')} /> : null}
      </Grid>
      {!d.talkToday && canSite(role, 'toolbox.record') ? <Banner tone="warning" title="No toolbox talk recorded today"
        text="Brief the crew on today's work, hazards and PPE before starting." actions={[{ label: 'Record talk', onPress: () => router.push('/site/toolbox') }]} /> : null}
      <Grid columns={2}>
        <KpiTile label="Live permits" value={d.live} />
        <KpiTile label="Open incidents" value={d.openIncidents.length} tone={d.openIncidents.length ? 'warning' : 'neutral'} />
        <KpiTile label="Plant logged today" value={`${d.plantLogged} / ${d.plant.length}`} sub={`${fmtQty(worked, 1)} hours worked`} zeroIsGood={false} />
        <KpiTile label="Plant breakdowns today" value={d.logs.filter((l) => l.status === 'breakdown').length} tone="danger" />
      </Grid>
      {d.myActions.length ? (
        <Section title="My corrective actions">
          <Card flush>
            {d.myActions.map((i) => (
              <ListRow key={i.id} id={i.id} title={i.corrective_action ?? i.description} subtitle={`${i.number} · ${INCIDENT_KIND_LABELS[i.kind]}`}
                meta={i.action_due ? `Due ${i.action_due}` : null} icon="shield-alert-outline" iconTone={i.action_due && i.action_due < today() ? 'danger' : 'warning'}
                chip={i.action_due && i.action_due < today() ? { label: 'Overdue', tone: 'danger' } : null} />
            ))}
          </Card>
        </Section>
      ) : null}
      <Section title="Permits to work" action={canSite(role, 'permit.request') ? 'Request' : undefined} onAction={() => router.push('/site/permit?new=1')}>
        {d.permits.length ? (
          <Card flush>
            {d.permits.map((w) => (
              <ListRow key={w.id} id={w.id} title={w.description} subtitle={`${w.number} · ${PERMIT_TYPE_LABELS[w.permit_type]}`}
                meta={`${fmtDateTime(w.valid_from)} → ${fmtDateTime(w.valid_to)} · ${personName(w.requested_by)}`} icon="fire"
                chip={permitExpired(w) ? { label: 'Expired — close', tone: 'danger' } : permitLive(w) ? { label: 'Live', tone: 'success' }
                  : w.status === 'requested' ? { label: 'To approve', tone: 'warning' } : { label: 'Approved', tone: 'info' }}
                sync={w._pending ? 'pending' : null} chevron onPress={(id) => router.push(`/site/permit?id=${id}`)} />
            ))}
          </Card>
        ) : <EmptyState compact icon="fire" title="No open permits" body="Hot work, work at height, excavation, lifting and electrical work need a permit." />}
      </Section>
      <Section title="Open incidents and near misses">
        {d.openIncidents.length ? <Card flush>{d.openIncidents.slice(0, 5).map((i) => <ListRow key={i.id} id={i.id} title={i.description}
          subtitle={`${i.number} · ${INCIDENT_KIND_LABELS[i.kind]} · ${fmtDateTime(i.occurred_at)}`} meta={i.corrective_action ?? i.immediate_action}
          icon="shield-alert-outline" iconTone={i.severity === 'serious' || i.severity === 'fatal' ? 'danger' : 'warning'}
          chip={{ label: INCIDENT_STATUS_LABELS[i.status], tone: i.status === 'action' ? 'info' : 'warning' }} sync={i._pending ? 'pending' : null} />)}</Card>
          : <EmptyState compact icon="shield-check-outline" title="No open incidents" body="Keep reporting near misses so hazards are corrected before someone is hurt." />}
      </Section>
      <Section title="Today's plant" action="Daily log" onAction={() => router.push('/site/plant')}>
        {d.plant.length ? <Card flush>{d.plant.map((p) => {
          const log = d.logs.find((l) => l.plant_id === p.id);
          return <ListRow key={p.id} id={p.id} title={`${p.code} · ${p.name}`} subtitle={log ? `${log.operator_name ?? 'Operator not recorded'} · ${fmtQty(log.hours_worked, 1)} h worked` : PLANT_STATUS_LABELS[p.status]}
            meta={log?.breakdown_note ?? log?.work_done ?? log?.idle_reason} icon="excavator" iconTone={p.status === 'under_repair' || log?.status === 'breakdown' ? 'danger' : log ? 'success' : 'warning'}
            chip={log ? { label: log.status, tone: log.status === 'working' ? 'success' : log.status === 'idle' ? 'warning' : 'danger' } : { label: 'Not logged', tone: 'warning' }}
            sync={(log?._pending ?? p._pending) ? 'pending' : null} chevron onPress={(id) => router.push(`/site/plant?id=${id}`)} />;
        })}</Card> : <EmptyState compact icon="excavator" title="No plant registered" body="Register owned and hired machines, then log their hours, fuel and breakdowns daily." />}
      </Section>
    </Screen>
  );
}
