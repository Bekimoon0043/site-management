// Request detail (FR-WF-06) for both material flows (contract-flows.ts):
//   Site use: office engineer review (reviewed qty + stock available to issue + convert shortfall)
//             → coordinator approval = store order (trim qty, store, issue-by) → store keeper issues
//             → site engineer acknowledges → received.
//   Purchase: coordinator review (trim) → management approve / endorse → procurement accept
//             (read-only purchase status after; notify store of delivery) → store keeper GRN → received.
// Flow timeline + "Your turn" banner on top; sticky [Return] [Reject] [Primary ▸]; auto-advance to the next inbox item.
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, router, useLocalSearchParams, type Href } from 'expo-router';
import { useData, useSession, useSyncState } from '../../lib/app';
import { get, list } from '../../lib/db';
import { can, type Block, type Miv, type MrEvent, type Store } from '../../lib/contract';
import { canFlow, type DeliveryNotice, type FlowMrStatus, type MrFlowAction } from '../../lib/contract-flows';
import type { PurchaseOrder } from '../../lib/contract-procurement';
import { elementLabel, issuedForLine, lineElements, mrLines, personName, specLabel, specUom, stockQty } from '../../lib/queries';
import { flowInboxItems, rowsWhere, jf } from '../../lib/counts';
import {
  approvalsOf, endorsedByMe, fetchAtiServer, flowLabel, flowSettings, isMyTurn, linkedPrs, mainStoreId, nextFlowNumber,
  noticeLabel, noticesForPo, ownerOf, posForMr, requestTypeOf, stockCheckLocal, typeLabel, type AtiLine, type FlowLine, type FlowMr,
} from '../../lib/flows';
import { ft } from '../../lib/flows-i18n';
import { enqueue, uuid } from '../../lib/sync';
import { addDays, fmtDate, fmtDateTime, fmtQty, num, titleCase, today } from '../../lib/format';
import { printMr } from '../../lib/print';
import { useLocale } from '../../lib/i18n';
import { space } from '../../theme';
import {
  ActionBar, Banner, Button, Card, Chip, Divider, EmptyState, Field, InfoRow, ListRow, PhotoStrip, PriorityChip, ProgressBar,
  QuantityStepper, ReasonSheet, Row, Screen, Section, Sheet, StatusChip, SyncChip, SyncError, Text, confirm, haptic, showError, toast,
  type BarAction,
} from '../../components/ui';
import { DateField, StorePicker } from '../../components/pickers';
import { FlowTimeline, YourTurnBanner } from '../../components/FlowTimeline';

type Mode = 'oe_review' | 'sur_approve' | 'pr_review' | 'pr_approve' | 'pr_accept' | null;
type ReasonKind = 'return' | 'reject' | 'cancel' | 'close';

const RETURN_REASONS = () => [ft('flow.reason.qtyUnclear'), ft('flow.reason.wrongElement'), ft('flow.reason.missingDrawing'), ft('flow.reason.specUnclear')];
const REJECT_REASONS = () => [ft('flow.reason.notInBoq'), ft('flow.reason.stockAvailable'), ft('flow.reason.duplicate'), ft('flow.reason.wrongGrade'), ft('flow.reason.budget')];
const CANCEL_REASONS = () => [ft('flow.reason.noLongerNeeded'), ft('flow.reason.duplicate'), ft('flow.reason.budget')];

