// Approvals / Review inbox (spec §4.4): requests oldest first with age + flags, adjustments,
// stock counts and emergency issues to regularise.
import React, { memo, useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useData, useDataVersion, useSession } from '../../lib/app';
import { list, get } from '../../lib/db';
import { can, type Adjustment, type AdjustmentLine, type Block, type Miv, type StockCount, type StockCountLine } from '../../lib/contract';
import { flowInboxItems, mrRows, rowsWhere, jf, syncStatusMap, type FlowInboxKind } from '../../lib/counts';
import { requestTypeOf, typeLabel } from '../../lib/flows';
import { ft, ftx } from '../../lib/flows-i18n';
import { flowRowChip } from '../../components/FlowTimeline';
import { personName, requests, specLabel, specMap, specUom } from '../../lib/queries';
import { enqueue } from '../../lib/sync';
import { canProcure } from '../../lib/contract-procurement';
import { canControl } from '../../lib/contract-control';
import { canSchedule } from '../../lib/contract-schedule';
import { TaskVerifyList } from '../../components/schedule';
import { scheduleCounts } from '../../lib/counts';
import { canSeePrices, gatePassLines, gatePasses, poLines, poTotals, purchaseOrders, supplierName } from '../../lib/pc';
import { t, useLocale } from '../../lib/i18n';
import { fmtMoney } from '../../lib/format';
import { ago, fmtDate, fmtDateTime, fmtQty } from '../../lib/format';
import { priorityInfo, sentence, space, type Tone } from '../../theme';
import {
  Banner, Button, Card, Chip, ChipGroup, EmptyState, InfoRow, Picker, ReasonSheet, Row, Screen, StatusChip, SyncDot, Text,
  haptic, toast, type IconName,
} from '../../components/ui';

type Tab = 'requests' | 'adjustments' | 'counts' | 'emergency' | 'pos' | 'gate' | 'tasks';
type Kind = 'adjustment' | 'count' | 'po' | 'gate';

function ageChip(iso: string | null): { label: string; tone: Tone } {
  if (!iso) return { label: 'Waiting', tone: 'neutral' };
  const h = (Date.now() - new Date(iso).getTime()) / 3600e3;
  const label = h < 1 ? 'Waiting < 1 h' : h < 48 ? `Waiting ${Math.round(h)} h` : `Waiting ${Math.round(h / 24)} d`;
  return { label, tone: h > 48 ? 'danger' : h > 24 ? 'warning' : 'neutral' };
}

interface ReqItem {
  id: string; number: string; status: string; who: string; block: string; lines: number; summary: string;
  age: { label: string; tone: Tone }; flags: { label: string; tone: Tone; icon: IconName }[]; sync: 'pending' | 'failed' | null;
}

const RequestCard = memo(function RequestCard({ r, onOpen }: { r: ReqItem; onOpen: (id: string) => void }) {
  return (
    <View style={styles.cardWrap}>
      <Card onPress={() => onOpen(r.id)} stripe={r.age.tone === 'danger' ? 'danger' : r.age.tone === 'warning' ? 'warning' : null}>
        <Row justify="space-between">
          <Row gap={6} style={styles.shrink}><Text variant="titleSm" numberOfLines={1}>{r.number}</Text><SyncDot status={r.sync} /></Row>
          <Chip label={r.age.label} tone={r.age.tone} icon="clock-outline" />
        </Row>
        <Text variant="bodySm" tone="muted" numberOfLines={1}>{r.who} · {r.block} · {r.lines} line{r.lines === 1 ? '' : 's'}</Text>
        <Text variant="body" numberOfLines={2}>{r.summary}</Text>
        <Row wrap gap={6}>
          {r.status ? <StatusChip status={r.status} /> : null}
          {r.flags.map((f) => <Chip key={f.label} label={f.label} tone={f.tone} icon={f.icon} />)}
        </Row>
      </Card>
    </View>
  );
});

