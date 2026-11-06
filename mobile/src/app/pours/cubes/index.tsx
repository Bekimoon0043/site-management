// Cubes due (v_cubes_due, computed locally): overdue / due today / next 7 days, then recent results.
import React, { useCallback } from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../../../lib/app';
import { jf, rowsWhere } from '../../../lib/counts';
import type { CubeSet } from '../../../lib/contract-field';
import { cubesDue } from '../../../lib/field';
import { elementLabel } from '../../../lib/queries';
import { fmtDate } from '../../../lib/format';
import { Card, EmptyState, ListRow, Screen, Section } from '../../../components/ui';

export default function CubesDue() {
  const { project } = useSession();
  const d = useData(() => ({
    due: cubesDue(project.id, 7),
    recent: rowsWhere<CubeSet>('cube_sets', project.id, `AND (${jf('result_28d')} IS NOT NULL OR ${jf('result_early')} IS NOT NULL)`, [], `${jf('updated_at')} DESC`, 30),
  }), [project.id]);
  const open = useCallback((id: string) => router.push(`/pours/cubes/${id}`), []);
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Cube tests' }} />
      <Section title="Due">
        {d.due.length ? (
          <Card flush>
            {d.due.map((c) => (
              <ListRow key={`${c.setId}:${c.age}`} id={c.setId} title={`${c.number} · ${c.age}-day test`}
                subtitle={`${c.pourNumber}${c.elementId ? ` · ${elementLabel(c.elementId)}` : ''} · ${c.cubes} cubes${c.lab ? ` · ${c.lab}` : ''}`}
                chip={c.status === 'overdue' ? { label: `Overdue since ${fmtDate(c.due)}`, tone: 'danger', icon: 'clock-alert-outline' }
                  : c.status === 'due' ? { label: 'Due today', tone: 'warning', icon: 'calendar-today' } : { label: `Due ${fmtDate(c.due)}`, tone: 'neutral', icon: 'calendar-outline' }}
                stripe={c.status === 'overdue' ? 'danger' : c.status === 'due' ? 'warning' : null} icon="test-tube" chevron onPress={open} />
            ))}
          </Card>
        ) : <EmptyState compact icon="test-tube" tone="success" title="No cube tests due this week" />}
      </Section>
      <Section title="Recent results">
        {d.recent.length ? (
          <Card flush>
            {d.recent.map((c) => <ListRow key={c.id} id={c.id} title={c.number} subtitle={c.mean_28d_mpa != null ? `28-day mean ${c.mean_28d_mpa} MPa (fck ${c.required_strength_mpa})` : `Early ${c.result_early ?? '—'}`}
              status={c.result_28d ?? c.result_early} icon="test-tube" chevron onPress={open} />)}
          </Card>
        ) : null}
      </Section>
    </Screen>
  );
}
