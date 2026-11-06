// Home (spec §4.3): hero action, "Needs you" task inbox, 4 KPIs, quick actions.
// Every count comes from SQL COUNT(*) (lib/counts.ts), not list() + JS filtering.
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, type Href } from 'expo-router';
import { useData, useDataVersion, useSession } from '../../lib/app';
import { canProcure } from '../../lib/contract-procurement';
import { canControl, ROLE_LABELS_AM } from '../../lib/contract-control';
import { criticalOpenAlerts, pcCounts, vehicleLog } from '../../lib/pc';
import { t, useLocale } from '../../lib/i18n';
import { dashboardCounts, fieldCounts, jf, mrField, mrRows, mrStatusIn, rowsWhere, type DashboardCounts } from '../../lib/counts';
import { fieldTasks } from '../../components/field';
import { ProgressOverviewCard, scheduleTasks } from '../../components/schedule';
import { scheduleCounts } from '../../lib/counts';
import { flowInboxCounts, flowInboxItems, type FlowInboxItem, type FlowInboxKind } from '../../lib/counts';
import { ft, ftx } from '../../lib/flows-i18n';
import { ROLE_LABELS, can, type Miv } from '../../lib/contract';
import { ago, fmtDate, today } from '../../lib/format';
import { printStockStatus } from '../../lib/print';
import { space, type Tone } from '../../theme';
import {
  ActionTile, Banner, Card, Grid, HeroAction, KpiTile, LastSynced, ListRow, Screen, Section, Sheet, Text, type IconName,
} from '../../components/ui';
import { kindFor, type RoleKind } from '../../components/AppChrome';

interface Task { id: string; icon: IconName; tone: Tone; title: string; sub: string; href: Href; stripe: Tone }
interface Kpi { label: string; value: number | string; sub?: string; tone?: Tone; href: Href }
interface QA { icon: IconName; label: string; href?: Href; onPress?: () => void; tone?: Tone }

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? t('home.morning') : h < 17 ? t('home.afternoon') : t('home.evening');
};

/** Procurement + gate + alert tasks (critical alerts first). */
function pcTasks(kind: RoleKind, role: Parameters<typeof canControl>[0], projectId: string, p: ReturnType<typeof pcCounts>): { tasks: Task[]; total: number } {
  const tasks: Task[] = [];
  let total = 0;
  if (canControl(role, 'alert.manage') && p.criticalAlerts) {
    criticalOpenAlerts(projectId).slice(0, 2).forEach((a) => tasks.push({ id: `al:${a.id}`, icon: 'bell-alert-outline', tone: 'danger', stripe: 'danger', title: a.title, sub: a.details?.summary ?? t('home.criticalAlertsSub'), href: '/alerts' }));
    total += p.criticalAlerts;
  }
  if (canProcure(role, 'po.approve') && p.posToApprove) { tasks.push({ id: 'po', icon: 'cart-outline', tone: 'info', stripe: 'info', title: t('home.posToApprove', { n: p.posToApprove }), sub: t('act.purchaseOrders'), href: '/approvals?tab=pos' }); total += p.posToApprove; }
  if (canControl(role, 'gatepass.approve') && p.gateToApprove) { tasks.push({ id: 'gp', icon: 'boom-gate-outline', tone: 'warning', stripe: 'warning', title: t('home.gateToApprove', { n: p.gateToApprove }), sub: t('gate.passes'), href: '/approvals?tab=gate' }); total += p.gateToApprove; }
  if ((kind === 'store' || kind === 'procurement') && p.expectedDelayed) { tasks.push({ id: 'del', icon: 'clock-alert-outline', tone: 'danger', stripe: 'danger', title: `${t('home.expected')} · ${t('home.delayed', { n: p.expectedDelayed })}`, sub: kind === 'store' ? t('home.receive') : t('act.purchaseOrders'), href: kind === 'store' ? '/procurement/deliveries' : '/procurement' }); total += p.expectedDelayed; }
  if ((kind === 'gate' || kind === 'store') && p.overdue) { tasks.push({ id: 'ovd', icon: 'clock-alert-outline', tone: 'danger', stripe: 'danger', title: `${t('gate.overdue')} · ${p.overdue}`, sub: t('gate.onLoan'), href: '/passes' }); total += p.overdue; }
  if (kind === 'gate' && p.pendingExit) { tasks.push({ id: 'exit', icon: 'boom-gate-outline', tone: 'info', stripe: 'info', title: `${t('gate.pendingExit')} · ${p.pendingExit}`, sub: t('gate.scanHint'), href: '/passes' }); total += p.pendingExit; }
  return { tasks, total };
}

