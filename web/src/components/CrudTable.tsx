import { useState, type ReactNode } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { check, fetchAll, supabase } from '../lib/supabase';
import { invalidateAfterWrite } from '../lib/query';
import { useAsync } from '../lib/hooks';
import { DataTable, type Column, type EmptyState } from './DataTable';
import { Drawer, Modal, confirm } from './Dialog';
import { ErrorBanner } from './Page';
import { Field, useBusy } from './Form';
import { toast } from './toast';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'bool' | 'select' | 'textarea' | 'tags';
  options?: { value: string; label: string }[];
  required?: boolean;
  /** Shown in the table; defaults to true. */
  inTable?: boolean;
  /** Shown in the form; defaults to true. */
  inForm?: boolean;
  render?: (row: Record<string, unknown>) => ReactNode;
  hint?: string;
  /** Right-aligned/tabular in the table (defaults true for numbers). */
  align?: 'right' | 'center';
  /** Hidden by default in the table (column chooser). */
  hidden?: boolean;
}

type Row = Record<string, unknown>;

/**
 * Config-driven list + create/edit form for simple master-data tables.
 * Form opens in a Modal (≤6 fields) or a Drawer (more). Soft-deletes via deleted_at when the table has it.
 */
export function CrudTable({ table, title, fields, filter = {}, defaults = {}, orderBy, canEdit, softDelete = true, hardDelete = false,
  pk = 'id', exportName, onSaved, extraActions, filterRows, filtered, onClearFilters, empty, toolbar, onRowClick, viewKey }: {
  table: string;
  title?: string;
  fields: FieldDef[];
  filter?: Row;
  defaults?: Row;
  orderBy?: string;
  canEdit: boolean;
  softDelete?: boolean;
  hardDelete?: boolean;
  pk?: string;
  exportName?: string;
  onSaved?: () => void;
  extraActions?: (row: Row) => ReactNode;
  filterRows?: (rows: Row[]) => Row[];
  /** Page filters are active (empty → "no results" state). */
  filtered?: boolean;
  onClearFilters?: () => void;
  empty?: ReactNode | EmptyState;
  toolbar?: ReactNode;
  onRowClick?: (row: Row) => void;
  viewKey?: string;
}) {
  const filterKey = JSON.stringify(filter);
  const q = useAsync(() => fetchAll<Row>((a, b) => {
    let qb = supabase.from(table).select('*').match(filter);
    if (softDelete) qb = qb.is('deleted_at', null);
    if (orderBy) qb = qb.order(orderBy);
    return qb.range(a, b);
  }), [table, filterKey, softDelete, orderBy], { key: `crud:${table}` });
  const [editing, setEditing] = useState<Row | null>(null);
  const [isNew, setIsNew] = useState(false);
  const { busy, error, setError, run } = useBusy();
  const label = title ?? 'record';

  const optLabel = (f: FieldDef, v: unknown) => f.options?.find((o) => o.value === v)?.label ?? String(v ?? '');
  const columns: Column<Row>[] = fields.filter((f) => f.inTable !== false).map((f, i) => ({
    key: f.key,
    label: f.label,
    id: i === 0 && !f.render,
    hidden: f.hidden,
    align: f.align ?? (f.type === 'number' ? 'right' : undefined),
    value: (r) => (f.type === 'select' ? optLabel(f, r[f.key]) : f.type === 'tags' ? ((r[f.key] as string[] | null) ?? []).join(', ') : r[f.key]),
    render: f.render ?? ((r) => {
      const v = r[f.key];
      if (v === null || v === undefined || v === '') return <span className="muted-dash">—</span>;
      if (f.type === 'bool') return v ? 'Yes' : 'No';
      if (f.type === 'select') return optLabel(f, v);
      if (f.type === 'tags') return <span className="badges">{((v as string[] | null) ?? []).map((t) => <span key={t} className="chip">{t}</span>)}</span>;
      return String(v);
    }),
  }));
  const startEdit = (r: Row) => { setIsNew(false); setEditing({ ...r }); setError(null); };
  if (canEdit || extraActions) {
    columns.push({
      key: '_actions', label: '', noExport: true, align: 'right', sortable: false,
      render: (r) => (
        <div className="row end">
          {extraActions?.(r)}
          {canEdit && <button className="icon-btn sm" title="Edit" aria-label={`Edit ${label}`} onClick={() => startEdit(r)}><Pencil size={14} /></button>}
          {canEdit && (softDelete || hardDelete) && (
            <button className="icon-btn sm" title="Remove" aria-label={`Remove ${label}`} disabled={busy} onClick={async () => {
              if (!(await confirm({ title: `Remove this ${label.toLowerCase()}?`, confirm: 'Remove', danger: true }))) return;
              void run(async () => {
                const m = pk.split(',').reduce((acc, k) => ({ ...acc, [k]: r[k] }), {} as Row);
                if (softDelete) check(await supabase.from(table).update({ deleted_at: new Date().toISOString() }).match(m));
                else check(await supabase.from(table).delete().match(m));
                invalidateAfterWrite();
                onSaved?.();
                toast.success(`${label} removed`);
              });
            }}><Trash2 size={14} /></button>
          )}
        </div>
      ),
    });
  }

  const save = () => run(async () => {
    if (!editing) return;
    for (const f of fields) {
      if (f.required && f.inForm !== false && (editing[f.key] === '' || editing[f.key] === null || editing[f.key] === undefined)) {
        throw new Error(`${f.label} is required`);
      }
    }
    const payload: Row = {};
    for (const f of fields) {
      if (f.inForm === false) continue;
      let v = editing[f.key];
      if (f.type === 'number') v = v === '' || v === null || v === undefined ? null : Number(v);
      if ((f.type === 'date' || f.type === 'select') && v === '') v = null;
      if (f.type === 'text' || f.type === 'textarea') v = v === '' ? null : v;
      if (f.type === 'tags' && typeof v === 'string') v = v.split(',').map((x) => x.trim()).filter(Boolean);
      payload[f.key] = v;
    }
    if (isNew) {
      check(await supabase.from(table).insert({ ...defaults, ...payload }));
    } else {
      const m = pk.split(',').reduce((acc, k) => ({ ...acc, [k]: editing[k] }), {} as Row);
      check(await supabase.from(table).update(payload).match(m));
    }
    setEditing(null);
    invalidateAfterWrite();
    onSaved?.();
    toast.success(`${label} ${isNew ? 'added' : 'saved'}`);
  });

  const rows = q.data ? (filterRows ? filterRows(q.data) : q.data) : [];
  const formFields = fields.filter((f) => f.inForm !== false);
  const Container = formFields.length > 6 ? Drawer : Modal;

  return (
    <div className="stack tight">
      <ErrorBanner error={q.error ?? (editing ? null : error)} onRetry={q.reload} />
      <DataTable rows={rows} columns={columns} exportName={exportName ?? title ?? table} loading={!q.data} viewKey={viewKey}
        rowKey={(r, i) => pk.split(',').map((k) => String(r[k])).join('|') || String(i)}
        filtered={filtered} onClearFilters={onClearFilters} onRowClick={onRowClick ?? (canEdit ? startEdit : undefined)}
        empty={empty ?? { title: `No ${label.toLowerCase()}s yet`, action: canEdit ? <button className="primary small" onClick={() => { setIsNew(true); setEditing({ ...defaults }); setError(null); }}><Plus size={14} />Add {label.toLowerCase()}</button> : undefined }}
        toolbar={<>{toolbar}{canEdit && <button className="primary small" onClick={() => { setIsNew(true); setEditing({ ...defaults }); setError(null); }}><Plus size={14} aria-hidden />Add {label.toLowerCase()}</button>}</>} />
      {editing && (
        <Container title={`${isNew ? 'Add' : 'Edit'} ${label.toLowerCase()}`} onClose={() => setEditing(null)} footer={
          <>
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}{busy ? 'Saving…' : 'Save'}</button>
          </>
        }>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <ErrorBanner error={error} />
            <div className="form-grid">
              {formFields.map((f) => (
                <Field key={f.key} label={f.label} required={f.required} hint={f.hint} wide={f.type === 'textarea'} check={f.type === 'bool'}>
                  <FieldInput f={f} value={editing[f.key]} onChange={(v) => setEditing({ ...editing, [f.key]: v })} />
                </Field>
              ))}
            </div>
            <button type="submit" hidden />
          </form>
        </Container>
      )}
    </div>
  );
}

function FieldInput({ f, value, onChange }: { f: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  switch (f.type) {
    case 'bool':
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'select':
      return (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-required={f.required}>
          <option value="">—</option>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'textarea':
      return <textarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-required={f.required} />;
    case 'tags':
      return <input value={Array.isArray(value) ? value.join(', ') : String(value ?? '')} placeholder="comma separated" onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return <input type="number" inputMode="decimal" step="any" style={{ textAlign: 'right' }} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)} aria-required={f.required} />;
    case 'date':
      return <input type="date" value={String(value ?? '').slice(0, 10)} onChange={(e) => onChange(e.target.value)} aria-required={f.required} />;
    default:
      return <input value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} aria-required={f.required} />;
  }
}
