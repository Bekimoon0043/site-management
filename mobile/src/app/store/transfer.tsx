// Transfers between stores / projects with send and receive confirmation (FR-ST-06).
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useData, useSession } from '../../lib/app';
import { get, list } from '../../lib/db';
import type { Project, Store, Transfer, TransferLine } from '../../lib/contract';
import { specLabel, specUom, stockQty, stores } from '../../lib/queries';
import { enqueue, uuid } from '../../lib/sync';
import { nextDocNumber } from '../../lib/device';
import { fmtDateTime, fmtQty, num } from '../../lib/format';
import { space } from '../../theme';
import {
  Button, Card, EmptyState, Field, QuantityStepper, Row, Screen, Section, Segmented, StatusChip, SyncChip, Text, haptic, showError, toast,
} from '../../components/ui';
import { SpecPicker, StorePicker } from '../../components/pickers';

interface Line { id: string; specId: string | null; qty: string }
const blank = (): Line => ({ id: uuid(), specId: null, qty: '' });

export default function Transfers() {
  const { project } = useSession();
  const params = useLocalSearchParams<{ tab?: 'incoming' | 'send' | 'history' }>();
  const [tab, setTab] = useState<'incoming' | 'send' | 'history'>(params.tab ?? 'incoming');
  const [from, setFrom] = useState<string | null>(() => stores(project.id)[0]?.id ?? null);
  const [to, setTo] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [recv, setRecv] = useState<Record<string, string>>({});

  const all = useData(() => list<Transfer>('transfers').filter((x) => x.project_id === project.id || x.to_project_id === project.id)
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at)), [project.id]);
  const incoming = all.filter((x) => x.to_project_id === project.id && x.status === 'in_transit');
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  const send = () => {
    try {
      if (!from || !to) throw new Error('Select both stores');
      if (from === to) throw new Error('Choose a different destination store');
      const out = lines.filter((l) => l.specId && num(l.qty) > 0).map((l) => {
        const avail = stockQty(project.id, l.specId!, from);
        if (num(l.qty) > avail + 1e-9) throw new Error(`${specLabel(l.specId)}: only ${fmtQty(avail)} available`);
        return { id: l.id, material_spec_id: l.specId!, qty: num(l.qty) };
      });
      if (!out.length) throw new Error('Enter at least one quantity');
      const id = uuid();
      const number = nextDocNumber(project.code, 'TRF');
      enqueue('send_transfer', { id, project_id: project.id, number, from_store_id: from, to_store_id: to, sent_at: new Date().toISOString(), remarks: remarks.trim() || undefined, lines: out },
        { entityType: 'transfer', entityId: id, label: `${number} sent` });
      haptic('confirm');
      toast.success(`${number} sent · saved on phone`);
      setLines([blank()]);
      setTab('history');
    } catch (e) { showError(e); }
  };

  const receive = (tr: Transfer) => {
    const ls = list<TransferLine>('transfer_lines', { parent: tr.id });
    try {
      const out = ls.map((l) => {
        const v = recv[l.id];
        const q = v === undefined || v === '' ? Number(l.qty) : num(v);
        if (!(q >= 0) || q > Number(l.qty)) throw new Error(`Received quantity must be between 0 and ${l.qty}`);
        return { id: l.id, qty_received: q };
      });
      enqueue('receive_transfer', { transfer_id: tr.id, received_at: new Date().toISOString(), lines: out },
        { entityType: 'transfer', entityId: tr.id, label: `${tr.number} received` });
      haptic('confirm');
      toast.success(`${tr.number} received`);
    } catch (e) { showError(e); }
  };

  const storeName = (id: string) => {
    const s = get<Store>('stores', id);
    const p = s ? get<Project>('projects', s.project_id) : null;
    return s ? `${p && p.id !== project.id ? `${p.code} · ` : ''}${s.name}` : 'Other project store';
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Transfers' }} />
      <Segmented value={tab} onChange={setTab} options={[{ value: 'incoming', label: `Incoming · ${incoming.length}` }, { value: 'send', label: 'Send' }, { value: 'history', label: 'History' }]} />

      {tab === 'incoming' && (incoming.length ? incoming.map((tr) => (
        <Card key={tr.id} stripe="info">
          <Row justify="space-between"><Text variant="titleSm">{tr.number}</Text><SyncChip entityId={tr.id} /></Row>
          <Text variant="bodySm" tone="muted">From {storeName(tr.from_store_id)} → {storeName(tr.to_store_id)} · sent {fmtDateTime(tr.sent_at)}</Text>
          {list<TransferLine>('transfer_lines', { parent: tr.id }).map((l) => (
            <QuantityStepper key={l.id} label={specLabel(l.material_spec_id)} unit={specUom(l.material_spec_id)} info={`Sent ${fmtQty(l.qty)}`}
              value={recv[l.id] ?? String(Number(l.qty))} onChange={(v) => setRecv((r) => ({ ...r, [l.id]: v }))} max={Number(l.qty)} quick={[]}
              fill={{ label: 'Sent', value: Number(l.qty) }} />
          ))}
          <Button title="Confirm receipt" icon="check" block onPress={() => receive(tr)} />
        </Card>
      )) : <EmptyState icon="truck-fast-outline" title="Nothing in transit" body="Transfers sent to this project appear here." compact />)}

      {tab === 'send' && (
        <>
          <Card>
            <StorePicker projectId={project.id} label="From store" value={from} onChange={setFrom} />
            <StorePicker projectId={project.id} all label="To store (any of your projects)" value={to} onChange={setTo} />
          </Card>
          <Section title="Items">
            {lines.map((l, i) => (
              <Card key={l.id}>
                <SpecPicker value={l.specId} onChange={(v) => setLine(i, { specId: v })} />
                <QuantityStepper value={l.qty} onChange={(v) => setLine(i, { qty: v })} unit={l.specId ? specUom(l.specId) : ''}
                  info={l.specId && from ? `Available ${fmtQty(stockQty(project.id, l.specId, from))}` : null} />
                {lines.length > 1 ? <Button title="Remove" size="sm" variant="dangerOutline" icon="trash-can-outline" onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))} /> : null}
              </Card>
            ))}
            <Button variant="tonal" title="Add item" icon="plus" onPress={() => setLines((ls) => [...ls, blank()])} />
          </Section>
          <Field label="Remarks" optional value={remarks} onChangeText={setRemarks} />
          <Button title="Send transfer" icon="truck-fast-outline" block onPress={send} />
        </>
      )}

      {tab === 'history' && (all.length ? all.map((tr) => (
        <Card key={tr.id} dense>
          <Row justify="space-between"><Text variant="titleSm">{tr.number}</Text><Row gap={6}><SyncChip entityId={tr.id} /><StatusChip status={tr.status} /></Row></Row>
          <Text variant="bodySm" tone="muted">{storeName(tr.from_store_id)} → {storeName(tr.to_store_id)}</Text>
          <Text variant="caption" tone="muted">Sent {fmtDateTime(tr.sent_at)}{tr.received_at ? ` · received ${fmtDateTime(tr.received_at)}` : ''}</Text>
        </Card>
      )) : <EmptyState icon="swap-horizontal" title="No transfers yet" compact />)}
      <View style={styles.pad} />
    </Screen>
  );
}

const styles = StyleSheet.create({ pad: { height: space[2] } });