/** Material procurement flow items (v_my_approvals kinds) as home tasks. */
const FLOW_ICON: Record<FlowInboxKind, IconName> = {
  pr_review: 'cart-outline', pr_approve: 'check-decagram-outline', pr_accept: 'cart-arrow-down', mr_review: 'clipboard-check-outline',
  mr_approve: 'check-decagram-outline', sur_issue: 'tray-arrow-up', delivery_ack: 'truck-delivery-outline', miv_ack: 'account-clock-outline',
};
function flowTask(x: FlowInboxItem): Task {
  const href: Href = x.kind === 'sur_issue' ? `/store/issue?mr=${x.id}` : x.kind === 'delivery_ack' ? ('/store/deliveries' as Href)
    : x.kind === 'miv_ack' ? `/store/doc?type=miv&id=${x.id}` : `/requests/${x.id}`;
  const tone: Tone = x.urgent ? 'danger' : x.kind === 'delivery_ack' || x.kind === 'sur_issue' ? 'warning' : 'info';
  const parts = [ftx(`flow.task.${x.kind}`, x.kind), x.at ? ft('flow.waiting', { t: ago(x.at).replace(' ago', '') }) : null,
    x.required ? (x.kind === 'delivery_ack' ? ft('flow.expectedOn', { d: fmtDate(x.required) }) : ft('flow.needed', { d: fmtDate(x.required) })) : null];
  return { id: `${x.kind}:${x.id}`, icon: FLOW_ICON[x.kind], tone, stripe: tone, title: x.number, sub: parts.filter(Boolean).join(' · '), href };
}
function flowTasks(projectId: string, userId: string, role: string, kinds: FlowInboxKind[]): { tasks: Task[]; total: number } {
  const n = flowInboxCounts(projectId, userId, role);
  return { tasks: flowInboxItems(projectId, userId, role, kinds, 3).slice(0, 3).map(flowTask), total: kinds.reduce((sum, k) => sum + n[k], 0) };
}

