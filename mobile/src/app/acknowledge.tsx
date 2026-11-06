// Engineer: acknowledge issues and confirm deliveries for my requests (FR-ST-02, FR-RC-07).
import React from 'react';
import { Stack, router } from 'expo-router';
import { useData, useSession } from '../lib/app';
import { list } from '../lib/db';
import type { Grn, GrnLine, Miv, MivLine, MrLine, MaterialRequest } from '../lib/contract';
import { specLabel, specUom } from '../lib/queries';
import { enqueue } from '../lib/sync';
import { fmtDateTime, fmtQty } from '../lib/format';
import { Button, Card, EmptyState, InfoRow, Row, Screen, Section, SyncChip, Text, haptic, toast } from '../components/ui';

export default function Acknowledge() {
  const { profile, project } = useSession();
  const d = useData(() => {
    const mivs = list<Miv>('mivs', { project: project.id }).filter((m) => m.issued_to === profile.id && m.status === 'pending_ack');
    const myMrs = new Set(list<MaterialRequest>('material_requests', { project: project.id }).filter((r) => r.requested_by === profile.id).map((r) => r.id));
    const myLines = new Set(list<MrLine>('mr_lines', { project: project.id }).filter((l) => myMrs.has(l.mr_id)).map((l) => l.id));
    const gl = list<GrnLine>('grn_lines', { project: project.id }).filter((l) => l.mr_line_id && myLines.has(l.mr_line_id));
    const gIds = new Set(gl.map((l) => l.grn_id));
    const grns = list<Grn>('grns', { project: project.id }).filter((g) => gIds.has(g.id) && !g.confirmed_by && g.status === 'posted');
    return { mivs, grns, gl };
  }, [project.id, profile.id]);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Sign off & confirm' }} />
      <Section title={`Issued to me · ${d.mivs.length}`}>
        {d.mivs.length ? d.mivs.map((m) => (
          <Card key={m.id} stripe="warning">
            <Row justify="space-between"><Text variant="titleSm">{m.number}</Text><SyncChip entityId={m.id} /></Row>
            <Text variant="caption" tone="muted">{fmtDateTime(m.issued_at)}</Text>
            {list<MivLine>('miv_lines', { parent: m.id }).map((l) => <InfoRow key={l.id} label={specLabel(l.material_spec_id)} value={`${fmtQty(l.qty)} ${specUom(l.material_spec_id)}`} />)}
            <Row>
              <Button title="Open & sign" variant="outline" flex icon="draw-pen" onPress={() => router.push(`/store/doc?type=miv&id=${m.id}`)} />
              <Button title="Acknowledge" flex icon="check" onPress={() => {
                enqueue('acknowledge_miv', { miv_id: m.id }, { entityType: 'miv', entityId: m.id, label: `${m.number} acknowledged` });
                haptic('confirm'); toast.success(`${m.number} acknowledged`);
              }} />
            </Row>
          </Card>
        )) : <EmptyState icon="check-all" tone="success" title="Nothing to sign off" compact />}
      </Section>

      <Section title={`Deliveries for my requests · ${d.grns.length}`}>
        {d.grns.length ? d.grns.map((g) => (
          <Card key={g.id} stripe="info" onPress={() => router.push(`/store/doc?type=grn&id=${g.id}`)}>
            <Row justify="space-between"><Text variant="titleSm">{g.number}</Text><SyncChip entityId={g.id} /></Row>
            <Text variant="caption" tone="muted">{g.supplier_name ?? ''} · {fmtDateTime(g.received_at)}</Text>
            {d.gl.filter((l) => l.grn_id === g.id).map((l) => <InfoRow key={l.id} label={specLabel(l.material_spec_id)} value={`${fmtQty(l.qty_accepted)} accepted`} />)}
            <Button title="Confirm receipt" variant="tonal" icon="check" block onPress={() => {
              enqueue('confirm_grn', { grn_id: g.id }, { entityType: 'grn', entityId: g.id, label: `${g.number} confirmed` });
              haptic('confirm'); toast.success(`${g.number} confirmed`);
            }} />
          </Card>
        )) : <EmptyState icon="truck-check-outline" tone="success" title="No deliveries to confirm" compact />}
      </Section>
    </Screen>
  );
}
