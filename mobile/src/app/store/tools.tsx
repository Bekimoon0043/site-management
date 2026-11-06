// Returnable tools register: cached register, online issue/return with condition check.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useSession, useSyncState } from '../../lib/app';
import { cachedTools, refreshTools, storeRpc } from '../../lib/store';
import { TOOL_CATEGORY_LABELS, TOOL_ROLES, TOOL_STATUS_LABELS, type ToolCategory, type ToolCondition, type ToolRow, type ToolStatus } from '../../lib/contract-store';
import { uuid } from '../../lib/sync';
import { ago, fmtDate, today } from '../../lib/format';
import {
  Banner, Button, ChipGroup, EmptyState, Field, InfoRow, ListRow, Picker, Screen, Sheet, Text,
  haptic, showError, toast,
} from '../../components/ui';
import { DateField, PersonPicker, StorePicker } from '../../components/pickers';

const STATUS_TONE: Record<ToolStatus, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  in_store: 'success', issued: 'info', repair: 'warning', lost: 'danger', disposed: 'neutral',
};
type Filter = 'all' | 'issued' | 'overdue' | 'repair';
type Mode = 'register' | 'issue' | 'return' | null;

export default function Tools() {
  const { project } = useSession();
  return <ToolsProject key={project.id} projectId={project.id} />;
}