function buildTasks(kind: RoleKind, projectId: string, userId: string, c: DashboardCounts, role: string): { tasks: Task[]; total: number; all: Href } {
  const tasks: Task[] = [];
  let total = 0;
  if (c.failedSync) {
    tasks.push({ id: 'sync', icon: 'cloud-alert-outline', tone: 'danger', stripe: 'danger', title: `${c.failedSync} change${c.failedSync > 1 ? 's' : ''} rejected by the server`, sub: 'Tap to fix or discard', href: '/sync' });
    total += 1;
  }
  const mrTask = (r: ReturnType<typeof mrRows>[number], verb: string, href: Href, tone: Tone): Task => ({
    id: r.id, icon: 'clipboard-list-outline', tone, stripe: tone, title: r.number,
    sub: `${verb} · ${r.lineCount} line${r.lineCount === 1 ? '' : 's'} · needed ${fmtDate(r.required_date)}`, href,
  });
  if (kind === 'store') {
    const fl = flowTasks(projectId, userId, role, ['delivery_ack', 'sur_issue']);
    tasks.push(...fl.tasks);
    total += fl.total;
    if (c.incoming) { tasks.push({ id: 'trf', icon: 'truck-fast-outline', tone: 'info', stripe: 'info', title: `${c.incoming} transfer${c.incoming > 1 ? 's' : ''} arriving`, sub: 'Confirm what you received', href: '/store/transfer' }); total += c.incoming; }
    return { tasks, total, all: '/queue' };
  }
  if (kind === 'site') {
    mrRows(projectId, `${mrStatusIn(['returned'])} AND ${mrField('requested_by')} = ?`, [userId], `${mrField('updated_at')} DESC`, 3)
      .forEach((r) => tasks.push(mrTask(r, 'Returned to you · fix and resubmit', `/requests/${r.id}`, 'warning')));
    rowsWhere<Miv>('mivs', projectId, `AND ${jf('issued_to')} = ? AND ${jf('status')} = 'pending_ack'`, [userId], `${jf('issued_at')} ASC`, 3)
      .forEach((m) => tasks.push({ id: m.id, icon: 'account-clock-outline', tone: 'warning', stripe: 'warning', title: m.number, sub: `Issued to you ${ago(m.issued_at)} · sign off`, href: `/store/doc?type=miv&id=${m.id}` }));
    if (c.toConfirm) tasks.push({ id: 'grn', icon: 'truck-check-outline', tone: 'info', stripe: 'info', title: `${c.toConfirm} deliver${c.toConfirm > 1 ? 'ies' : 'y'} for your requests`, sub: 'Confirm receipt', href: '/acknowledge' });
    total += c.returned + c.toAck + c.toConfirm;
    return { tasks, total, all: '/acknowledge' };
  }
  if (kind === 'office') {
    const fl = flowTasks(projectId, userId, role, ['mr_review']);
    tasks.push(...fl.tasks);
    mrRows(projectId, `${mrStatusIn(['returned'])} AND ${mrField('requested_by')} = ?`, [userId], `${mrField('updated_at')} DESC`, 2)
      .forEach((r) => tasks.push(mrTask(r, ft('flow.task.returned'), `/requests/${r.id}`, 'warning')));
    if (c.toVerify) tasks.push({ id: 'verify', icon: 'shield-check-outline', tone: 'warning', stripe: 'warning', title: `${c.toVerify} progress report${c.toVerify > 1 ? 's' : ''} to verify`, sub: 'Check and verify site progress', href: '/progress/verify' });
    total += fl.total + c.returned + c.toVerify;
    return { tasks, total, all: '/approvals' };
  }
  if (kind === 'management') {
    const fl = flowTasks(projectId, userId, role, ['pr_review', 'pr_approve', 'mr_approve']);
    tasks.push(...fl.tasks);
    if (c.adjustments + c.counts) tasks.push({ id: 'adj', icon: 'delete-variant', tone: 'warning', stripe: 'warning', title: `${c.adjustments + c.counts} stock adjustment${c.adjustments + c.counts > 1 ? 's' : ''} to decide`, sub: 'Wastage, damage and counts', href: '/approvals?tab=adjustments' });
    if (c.emergency) tasks.push({ id: 'em', icon: 'fire', tone: 'danger', stripe: 'danger', title: `${c.emergency} emergency issue${c.emergency > 1 ? 's' : ''} to regularise`, sub: 'Within 24 h of issue', href: '/approvals?tab=emergency' });
    total += fl.total + c.adjustments + c.counts + c.emergency;
    return { tasks, total, all: '/approvals' };
  }
  if (kind === 'gate') return { tasks, total, all: '/passes' };
  // procurement
  const fl = flowTasks(projectId, userId, role, ['pr_accept']);
  tasks.push(...fl.tasks);
  total += fl.total;
  return { tasks, total, all: '/approvals' };
}

