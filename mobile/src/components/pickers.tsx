// Domain pickers built on the search-select sheet (spec §3.6) + DateField with quick chips.
import React from 'react';
import { View } from 'react-native';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { list } from '../lib/db';
import { useData } from '../lib/app';
import { blocks, elements, levels, members, projects, specs, stores, suppliers } from '../lib/queries';
import { ROLE_LABELS, type AppRole, type Store } from '../lib/contract';
import { addDays, fmtDate, isoDate, today } from '../lib/format';
import { ChipGroup, Picker, SelectField, toast, type Option, type PickerProps, type ScanResolver } from './ui';

export { Picker, type Option } from './ui';

type Base = { label?: string; value: string | null; onChange: (id: string | null) => void; error?: string | null; hint?: string | null; warning?: string | null; name?: string; optional?: boolean; allowClear?: boolean; placeholder?: string };
// QR labels: scan in the search sheet selects the scanned spec / material / element / store.
const scanSpec: ScanResolver = (type, id) => {
  if (type === 'spec') return { id };
  if (type === 'material') {
    const ss = specs().filter((s) => s.material_id === id);
    return ss.length === 1 ? { id: ss[0].id } : ss.length ? { query: ss[0].material_name } : null;
  }
  return null;
};
const scanAs = (want: string): ScanResolver => (type, id) => (type === want ? { id } : null);
const scanElement = scanAs('element');
const scanStore = scanAs('store');

const pass = (p: Base): Partial<PickerProps> => ({ error: p.error, hint: p.hint, warning: p.warning, name: p.name, optional: p.optional, allowClear: p.allowClear, placeholder: p.placeholder });

export function SpecPicker(props: Base) {
  const options = useData(() => specs().map<Option>((s) => ({ id: s.id, label: s.label, sub: `${s.category} · ${s.uom}`, category: s.category, trailing: s.uom })));
  return (
    <Picker {...pass(props)} label={props.label ?? 'Material / grade'} value={props.value} onChange={props.onChange} options={options}
      recentKey="spec" favKey="spec" categories sheetTitle="Material / grade" scan={scanSpec}
      emptyAction={{ label: 'Request new code', onPress: (q) => toast.show({ text: `Ask your office engineer to add “${q}” to the material register.`, tone: 'warning' }) }} />
  );
}

export function ElementPicker({ projectId, ...props }: Base & { projectId: string }) {
  const options = useData(() => {
    const lv = new Map(levels(projectId).map((l) => [l.id, l.code]));
    return elements(projectId).map<Option>((e) => {
      const level = e.level_id ? lv.get(e.level_id) ?? '' : '';
      return { id: e.id, code: e.code, label: `${e.code}${level ? ` (${level})` : ''}`, sub: `${e.element_type}${e.grid ? ` · grid ${e.grid}` : ''}`, category: level || undefined };
    });
  }, [projectId]);
  return <Picker {...pass(props)} label={props.label ?? 'Structural element'} value={props.value} onChange={props.onChange} options={options}
    recentKey={`element:${projectId}`} favKey={`element:${projectId}`} categories scan={scanElement} placeholder={props.placeholder ?? 'Select element'} />;
}

export function PersonPicker({ projectId, roles, ...props }: Base & { projectId: string; roles?: AppRole[]; label: string }) {
  const options = useData(() => members(projectId, roles).map<Option>((p) => ({
    id: p.id, label: p.full_name || p.email || p.phone || p.id, sub: ROLE_LABELS[p.role] ?? p.role, category: ROLE_LABELS[p.role],
  })), [projectId, roles?.join()]);
  return <Picker {...pass(props)} label={props.label} value={props.value} onChange={props.onChange} options={options} recentKey="person" categories />;
}

export function StorePicker({ projectId, label = 'Store', all, ...props }: Base & { projectId: string; all?: boolean }) {
  const opts = useData(() => {
    const names = new Map(projects().map((p) => [p.id, p.code]));
    const rows = all ? list<Store>('stores').filter((s) => !s.deleted_at) : stores(projectId);
    return rows.map<Option>((s) => ({ id: s.id, label: all ? `${names.get(s.project_id) ?? ''} · ${s.name}` : s.name, sub: `${s.store_type} store`, category: all ? names.get(s.project_id) : undefined }));
  }, [projectId, all]);
  return <Picker {...pass(props)} label={label} value={props.value} onChange={props.onChange} options={opts} categories={all} scan={scanStore} />;
}

export function BlockPicker({ projectId, ...props }: Base & { projectId: string }) {
  const opts = useData(() => blocks(projectId).map<Option>((b) => ({ id: b.id, code: b.code, label: `${b.code} · ${b.name}` })), [projectId]);
  return <Picker {...pass(props)} label={props.label ?? 'Block'} value={props.value} onChange={props.onChange} options={opts} recentKey={`block:${projectId}`} />;
}

export function SupplierPicker(props: Base) {
  const opts = useData(() => suppliers().map<Option>((s) => ({ id: s.id, label: s.name, sub: s.phone ?? s.contact_person ?? undefined })));
  return <Picker {...pass(props)} label={props.label ?? 'Supplier'} value={props.value} onChange={props.onChange} options={opts}
    recentKey="supplier" favKey="supplier" allowClear />;
}

// ---------------------------------------------------------------------------
// DateField: quick chips (Today / Tomorrow / +2 / pick) + native date dialog
// ---------------------------------------------------------------------------

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (iso: string) => DAY[new Date(`${iso}T00:00:00`).getDay()];

export function openDatePicker(value: string | null, onChange: (iso: string) => void, minimumDate?: Date) {
  DateTimePickerAndroid.open({
    value: value ? new Date(`${value}T00:00:00`) : new Date(),
    mode: 'date',
    minimumDate,
    onChange: (ev, d) => { if (ev.type === 'set' && d) onChange(isoDate(d)); },
  });
}

export function DateField({ label, value, onChange, error, hint, minimumDate, quick, optional, name, placeholder = 'Pick a date' }: {
  label: string; value: string | null; onChange: (iso: string) => void; error?: string | null; hint?: string | null;
  minimumDate?: Date; optional?: boolean; name?: string; placeholder?: string;
  /** Show Today / Tomorrow / day-after chips (future dates). */
  quick?: boolean;
}) {
  const t0 = today();
  const opts = [t0, addDays(t0, 1), addDays(t0, 2), addDays(t0, 3)];
  const chip = quick ? (
    <ChipGroup scroll value={value && opts.includes(value) ? value : null} onChange={onChange}
      options={opts.map((d, i) => ({ value: d, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `${dayName(d)} ${Number(d.slice(8))}` }))} />
  ) : null;
  return (
    <View style={{ gap: 4 }}>
      <SelectField label={label} value={value ? `${fmtDate(value)} · ${dayName(value)}` : null} placeholder={placeholder}
        icon="calendar-outline" onPress={() => openDatePicker(value, onChange, minimumDate)} error={error} hint={hint} optional={optional} name={name} />
      {chip}
    </View>
  );
}