function ToolsProject({ projectId }: { projectId: string }) {
  const { profile, project } = useSession();
  const sync = useSyncState();
  const [cache, setCache] = useState(() => cachedTools(projectId));
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<ToolRow | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState(true);
  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [category, setCategory] = useState<ToolCategory>('hand_tool');
  const [storeId, setStoreId] = useState<string | null>(null);
  const [holderId, setHolderId] = useState<string | null>(null);
  const [holderName, setHolderName] = useState('');
  const [due, setDue] = useState<string | null>(today());
  const [condition, setCondition] = useState<ToolCondition>('good');
  const [note, setNote] = useState('');
  const canManage = (TOOL_ROLES.manage as readonly string[]).includes(profile.role);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const fresh = await refreshTools(projectId);
      setCache(fresh); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [projectId]);
  useEffect(() => {
    let on = true;
    void refreshTools(projectId).then((fresh) => { if (on) { setCache(fresh); setError(null); } })
      .catch((e) => { if (on) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (on) setBusy(false); });
    return () => { on = false; };
  }, [projectId]);

  const rows = useMemo(() => (cache?.rows ?? []).filter((r) => filter === 'all'
    || (filter === 'overdue' ? r.is_overdue : r.status === filter)), [cache, filter]);
  const openAction = (next: Exclude<Mode, 'register' | null>) => {
    setHolderId(null); setHolderName(''); setDue(today()); setCondition('good'); setNote(''); setMode(next);
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'register') {
        if (!name.trim()) throw new Error('Enter the tool name');
        await storeRpc('save_tool', { id: uuid(), project_id: project.id, name: name.trim(), tag: tag.trim() || undefined,
          category, store_id: storeId });
        toast.success('Tool registered');
      } else if (mode === 'issue' && selected) {
        if (!holderId && !holderName.trim()) throw new Error('Select a staff member or enter the crew / worker name');
        await storeRpc('tool_action', { tool_id: selected.id, action: 'issue', holder_id: holderId ?? undefined,
          holder_name: holderId ? undefined : holderName.trim(), due_on: due ?? undefined });
        toast.success(`${selected.tag} issued`);
      } else if (mode === 'return' && selected) {
        if (condition === 'damaged' && !note.trim()) throw new Error('Describe the damage');
        await storeRpc('tool_action', { tool_id: selected.id, action: 'return', condition, note: note.trim() || undefined });
        toast.success(condition === 'damaged' ? `${selected.tag} returned for repair` : `${selected.tag} returned`);
      }
      haptic('confirm');
      const fresh = await refreshTools(project.id);
      setCache(fresh); setError(null); setMode(null); setSelected(null); setName(''); setTag('');
    } catch (e) { showError(e); }
    finally { setBusy(false); }
  };

  return (
    <Screen scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Tools register' }} />
      <View style={styles.head}>
        {!sync.online ? <Banner tone="info" icon="cloud-off-outline" text="Offline: showing the last downloaded register. Connect to issue or return tools." /> : null}
        {error ? <Banner tone="danger" text={error} actions={[{ label: 'Retry', onPress: () => void reload() }]} /> : null}
        <ChipGroup<Filter> scroll value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'All', count: cache?.rows.length ?? 0 },
          { value: 'issued', label: 'Issued', count: cache?.rows.filter((r) => r.status === 'issued').length ?? 0 },
          { value: 'overdue', label: 'Overdue', count: cache?.rows.filter((r) => r.is_overdue).length ?? 0, tone: 'danger' },
          { value: 'repair', label: 'Repair', count: cache?.rows.filter((r) => r.status === 'repair').length ?? 0, tone: 'warning' },
        ]} />
        {canManage ? <Button title="Register tool" icon="plus" variant="outline" size="md" block onPress={() => {
          setName(''); setTag(''); setCategory('hand_tool'); setStoreId(null); setMode('register');
        }} /> : null}
        {cache ? <Text variant="caption" tone="muted">Register updated {ago(cache.at)}</Text> : null}
      </View>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item: r }) => <ListRow id={r.id} title={`${r.tag} · ${r.name}`}
          subtitle={`${TOOL_CATEGORY_LABELS[r.category]} · ${r.holder ?? r.store_name ?? 'No store'}`}
          meta={r.due_on ? `Return by ${fmtDate(r.due_on)}${r.is_overdue ? ` · ${r.days_overdue} days late` : ''}` : null}
          chip={{ label: TOOL_STATUS_LABELS[r.status], tone: STATUS_TONE[r.status], icon: r.is_overdue ? 'alert-outline' : undefined }}
          stripe={r.is_overdue ? 'danger' : null} chevron onPress={(id) => setSelected(rows.find((x) => x.id === id) ?? null)} />}
        ListEmptyComponent={<EmptyState icon="tools" title={cache ? 'No tools in this filter' : 'No downloaded tools'}
          body={cache ? 'Register returnable tools or choose another filter.' : 'Connect once to download the tools register.'} compact />}
        contentContainerStyle={styles.list}
      />

      {selected && !mode ? (
        <Sheet visible onClose={() => setSelected(null)} title={`${selected.tag} · ${selected.name}`} subtitle={TOOL_STATUS_LABELS[selected.status]}>
          <View style={styles.sheet}>
            <InfoRow label="Type" value={TOOL_CATEGORY_LABELS[selected.category]} />
            <InfoRow label="Condition" value={selected.condition} />
            <InfoRow label="Store" value={selected.store_name ?? '—'} />
            <InfoRow label="With" value={selected.holder ?? '—'} />
            <InfoRow label="Return by" value={fmtDate(selected.due_on)} tone={selected.is_overdue ? 'danger' : 'default'} />
            {selected.serial_no ? <InfoRow label="Serial no." value={selected.serial_no} /> : null}
            {canManage && selected.status === 'in_store' && selected.condition !== 'damaged' ? (
              <Button title="Issue tool" icon="account-hard-hat-outline" block onPress={() => openAction('issue')} />
            ) : null}
            {canManage && selected.status === 'issued' ? <Button title="Record return" icon="keyboard-return" block onPress={() => openAction('return')} /> : null}
          </View>
        </Sheet>
      ) : null}

      {mode === 'register' ? (
        <Sheet visible onClose={() => setMode(null)} title="Register tool"
          footer={<Button title="Save tool" busy={busy} onPress={() => void submit()} />}>
          <View style={styles.sheet}>
            <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Poker vibrator 38 mm" />
            <Field label="Tag no." value={tag} onChangeText={setTag} optional hint="Empty = next available T-0001 number" />
            <Picker label="Type" value={category} onChange={(v) => v && setCategory(v as ToolCategory)}
              options={Object.entries(TOOL_CATEGORY_LABELS).map(([id, label]) => ({ id, label }))} />
            <StorePicker projectId={project.id} value={storeId} onChange={setStoreId} optional />
          </View>
        </Sheet>
      ) : null}

      {selected && (mode === 'issue' || mode === 'return') ? (
        <Sheet visible onClose={() => setMode(null)} title={mode === 'issue' ? `Issue ${selected.tag}` : `Return ${selected.tag}`}
          subtitle={selected.name} footer={<Button title={mode === 'issue' ? 'Confirm issue' : 'Confirm return'} busy={busy} onPress={() => void submit()} />}>
          <View style={styles.sheet}>
            {mode === 'issue' ? <>
              <PersonPicker projectId={project.id} label="Issue to staff member" value={holderId} onChange={setHolderId} optional />
              {!holderId ? <Field label="Crew / worker name" value={holderName} onChangeText={setHolderName} placeholder="e.g. Concrete gang (Abebe)" /> : null}
              <DateField label="Return by" value={due} onChange={setDue} quick optional />
            </> : <>
              <ChipGroup<ToolCondition> label="Condition on return" value={condition} onChange={setCondition} options={[
                { value: 'good', label: 'Good', tone: 'success' }, { value: 'fair', label: 'Fair', tone: 'warning' },
                { value: 'damaged', label: 'Damaged → repair', tone: 'danger' },
              ]} />
              <Field label={condition === 'damaged' ? 'Describe the damage' : 'Note'} value={note} onChangeText={setNote}
                multiline optional={condition !== 'damaged'} />
            </>}
          </View>
        </Sheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { padding: 16, gap: 12 },
  list: { paddingBottom: 32 },
  sheet: { padding: 16, gap: 16 },
});
