// BoQ progress (v_boq_progress) + mapping check (v_boq_mapping_check) + tasks without any BoQ / element link.
import { useMemo, useState } from 'react';
import { useAsync } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { num } from '../../lib/format';
import { Badge, Bar, Card, DataTable, FilterBar, FilterSelect, SearchInput, Tabs } from '../ui';
import { d2, type SchedTask, type TaskFlags } from './data';
import { EV_METHOD_LABELS } from '../../lib/contract-schedule';

interface BoqProgRow { boq_item_id: string; item_no: string; description: string; unit: string; qty_contract: number; qty_mapped: number; qty_to_date: number; pct_of_contract: number | null; status_date: string }
interface MapRow { boq_item_id: string; item_no: string; description: string; unit: string; quantity: number; mapped_qty: number; tasks: number; mapping_status: 'unmapped' | 'under_mapped' | 'over_mapped' | 'ok' }

const MAP_LABEL: Record<MapRow['mapping_status'], { label: string; tone: 'danger' | 'warning' | 'info' | 'success' }> = {
  unmapped: { label: 'Not linked to any task', tone: 'danger' }, under_mapped: { label: 'Partly linked', tone: 'warning' },
  over_mapped: { label: 'Linked more than the BoQ', tone: 'info' }, ok: { label: 'Fully linked', tone: 'success' },
};

type View = 'progress' | 'mapping' | 'tasks';