export default function Approvals() {
  const { profile, project } = useSession();
  const params = useLocalSearchParams<{ regularise?: string; tab?: Tab }>();
  const mgmt = can(profile.role, 'adjustment.decide');
  const [tab, setTab] = useState<Tab>(params.regularise ? 'emergency' : params.tab ?? 'requests');
  const [regMr, setRegMr] = useState<Record<string, string | null>>({});
  const [reason, setReason] = useState<{ kind: Kind; id: string; number: string; approve: boolean } | null>(null);
  useLocale();
  const poMgr = canProcure(profile.role, 'po.approve');
  const gateMgr = canControl(profile.role, 'gatepass.approve');
  const prices = canSeePrices(profile.role);
  const v = useDataVersion();

  const d = useData(() => {
    const sm = specMap(v);
    const sync = syncStatusMap();
    // Flow inbox (app.approvals_for kinds): site-use review / store-order approval, PR review / approve / accept.
    const items = flowInboxItems(project.id, profile.id, profile.role, ['mr_review', 'mr_approve', 'pr_review', 'pr_approve', 'pr_accept'] as FlowInboxKind[]);
    const kindOf = new Map(items.map((x) => [x.id, x.kind]));
    const ids = items.map((x) => `'${x.id.replace(/'/g, "''")}'`).join(',');
    const byId = new Map((ids ? mrRows(project.id, `AND r.pk IN (${ids})`) : []).map((r) => [r.id, r]));
    const reqs: ReqItem[] = items.map((x) => byId.get(x.id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => {
      const p = priorityInfo(r.priority);
      const type = requestTypeOf(r);
      const fc = flowRowChip(r.status, type);
      const flags: ReqItem['flags'] = [
        { label: ftx(`flow.task.${kindOf.get(r.id)}`, typeLabel(type)), tone: type === 'purchase' ? 'violet' : 'primary', icon: type === 'purchase' ? 'cart-outline' : 'package-variant-closed' },
        { label: fc.label, tone: fc.tone, icon: fc.icon },
      ];
      if (r.overBoq) flags.push({ label: 'Over BoQ', tone: 'danger', icon: 'scale-balance' });
      if (p) flags.push({ label: p.label, tone: p.tone, icon: p.icon });
      if (r.is_lookahead) flags.push({ label: 'Look-ahead', tone: 'info', icon: 'calendar-outline' });
      return {
        id: r.id, number: r.number, status: '', who: personName(r.requested_by),
        block: get<Block>('blocks', r.block_id)?.code ?? '—', lines: r.lineCount,
        summary: `${r.specIds.map((s) => sm.get(s)?.label ?? 'Material').join(', ')}${r.lineCount > 3 ? ` +${r.lineCount - 3}` : ''} · needed ${fmtDate(r.required_date)}`,
        age: ageChip(r.submitted_at), flags, sync: sync.get(r.id) ?? null,
      };
    });
    const adjs = rowsWhere<Adjustment>('adjustments', project.id, `AND ${jf('status')} = 'pending'`, [], `${jf('created_at')} ASC`);
    const counts = rowsWhere<StockCount>('stock_counts', project.id, `AND ${jf('status')} = 'submitted'`, [], `${jf('counted_at')} ASC`);
    const emergency = rowsWhere<Miv>('mivs', project.id, `AND ${jf('is_emergency')} = 1 AND ${jf('mr_id')} IS NULL AND ${jf('status')} != 'reversed'`, [], `${jf('issued_at')} ASC`);
    const approvedMrs = requests(project.id).filter((r) => ['approved', 'partially_issued', 'issued'].includes(r.status))
      .map((r) => ({ id: r.id, label: r.number, code: r.number, sub: `Needed ${fmtDate(r.required_date)} · ${personName(r.requested_by)}` }));
    const pos = poMgr ? purchaseOrders(project.id, ['submitted']).reverse().map((p) => ({
      id: p.id, number: p.number, supplier: supplierName(p.supplier_id), lines: poLines(p.id), totals: prices ? poTotals(p.id) : null,
      age: ageChip(p.submitted_at), expected: p.expected_date, sync: sync.get(p.id) ?? null,
    })) : [];
    const gates = gateMgr ? gatePasses(project.id, 'to_approve').reverse().map((g) => ({ g, lines: gatePassLines(g.id), age: ageChip(g.submitted_at), sync: sync.get(g.id) ?? null })) : [];
    return { reqs, adjs, counts, emergency, approvedMrs, pos, gates };
  }, [project.id, profile.role, poMgr, gateMgr, prices]);

  const open = useCallback((id: string) => router.push(`/requests/${id}`), []);

  const tabs = [
    { value: 'requests' as const, label: `Requests · ${d.reqs.length}` },
    ...(mgmt ? [{ value: 'adjustments' as const, label: `Adjustments · ${d.adjs.length}` }, { value: 'counts' as const, label: `Counts · ${d.counts.length}` }] : []),
    ...(mgmt || profile.role === 'store_keeper' ? [{ value: 'emergency' as const, label: `Emergency · ${d.emergency.length}` }] : []),
    ...(poMgr ? [{ value: 'pos' as const, label: `${t('act.purchaseOrders')} · ${d.pos.length}` }] : []),
    ...(gateMgr ? [{ value: 'gate' as const, label: `${t('gate.passes')} · ${d.gates.length}` }] : []),
    ...(canSchedule(profile.role, 'progress.verify') ? [{ value: 'tasks' as const, label: `${t('sch.verifyTasks')} · ${scheduleCounts(project.id, profile.id).tasksToVerify}` }] : []),
  ];

  const decide = (kind: Kind, id: string, number: string, approve: boolean, comment: string) => {
    if (kind === 'po') {
      enqueue('po_action', { po_id: id, action: approve ? 'approve' : 'reject', comment: comment || undefined }, { entityType: 'purchase_order', entityId: id, label: `${number} ${approve ? 'approved' : 'rejected'}` });
    } else if (kind === 'gate') {
      enqueue('gate_pass_action', { gate_pass_id: id, action: approve ? 'approve' : 'reject', comment: comment || undefined }, { entityType: 'gate_pass', entityId: id, label: `${number} ${approve ? 'approved' : 'rejected'}` });
    } else if (kind === 'adjustment') {
      enqueue('decide_adjustment', { adjustment_id: id, approve, comment: comment || undefined }, { entityType: 'adjustment', entityId: id, label: `${number} ${approve ? 'approved' : 'rejected'}` });
    } else {
      enqueue('decide_stock_count', { count_id: id, approve, comment: comment || undefined }, { entityType: 'stock_count', entityId: id, label: `${number} ${approve ? 'approved' : 'rejected'}` });
    }
    haptic(approve ? 'confirm' : 'reject');
    toast.success(`${number} ${approve ? 'approved' : 'rejected'} · saved on phone`);
    setReason(null);
  };

  const header = tabs.length > 1 ? (
    <View style={styles.head}>
      <ChipGroup<Tab> scroll options={tabs} value={tab} onChange={setTab} />
    </View>
  ) : null;

  return (
    <Screen scroll={false} padded={false} insetBottom={false}>
      {header}
      {tab === 'requests' ? (
        <FlashList
          data={d.reqs}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <RequestCard r={item} onOpen={open} />}
          ListEmptyComponent={<EmptyState icon="check-all" tone="success" title={ft('flow.inboxEmpty')} body={ft('flow.inboxEmptyBody')} />}
          contentContainerStyle={styles.list}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {tab === 'adjustments' && (d.adjs.length ? d.adjs.map((a) => (
            <Card key={a.id} stripe="warning">
              <Row justify="space-between">
                <Text variant="titleSm">{a.number}</Text>
                <Chip label={sentence(a.adj_type)} tone="warning" icon="delete-variant" />
              </Row>
              <Text variant="bodySm" tone="muted">{personName(a.requested_by)} · {a.reason_code} · {fmtDateTime(a.created_at)}</Text>
              {list<AdjustmentLine>('adjustment_lines', { parent: a.id }).map((l) => (
                <InfoRow key={l.id} label={`${specLabel(l.material_spec_id)} (${l.stock_status})`} value={`${fmtQty(l.qty_delta)} ${specUom(l.material_spec_id)}`} tone="danger" />
              ))}
              {a.remarks ? <Text variant="bodySm">{a.remarks}</Text> : null}
              <Row>
                <Button title="Photos" size="md" variant="ghost" icon="image-multiple-outline" onPress={() => router.push(`/store/doc?type=adjustment&id=${a.id}`)} />
                <View style={styles.flex} />
              </Row>
              <Row>
                <Button title="Reject" variant="dangerOutline" flex onPress={() => setReason({ kind: 'adjustment', id: a.id, number: a.number, approve: false })} />
                <Button title="Approve" flex icon="check" onPress={() => setReason({ kind: 'adjustment', id: a.id, number: a.number, approve: true })} />
              </Row>
            </Card>
          )) : <EmptyState icon="check-all" tone="success" title="No adjustments waiting" compact />)}

          {tab === 'counts' && (d.counts.length ? d.counts.map((cn) => {
            const ls = list<StockCountLine>('stock_count_lines', { parent: cn.id });
            const vars = ls.filter((l) => Number(l.variance) !== 0);
            return (
              <Card key={cn.id} stripe={vars.length ? 'warning' : 'success'}>
                <Text variant="titleSm">{cn.number}</Text>
                <Text variant="bodySm" tone="muted">{personName(cn.counted_by)} · {fmtDateTime(cn.counted_at)} · {sentence(cn.count_type)}</Text>
                {vars.map((l) => (
                  <InfoRow key={l.id} label={`${specLabel(l.material_spec_id)} · system ${fmtQty(l.system_qty)}, counted ${fmtQty(l.counted_qty)}`}
                    value={`${Number(l.variance) > 0 ? '+' : ''}${fmtQty(l.variance)}`} tone="danger" />
                ))}
                {!vars.length ? <Chip label="No variances" tone="success" icon="check" /> : null}
                <Row>
                  <Button title="Reject" variant="dangerOutline" flex onPress={() => setReason({ kind: 'count', id: cn.id, number: cn.number, approve: false })} />
                  <Button title="Approve & adjust" flex icon="check" onPress={() => setReason({ kind: 'count', id: cn.id, number: cn.number, approve: true })} />
                </Row>
              </Card>
            );
          }) : <EmptyState icon="check-all" tone="success" title="No counts waiting" compact />)}

          {tab === 'emergency' && (d.emergency.length ? d.emergency.map((m) => (
            <Card key={m.id} stripe="danger" selected={params.regularise === m.id}>
              <Row justify="space-between">
                <Text variant="titleSm">{m.number}</Text>
                <Chip label={`Issued ${ago(m.issued_at)}`} tone="danger" icon="fire" />
              </Row>
              <Text variant="bodySm" tone="muted">To {personName(m.issued_to)} · {m.emergency_reason}</Text>
              <Picker label="Regularise against approved request" value={regMr[m.id] ?? null} options={d.approvedMrs}
                onChange={(val) => setRegMr((s) => ({ ...s, [m.id]: val }))} />
              <Button title="Regularise" icon="link-variant" block disabled={!regMr[m.id]} onPress={() => {
                enqueue('regularise_miv', { miv_id: m.id, mr_id: regMr[m.id]! }, { entityType: 'miv', entityId: m.id, label: `${m.number} regularised` });
                haptic('confirm'); toast.success(`${m.number} regularised`);
              }} />
            </Card>
          )) : <EmptyState icon="check-all" tone="success" title="No emergency issues to regularise" compact />)}
          {tab === 'pos' && (d.pos.length ? d.pos.map((p) => (
            <Card key={p.id} stripe={p.age.tone === 'danger' ? 'danger' : p.age.tone === 'warning' ? 'warning' : 'info'} onPress={() => router.push(`/procurement/po/${p.id}`)}>
              <Row justify="space-between">
                <Row gap={6} style={styles.shrink}><Text variant="titleSm" numberOfLines={1}>{p.number}</Text><SyncDot status={p.sync} /></Row>
                <Chip label={p.age.label} tone={p.age.tone} icon="clock-outline" />
              </Row>
              <Text variant="bodySm" tone="muted">{p.supplier} · {p.lines.length} line{p.lines.length === 1 ? '' : 's'}{p.expected ? ` · expected ${fmtDate(p.expected)}` : ''}</Text>
              {p.lines.slice(0, 3).map((l) => <InfoRow key={l.id} label={specLabel(l.material_spec_id)} value={`${fmtQty(l.qty)} ${l.uom ?? specUom(l.material_spec_id)}`} />)}
              {p.lines.length > 3 ? <Text variant="caption" tone="muted">+{p.lines.length - 3} more</Text> : null}
              {p.totals ? <InfoRow label="Total incl. VAT" value={fmtMoney(p.totals.total, p.totals.currency)} strong /> : null}
              <Row>
                <Button title={t('common.reject')} variant="dangerOutline" flex onPress={() => setReason({ kind: 'po', id: p.id, number: p.number, approve: false })} />
                <Button title={t('common.approve')} flex icon="check" onPress={() => setReason({ kind: 'po', id: p.id, number: p.number, approve: true })} />
              </Row>
            </Card>
          )) : <EmptyState icon="check-all" tone="success" title="No purchase orders waiting" compact />)}

          {tab === 'gate' && (d.gates.length ? d.gates.map(({ g, lines, age, sync }) => (
            <Card key={g.id} stripe={g.pass_type === 'non_returnable' ? 'warning' : 'info'} onPress={() => router.push(`/gate/${g.id}`)}>
              <Row justify="space-between">
                <Row gap={6} style={styles.shrink}><Text variant="titleSm" numberOfLines={1}>{g.number}</Text><SyncDot status={sync} /></Row>
                <Chip label={g.pass_type === 'returnable' ? t('gate.returnable') : t('gate.nonReturnable')} tone={g.pass_type === 'returnable' ? 'info' : 'warning'} icon="boom-gate-outline" />
              </Row>
              <Text variant="bodySm" tone="muted">{personName(g.requested_by)} · {g.destination} · {age.label}</Text>
              <Text variant="body">{g.purpose}</Text>
              {lines.slice(0, 4).map((l) => <InfoRow key={l.id} label={l.material_spec_id ? specLabel(l.material_spec_id) : l.description ?? '—'} value={`${fmtQty(l.qty)} ${l.uom ?? ''}`} />)}
              {g.expected_return ? <InfoRow label={t('gate.expectedReturn')} value={fmtDate(g.expected_return)} /> : null}
              <Row>
                <Button title={t('common.reject')} variant="dangerOutline" flex onPress={() => setReason({ kind: 'gate', id: g.id, number: g.number, approve: false })} />
                <Button title={t('common.approve')} flex icon="check" onPress={() => setReason({ kind: 'gate', id: g.id, number: g.number, approve: true })} />
              </Row>
            </Card>
          )) : <EmptyState icon="check-all" tone="success" title="No gate passes waiting" compact />)}

          {tab === 'tasks' ? <TaskVerifyList /> : null}

          {tab !== 'emergency' && tab !== 'pos' && tab !== 'gate' && tab !== 'tasks' && !mgmt ? <Banner tone="info" text="Only coordinators and managers can decide adjustments and counts." /> : null}
        </ScrollView>
      )}
      {reason ? (
        <ReasonSheet visible onClose={() => setReason(null)}
          title={`${reason.approve ? 'Approve' : 'Reject'} ${reason.number}`}
          subtitle={reason.approve ? 'Add a comment if needed.' : 'A reason is required to reject.'}
          reasons={reason.approve ? [] : reason.kind === 'po' ? ['Price too high', 'Get more quotations', 'Wrong supplier', 'Budget exceeded']
            : reason.kind === 'gate' ? ['Not justified', 'No stock to release', 'Wrong destination', 'Missing details']
            : ['Not justified', 'Wrong quantity', 'Recount needed', 'Missing photos']}
          allowEmpty={reason.approve || reason.kind === 'count'} confirmLabel={reason.approve ? 'Approve' : 'Reject'} variant={reason.approve ? 'primary' : 'danger'}
          placeholder={reason.approve ? 'Comment (optional)' : undefined}
          onConfirm={(c) => decide(reason.kind, reason.id, reason.number, reason.approve, c)} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  head: { paddingHorizontal: space[4], paddingTop: space[3], paddingBottom: space[1] },
  list: { paddingTop: space[2], paddingBottom: space[8] },
  cardWrap: { paddingHorizontal: space[4], paddingVertical: space[1] + 2 },
  scroll: { padding: space[4], gap: space[3], paddingBottom: space[8] },
});