export default function Home() {
  const { profile, project } = useSession();
  const kind = kindFor(profile.role);
  const [more, setMore] = useState(false);
  const { locale } = useLocale();
  const v = useDataVersion();
  const data = useData(() => {
    const c = dashboardCounts(project.id, profile.id);
    const p = pcCounts(project.id, v);
    const vehiclesToday = kind === 'gate' ? vehicleLog(project.id, 500).filter((m) => m.at.slice(0, 10) === today()).length : 0;
    const pt = pcTasks(kind, profile.role, project.id, p);
    const b0 = buildTasks(kind, project.id, profile.id, c, profile.role);
    const b = { ...b0, tasks: [...b0.tasks.filter((x) => x.id === 'sync'), ...pt.tasks, ...b0.tasks.filter((x) => x.id !== 'sync')], total: b0.total + pt.total };
    // field & quality items (diary, snags, cubes, inspections, trucks) after any sync failure
    const f = fieldTasks(profile.role, fieldCounts(project.id, profile.id));
    // schedule progress + look-ahead (overdue tasks, constraints I own, ready work to commit, tasks to verify)
    const s = scheduleTasks(profile.role, scheduleCounts(project.id, profile.id));
    const sync = b.tasks.filter((x) => x.id === 'sync');
    const fl = flowInboxCounts(project.id, profile.id, profile.role);
    return { c, p, fl, vehiclesToday, ...b, tasks: [...sync, ...f.tasks, ...s.tasks, ...b.tasks.filter((x) => x.id !== 'sync')], total: b.total + f.total + s.total };
  }, [project.id, profile.id, kind, locale]);
  const { c, p, fl, vehiclesToday, tasks, total, all } = data;

  const { hero, kpis, actions, extra } = useMemo(() => {
    const zeroOk = (n: number, tone: Tone): Tone => (n ? tone : 'neutral');
    let hero: { icon: IconName; label: string; hint?: string; href: Href } | null = null;
    let kpis: Kpi[] = [];
    let extra: Kpi[] = [];
    let actions: QA[] = [];
    if (kind === 'store') {
      hero = { icon: 'tray-arrow-down', label: t('home.receive'), hint: p.expected ? `${t('home.expected')}: ${p.expected}${p.expectedDelayed ? ` · ${t('home.delayed', { n: p.expectedDelayed })}` : ''}` : c.awaitingIssue ? `${c.awaitingIssue} approved request${c.awaitingIssue > 1 ? 's' : ''} open` : t('home.receiveHint'), href: '/store/receive' };
      kpis = [
        { label: t('kpi.awaitingIssue'), value: fl.sur_issue, sub: ft('flow.storeOrders'), tone: 'info', href: '/queue' },
        { label: t('kpi.lowStock'), value: c.lowStock, sub: 'At or below reorder', tone: zeroOk(c.lowStock, 'danger'), href: '/stock?low=1' },
        { label: t('kpi.due'), value: c.dueToday, sub: 'Required date reached', tone: zeroOk(c.dueToday, 'warning'), href: '/queue' },
        { label: t('kpi.expected'), value: p.expected, sub: p.expectedDelayed ? t('home.delayed', { n: p.expectedDelayed }) : 'From purchase orders', tone: zeroOk(p.expectedDelayed, 'danger'), href: '/procurement/deliveries' },
      ];
      extra = [
        { label: t('kpi.transfersIn'), value: c.incoming, href: '/store/transfer' },
        { label: t('gate.onLoan'), value: p.onLoan, href: '/passes' },
        { label: 'Adjustments pending', value: c.adjustments, href: '/docs?type=adjustment' },
        { label: 'Counts pending', value: c.counts, href: '/docs?type=count' },
      ];
      actions = [
        { icon: 'tray-arrow-up', label: t('act.issue'), href: '/queue' },
        { icon: 'keyboard-return', label: t('act.return'), href: '/store/return' },
        { icon: 'counter', label: t('act.count'), href: '/store/count' },
        { icon: 'delete-variant', label: t('act.wastage'), href: '/store/wastage', tone: 'warning' },
        { icon: 'boom-gate-outline', label: t('act.gatePass'), href: '/passes' },
        { icon: 'dots-horizontal', label: t('act.more'), onPress: () => setMore(true), tone: 'neutral' },
      ];
    } else if (kind === 'site') {
      hero = { icon: 'plus', label: t('home.newRequest'), hint: t('home.newRequestHint'), href: '/requests/new' };
      kpis = [
        { label: t('kpi.myOpen'), value: c.myOpen, tone: 'info', href: '/requests?filter=mine' },
        { label: t('kpi.issuedToMe'), value: c.toAck, sub: 'Awaiting my sign-off', tone: zeroOk(c.toAck, 'warning'), href: '/acknowledge' },
        { label: t('kpi.activeElements'), value: c.active, sub: "Update today's progress", tone: 'info', href: '/progress?filter=active' },
        { label: t('kpi.delayedElements'), value: c.delayed, tone: zeroOk(c.delayed, 'danger'), href: '/progress?filter=delayed' },
      ];
      extra = [
        { label: 'Arrived for me', value: c.toConfirm, href: '/acknowledge' },
        { label: 'Returned to me', value: c.returned, href: '/requests?filter=mine' },
      ];
      actions = [
        { icon: 'progress-wrench', label: t('act.updateProgress'), href: '/progress?filter=active' },
        { icon: 'clipboard-list-outline', label: t('act.requests'), href: '/requests' },
        { icon: 'account-clock-outline', label: t('act.signOff'), href: '/acknowledge' },
        { icon: 'calendar-month-outline', label: t('la.title'), href: '/lookahead' as Href },
        { icon: 'notebook-edit-outline', label: 'Site diary', href: `/diary/edit?date=${today()}` as Href },
        { icon: 'dots-horizontal', label: t('act.more'), onPress: () => setMore(true), tone: 'neutral' },
      ];
    } else if (kind === 'office') {
      hero = { icon: 'calendar-outline', label: t('home.lookahead'), hint: t('home.lookaheadHint'), href: '/requests/new?lookahead=1' };
      kpis = [
        { label: t('kpi.awaitingReview'), value: fl.mr_review, sub: 'Check vs take-off', tone: zeroOk(fl.mr_review, 'warning'), href: '/approvals' },
        { label: t('kpi.toVerify'), value: c.toVerify, tone: zeroOk(c.toVerify, 'warning'), href: '/progress/verify' },
        { label: t('kpi.boqAlerts'), value: c.overBoq, sub: 'Requests above take-off', tone: zeroOk(c.overBoq, 'danger'), href: '/approvals' },
        { label: t('kpi.overall'), value: `${c.avgProgress.toFixed(1)}%`, sub: `${c.elements} elements`, tone: 'info', href: '/progress' },
      ];
      extra = [
        { label: 'Look-ahead 14 days', value: c.lookahead, href: '/requests?filter=lookahead' },
        { label: 'Delayed elements', value: c.delayed, href: '/progress?filter=delayed' },
      ];
      actions = [
        { icon: 'shield-check-outline', label: t('act.verifyProgress'), href: '/progress/verify' },
        { icon: 'cart-plus', label: ft('flow.newPurchase'), href: '/requests/purchase' as Href },
        { icon: 'clipboard-list-outline', label: t('act.requests'), href: '/requests' },
        { icon: 'warehouse', label: t('act.stock'), href: '/stock' },
        { icon: 'calendar-month-outline', label: t('la.title'), href: '/lookahead' as Href },
        { icon: 'dots-horizontal', label: t('act.more'), onPress: () => setMore(true), tone: 'neutral' },
      ];
    } else if (kind === 'gate') {
      hero = { icon: 'qrcode-scan', label: t('gate.scan'), hint: t('gate.scanHint'), href: '/gate/scan' };
      kpis = [
        { label: t('gate.pendingExit'), value: p.pendingExit, sub: 'Approved, not yet out', tone: 'info', href: '/passes' },
        { label: t('gate.onLoan'), value: p.onLoan, sub: 'Returnable items out', tone: 'info', href: '/passes' },
        { label: t('gate.overdue'), value: p.overdue, tone: zeroOk(p.overdue, 'danger'), href: '/passes' },
        { label: t('gate.vehicle'), value: vehiclesToday, sub: t('home.today'), tone: 'info', href: '/gate/vehicle' },
      ];
      actions = [
        { icon: 'qrcode-scan', label: t('common.scan'), href: '/gate/scan' },
        { icon: 'car-outline', label: t('gate.vehicle'), href: '/gate/vehicle' },
        { icon: 'boom-gate-outline', label: t('gate.passes'), href: '/passes' },
      ];
    } else {
      const isProc = kind === 'procurement';
      kpis = [
        { label: t('kpi.pendingApprovals'), value: fl.mr_approve + fl.pr_review + fl.pr_approve + p.posToApprove + p.gateToApprove, sub: c.oldestPending ? `Oldest ${ago(c.oldestPending)}` : undefined, tone: zeroOk(fl.mr_approve + fl.pr_review + fl.pr_approve + p.posToApprove + p.gateToApprove, 'warning'), href: '/approvals' },
        { label: t('kpi.overall'), value: `${c.avgProgress.toFixed(1)}%`, sub: `${c.delayed} delayed`, tone: 'info', href: '/progress' },
        { label: t('kpi.shortages'), value: c.lowStock, sub: 'At or below reorder', tone: zeroOk(c.lowStock, 'danger'), href: '/stock?low=1' },
        { label: isProc ? t('kpi.toSource') : t('kpi.awaitingIssue'), value: c.awaitingIssue, tone: 'info', href: '/requests?filter=to_issue' },
      ];
      if (isProc) kpis[0] = { label: t('kpi.toSource'), value: fl.pr_accept, tone: zeroOk(fl.pr_accept, 'warning'), href: '/approvals' };
      if (isProc) kpis[1] = { label: t('kpi.expected'), value: p.expected, sub: p.expectedDelayed ? t('home.delayed', { n: p.expectedDelayed }) : undefined, tone: zeroOk(p.expectedDelayed, 'danger'), href: '/procurement' };
      if (isProc) kpis[3] = { label: t('kpi.lookahead14'), value: c.lookahead, tone: 'info', href: '/requests?filter=lookahead' };
      extra = [
        ...(!isProc ? [{ label: t('title.alerts'), value: p.openAlerts, href: '/alerts' as Href }] : []),
        { label: 'Adjustments & counts', value: c.adjustments + c.counts, href: '/approvals?tab=adjustments' },
        { label: 'Emergency issues', value: c.emergency, href: '/approvals?tab=emergency' },
        { label: t('kpi.openPos'), value: p.expected, href: '/procurement' },
      ];
      actions = isProc ? [
        { icon: 'cart-outline', label: t('act.purchaseOrders'), href: '/procurement' },
        { icon: 'tag-outline', label: t('act.logPrice'), href: '/procurement/price' },
        { icon: 'cart-arrow-down', label: t('act.reorder'), href: '/procurement/reorder' },
        { icon: 'clipboard-list-outline', label: t('act.requests'), href: '/requests' },
        { icon: 'warehouse', label: t('act.stock'), href: '/stock' },
        { icon: 'file-pdf-box', label: t('act.stockReport'), onPress: () => void printStockStatus(project.id) },
      ] : [
        { icon: 'check-decagram-outline' as IconName, label: t('act.approvals'), href: '/approvals' as Href },
        ...(profile.role === 'coordinator' || profile.role === 'manager' || profile.role === 'admin' ? [{ icon: 'calendar-month-outline' as IconName, label: t('la.title'), href: '/lookahead' as Href }] : []),
        { icon: 'bell-alert-outline' as IconName, label: t('act.alerts'), href: '/alerts' as Href, tone: p.criticalAlerts ? 'danger' : undefined },
        { icon: 'clipboard-list-outline', label: t('act.requests'), href: '/requests' },
        ...(can(profile.role, 'mr.create') ? [{ icon: 'plus' as IconName, label: t('home.newRequest'), href: '/requests/new' as Href }] : []),
        { icon: 'cart-outline', label: t('act.purchaseOrders'), href: '/procurement' },
        { icon: 'chart-gantt', label: t('act.progress'), href: '/progress' },
        { icon: 'file-pdf-box', label: t('act.stockReport'), onPress: () => void printStockStatus(project.id) },
      ];
      actions = actions.slice(0, 6);
    }
    return { hero, kpis, actions, extra };
  }, [kind, c, p, fl, vehiclesToday, profile.role, project.id, locale]);

  const go = (h: Href) => router.push(h);
  const first = profile.full_name.split(' ')[0] || profile.full_name;

  return (
    <Screen insetBottom={false} gap={space[4]}>
      <Text variant="bodySm" tone="muted">{greeting()}, {first} · {locale === 'am' ? ROLE_LABELS_AM[profile.role] : ROLE_LABELS[profile.role]}</Text>
      {hero ? <HeroAction icon={hero.icon} label={hero.label} hint={hero.hint} onPress={() => go(hero.href)} /> : null}

      <Section title={t('home.needsYou')} action={total > tasks.length ? t('home.seeAll', { n: total }) : undefined} onAction={() => go(all)}>
        {tasks.length ? (
          <Card flush>
            {tasks.slice(0, 3).map((x) => (
              <ListRow key={x.id} id={x.id} title={x.title} subtitle={x.sub} icon={x.icon} iconTone={x.tone} stripe={x.stripe} chevron
                onPress={() => go(x.href)} />
            ))}
          </Card>
        ) : (
          <Banner tone="success" icon="check-all" title={t('home.nothing')} text={t('home.nothingBody')} />
        )}
      </Section>

      {kind === 'management' ? <ProgressOverviewCard projectId={project.id} /> : null}

      <Section title={t('home.today')}>
        <Grid>
          {kpis.map((k) => <KpiTile key={k.label} label={k.label} value={k.value} sub={k.sub} tone={k.tone} onPress={() => go(k.href)} />)}
        </Grid>
        {extra.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.more}>
            {extra.map((k) => (
              <View key={k.label} style={styles.moreTile}>
                <KpiTile label={k.label} value={k.value} onPress={() => go(k.href)} zeroIsGood={false} />
              </View>
            ))}
          </ScrollView>
        ) : null}
      </Section>

      <Section title={t('home.quick')}>
        <Grid columns={3}>
          {actions.map((a) => (
            <ActionTile key={a.label} compact icon={a.icon} label={a.label} tone={a.tone ?? 'primary'}
              onPress={a.onPress ?? (() => a.href && go(a.href))} />
          ))}
        </Grid>
      </Section>
      <LastSynced />

      {more ? (
        <Sheet visible={more} onClose={() => setMore(false)} title={t('home.moreActions')}>
          <View style={styles.sheet}>
            {[
              ...(can(profile.role, 'miv.post') ? [{ icon: 'fire' as IconName, label: t('issue.emergency'), href: '/store/issue?emergency=1' as Href }] : []),
              ...(canProcure(profile.role, 'po.receive') ? [{ icon: 'truck-delivery-outline' as IconName, label: t('home.expected'), href: '/procurement/deliveries' as Href }] : []),
              ...(canControl(profile.role, 'gatepass.create') ? [{ icon: 'boom-gate-outline' as IconName, label: t('gate.new'), href: '/gate/new' as Href }] : []),
              ...(canControl(profile.role, 'vehicle.log') ? [{ icon: 'car-outline' as IconName, label: t('gate.vehicle'), href: '/gate/vehicle' as Href }] : []),
              ...(canProcure(profile.role, 'reorder.createMr') ? [{ icon: 'cart-arrow-down' as IconName, label: t('kpi.reorder'), href: '/procurement/reorder' as Href }] : []),
              { icon: 'file-document-multiple-outline' as IconName, label: 'Store documents', href: '/docs' as Href },
              { icon: 'warehouse' as IconName, label: 'Stock', href: '/stock' as Href },
              { icon: 'clipboard-list-outline' as IconName, label: 'Requests', href: '/requests' as Href },
              { icon: 'chart-gantt' as IconName, label: 'Elements & progress', href: '/progress' as Href },
              { icon: 'calendar-month-outline' as IconName, label: t('la.title'), href: '/lookahead' as Href },
              { icon: 'clipboard-check-outline' as IconName, label: 'Site & quality (diary, snags, pours)', href: '/field' as Href },
              ...(can(profile.role, 'progress.verify') ? [{ icon: 'shield-check-outline' as IconName, label: 'Verify progress', href: '/progress/verify' as Href }] : []),
              { icon: 'file-pdf-box' as IconName, label: 'Share stock report (PDF)', onPress: () => void printStockStatus(project.id) },
              { icon: 'cog-outline' as IconName, label: t('common.settings'), href: '/settings' as Href },
            ].map((a) => (
              <ListRow key={a.label} id={a.label} title={a.label} icon={a.icon} chevron
                onPress={() => { setMore(false); if ('href' in a && a.href) go(a.href); else if ('onPress' in a && a.onPress) a.onPress(); }} />
            ))}
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  more: { gap: space[3], paddingTop: space[3] },
  moreTile: { width: 160 },
  sheet: { paddingBottom: space[2] },
});
