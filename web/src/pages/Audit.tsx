import { useState } from 'react';
import { useProjectId } from '../lib/auth';
import { useAsync, useLookups } from '../lib/hooks';
import { fetchAll, supabase } from '../lib/supabase';
import { dateTime, humanize } from '../lib/format';
import { useQueryParams, useUrlFilters, useUrlParam } from '../lib/url';
import { Badge, DataTable, Drawer, ErrorBanner, FilterBar, FilterDate, FilterSelect, FilterText, Page } from '../components/ui';

interface AuditRow { id: number; at: string; user_id: string | null; device_id: string | null; project_id: string | null; table_name: string; record_id: string | null; action: string; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null }

const TABLES = ['material_requests', 'mr_lines', 'grns', 'mivs', 'mrns', 'adjustments', 'stock_counts', 'transfers', 'progress_updates', 'elements',
  'element_takeoffs', 'boq_items', 'boq_rates', 'materials', 'material_specs', 'spec_prices', 'suppliers', 'stores', 'projects', 'project_members',
  'project_settings', 'profiles', 'approval_limits', 'app_settings', 'attachments'];
const PAGE = 100;

/** Fields that changed between old and new row images. */
function changedKeys(r: AuditRow): string[] {
  const o = r.old_data ?? {}, n = r.new_data ?? {};
  return Object.keys({ ...o, ...n }).filter((k) => k !== 'updated_at' && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
}
function changes(r: AuditRow): string {
  if (r.action === 'insert') return 'created';
  if (r.action === 'delete') return 'deleted';
  return changedKeys(r).map((k) => `${k}: ${JSON.stringify(r.old_data?.[k]) ?? '∅'} → ${JSON.stringify(r.new_data?.[k])}`).join('; ');
}
const fmt = (v: unknown) => (v === undefined ? '' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Server-paged audit log (range + estimated count), filters in the URL, field-level diff drawer. */
export function Audit() {
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const [f, setF, { active, clear }] = useUrlFilters({ table: '', action: '', user: '', from: '', to: '', record: '' });
  const [params, setParams] = useQueryParams();
  const page = Math.max(0, Number(params.get('page') ?? 1) - 1);
  const [openId, setOpenId] = useUrlParam('peek');
  const [showAll, setShowAll] = useState(false);

  const build = () => {
    let qb = supabase.from('audit_log').select('*', { count: 'estimated' }).or(`project_id.eq.${projectId},project_id.is.null`);
    if (f.table) qb = qb.eq('table_name', f.table);
    if (f.action) qb = qb.eq('action', f.action);
    if (f.user) qb = qb.eq('user_id', f.user);
    if (f.from) qb = qb.gte('at', f.from);
    if (f.to) qb = qb.lte('at', `${f.to}T23:59:59`);
    if (f.record.trim()) qb = qb.eq('record_id', f.record.trim());
    return qb.order('at', { ascending: false });
  };
  const q = useAsync(async () => {
    const { data, error, count } = await build().range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as AuditRow[], total: count };
  }, [projectId, JSON.stringify(f), page], { key: 'audit' });

  const person = (id: string | null) => (id ? lk.data?.person(id) ?? id : 'system');
  const open = q.data?.rows.find((r) => String(r.id) === openId) ?? null;
  const keys = open ? (open.action === 'update' ? changedKeys(open) : Object.keys(open.new_data ?? open.old_data ?? {})) : [];
  const unchanged = open && open.action === 'update' ? Object.keys(open.new_data ?? {}).filter((k) => !keys.includes(k)) : [];

  return (
    <Page title="Audit log" subtitle="Who did what, when, from which device (FR-AU-01/03)">
      <FilterBar active={active} onClear={clear}>
        <FilterSelect label="Table" value={f.table} onChange={(v) => setF('table', v)} options={TABLES.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterSelect label="Action" value={f.action} onChange={(v) => setF('action', v)} options={['insert', 'update', 'delete'].map((a) => ({ value: a, label: humanize(a) }))} />
        <FilterSelect label="User" value={f.user} onChange={(v) => setF('user', v)} options={(lk.data?.profiles ?? []).map((p) => ({ value: p.id, label: p.full_name || p.email || '' }))} />
        <FilterDate label="From" value={f.from} onChange={(v) => setF('from', v)} />
        <FilterDate label="To" value={f.to} onChange={(v) => setF('to', v)} />
        <FilterText label="Record id" value={f.record} onChange={(v) => setF('record', v)} placeholder="uuid" />
      </FilterBar>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={q.data?.rows ?? []} loading={!q.data || q.loading} exportName="audit-log" rowKey={(r) => String(r.id)} activeKey={openId}
        onRowClick={(r) => setOpenId(String(r.id), true)} filtered={active > 0} onClearFilters={clear}
        server={{ page, pageSize: PAGE, total: q.data?.total ?? null, onPage: (p) => setParams((x) => { if (p > 0) x.set('page', String(p + 1)); else x.delete('page'); return x; }) }}
        onExportAll={() => fetchAll<AuditRow>((a, b) => build().range(a, b), 5000)}
        empty={{ title: 'No audit entries', body: 'Changes to records appear here as they happen.' }}
        columns={[
          { key: 'at', label: 'When', render: (r) => dateTime(r.at) },
          { key: 'user', label: 'User', value: (r) => person(r.user_id) },
          { key: 'device_id', label: 'Device', value: (r) => (r.device_id ? r.device_id.slice(0, 8) : '') },
          { key: 'table_name', label: 'Table', value: (r) => humanize(r.table_name) },
          { key: 'action', label: 'Action', render: (r) => <Badge tone={r.action === 'delete' ? 'danger' : r.action === 'insert' ? 'success' : 'info'} icon={null} label={humanize(r.action)} /> },
          { key: 'record', label: 'Record', value: (r) => String(r.new_data?.number ?? r.old_data?.number ?? r.new_data?.code ?? r.new_data?.name ?? r.record_id ?? '') },
          { key: 'changes', label: 'Changes', value: changes, render: (r) => <span className="small-text muted truncate" style={{ display: 'inline-block', maxWidth: 420 }}>{changes(r)}</span> },
        ]} />
      {open && (
        <Drawer size="lg" title={`${humanize(open.table_name)} · ${open.action}`} subtitle={`${dateTime(open.at)} · ${person(open.user_id)} · device ${open.device_id ?? '—'}`} onClose={() => setOpenId(null)}>
          <p className="muted small-text">Record {open.record_id}</p>
          <div className="table-wrap">
            <table className="diff">
              <thead><tr><th>Field</th>{open.action !== 'insert' && <th>Before</th>}{open.action !== 'delete' && <th>After</th>}</tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k}>
                    <td className="strong">{k}</td>
                    {open.action !== 'insert' && <td className={open.action === 'update' ? 'old' : ''}>{fmt(open.old_data?.[k])}</td>}
                    {open.action !== 'delete' && <td className={open.action === 'update' ? 'new' : ''}>{fmt(open.new_data?.[k])}</td>}
                  </tr>
                ))}
                {showAll && unchanged.map((k) => (
                  <tr key={k}><td className="muted">{k}</td><td className="muted">{fmt(open.old_data?.[k])}</td><td className="muted">{fmt(open.new_data?.[k])}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {unchanged.length > 0 && <button className="link-btn mt-2" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide' : 'Show'} {unchanged.length} unchanged field{unchanged.length === 1 ? '' : 's'}</button>}
        </Drawer>
      )}
    </Page>
  );
}
