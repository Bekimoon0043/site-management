// Material procurement flow UI (docs/research/schedule-ux.md "flow timeline" + "Your turn"):
// vertical stepper for the request detail, a compact chip for list rows and the ball-in-court banner.
import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MrEvent } from '../lib/contract';
import { flowSteps, isTerminal, stepIndex, type FlowActor, type FlowMrStatus, type RequestType } from '../lib/contract-flows';
import { actorLabel, flowLabel, flowProgress, stepLabel, type FlowMr } from '../lib/flows';
import { ft } from '../lib/flows-i18n';
import { personName } from '../lib/queries';
import { ago, fmtDateTime } from '../lib/format';
import { space, statusInfo, tone as toneOf, useTheme, type Tone } from '../theme';
import { Banner, Card, Chip, Icon, Text, type IconName } from './ui';

/** Compact list-row chip: flow status in words + step k/n. */
export function flowRowChip(status: FlowMrStatus, type: RequestType): { label: string; tone: Tone; icon: IconName } {
  const s = statusInfo(status);
  const p = flowProgress(status, type);
  const label = isTerminal(status) ? flowLabel(status, type) : `${p.k}/${p.n} · ${flowLabel(status, type)}`;
  return { label, tone: s.tone, icon: s.icon };
}

export const FlowChip = memo(function FlowChip({ status, type }: { status: FlowMrStatus; type: RequestType }) {
  const c = flowRowChip(status, type);
  return <Chip label={c.label} tone={c.tone} icon={c.icon} />;
});

interface Props { mr: FlowMr; type: RequestType; events: MrEvent[]; owner: FlowActor | null; myTurn: boolean }

/** Vertical stepper: done steps show who/when (first move into the next step), the current step its owner. */
export function FlowTimeline({ mr, type, events, owner, myTurn }: Props) {
  const t = useTheme();
  const steps = flowSteps(type);
  const terminal = isTerminal(mr.status) && mr.status !== 'closed';
  // where a rejected / cancelled request stopped: the step it left
  let cur = stepIndex(mr.status, type);
  if (cur < 0) {
    const last = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at)).find((e) => e.to_status === mr.status);
    cur = last?.from_status ? stepIndex(last.from_status as FlowMrStatus, type) : 0;
    if (cur < 0) cur = 0;
  }
  const finished = steps[cur]?.actor === null;
  const asc = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const doneBy = (i: number) => {
    const next = steps[i + 1];
    if (!next) return null;
    let hit: MrEvent | null = null;
    for (const e of asc) if (e.to_status && next.statuses.includes(e.to_status as FlowMrStatus)) hit = e;
    return hit;
  };
  const p = flowProgress(mr.status, type);

  return (
    <Card>
      <View style={styles.head}>
        <Text variant="titleSm">{ft('flow.timeline')}</Text>
        <Text variant="caption" tone="muted">{terminal ? ft('flow.stopped', { status: flowLabel(mr.status, type) }) : finished ? ft('flow.finished') : ft('flow.stepOf', { k: p.k, n: p.n })}</Text>
      </View>
      {steps.map((s, i) => {
        const done = i < cur || (finished && i === cur);
        const now = i === cur && !finished;
        const stopped = now && terminal;
        const c = stopped ? toneOf(t, 'danger') : done ? toneOf(t, 'success') : now ? toneOf(t, myTurn ? 'warning' : 'primary') : null;
        const e = done ? doneBy(i) : null;
        const sub = stopped
          ? `${flowLabel(mr.status, type)}${mr.status_reason ? ` · “${mr.status_reason}”` : ''}`
          : now
            ? `${myTurn ? ft('flow.yourTurn') : ft('flow.waitingFor', { who: actorLabel(owner ?? s.actor) })}${mr.updated_at ? ` · ${ago(mr.updated_at)}` : ''}`
            : e ? `${personName(e.actor)} · ${fmtDateTime(e.created_at)}` : null;
        const last = i === steps.length - 1;
        return (
          <View key={s.key} style={styles.step} accessibilityLabel={`${stepLabel(type, s.key, s.label)}${done ? ', done' : now ? ', current' : ''}`}>
            <View style={styles.rail}>
              <View style={[styles.dot, c ? { backgroundColor: c.solid, borderColor: c.solid } : { borderColor: t.border, backgroundColor: t.surface }]}>
                {done ? <Icon name="check" size={16} color={c!.onSolid} /> : stopped ? <Icon name="close" size={16} color={c!.onSolid} />
                  : now ? <View style={[styles.inner, { backgroundColor: c!.onSolid }]} /> : null}
              </View>
              {!last ? <View style={[styles.line, { backgroundColor: done ? toneOf(t, 'success').solid : t.border }]} /> : null}
            </View>
            <View style={styles.body}>
              <Text variant={now ? 'label' : 'bodySm'} tone={done || now ? 'default' : 'muted'}>{stepLabel(type, s.key, s.label)}</Text>
              {sub ? <Text variant="caption" tone={stopped ? 'danger' : now && myTurn ? 'warning' : 'muted'}>{sub}</Text> : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

/** Ball-in-court banner on top of the detail. */
export function YourTurnBanner({ type, status, owner, myTurn, endorsed, since }: {
  type: RequestType; status: FlowMrStatus; owner: FlowActor | null; myTurn: boolean; endorsed: boolean; since: string | null;
}) {
  if (isTerminal(status)) return null;
  const step = flowSteps(type).find((s) => s.statuses.includes(status));
  if (!step || step.actor === null) return null;
  const label = stepLabel(type, step.key, step.label);
  if (endorsed) return <Banner tone="info" icon="timer-sand" text={ft('flow.endorsed')} />;
  if (myTurn) return <Banner tone="warning" icon="hand-back-left-outline" title={ft('flow.yourTurn')} text={label} />;
  return (
    <Banner tone="neutral" icon="timer-sand" title={ft('flow.waitingFor', { who: actorLabel(owner) })}
      text={`${label}${since ? ` · ${ago(since)}` : ''}`} />
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[1] },
  step: { flexDirection: 'row', gap: space[3], minHeight: 44 },
  rail: { width: 24, alignItems: 'center' },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  inner: { width: 8, height: 8, borderRadius: 4 },
  line: { width: 2, flex: 1, minHeight: 12, marginVertical: 2 },
  body: { flex: 1, paddingBottom: space[3], gap: 2 },
});
