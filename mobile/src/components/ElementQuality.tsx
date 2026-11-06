// "Quality" section on the element detail (Progress tab): hold-point inspections
// (request / do / open the pending one) and links to the element's inspections,
// snags, pours and rebar BBS reconciliation. All counts are local reads.
import React from 'react';
import { router } from 'expo-router';
import { useData, useSession } from '../lib/app';
import { list } from '../lib/db';
import type { ElementActivity } from '../lib/contract';
import { canField, type Inspection, type Snag } from '../lib/contract-field';
import { holdPointState, pourElements, rebarReconciliation } from '../lib/field';
import { jf, rowsWhere } from '../lib/counts';
import type { Pour } from '../lib/contract-field';
import { Button, Card, Chip, ListRow, Row, Section, Text } from './ui';

export function ElementQuality({ elementId }: { elementId: string }) {
  const { profile, project } = useSession();
  const d = useData(() => {
    const acts = list<ElementActivity>('element_activities', { parent: elementId }).filter((a) => a.is_hold_point).sort((a, b) => a.seq - b.seq);
    const ins = list<Inspection>('inspections', { parent: elementId });
    const snags = list<Snag>('snags', { parent: elementId }).filter((s) => !['closed', 'cancelled'].includes(s.status));
    const pours = rowsWhere<Pour>('pours', project.id, `AND ${jf('status')} != 'cancelled'`).filter((p) => pourElements(p.id).some((e) => e.element_id === elementId && !e.deleted_at));
    const rebar = rebarReconciliation(elementId);
    return {
      holds: acts.map((a) => ({ a, st: holdPointState(project.id, a.id), requested: ins.find((i) => i.element_activity_id === a.id && i.status === 'requested') ?? null })),
      inspections: ins.length, requested: ins.filter((i) => i.status === 'requested').length, snags: snags.length,
      pours: pours.length, activePours: pours.filter((p) => p.status === 'planned' || p.status === 'in_progress').length,
      rebarFlags: rebar.filter((r) => r.flag !== 'ok').length, rebarRows: rebar.length,
    };
  }, [elementId, project.id]);
  const canPerform = canField(profile.role, 'inspection.perform');
  const canRequest = canField(profile.role, 'inspection.request');

  return (
    <Section title="Quality">
      {d.holds.map(({ a, st, requested }) => (
        <Card key={a.id} dense stripe={st.cleared ? 'success' : 'warning'}>
          <Row justify="space-between">
            <Text variant="label" style={{ flex: 1 }}>{a.seq}. {a.name}</Text>
            <Chip label={st.cleared ? 'Cleared' : requested ? 'Inspection requested' : 'Hold point'} tone={st.cleared ? 'success' : requested ? 'info' : 'warning'}
              icon={st.cleared ? 'lock-open-outline' : 'hand-back-left-outline'} small />
          </Row>
          {!st.cleared && st.pending.length ? <Text variant="caption" tone="muted">Needs: {st.pending.map((p) => p.name).join(', ')}</Text> : null}
          {!st.cleared ? (
            requested
              ? <Button title={canPerform ? 'Do inspection' : 'Open request'} size="sm" icon="clipboard-check-outline" variant={canPerform ? 'primary' : 'tonal'}
                  onPress={() => router.push(canPerform ? `/inspections/check?id=${requested.id}` : `/inspections/${requested.id}`)} />
              : canPerform || canRequest
                ? <Button title={canPerform ? 'Do inspection' : 'Request inspection'} size="sm" variant="tonal" icon={canPerform ? 'clipboard-check-outline' : 'send-outline'}
                    onPress={() => router.push(`/inspections/check?element=${elementId}&activity=${a.id}`)} />
                : null
          ) : null}
        </Card>
      ))}
      <Card flush>
        <ListRow id="ins" title="Inspections" subtitle={d.requested ? `${d.requested} requested` : undefined} qty={String(d.inspections)} icon="clipboard-check-outline" chevron
          onPress={() => router.push(`/inspections?element=${elementId}`)} />
        <ListRow id="snags" title="Open snags" qty={String(d.snags)} qtyTone={d.snags ? 'warning' : 'default'} icon="bug-outline" chevron
          onPress={() => router.push(`/snags?element=${elementId}`)} />
        <ListRow id="pours" title="Concrete pours" subtitle={d.activePours ? `${d.activePours} active` : undefined} qty={String(d.pours)} icon="dump-truck" chevron
          onPress={() => router.push(d.pours ? `/pours?element=${elementId}` : `/pours/new?element=${elementId}`)} />
        <ListRow id="bbs" title="Rebar (BBS)" subtitle={d.rebarRows ? (d.rebarFlags ? `${d.rebarFlags} diameter(s) flagged` : 'Within allowance') : 'No BBS / take-off'}
          icon="ruler-square" iconTone={d.rebarFlags ? 'danger' : 'primary'} chevron onPress={() => router.push(`/rebar/${elementId}`)} />
      </Card>
      {canField(profile.role, 'snag.create') ? <Button title="Raise snag" size="sm" variant="ghost" icon="camera-plus-outline" onPress={() => router.push(`/snags/new?element=${elementId}`)} /> : null}
    </Section>
  );
}
