// Rebar for one element (features C4): current BBS cut list (synced read-only) and the
// reconciliation BBS kg vs take-off vs issued vs returned per bar diameter with a flag.
// Computed locally from synced tables; when online the server view v_rebar_reconciliation
// is fetched and shown instead. Office engineers can approve a draft BBS.
import React, { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useData, useSession, useSyncState } from '../../lib/app';
import { canField, type RebarReconciliationRow } from '../../lib/contract-field';
import { FLAG_INFO, bbsLines, currentBbs, rebarReconciliation, type RebarRow } from '../../lib/field';
import { elementLabel, personName } from '../../lib/queries';
import { supabase } from '../../lib/supabase';
import { enqueue } from '../../lib/sync';
import { fmtDateTime, fmtQty } from '../../lib/format';
import {
  ActionBar, Banner, Card, Chip, EmptyState, InfoRow, Row, Screen, Section, StatusChip, SyncChip, Text, haptic, toast,
} from '../../components/ui';
import { PhotoStrip } from '../../components/ui';

const fromServer = (r: RebarReconciliationRow): RebarRow => ({
  diameter: r.diameter_mm, bbsKg: Number(r.bbs_kg), takeoffKg: Number(r.takeoff_kg), issuedKg: Number(r.issued_kg), returnedKg: Number(r.returned_kg),
  netKg: Number(r.net_issued_kg), basisKg: Number(r.basis_kg), variancePct: r.variance_pct == null ? null : Number(r.variance_pct), allowancePct: Number(r.allowance_pct), flag: r.flag,
});

export default function RebarElement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useSession();
  const sync = useSyncState();
  const [server, setServer] = useState<RebarRow[] | null>(null);
  const d = useData(() => {
    const bbs = currentBbs(id);
    return { bbs, lines: bbs ? bbsLines(bbs.id) : [], local: rebarReconciliation(id) };
  }, [id]);
  useEffect(() => {
    if (!sync.online) return;
    let on = true;
    void supabase.from('v_rebar_reconciliation').select('*').eq('element_id', id).order('diameter_mm').then(({ data, error }) => {
      if (on && !error && data) setServer((data as RebarReconciliationRow[]).map(fromServer));
    });
    return () => { on = false; };
  }, [id, sync.online, sync.lastSyncAt]);
  const rows = server ?? d.local;
  const { bbs, lines } = d;
  const total = lines.reduce((s, l) => s + Number(l.weight_kg), 0);
  const canApprove = !!bbs && bbs.status === 'draft' && canField(profile.role, 'bbs.edit');
  const flagged = rows.filter((r) => r.flag !== 'ok');

  return (
    <Screen footer={canApprove ? <ActionBar summary={`${bbs!.number} rev ${bbs!.revision} · ${fmtQty(total, 1)} kg`}
      primary={{ title: 'Approve BBS', icon: 'check-decagram-outline', onPress: () => {
        enqueue('approve_bbs', { bbs_id: bbs!.id }, { entityType: 'bbs', entityId: bbs!.id, label: `${bbs!.number} approved` });
        haptic('confirm'); toast.success(`${bbs!.number} approved · saved on phone`);
      } }} /> : undefined}>
      <Stack.Screen options={{ title: `Rebar · ${elementLabel(id)}` }} />
      <Section title="Reconciliation by diameter">
        {flagged.length ? <Banner tone={flagged.some((f) => f.flag === 'over') ? 'danger' : 'warning'} icon="scale-balance"
          title={`${flagged.length} diameter${flagged.length > 1 ? 's' : ''} flagged`} text={flagged.map((f) => `Ø${f.diameter}: ${FLAG_INFO[f.flag].label.toLowerCase()}`).join(' · ')} /> : null}
        {rows.length ? rows.map((r) => (
          <Card key={r.diameter} dense stripe={FLAG_INFO[r.flag].tone === 'success' ? null : FLAG_INFO[r.flag].tone}>
            <Row justify="space-between">
              <Text variant="titleSm">Ø{r.diameter} mm</Text>
              <Chip label={FLAG_INFO[r.flag].label} tone={FLAG_INFO[r.flag].tone} icon={r.flag === 'ok' ? 'check' : 'alert-outline'} small />
            </Row>
            <InfoRow label="BBS" value={`${fmtQty(r.bbsKg, 1)} kg`} />
            <InfoRow label="Take-off" value={`${fmtQty(r.takeoffKg, 1)} kg`} />
            <InfoRow label="Issued" value={`${fmtQty(r.issuedKg, 1)} kg`} />
            <InfoRow label="Returned" value={`${fmtQty(r.returnedKg, 1)} kg`} />
            <InfoRow label="Net vs basis" strong value={`${fmtQty(r.netKg, 1)} / ${fmtQty(r.basisKg, 1)} kg${r.variancePct != null ? ` (${r.variancePct > 0 ? '+' : ''}${r.variancePct.toFixed(1)}%, allowance ${r.allowancePct}%)` : ''}`}
              tone={r.flag === 'over' ? 'danger' : r.flag === 'ok' ? 'default' : 'warning'} />
          </Card>
        )) : <EmptyState compact icon="scale-balance" title="No rebar recorded" body="No BBS, rebar take-off or rebar issues for this element yet." />}
        <Text variant="caption" tone="muted">{server ? 'Figures from the server.' : 'Calculated on this phone from synced data.'}</Text>
      </Section>

      <Section title="Bar bending schedule">
        {bbs ? (
          <>
            <Card>
              <Row wrap gap={6}><StatusChip status={bbs.status} /><Chip label={`Rev ${bbs.revision}`} /><SyncChip entityId={bbs.id} /></Row>
              <Text variant="titleSm">{bbs.number}</Text>
              {bbs.drawing_ref ? <InfoRow label="Drawing" value={bbs.drawing_ref} /> : null}
              <InfoRow label="Total" value={`${fmtQty(total, 1)} kg · ${lines.length} bar marks`} strong />
              {bbs.approved_by ? <InfoRow label="Approved" value={`${personName(bbs.approved_by)} · ${fmtDateTime(bbs.approved_at)}`} /> : null}
              {bbs.remarks ? <InfoRow label="Remarks" value={bbs.remarks} /> : null}
            </Card>
            {lines.map((l) => (
              <Card key={l.id} dense>
                <Row justify="space-between">
                  <Text variant="label">{l.bar_mark} · Ø{l.diameter_mm}{l.shape_code ? ` · shape ${l.shape_code}` : ''}</Text>
                  <Text variant="label" num>{fmtQty(l.weight_kg, 1)} kg</Text>
                </Row>
                <Text variant="bodySm" tone="muted" num>{l.no_of_members} × {l.bars_per_member} bars × {fmtQty(l.cut_length_m, 3)} m = {fmtQty(l.total_length_m, 2)} m</Text>
              </Card>
            ))}
          </>
        ) : <EmptyState compact icon="ruler-square" title="No BBS for this element" body="The office engineer imports bar bending schedules on the web console." />}
      </Section>
      {bbs ? (
        <Section title="Photos of the fixed bars">
          <PhotoStrip projectId={bbs.project_id} entityType="bbs" entityId={bbs.id}
            canAdd={canField(profile.role, 'bbs.edit') || canField(profile.role, 'pour.write')} />
        </Section>
      ) : null}
    </Screen>
  );
}