export default function RequestDetail() {
  useLocale();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, project } = useSession();
  const { online } = useSyncState();
  const [comment, setComment] = useState('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [issueBy, setIssueBy] = useState<string | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [reason, setReason] = useState<ReasonKind | null>(null);
  const [history, setHistory] = useState(false);
  const [convert, setConvert] = useState(false);
  const [notify, setNotify] = useState(false);
  const [server, setServer] = useState<Map<string, { ati: number; reserved: number; available: number }> | null>(null);

  const data = useData(() => {
    const mr = get<FlowMr>('material_requests', id);
    if (!mr) return null;
    const type = requestTypeOf(mr);
    const s = flowSettings(mr.project_id);
    const approvals = approvalsOf(mr.id);
    const lines = (mrLines(id) as FlowLine[]).filter((l) => !l.deleted_at).map((l) => {
      const issued = issuedForLine(mr.project_id, l.id);
      return {
        l, issued, stock: stockQty(mr.project_id, l.material_spec_id), uom: specUom(l.material_spec_id),
        remaining: Math.max(Number(l.approved_qty ?? 0) - issued, 0),
        els: lineElements(l.id).filter((e) => !e.deleted_at),
      };
    });
    const events = list<MrEvent>('mr_events', { parent: id }).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const owner = ownerOf(mr, s);
    const me = { id: profile.id, role: profile.role };
    const mine = isMyTurn(mr, me, s, approvals);
    const prs = type === 'site_use' ? linkedPrs(mr.project_id, mr.id) : [];
    const source = mr.source_mr_id ? get<FlowMr>('material_requests', mr.source_mr_id) : null;
    const pos = type === 'purchase' ? posForMr(mr.id) : [];
    const notices = pos.flatMap((po) => noticesForPo(po.id).map((n) => ({ n, po })));
    const mivs = type === 'site_use' ? rowsWhere<Miv>('mivs', mr.project_id, `AND ${jf('mr_id')} = ?`, [mr.id], `${jf('issued_at')} ASC`) : [];
    const stock = type === 'site_use' ? stockCheckLocal(mr.project_id, mr) : [];
    return { mr, type, s, approvals, lines, events, owner, mine, endorsed: endorsedByMe(mr, profile.id, approvals), prs, source, pos, notices, mivs, stock };
  }, [id, profile.id, profile.role]);

  const mr = data?.mr ?? null;
  const type = data?.type ?? 'site_use';
  const role = profile.role;
  const st = (mr?.status ?? 'draft') as FlowMrStatus;
  const notMine = !!mr && mr.requested_by !== profile.id;
  const s = data?.s;

  // Which decision panel this user gets (UI gating; the server enforces the same rules).
  const mode: Mode = useMemo(() => {
    if (!mr || !s) return null;
    if (type === 'site_use') {
      if (st === 'submitted' && s.requireReview && canFlow(role, 'sur.review') && (role === 'office_engineer' || role === 'admin')) return 'oe_review';
      if ((st === 'reviewed' || (st === 'submitted' && (!s.requireReview || role !== 'office_engineer'))) && canFlow(role, 'sur.approve') && notMine) return 'sur_approve';
      return null;
    }
    if (st === 'submitted' && s.requireCoordinatorReview && canFlow(role, 'pr.review') && notMine) return 'pr_review';
    const coordFinal = role === 'coordinator' && s.coordinatorFinalLimit != null;
    if ((['reviewed_by_coordinator', 'reviewed'].includes(st) || (st === 'submitted' && (!s.requireCoordinatorReview || coordFinal)))
      && (canFlow(role, 'pr.approve') || coordFinal) && notMine && !data?.endorsed) return 'pr_approve';
    if (['approved_by_management', 'approved'].includes(st) && canFlow(role, 'pr.accept')) return 'pr_accept';
    return null;
  }, [mr, s, type, st, role, notMine, data?.endorsed]);

  // Live stock available to issue (v_stock_available_to_issue) when reviewing / approving online.
  const storeForStock = storeId ?? mr?.store_id ?? (mr ? mainStoreId(mr.project_id) : null);
  const specKey = data?.lines.map((x) => x.l.material_spec_id).join(',') ?? '';
  useEffect(() => {
    if (!mr || type !== 'site_use' || !online || !(mode === 'oe_review' || mode === 'sur_approve')) { setServer(null); return; }
    let alive = true;
    void fetchAtiServer(mr.project_id, storeForStock, specKey.split(',').filter(Boolean)).then((m) => { if (alive) setServer(m); });
    return () => { alive = false; };
  }, [mr?.id, type, online, mode, storeForStock, specKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextId = useMemo(() => {
    if (!mode) return null;
    const kinds = mode === 'oe_review' ? ['mr_review'] : mode === 'sur_approve' ? ['mr_approve'] : mode === 'pr_review' ? ['pr_review'] : mode === 'pr_approve' ? ['pr_approve'] : ['pr_accept'];
    return flowInboxItems(project.id, profile.id, role, kinds as never).find((x) => x.id !== id)?.id ?? null;
  }, [mode, project.id, profile.id, role, id]);

  if (!data || !mr || !s) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Request' }} />
        <EmptyState icon="cloud-off-outline" title="Not on this phone yet" body="This request has not been downloaded. Sync and try again." />
      </Screen>
    );
  }
  const { lines, events, owner, mine: myTurn, endorsed, prs, source, pos, notices, mivs, approvals } = data;
  const requester = mr.requested_by === profile.id;
  const anyIssued = lines.some((x) => x.issued > 0);
  const isMgmt = can(role, 'mr.approve');

  // Stock per line: server values win when online.
  const stock: AtiLine[] = data.stock.map((x) => {
    const v = server?.get(x.specId);
    if (!v) return x;
    const ati = Math.max(v.ati, 0);
    return { ...x, available: v.available, reserved: v.reserved, ati, shortfall: Math.max(x.requested - x.issued - ati, 0) };
  });
  const shortLines = stock.filter((x) => x.shortfall > 0.0005);
  const canConvert = type === 'site_use' && canFlow(role, 'sur.convertShortfall') && ['submitted', 'reviewed', 'approved', 'partially_issued'].includes(st);

  // Generic permissions
  const editable = type === 'site_use'
    ? (requester || isMgmt) && ['draft', 'returned', 'submitted'].includes(st)
    : (requester || isMgmt) && ['draft', 'returned', 'submitted'].includes(st);
  const canReturn = type === 'site_use'
    ? ['submitted', 'reviewed'].includes(st) && can(role, 'mr.review')
    : (['submitted', 'reviewed_by_coordinator', 'reviewed'].includes(st) && ['coordinator', 'manager', 'admin'].includes(role))
      || (['approved_by_management', 'approved', 'with_procurement'].includes(st) && ['procurement', 'coordinator', 'manager', 'admin'].includes(role) && !pos.length);
  const canReject = type === 'site_use'
    ? ['submitted', 'reviewed', 'approved'].includes(st) && isMgmt && !anyIssued
    : (st === 'submitted' && ['coordinator', 'manager', 'admin'].includes(role))
      || (['reviewed_by_coordinator', 'reviewed', 'approved_by_management', 'approved'].includes(st) && ['manager', 'admin'].includes(role) && !pos.length);
  const canCancel = type === 'site_use'
    ? ['draft', 'submitted', 'reviewed', 'returned', 'approved'].includes(st) && !anyIssued && (requester || isMgmt)
    : (['draft', 'submitted', 'returned', 'reviewed_by_coordinator', 'reviewed'].includes(st) && (requester || isMgmt))
      || (['approved_by_management', 'with_procurement', 'sourced', 'approved'].includes(st) && isMgmt && !pos.some((p) => !['draft', 'rejected', 'cancelled'].includes(p.status)));
  const cancelNeedsReason = type === 'purchase' && ['approved_by_management', 'with_procurement', 'sourced', 'approved'].includes(st);
  const canClose = type === 'site_use'
    ? ['approved', 'partially_issued', 'issued', 'received'].includes(st) && canFlow(role, 'sur.close')
    : ['with_procurement', 'sourced', 'ordered', 'delivery_expected', 'partially_received', 'received'].includes(st) && canFlow(role, 'pr.close');
  const closeNeedsReason = type === 'purchase' && st !== 'received';
  const canIssue = type === 'site_use' && ['approved', 'sourced', 'ordered', 'partially_issued'].includes(st) && canFlow(role, 'sur.issue');
  const openPos = pos.filter((p) => ['approved', 'sent', 'partially_received'].includes(p.status));
  const canNotify = type === 'purchase' && canFlow(role, 'delivery.notify') && openPos.length > 0
    && ['with_procurement', 'sourced', 'ordered', 'partially_received', 'delivery_expected'].includes(st);
  const myPendingMivs = mivs.filter((m) => m.status === 'pending_ack' && (m.issued_to === profile.id || isMgmt));

  const decided = (key: Parameters<typeof ft>[0]) => {
    haptic('confirm');
    const base = ft(key, { n: mr.number });
    if (nextId) {
      toast.success(base + ft('flow.done.next'));
      router.replace(`/requests/${nextId}`);
    } else {
      toast.success(base + (mode ? ft('flow.done.caughtUp') : ''));
    }
  };

  const act = (action: MrFlowAction, text?: string, extra: Record<string, unknown> = {}) => {
    const c = (text ?? comment).trim();
    enqueue('mr_action', { mr_id: mr.id, action, comment: c || undefined, ...extra },
      { entityType: 'material_request', entityId: mr.id, label: `${mr.number} ${action.replace('_', ' ')}` });
    setComment('');
  };

  /** Steppers → payload lines. field = reviewed_qty | approved_qty, cap per line. */
  const collect = (field: 'reviewed_qty' | 'approved_qty', cap: (l: FlowLine) => number) => {
    const out: { id: string; reviewed_qty?: number; approved_qty?: number }[] = [];
    for (const { l } of lines) {
      const v = qty[l.id];
      if (v === undefined || v === '') continue;
      const q = num(v);
      const max = cap(l);
      if (!(q >= 0) || q > max + 1e-9) { showError(new Error(`Line ${l.line_no}: ${ft('flow.qtyMax', { max: fmtQty(max) })}`)); return null; }
      if (Math.abs(q - max) > 1e-9) out.push({ id: l.id, [field]: q });
    }
    return out;
  };
  const reviewCap = (l: FlowLine) => Number(l.qty);
  const approveCap = (l: FlowLine) => Number(l.reviewed_qty ?? l.qty);
  const acceptedIssueBy = issueBy ?? mr.issue_by ?? mr.required_date;

  const doReview = () => {
    const ls = collect('reviewed_qty', reviewCap);
    if (!ls) return;
    act('review', undefined, { lines: ls });
    decided(type === 'purchase' ? 'flow.done.reviewed' : 'flow.done.forwarded');
  };
  const doApprove = () => {
    const ls = collect('approved_qty', approveCap);
    if (!ls) return;
    if (type === 'site_use') {
      act('approve', undefined, { lines: ls, issue_by: acceptedIssueBy, store_id: storeId ?? mr.store_id ?? mainStoreId(mr.project_id) ?? undefined });
      decided('flow.done.storeOrder');
    } else {
      act('approve', undefined, { lines: ls });
      decided('flow.done.approved');
    }
  };
  const doAccept = () => { act('accept'); decided('flow.done.accepted'); };

  const submitDraft = () => {
    enqueue('save_mr', {
      id: mr.id, project_id: mr.project_id, number: mr.number, request_type: type, block_id: mr.block_id, priority: mr.priority,
      required_date: mr.required_date, delivery_location: mr.delivery_location ?? undefined, store_id: mr.store_id ?? undefined,
      drawing_ref: mr.drawing_ref ?? undefined, purpose: mr.purpose ?? undefined, is_lookahead: mr.is_lookahead, submit: true,
      lines: lines.map(({ l, els }) => ({
        id: l.id, material_spec_id: l.material_spec_id, qty: Number(l.qty), required_date: l.required_date ?? undefined,
        remarks: l.remarks ?? undefined, over_boq_reason: l.over_boq_reason ?? undefined,
        elements: els.map((e) => ({ id: e.id, element_id: e.element_id, qty: Number(e.qty) })),
      })),
    }, { entityType: 'material_request', entityId: mr.id, label: `${mr.number} submitted` });
    haptic('confirm');
    toast.success(ft('flow.prSubmitted', { n: mr.number }));
  };
  const editHref = (type === 'purchase' ? `/requests/purchase?id=${mr.id}` : `/requests/new?id=${mr.id}`) as Href;

  // Sticky bar per role / status
  const summary = `${typeLabel(type)} · ${ft('flow.lines', { n: lines.length })}`;
  let bar: { primary: BarAction; secondary?: BarAction; tertiary?: BarAction; summary?: string; warning?: boolean } | null = null;
  const ret: BarAction | undefined = canReturn ? { title: ft('flow.act.return'), onPress: () => setReason('return'), variant: 'ghost' } : undefined;
  const rej: BarAction | undefined = canReject ? { title: ft('flow.act.reject'), onPress: () => setReason('reject'), variant: 'dangerOutline' } : undefined;
  if (mode === 'oe_review') {
    bar = { summary: shortLines.length ? ft('flow.shortLines', { n: shortLines.length }) : summary, warning: shortLines.length > 0,
      secondary: ret ? { ...ret, variant: 'outline' } : undefined, primary: { title: ft('flow.act.forward'), onPress: doReview } };
  } else if (mode === 'sur_approve') {
    bar = { summary: shortLines.length ? ft('flow.shortLines', { n: shortLines.length }) : summary, warning: shortLines.length > 0,
      tertiary: ret, secondary: rej, primary: { title: ft('flow.act.approveStoreOrder'), onPress: doApprove } };
  } else if (mode === 'pr_review') {
    bar = { summary, tertiary: ret, secondary: rej, primary: { title: ft('flow.act.reviewPr'), onPress: doReview } };
  } else if (mode === 'pr_approve') {
    bar = { summary, tertiary: ret, secondary: rej, primary: { title: ft('flow.act.approvePr'), onPress: doApprove } };
  } else if (mode === 'pr_accept') {
    bar = { summary, secondary: ret ? { ...ret, variant: 'outline' } : undefined, primary: { title: ft('flow.act.accept'), icon: 'cart-outline', onPress: doAccept } };
  } else if (canIssue) {
    bar = { summary: `${lines.filter((x) => x.remaining > 0).length} line(s) to issue${mr.issue_by ? ` · ${ft('flow.issueByDate', { d: fmtDate(mr.issue_by) })}` : ''}`,
      primary: { title: ft('flow.act.issue'), icon: 'tray-arrow-up', onPress: () => router.push(`/store/issue?mr=${mr.id}`) } };
  } else if (myPendingMivs.length && st === 'issued' && requester) {
    bar = { summary: `${myPendingMivs.length} MIV`, primary: { title: ft('flow.act.acknowledge'), icon: 'check', onPress: () => ackAll() } };
  } else if (canNotify) {
    bar = { summary: flowLabel(st, type), primary: { title: ft('flow.act.notify'), icon: 'truck-fast-outline', onPress: () => setNotify(true) } };
  } else if (editable && st !== 'submitted') {
    bar = {
      secondary: { title: ft('flow.act.edit'), icon: 'pencil-outline', onPress: () => router.push(editHref), variant: 'outline' },
      primary: { title: ft('flow.act.submit'), onPress: submitDraft },
    };
  }

  function ackAll() {
    for (const m of myPendingMivs) enqueue('acknowledge_miv', { miv_id: m.id }, { entityType: 'miv', entityId: m.id, label: `${m.number} acknowledged` });
    haptic('confirm');
    toast.success(ft('flow.ackDone', { n: myPendingMivs.map((m) => m.number).join(', ') }));
  }

  const qtyField = mode === 'oe_review' || mode === 'pr_review' ? 'review' : mode === 'sur_approve' || mode === 'pr_approve' ? 'approve' : null;
  const store = get<Store>('stores', storeId ?? mr.store_id);

  return (
    <Screen footer={bar ? <ActionBar {...bar} /> : undefined}>
      <Stack.Screen options={{ title: mr.number }} />
      <SyncError entityId={mr.id} />
      <YourTurnBanner type={type} status={st} owner={owner} myTurn={myTurn} endorsed={endorsed} since={mr.updated_at} />
      <Card>
        <Row wrap gap={6}>
          <Chip label={typeLabel(type)} tone={type === 'purchase' ? 'violet' : 'primary'} icon={type === 'purchase' ? 'cart-outline' : 'package-variant-closed'} />
          <StatusChip status={st} label={flowLabel(st, type)} />
          <PriorityChip priority={mr.priority} />
          {mr.is_lookahead ? <Chip label="Look-ahead" tone="info" icon="calendar-outline" /> : null}
          <SyncChip entityId={mr.id} showSynced />
        </Row>
        <InfoRow label="Requested by" value={`${personName(mr.requested_by)} (${titleCase(mr.requester_role)})`} />
        <InfoRow label={ft('flow.requiredBy')} value={fmtDate(mr.required_date)} />
        {mr.issue_by ? <InfoRow label={ft('flow.issueBy')} value={fmtDate(mr.issue_by)} /> : null}
        {mr.block_id ? <InfoRow label="Block" value={get<Block>('blocks', mr.block_id)?.name ?? '—'} /> : null}
        <InfoRow label={ft('flow.deliverTo')} value={get<Store>('stores', mr.store_id)?.name ?? mr.delivery_location ?? '—'} />
        {mr.drawing_ref ? <InfoRow label="Drawing" value={mr.drawing_ref} /> : null}
        {source ? <InfoRow label={ft('flow.raisedFor', { n: source.number })} value={flowLabel(source.status, 'site_use')} /> : null}
        {mr.purpose ? <Text variant="body">{mr.purpose}</Text> : null}
        {mr.status_reason && ['returned', 'rejected', 'cancelled', 'closed'].includes(st) ? <Text variant="bodySm" tone="warning">“{mr.status_reason}”</Text> : null}
        {source ? <Button title={source.number} size="sm" variant="ghost" icon="link-variant" onPress={() => router.push(`/requests/${source.id}`)} /> : null}
      </Card>

      <FlowTimeline mr={mr} type={type} events={events} owner={owner} myTurn={myTurn} />

      {/* Site use: stock available to issue (review / approve / convert) */}
      {type === 'site_use' && (mode || canConvert || canIssue) && !['issued', 'received', 'closed'].includes(st) ? (
        <Section title={ft('flow.stockPanel')} action={server ? ft('flow.sourceServer') : ft('flow.sourceLocal')}>
          <Card>
            {stock.map((x, i) => {
              const uom = specUom(x.specId);
              return (
                <View key={x.lineId} style={styles.gap}>
                  {i > 0 ? <Divider /> : null}
                  <Row justify="space-between">
                    <Text variant="label" style={styles.flex} numberOfLines={1}>{specLabel(x.specId)}</Text>
                    {x.shortfall > 0.0005 ? <Chip label={ft('flow.shortBy', { q: fmtQty(x.shortfall), u: uom })} tone="warning" icon="alert-outline" small />
                      : <Chip label={ft('flow.covered')} tone="success" icon="check" small />}
                  </Row>
                  <Text variant="bodySm" num>{ft('flow.ati', { q: fmtQty(x.ati), u: uom })}{x.reserved > 0 ? ` · ${ft('flow.reservedFor', { q: fmtQty(x.reserved) })}` : ''}</Text>
                  {x.otherStores.length ? <Text variant="caption" tone="muted">{ft('flow.otherStores', { list: x.otherStores.map((o) => `${o.name} ${fmtQty(o.qty)}`).join(', ') })}</Text> : null}
                  {x.onOrder.length ? <Text variant="caption" tone="muted">{ft('flow.onOrder', { list: x.onOrder.map((o) => `${o.number} ${fmtQty(o.qty)}${o.eta ? ` (${fmtDate(o.eta)})` : ''}`).join(', ') })}</Text> : null}
                </View>
              );
            })}
            {canConvert && shortLines.length ? (
              <Button title={ft('flow.act.convert')} variant="tonal" icon="cart-plus" block onPress={() => setConvert(true)} />
            ) : null}
          </Card>
        </Section>
      ) : null}

      <Section title="Lines">
        {lines.map(({ l, issued, remaining, stock: onSite, els, uom }) => {
          const over = l.exceeds_boq || !!l.over_boq_reason;
          const cap = qtyField === 'review' ? reviewCap(l) : approveCap(l);
          const v = qty[l.id];
          const issuedPct = l.approved_qty != null && Number(l.approved_qty) > 0 ? (issued / Number(l.approved_qty)) * 100 : null;
          const recvPct = type === 'purchase' && l.approved_qty != null && Number(l.approved_qty) > 0 ? (Number(l.qty_received ?? 0) / Number(l.approved_qty)) * 100 : null;
          return (
            <Card key={l.id} stripe={over ? 'warning' : null}>
              <Row justify="space-between" align="flex-start">
                <Text variant="titleSm" style={styles.flex}>{l.line_no}. {specLabel(l.material_spec_id)}</Text>
                <Text variant="titleSm" num>{fmtQty(l.qty)} {uom}</Text>
              </Row>
              {type === 'site_use' ? (
                <Row wrap gap={6}>
                  {over ? <Chip label="Over BoQ" tone="warning" icon="scale-balance" /> : <Chip label="Within BoQ" tone="success" icon="check" />}
                  <Chip label={`Stock ${fmtQty(onSite)} ${uom}`} tone={onSite >= Number(l.approved_qty ?? l.qty) ? 'success' : 'warning'} icon={onSite >= Number(l.approved_qty ?? l.qty) ? 'check' : 'alert-outline'} />
                </Row>
              ) : null}
              {l.over_boq_reason ? <Text variant="bodySm" tone="warning">Reason: {l.over_boq_reason}</Text> : null}
              {els.map((e) => <Text key={e.id} variant="bodySm" tone="muted">{elementLabel(e.element_id)}: {fmtQty(e.qty)} {uom}</Text>)}
              {l.reviewed_qty != null ? <InfoRow label={ft('flow.reviewedQty')} value={`${fmtQty(l.reviewed_qty)} ${uom}`} /> : null}
              {l.approved_qty != null ? <InfoRow label={ft('flow.approvedQty')} value={`${fmtQty(l.approved_qty)} ${uom}`} /> : null}
              {type === 'site_use' && l.approved_qty != null ? (
                <View style={styles.gap}>
                  <InfoRow label="Issued / remaining" value={`${fmtQty(issued)} / ${fmtQty(remaining)} ${uom}`} />
                  {issuedPct != null ? <ProgressBar pct={issuedPct} showLabel /> : null}
                </View>
              ) : null}
              {recvPct != null ? (
                <View style={styles.gap}>
                  <InfoRow label="Received" value={`${fmtQty(l.qty_received ?? 0)} / ${fmtQty(l.approved_qty)} ${uom}`} />
                  <ProgressBar pct={recvPct} showLabel />
                </View>
              ) : null}
              {l.line_status && l.line_status !== 'open' ? <Chip label={titleCase(l.line_status)} tone="neutral" icon="lock-outline" small /> : null}
              {l.remarks ? <Text variant="bodySm" tone="muted">{l.remarks}</Text> : null}
              {qtyField ? (
                <QuantityStepper label={qtyField === 'review' ? ft('flow.reviewedQty') : ft('flow.approvedQty')} unit={uom}
                  value={v ?? String(cap)} onChange={(x) => setQty((q) => ({ ...q, [l.id]: x }))} max={cap} quick={[]}
                  fill={{ label: ft('flow.requested'), value: cap }}
                  error={v && num(v) > cap ? ft('flow.qtyMax', { max: fmtQty(cap) }) : null} />
              ) : null}
            </Card>
          );
        })}
      </Section>

      {mode === 'sur_approve' ? (
        <Card>
          <Text variant="bodySm" tone="muted">{ft('flow.storeOrderHint')}</Text>
          <StorePicker projectId={mr.project_id} label={ft('flow.issueFrom')} value={storeId ?? mr.store_id ?? mainStoreId(mr.project_id)} onChange={(x) => setStoreId(x ?? null)} />
          <DateField label={ft('flow.issueBy')} value={acceptedIssueBy} onChange={setIssueBy} minimumDate={new Date()} quick
            hint={store ? store.name : undefined} />
        </Card>
      ) : null}
      {mode ? <Field label={ft('flow.comment')} optional value={comment} onChangeText={setComment} multiline placeholder={ft('flow.commentPh')} /> : null}

      {/* Purchase: read-only purchase status (POs, delivery notices) */}
      {type === 'purchase' && (pos.length || notices.length) ? (
        <Section title={ft('flow.purchaseStatus')}>
          <Card flush>
            {pos.map((po) => (
              <ListRow key={po.id} id={po.id} title={po.number} subtitle={po.eta || po.expected_date ? ft('flow.expectedOn', { d: fmtDate(po.eta ?? po.expected_date) }) : null}
                status={po.status} icon="cart-outline" chevron onPress={() => router.push(`/procurement/po/${po.id}` as Href)} />
            ))}
            {notices.map(({ n, po }) => (
              <NoticeRow key={n.id} n={n} po={po} canAck={canFlow(role, 'delivery.acknowledge')} />
            ))}
          </Card>
        </Section>
      ) : null}

      {/* Site use: linked purchase requests + issues */}
      {prs.length ? (
        <Section title={ft('flow.linkedPrs')}>
          <Card flush>
            {prs.map((p) => <ListRow key={p.id} id={p.id} title={p.number} subtitle={flowLabel(p.status, 'purchase')} status={p.status} icon="cart-outline" chevron onPress={(x) => router.push(`/requests/${x}`)} />)}
          </Card>
        </Section>
      ) : null}
      {mivs.length ? (
        <Section title={ft('flow.issues')}>
          <Card flush>
            {mivs.map((m) => <ListRow key={m.id} id={m.id} title={m.number} subtitle={`${personName(m.issued_to)} · ${fmtDateTime(m.issued_at)}`} status={m.status} icon="tray-arrow-up" chevron
              onPress={(x) => router.push(`/store/doc?type=miv&id=${x}`)} />)}
          </Card>
        </Section>
      ) : null}

      <PhotoStrip projectId={mr.project_id} entityType="material_request" entityId={mr.id} canAdd={requester} label="Attachments (sketches, BBS, photos)" />

      <Section title="More actions">
        <Card flush>
          {editable && st === 'submitted' ? <ListRow id="edit" title="Edit request" icon="pencil-outline" chevron onPress={() => router.push(editHref)} /> : null}
          {canConvert && !shortLines.length ? <ListRow id="convert" title={ft('flow.act.convert')} icon="cart-plus" chevron onPress={() => setConvert(true)} /> : null}
          {canNotify && bar?.primary.title !== ft('flow.act.notify') ? <ListRow id="notify" title={ft('flow.act.notify')} icon="truck-fast-outline" chevron onPress={() => setNotify(true)} /> : null}
          {(type === 'site_use' ? can(role, 'mr.create') : canFlow(role, 'pr.create'))
            ? <ListRow id="clone" title="Request again (clone)" icon="content-copy" chevron onPress={() => router.push((type === 'purchase' ? `/requests/purchase?clone=${mr.id}` : `/requests/new?clone=${mr.id}`) as Href)} /> : null}
          <ListRow id="pdf" title="Share as PDF" icon="file-pdf-box" chevron onPress={() => void printMr(mr.id)} />
          {canReject && !bar?.secondary ? <ListRow id="reject" title={ft('flow.act.reject')} icon="close-octagon-outline" iconTone="danger" onPress={() => setReason('reject')} /> : null}
          {canReturn && !mode ? <ListRow id="return" title={ft('flow.act.return')} icon="undo-variant" iconTone="warning" onPress={() => setReason('return')} /> : null}
          {canClose ? <ListRow id="close" title={ft('flow.act.close')} icon="lock-outline" iconTone="neutral"
            onPress={() => (closeNeedsReason ? setReason('close') : confirm(ft('flow.act.close'), 'No further issues or receipts will be possible.', () => { act('close'); toast.success(ft('flow.done.closed', { n: mr.number })); }))} /> : null}
          {canCancel ? <ListRow id="cancel" title={ft('flow.act.cancel')} icon="cancel" iconTone="danger"
            onPress={() => (cancelNeedsReason ? setReason('cancel') : confirm(ft('flow.cancelTitle', { n: mr.number }), ft('flow.cancelSub'), () => { act('cancel'); toast.success(ft('flow.done.cancelled', { n: mr.number })); }, ft('flow.act.cancel'), true))} /> : null}
        </Card>
      </Section>

      <Section title={`History · ${events.length}`} action={history ? 'Hide' : 'Show'} onAction={() => setHistory((x) => !x)}>
        {history ? (
          <Card>
            {events.length ? events.map((e, i) => (
              <View key={e.id} style={styles.gap}>
                {i > 0 ? <Divider /> : null}
                <Row justify="space-between">
                  <Text variant="label">{titleCase(e.action)}</Text>
                  <Text variant="caption" tone="muted">{fmtDateTime(e.created_at)}</Text>
                </Row>
                <Text variant="bodySm" tone="muted">{personName(e.actor)}{e.to_status ? ` → ${flowLabel(e.to_status as FlowMrStatus, type)}` : ''}</Text>
                {e.comment ? <Text variant="bodySm">“{e.comment}”</Text> : null}
              </View>
            )) : <Text tone="muted">No history yet</Text>}
            {approvals.filter((a) => !a.superseded).length ? <Divider /> : null}
            {approvals.filter((a) => !a.superseded).map((a) => (
              <Text key={a.id} variant="caption" tone="muted">{titleCase(a.step)} · {personName(a.actor)} · {fmtDateTime(a.created_at)}{a.comment ? ` · “${a.comment}”` : ''}</Text>
            ))}
          </Card>
        ) : null}
      </Section>
      <Text variant="caption" tone="muted">Project {project.code} · version {mr.version}</Text>

      {reason ? (
        <ReasonSheet visible onClose={() => setReason(null)}
          title={reason === 'return' ? ft('flow.returnTitle', { n: mr.number }) : reason === 'reject' ? ft('flow.rejectTitle', { n: mr.number })
            : reason === 'cancel' ? ft('flow.cancelTitle', { n: mr.number }) : `${ft('flow.act.close')} · ${mr.number}`}
          subtitle={reason === 'return' ? ft('flow.returnSub') : reason === 'reject' ? ft('flow.rejectSub') : reason === 'cancel' ? ft('flow.cancelSub') : undefined}
          reasons={reason === 'return' ? RETURN_REASONS() : reason === 'reject' ? REJECT_REASONS() : CANCEL_REASONS()}
          confirmLabel={ft(reason === 'return' ? 'flow.act.return' : reason === 'reject' ? 'flow.act.reject' : reason === 'cancel' ? 'flow.act.cancel' : 'flow.act.close')}
          variant={reason === 'return' || reason === 'close' ? 'primary' : 'danger'}
          onConfirm={(r) => {
            const why = [r, comment.trim()].filter(Boolean).join(' · ');
            act(reason, why);
            setReason(null);
            const key = reason === 'return' ? 'flow.done.returned' : reason === 'reject' ? 'flow.done.rejected' : reason === 'cancel' ? 'flow.done.cancelled' : 'flow.done.closed';
            if (mode && (reason === 'return' || reason === 'reject')) decided(key);
            else { haptic('confirm'); toast.success(ft(key, { n: mr.number })); }
          }} />
      ) : null}
      {convert ? <ConvertSheet mr={mr} projectCode={project.code} stock={stock} onClose={() => setConvert(false)} /> : null}
      {notify ? <NotifySheet pos={openPos} onClose={() => setNotify(false)} /> : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Delivery notice row (purchase status) with accept / receive for the store keeper
// ---------------------------------------------------------------------------

function NoticeRow({ n, po, canAck }: { n: DeliveryNotice; po: PurchaseOrder; canAck: boolean }) {
  const open = ['notified', 'acknowledged', 'reschedule_requested', 'arrived'].includes(n.status);
  return (
    <View style={styles.notice}>
      <Row justify="space-between">
        <Text variant="label">{ft('flow.delivery')} · {po.number}</Text>
        <StatusChip status={n.status} label={noticeLabel(n.status)} small />
      </Row>
      <Text variant="bodySm" tone="muted">
        {ft('flow.expectedOn', { d: fmtDate(n.expected_date) })}{n.expected_window ? ` · ${n.expected_window}` : ''}{n.vehicle_plate ? ` · ${n.vehicle_plate}` : ''}
      </Text>
      {canAck && open ? (
        <Row>
          {n.status === 'notified' || n.status === 'reschedule_requested' ? (
            <Button title={ft('flow.acceptDelivery')} size="sm" variant="outline" flex icon="check" onPress={() => {
              enqueue('acknowledge_delivery_notice', { id: n.id, decision: 'accept' }, { entityType: 'delivery_notice', entityId: n.id, label: `Delivery ${po.number} accepted` });
              haptic('confirm'); toast.success(ft('flow.noticeAccepted', { po: po.number }));
            }} />
          ) : null}
          <Button title={ft('flow.receiveGrn')} size="sm" flex icon="tray-arrow-down" onPress={() => router.push(`/store/receive?notice=${n.id}` as Href)} />
        </Row>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Convert shortfall → linked purchase request (client id + PR number so it works offline)
// ---------------------------------------------------------------------------

function ConvertSheet({ mr, projectCode, stock, onClose }: { mr: FlowMr; projectCode: string; stock: AtiLine[]; onClose: () => void }) {
  const lines = (mrLines(mr.id) as FlowLine[]).filter((l) => !l.deleted_at);
  const [q, setQ] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => {
    const sf = stock.find((x) => x.lineId === l.id)?.shortfall ?? 0;
    return [l.id, sf > 0 ? String(Math.round(Math.min(sf, Number(l.qty)) * 1000) / 1000) : ''];
  })));
  const confirmIt = () => {
    const out = lines.map((l) => ({ id: l.id, qty: num(q[l.id] ?? ''), pr_line_id: uuid() })).filter((x) => x.qty > 0);
    const bad = lines.find((l) => num(q[l.id] ?? '') > Number(l.qty) + 1e-9);
    if (bad) { showError(new Error(`Line ${bad.line_no}: ${ft('flow.qtyMax', { max: fmtQty(bad.qty) })}`)); return; }
    if (!out.length) { showError(new Error(ft('flow.convertNone'))); return; }
    try {
      const prId = uuid();
      const prNumber = nextFlowNumber(projectCode, 'purchase');
      enqueue('mr_action', { mr_id: mr.id, action: 'convert_shortfall', pr_id: prId, pr_number: prNumber, lines: out },
        { entityType: 'material_request', entityId: mr.id, label: `${mr.number} shortfall → ${prNumber}` });
      haptic('confirm');
      toast.success(ft('flow.convertDone', { pr: prNumber }), { label: prNumber, onPress: () => router.push(`/requests/${prId}`) });
      onClose();
    } catch (e) { showError(e); }
  };
  return (
    <Sheet visible onClose={onClose} title={ft('flow.convertTitle')} subtitle={ft('flow.convertSub')} full
      footer={<><Button title="Cancel" variant="ghost" onPress={onClose} /><Button title={ft('flow.convertConfirm')} flex icon="cart-plus" onPress={confirmIt} /></>}>
      <View style={styles.sheet}>
        {lines.map((l) => {
          const uom = specUom(l.material_spec_id);
          const sf = stock.find((x) => x.lineId === l.id)?.shortfall ?? 0;
          return (
            <QuantityStepper key={l.id} label={`${l.line_no}. ${specLabel(l.material_spec_id)}`} unit={uom} value={q[l.id] ?? ''}
              onChange={(v) => setQ((s) => ({ ...s, [l.id]: v }))} max={Number(l.qty)} quick={[]}
              info={sf > 0 ? ft('flow.shortBy', { q: fmtQty(sf), u: uom }) : ft('flow.covered')}
              fill={sf > 0 ? { label: ft('flow.convertQty'), value: Math.round(sf * 1000) / 1000 } : null} />
          );
        })}
      </View>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Procurement: delivery notice to the store keeper (+ security)
// ---------------------------------------------------------------------------

function NotifySheet({ pos, onClose }: { pos: PurchaseOrder[]; onClose: () => void }) {
  const [poId, setPoId] = useState<string | null>(pos[0]?.id ?? null);
  const [date, setDate] = useState<string | null>(pos[0]?.eta ?? pos[0]?.expected_date ?? addDays(today(), 1));
  const [win, setWin] = useState('');
  const [plate, setPlate] = useState('');
  const [driver, setDriver] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const send = () => {
    const po = pos.find((p) => p.id === poId);
    if (!po || !date) { showError(new Error(ft('flow.errDate'))); return; }
    const nid = uuid();
    enqueue('notify_store_delivery', {
      id: nid, po_id: po.id, expected_date: date, expected_window: win.trim() || undefined, vehicle_plate: plate.trim() || undefined,
      driver_name: driver.trim() || undefined, driver_phone: phone.trim() || undefined, note: note.trim() || undefined,
    }, { entityType: 'delivery_notice', entityId: nid, label: `Delivery notice ${po.number}` });
    haptic('confirm');
    toast.success(ft('flow.notifyDone', { po: po.number }));
    onClose();
  };
  return (
    <Sheet visible onClose={onClose} title={ft('flow.notifyTitle')} subtitle={ft('flow.notifySub')} full
      footer={<><Button title="Cancel" variant="ghost" onPress={onClose} /><Button title={ft('flow.notifyConfirm')} flex icon="send-outline" onPress={send} /></>}>
      <View style={styles.sheet}>
        {pos.length > 1 ? (
          <Row wrap gap={6}>
            {pos.map((p) => <Button key={p.id} title={p.number} size="sm" variant={p.id === poId ? 'primary' : 'outline'} onPress={() => setPoId(p.id)} />)}
          </Row>
        ) : <InfoRow label={ft('flow.po')} value={pos[0]?.number ?? ft('flow.noOpenPo')} />}
        <DateField label={ft('flow.expectedDate')} value={date} onChange={setDate} minimumDate={new Date()} quick />
        <Field label={ft('flow.window')} optional value={win} onChangeText={setWin} placeholder={ft('flow.windowPh')} />
        <Field label="Vehicle plate" optional value={plate} onChangeText={setPlate} autoCapitalize="characters" placeholder="AA-3-12345" />
        <Field label="Driver" optional value={driver} onChangeText={setDriver} autoCapitalize="words" />
        <Field label={ft('flow.driverPhone')} optional value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Field label={ft('flow.note')} optional value={note} onChangeText={setNote} multiline />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gap: { gap: space[1] },
  sheet: { paddingHorizontal: space[4], paddingBottom: space[6], gap: space[4] },
  notice: { padding: space[4], gap: space[2] },
});