export function BoqProgress({ projectId, scheduleId, tasks, flags, onOpenTask }: {
  projectId: string; scheduleId: string; tasks: SchedTask[]; flags: TaskFlags | undefined; onOpenTask: (id: string) => void;
}) {
  const [view, setView] = useState<View>('progress');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<MapRow['mapping_status'] | ''>('');
  const prog = useAsync(() => fetchAll<BoqProgRow>((a, b) => supabase.from('v_boq_progress').select('*').eq('schedule_id', scheduleId).order('item_no').range(a, b)),
    [scheduleId], { key: 'v-boq-progress', staleTime: 60_000 });
  const map = useAsync(async () => check(await supabase.from('v_boq_mapping_check').select('*').eq('project_id', projectId).order('item_no').limit(20000)) as MapRow[],
    [projectId], { key: 'v-boq-mapping', staleTime: 60_000 });
  const unlinked = useMemo(() => (flags ? tasks.filter((t) => !t.is_summary && !t.is_milestone && t.ev_method !== 'loe' && t.source_state === 'active'
    && !flags.boq.has(t.id) && !flags.elements.has(t.id)) : []), [tasks, flags]);

  const term = q.trim().toLowerCase();
  const m = (s: string | null | undefined) => !term || (s ?? '').toLowerCase().includes(term);
  const mapRows = (map.data ?? []).filter((r) => (status ? r.mapping_status === status : r.mapping_status !== 'ok') && (m(r.item_no) || m(r.description)));
  const problems = (map.data ?? []).filter((r) => r.mapping_status !== 'ok').length;

  return (
    <div className="stack">
      <Tabs variant="segmented" label="BoQ view" value={view} onChange={(v) => { setView(v); setStatus(''); }} tabs={[
        { key: 'progress', label: 'Progress by BoQ item' },
        { key: 'mapping', label: 'BoQ items not fully linked', count: map.data ? problems : undefined, hot: problems > 0 },
        { key: 'tasks', label: 'Tasks without links', count: flags ? unlinked.length : undefined, hot: unlinked.length > 0 },
      ]} />
      <FilterBar>
        <SearchInput value={q} onChange={setQ} placeholder={view === 'tasks' ? 'Search tasks' : 'Item no. or description'} />
        {view === 'mapping' && <FilterSelect label="Status" value={status} onChange={setStatus} allLabel="Needs attention"
          options={(Object.keys(MAP_LABEL) as MapRow['mapping_status'][]).map((k) => ({ value: k, label: MAP_LABEL[k].label }))} />}
      </FilterBar>
      {view === 'progress' && (
        <Card flush>
          <DataTable rows={(prog.data ?? []).filter((r) => m(r.item_no) || m(r.description))} loading={!prog.data} error={prog.error} onRetry={prog.reload}
            rowKey={(r) => r.boq_item_id} exportName="boq-progress" stickyFirst filtered={!!term} onClearFilters={() => setQ('')}
            empty={{ title: 'No BoQ items linked to the schedule yet', body: 'Link tasks to BoQ items (task drawer › BoQ & elements, or Auto-link from the MS Project custom field). Quantities done then add up here.' }}
            columns={[
              { key: 'item_no', label: 'Item', id: true },
              { key: 'description', label: 'Description' },
              { key: 'qty_contract', label: 'BoQ qty', align: 'right', render: (r) => <>{num(r.qty_contract, 2)}<span className="unit">{r.unit}</span></> },
              { key: 'qty_mapped', label: 'Linked to tasks', align: 'right', render: (r) => <span className={Number(r.qty_mapped) + 0.0005 < Number(r.qty_contract) ? 'warn-text' : ''}>{num(r.qty_mapped, 2)}</span> },
              { key: 'qty_to_date', label: 'Done (verified)', align: 'right', render: (r) => <>{num(r.qty_to_date, 2)}<span className="unit">{r.unit}</span></> },
              { key: 'pct_of_contract', label: '% of BoQ', value: (r) => Number(r.pct_of_contract ?? 0), render: (r) => <Bar pct={Number(r.pct_of_contract ?? 0)} /> },
            ]} />
          {prog.data?.[0] && <p className="muted small-text pad mb-0">As of status date {d2(prog.data[0].status_date)}. Only verified progress counts.</p>}
        </Card>
      )}
      {view === 'mapping' && (
        <Card flush>
          <DataTable rows={mapRows} loading={!map.data} error={map.error} onRetry={map.reload} rowKey={(r) => r.boq_item_id} exportName="boq-mapping-check" stickyFirst
            filtered={!!term || !!status} onClearFilters={() => { setQ(''); setStatus(''); }}
            empty={{ title: 'Every BoQ item is fully linked', body: 'Each BoQ quantity is covered by schedule tasks.' }}
            columns={[
              { key: 'item_no', label: 'Item', id: true },
              { key: 'description', label: 'Description' },
              { key: 'quantity', label: 'BoQ qty', align: 'right', render: (r) => <>{num(r.quantity, 2)}<span className="unit">{r.unit}</span></> },
              { key: 'mapped_qty', label: 'Linked', align: 'right', render: (r) => num(r.mapped_qty, 2) },
              { key: 'gap', label: 'Gap', align: 'right', value: (r) => Number(r.quantity) - Number(r.mapped_qty), render: (r) => num(Number(r.quantity) - Number(r.mapped_qty), 2) },
              { key: 'tasks', label: 'Tasks', align: 'right' },
              { key: 'mapping_status', label: 'Status', render: (r) => <Badge tone={MAP_LABEL[r.mapping_status].tone} label={MAP_LABEL[r.mapping_status].label} /> },
            ]} />
        </Card>
      )}
      {view === 'tasks' && (
        <Card flush>
          <DataTable rows={unlinked.filter((t) => m(t.name) || m(t.wbs))} loading={!flags} rowKey={(t) => t.id} exportName="tasks-without-links" stickyFirst onRowClick={(t) => onOpenTask(t.id)}
            filtered={!!term} onClearFilters={() => setQ('')}
            empty={{ title: 'Every work task is linked', body: 'All detailed tasks have a BoQ item or element, so they carry budget and measurable progress.' }}
            columns={[
              { key: 'wbs', label: 'WBS', id: true, value: (t) => t.wbs ?? t.msp_uid },
              { key: 'name', label: 'Task' },
              { key: 'planned_start', label: 'Start', render: (t) => d2(t.planned_start) },
              { key: 'planned_finish', label: 'Finish', render: (t) => d2(t.planned_finish) },
              { key: 'ev_method', label: 'Measured by', value: (t) => EV_METHOD_LABELS[t.ev_method].en },
            ]} />
          <p className="muted small-text pad mb-0">Unlinked tasks still show on the schedule but earn no value. Click a task to link it.</p>
        </Card>
      )}
    </div>
  );
}
