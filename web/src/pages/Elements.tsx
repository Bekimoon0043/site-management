import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange, Layers, ListTree, Ruler } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { invalidateLookups, useAsync, useLookups, type Lookups } from '../lib/hooks';
import { check, fetchAll, supabase } from '../lib/supabase';
import { ELEMENT_TYPES, type BoqItem, type ElementActivity } from '../lib/contract';
import { cellDate, cellNum, cellStr, humanize, money, num, pick, shortDate } from '../lib/format';
import { useUrlFilters, useUrlParam } from '../lib/url';
import { invalidateAfterWrite } from '../lib/query';
import { CrudTable } from '../components/CrudTable';
import { ImportWizard, type ImportRow } from '../components/ImportWizard';
import { BoqExcelImport } from '../components/boq/BoqExcelImport';
import { ElementsFromSchedule } from '../components/schedule/ElementsFromSchedule';
import { loadSchedules } from '../components/schedule/data';
import { Badge, Bar, Card, DataTable, Drawer, Empty, ErrorBanner, FilterBar, FilterSelect, Loading, Page, SearchInput, Tabs, toast, useBusy, useHashTab } from '../components/ui';
import { Attachments } from '../components/Attachments';

const TABS = ['elements', 'takeoffs', 'boq', 'import'] as const;
type Tab = (typeof TABS)[number];

async function inChunks<T>(rows: T[], fn: (chunk: T[]) => Promise<void>, size = 500) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

export function Elements() {
  const projectId = useProjectId();
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'elements');
  const lk = useLookups(projectId);
  const canEdit = auth.can('master.edit');

  return (
    <Page title="Elements & BoQ" subtitle="Structural element register, take-off quantities and bill of quantities">
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'elements', label: 'Elements', count: lk.data?.elements.length },
        { key: 'takeoffs', label: 'Take-off quantities' },
        { key: 'boq', label: 'BoQ items' },
        { key: 'import', label: 'Import from Excel' },
      ]} />
      <ErrorBanner error={lk.error} onRetry={lk.reload} />
      {!lk.data ? <Loading lines={8} /> : (
        <>
          {tab === 'elements' && <ElementList L={lk.data} projectId={projectId} canEdit={canEdit} />}
          {tab === 'takeoffs' && <Takeoffs L={lk.data} projectId={projectId} canEdit={canEdit} />}
          {tab === 'boq' && <Boq projectId={projectId} canEdit={canEdit} canSeePrices={auth.canSeePrices} currency={auth.project?.currency} />}
          {tab === 'import' && <Imports L={lk.data} projectId={projectId} canEdit={canEdit} canSeePrices={auth.canSeePrices} />}
        </>
      )}
    </Page>
  );
}

function ElementList({ L, projectId, canEdit }: { L: Lookups; projectId: string; canEdit: boolean }) {
  const [f, setF, { active, clear }] = useUrlFilters({ block: '', level: '', type: '', status: '', q: '' });
  const [peek, setPeek] = useUrlParam('peek');
  const levelsForBlock = L.levels.filter((l) => !f.block || l.block_id === f.block);
  const term = f.q.toLowerCase();

  return (
    <div className="stack">
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Code, grid, drawing" />
        <FilterSelect label="Block" value={f.block} onChange={(v) => setF('block', v)} options={L.blocks.map((b) => ({ value: b.id, label: b.code }))} />
        <FilterSelect label="Level" value={f.level} onChange={(v) => setF('level', v)} options={levelsForBlock.map((l) => ({ value: l.id, label: `${L.block(l.block_id)}/${l.code}` }))} />
        <FilterSelect label="Type" value={f.type} onChange={(v) => setF('type', v)} options={ELEMENT_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={['not_started', 'in_progress', 'completed'].map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      <CrudTable table="elements" title="Element" filter={{ project_id: projectId }} defaults={{ project_id: projectId, element_type: 'column' }}
        orderBy="code" canEdit={canEdit} onSaved={invalidateLookups} exportName="elements" viewKey="elements"
        filtered={active > 0} onClearFilters={clear} onRowClick={(r) => setPeek(String(r.id), true)}
        empty={{ title: 'No elements yet', body: 'Import your structural elements from Excel, or add them one by one.', action: canEdit ? <Link to="/elements#import">Import from Excel</Link> : undefined }}
        filterRows={(rows) => rows.filter((r) =>
          (!f.block || r.block_id === f.block) && (!f.level || r.level_id === f.level) && (!f.type || r.element_type === f.type) &&
          (!f.status || r.status === f.status) &&
          (!term || [r.code, r.grid, r.drawing_ref].some((v) => String(v ?? '').toLowerCase().includes(term))))}
        fields={[
          { key: 'code', label: 'Element ID', required: true },
          { key: 'element_type', label: 'Type', type: 'select', required: true, options: ELEMENT_TYPES.map((t) => ({ value: t, label: humanize(t) })) },
          { key: 'block_id', label: 'Block', type: 'select', options: L.blocks.map((b) => ({ value: b.id, label: b.code })) },
          { key: 'level_id', label: 'Level', type: 'select', options: L.levels.map((l) => ({ value: l.id, label: `${L.block(l.block_id)}/${l.code}` })) },
          { key: 'zone_id', label: 'Zone', type: 'select', inTable: false, options: L.zones.map((z) => ({ value: z.id, label: z.name })) },
          { key: 'grid', label: 'Grid' },
          { key: 'drawing_ref', label: 'Drawing ref.', hidden: true },
          { key: 'dimensions', label: 'Dimensions', inTable: false },
          { key: 'planned_start', label: 'Planned start', type: 'date', render: (r) => shortDate(r.planned_start) },
          { key: 'planned_finish', label: 'Planned finish', type: 'date', render: (r) => shortDate(r.planned_finish) },
          { key: 'progress_pct', label: 'Progress', inForm: false, render: (r) => <Bar pct={Number(r.progress_pct)} /> },
          { key: 'status', label: 'Status', inForm: false, render: (r) => <Badge value={String(r.status)} /> },
        ]} />
      {peek && <ElementDetail L={L} elementId={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

function ElementDetail({ L, elementId, onClose }: { L: Lookups; elementId: string; onClose: () => void }) {
  const q = useAsync(async () => {
    const [acts, takeoffs] = await Promise.all([
      supabase.from('element_activities').select('*').eq('element_id', elementId).order('seq').then(check),
      supabase.from('v_element_consumption').select('*').eq('element_id', elementId).then(check),
    ]);
    return { acts: acts as ElementActivity[], takeoffs: takeoffs as { material_spec_id: string; label: string; uom: string; planned_qty: number | null; issued_qty: number; variance_pct: number | null }[] };
  }, [elementId], { key: 'element-detail' });
  const el = L.elements.find((e) => e.id === elementId);
  return (
    <Drawer size="lg" title={`Element ${L.element(elementId)}`} subtitle={el ? `${humanize(el.element_type)} · grid ${el.grid ?? '—'} · drawing ${el.drawing_ref ?? '—'}` : undefined} onClose={onClose}>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {el && (
        <dl className="kv" style={{ marginBottom: 16 }}>
          <dt>Status</dt><dd><Badge value={el.status} /></dd>
          <dt>Planned</dt><dd>{shortDate(el.planned_start) || '—'} → {shortDate(el.planned_finish) || '—'}</dd>
          <dt>Actual</dt><dd>{shortDate(el.actual_start) || '—'} → {shortDate(el.actual_finish) || '—'}</dd>
          <dt>Verified progress</dt><dd style={{ maxWidth: 260 }}><Bar pct={Number(el.progress_pct)} /></dd>
        </dl>
      )}
      {!q.data ? <Loading /> : (
        <div className="stack">
          <h3 className="mb-0">Activity sequence</h3>
          <DataTable rows={q.data.acts} maxHeight="none" columns={[
            { key: 'seq', label: '#', align: 'right' },
            { key: 'name', label: 'Activity', render: (r) => <>{r.name}{r.is_hold_point && <> <Badge value="hold_point" /></>}</> },
            { key: 'weight', label: 'Weight', align: 'right' },
            { key: 'reported_pct', label: 'Reported %', align: 'right', render: (r) => num(r.reported_pct, 1) },
            { key: 'verified_pct', label: 'Verified %', render: (r) => <Bar pct={Number(r.verified_pct)} /> },
          ]} empty="No activity template for this element type." />
          <h3 className="mb-0">Materials: take-off vs issued</h3>
          <DataTable rows={q.data.takeoffs} rowKey={(r) => r.material_spec_id} maxHeight="none" empty="No take-off quantities for this element." columns={[
            { key: 'label', label: 'Material' },
            { key: 'planned_qty', label: 'Take-off', align: 'right', render: (r) => <>{num(r.planned_qty)}<span className="unit">{r.uom}</span></> },
            { key: 'issued_qty', label: 'Issued (net)', align: 'right', render: (r) => <>{num(r.issued_qty)}<span className="unit">{r.uom}</span></> },
            { key: 'variance_pct', label: 'Variance vs earned', align: 'right', render: (r) => (r.variance_pct === null ? <span className="muted-dash">—</span> : `${num(r.variance_pct, 1)}%`) },
          ]} />
        </div>
      )}
      <h3 className="mt-3">Photos &amp; drawings</h3>
      <Attachments entityType="element" entityId={elementId} canAdd kinds={['photo', 'drawing', 'document']} tags={['progress', 'before', 'after', 'issue', 'handover']}
        emptyText="No photos of this element yet." />
    </Drawer>
  );
}

function Takeoffs({ L, projectId, canEdit }: { L: Lookups; projectId: string; canEdit: boolean }) {
  const boq = useAsync(() => fetchAll<BoqItem>((a, b) => supabase.from('boq_items').select('*').eq('project_id', projectId).is('deleted_at', null).order('item_no').range(a, b), 60000), [projectId], { key: 'boq-items' });
  const [f, setF, { active, clear }] = useUrlFilters({ element: '', spec: '' }, 't');
  const boqLabel = useMemo(() => new Map((boq.data ?? []).map((b) => [b.id, `${b.item_no} — ${b.description}`])), [boq.data]);
  return (
    <div className="stack">
      <FilterBar active={active} onClear={clear}>
        <FilterSelect label="Element" value={f.element} onChange={(v) => setF('element', v)} options={L.elements.map((e) => ({ value: e.id, label: L.element(e.id) }))} />
        <FilterSelect label="Material" value={f.spec} onChange={(v) => setF('spec', v)} options={L.specs.map((s) => ({ value: s.id, label: s.label }))} />
      </FilterBar>
      <CrudTable table="element_takeoffs" title="Take-off" filter={{ project_id: projectId }} defaults={{ project_id: projectId }}
        canEdit={canEdit} exportName="takeoffs" filtered={active > 0} onClearFilters={clear}
        filterRows={(rows) => rows.filter((r) => (!f.element || r.element_id === f.element) && (!f.spec || r.material_spec_id === f.spec))}
        fields={[
          { key: 'element_id', label: 'Element', type: 'select', required: true, options: L.elements.map((e) => ({ value: e.id, label: L.element(e.id) })) },
          { key: 'material_spec_id', label: 'Material / grade', type: 'select', required: true, options: L.specs.map((s) => ({ value: s.id, label: s.label })) },
          { key: 'planned_qty', label: 'Planned qty', type: 'number', required: true, render: (r) => <>{num(r.planned_qty, 3)}<span className="unit">{L.specUom(String(r.material_spec_id))}</span></> },
          { key: 'boq_item_id', label: 'BoQ item', type: 'select', options: (boq.data ?? []).map((b) => ({ value: b.id, label: `${b.item_no} — ${b.description}` })),
            render: (r) => boqLabel.get(String(r.boq_item_id)) ?? <span className="muted-dash">—</span> },
        ]} />
    </div>
  );
}

function Boq({ projectId, canEdit, canSeePrices, currency }: { projectId: string; canEdit: boolean; canSeePrices: boolean; currency?: string }) {
  const rates = useAsync(async () => {
    if (!canSeePrices) return new Map<string, number>();
    const rows = await fetchAll<{ boq_item_id: string; rate: number }>((a, b) => supabase.from('boq_rates').select('boq_item_id, rate').range(a, b));
    return new Map(rows.map((r) => [r.boq_item_id, Number(r.rate)]));
  }, [projectId, canSeePrices], { key: 'boq-rates' });
  const items = useAsync(() => fetchAll<{ id: string; quantity: number }>((a, b) => supabase.from('boq_items').select('id, quantity').eq('project_id', projectId).is('deleted_at', null).order('id').range(a, b), 60000), [projectId], { key: 'boq-items-total' });
  const { error, run } = useBusy();
  const canEditRates = canSeePrices && canEdit;
  const total = canSeePrices && rates.data && items.data ? items.data.reduce((s, i) => s + (rates.data!.get(i.id) ?? 0) * Number(i.quantity), 0) : null;
  const isSection = (r: Record<string, unknown>) => String(r.item_no).split('.').length <= 2;

  return (
    <div className="stack">
      <ErrorBanner error={error ?? rates.error} />
      <CrudTable table="boq_items" title="BoQ item" filter={{ project_id: projectId }} defaults={{ project_id: projectId, quantity: 0 }}
        orderBy="item_no" canEdit={canEdit} exportName="boq"
        toolbar={total !== null ? <span className="muted">Total amount <strong className="tnum" style={{ color: 'var(--text)' }}>{money(total, currency)}</strong></span> : undefined}
        empty={{ title: 'No BoQ items yet', body: 'Import the bill of quantities first — take-offs link to it.', action: canEdit ? <Link to="/elements#import">Import from Excel</Link> : undefined }}
        fields={[
          { key: 'item_no', label: 'Item no.', required: true, render: (r) => <span className={isSection(r) ? 'strong code' : 'code'}>{String(r.item_no)}</span> },
          { key: 'description', label: 'Description', required: true, type: 'textarea', render: (r) => <span className={isSection(r) ? 'strong' : ''}>{String(r.description)}</span> },
          { key: 'unit', label: 'Unit', required: true },
          { key: 'quantity', label: 'Quantity', type: 'number', required: true, render: (r) => num(r.quantity, 3) },
          ...(canSeePrices ? [{
            key: 'rate', label: `Rate (${currency ?? 'ETB'})`, inForm: false, align: 'right' as const,
            render: (r: Record<string, unknown>) => {
              const v = rates.data?.get(String(r.id));
              if (!canEditRates) return v === undefined ? <span className="muted-dash">—</span> : money(v, '');
              return (
                <input type="number" inputMode="decimal" step="any" className="num-input" defaultValue={v ?? ''} onClick={(e) => e.stopPropagation()} aria-label="Rate"
                  onBlur={(e) => {
                    const val = e.target.value;
                    if (val === String(v ?? '')) return;
                    void run(async () => {
                      if (val === '') check(await supabase.from('boq_rates').delete().eq('boq_item_id', String(r.id)));
                      else check(await supabase.from('boq_rates').upsert({ boq_item_id: r.id, rate: Number(val) }));
                      invalidateAfterWrite();
                      toast.success('Rate saved');
                    });
                  }} />
              );
            },
          }, {
            key: 'amount', label: 'Amount', inForm: false, align: 'right' as const,
            render: (r: Record<string, unknown>) => { const v = rates.data?.get(String(r.id)); return v === undefined ? <span className="muted-dash">—</span> : money(v * Number(r.quantity), ''); },
          }] : []),
        ]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Excel imports (FR-MD-03)
// ---------------------------------------------------------------------------

interface ElementImport { block: string; level: string; code: string; element_type: string; grid: string | null; drawing_ref: string | null; dimensions: string | null; planned_start: string | null; planned_finish: string | null }
interface TakeoffImport { element_id: string; material_spec_id: string; planned_qty: number; boq_item_no: string | null }

function Imports({ L, projectId, canEdit, canSeePrices }: { L: Lookups; projectId: string; canEdit: boolean; canSeePrices: boolean }) {
  const [kind, setKind] = useState<'boq' | 'elements' | 'takeoffs' | 'schedule'>('boq');
  if (!canEdit) return <Empty title="No access">Only office engineers and management can import master data.</Empty>;

  const elHeaders = ['Block', 'Level', 'Element ID', 'Type', 'Grid', 'Drawing ref', 'Dimensions', 'Planned start', 'Planned finish'];
  const validateElements = async (rows: Record<string, unknown>[]): Promise<ImportRow<ElementImport>[]> => {
    const seen = new Set<string>();
    return rows.map((r, i) => {
      const rec: ElementImport = {
        block: cellStr(pick(r, 'Block', 'Block code')), level: cellStr(pick(r, 'Level', 'Level code', 'Floor')),
        code: cellStr(pick(r, 'Element ID', 'Element', 'Code')), element_type: cellStr(pick(r, 'Type', 'Element type')).toLowerCase(),
        grid: cellStr(pick(r, 'Grid')) || null, drawing_ref: cellStr(pick(r, 'Drawing ref', 'Drawing')) || null,
        dimensions: cellStr(pick(r, 'Dimensions')) || null,
        planned_start: cellDate(pick(r, 'Planned start', 'Start')), planned_finish: cellDate(pick(r, 'Planned finish', 'Finish')),
      };
      const errors: string[] = [];
      if (!rec.code) errors.push('Element ID missing');
      if (!rec.element_type) errors.push('Type missing');
      if (rec.level && !rec.block) errors.push('Level given without block');
      if (rec.planned_start && rec.planned_finish && rec.planned_finish < rec.planned_start) errors.push('Finish before start');
      const key = `${rec.block}|${rec.level}|${rec.code}`;
      if (seen.has(key)) errors.push('Duplicate row in file');
      seen.add(key);
      return {
        rowNo: i + 2, errors, record: errors.length ? null : rec,
        display: { Block: rec.block, Level: rec.level, 'Element ID': rec.code, Type: rec.element_type, Grid: rec.grid ?? '', 'Drawing ref': rec.drawing_ref ?? '',
          Dimensions: rec.dimensions ?? '', 'Planned start': rec.planned_start ?? '', 'Planned finish': rec.planned_finish ?? '' },
      };
    });
  };
  const commitElements = async (recs: ElementImport[]) => {
    // Create missing blocks and levels, then upsert elements.
    const blockIds = new Map(L.blocks.map((b) => [b.code.toLowerCase(), b.id]));
    const newBlocks = [...new Set(recs.map((r) => r.block).filter((b) => b && !blockIds.has(b.toLowerCase())))];
    if (newBlocks.length) {
      const ins = check(await supabase.from('blocks').upsert(newBlocks.map((code) => ({ project_id: projectId, code, name: code, deleted_at: null })), { onConflict: 'project_id,code' }).select('id, code')) as { id: string; code: string }[];
      ins.forEach((b) => blockIds.set(b.code.toLowerCase(), b.id));
    }
    const levelKey = (blockId: string, code: string) => `${blockId}|${code.toLowerCase()}`;
    const levelIds = new Map(L.levels.map((l) => [levelKey(l.block_id, l.code), l.id]));
    const newLevels = new Map<string, { project_id: string; block_id: string; code: string; name: string; deleted_at: null }>();
    for (const r of recs) {
      if (!r.level) continue;
      const bid = blockIds.get(r.block.toLowerCase())!;
      const k = levelKey(bid, r.level);
      if (!levelIds.has(k)) newLevels.set(k, { project_id: projectId, block_id: bid, code: r.level, name: r.level, deleted_at: null });
    }
    if (newLevels.size) {
      const ins = check(await supabase.from('levels').upsert([...newLevels.values()], { onConflict: 'block_id,code' }).select('id, block_id, code')) as { id: string; block_id: string; code: string }[];
      ins.forEach((l) => levelIds.set(levelKey(l.block_id, l.code), l.id));
    }
    const rows = recs.map((r) => {
      const bid = r.block ? blockIds.get(r.block.toLowerCase()) ?? null : null;
      return {
        project_id: projectId, block_id: bid, level_id: bid && r.level ? levelIds.get(levelKey(bid, r.level)) ?? null : null,
        code: r.code, element_type: r.element_type, grid: r.grid, drawing_ref: r.drawing_ref, dimensions: r.dimensions,
        planned_start: r.planned_start, planned_finish: r.planned_finish, deleted_at: null,
      };
    });
    await inChunks(rows, async (c) => { check(await supabase.from('elements').upsert(c, { onConflict: 'project_id,block_id,level_id,code' })); });
    invalidateLookups();
    return `Imported ${rows.length} elements (${newBlocks.length} new blocks, ${newLevels.size} new levels).`;
  };

  const toHeaders = ['Element ID', 'Block', 'Level', 'Material', 'Grade', 'Planned qty', 'BoQ item no'];
  const validateTakeoffs = async (rows: Record<string, unknown>[]): Promise<ImportRow<TakeoffImport>[]> => {
    const boq = await fetchAll<{ item_no: string }>((a, b) => supabase.from('boq_items').select('item_no').eq('project_id', projectId).is('deleted_at', null).order('item_no').range(a, b), 60000);
    const boqNos = new Set(boq.map((b) => b.item_no.toLowerCase()));
    return rows.map((r, i) => {
      const code = cellStr(pick(r, 'Element ID', 'Element', 'Code'));
      const block = cellStr(pick(r, 'Block')).toLowerCase();
      const level = cellStr(pick(r, 'Level')).toLowerCase();
      const mat = cellStr(pick(r, 'Material')).toLowerCase();
      const grade = cellStr(pick(r, 'Grade', 'Specification')).toLowerCase();
      const qty = cellNum(pick(r, 'Planned qty', 'Quantity', 'Qty'));
      const boqNo = cellStr(pick(r, 'BoQ item no', 'BoQ item', 'Item no')) || null;
      const errors: string[] = [];
      const matches = L.elements.filter((e) => e.code.toLowerCase() === code.toLowerCase()
        && (!block || L.block(e.block_id).toLowerCase() === block) && (!level || L.level(e.level_id).toLowerCase() === level));
      if (!code) errors.push('Element ID missing');
      else if (!matches.length) errors.push('Unknown element');
      else if (matches.length > 1) errors.push('Element ambiguous — add Block/Level');
      const spec = L.specs.find((s) => s.material_name.toLowerCase() === mat && s.grade.toLowerCase() === grade);
      if (!spec) errors.push(`Unknown material/grade "${mat} ${grade}"`);
      if (qty === null || qty < 0) errors.push('Invalid planned qty');
      if (boqNo && !boqNos.has(boqNo.toLowerCase())) errors.push(`Unknown BoQ item ${boqNo}`);
      return {
        rowNo: i + 2, errors,
        record: errors.length ? null : { element_id: matches[0].id, material_spec_id: spec!.id, planned_qty: qty!, boq_item_no: boqNo },
        display: { 'Element ID': code, Block: block, Level: level, Material: mat, Grade: grade, 'Planned qty': qty === null ? '' : String(qty), 'BoQ item no': boqNo ?? '' },
      };
    });
  };
  const commitTakeoffs = async (recs: TakeoffImport[]) => {
    const boq = await fetchAll<{ id: string; item_no: string }>((a, b) => supabase.from('boq_items').select('id, item_no').eq('project_id', projectId).is('deleted_at', null).order('item_no').range(a, b), 60000);
    const boqId = new Map(boq.map((b) => [b.item_no.toLowerCase(), b.id]));
    const rows = recs.map((r) => ({
      project_id: projectId, element_id: r.element_id, material_spec_id: r.material_spec_id, planned_qty: r.planned_qty,
      boq_item_id: r.boq_item_no ? boqId.get(r.boq_item_no.toLowerCase()) ?? null : null, deleted_at: null,
    }));
    await inChunks(rows, async (c) => { check(await supabase.from('element_takeoffs').upsert(c, { onConflict: 'element_id,material_spec_id' })); });
    return `Imported ${rows.length} take-off lines.`;
  };

  const kinds = [
    { key: 'boq' as const, icon: <ListTree size={16} aria-hidden />, title: '1 · BoQ items', body: 'Bill of quantities (item no., description, unit, qty).' },
    { key: 'elements' as const, icon: <Layers size={16} aria-hidden />, title: '2 · Structural elements', body: 'Element IDs with block, level, type and planned dates.' },
    { key: 'takeoffs' as const, icon: <Ruler size={16} aria-hidden />, title: '3 · Take-off quantities', body: 'Planned material per element, linked to BoQ items.' },
    { key: 'schedule' as const, icon: <CalendarRange size={16} aria-hidden />, title: 'From the schedule', body: 'Recognise blocks, levels and elements in the MS Project task names; link the tasks and calculate take-offs from the BoQ.' },
  ];
  return (
    <div className="stack">
      <Card title="What are you importing?" sub="Recommended order: BoQ → elements → take-offs (take-offs reference both).">
        <div className="choice-cards">
          {kinds.map((k) => (
            <button key={k.key} className={`choice-card${kind === k.key ? ' active' : ''}`} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
              <strong>{k.icon}{k.title}</strong><span className="muted">{k.body}</span>
            </button>
          ))}
        </div>
      </Card>
      {kind === 'boq' && <BoqExcelImport projectId={projectId} canSeePrices={canSeePrices} />}
      {kind === 'schedule' && <ScheduleElements projectId={projectId} />}
      {kind === 'elements' && <ImportWizard key="el" title="Import structural elements" templateFile="elements-template.xlsx" headers={elHeaders} required={['Element ID', 'Type']}
        aliases={{ Block: ['Block code'], Level: ['Level code', 'Floor'], 'Element ID': ['Element', 'Code'], Type: ['Element type'], 'Drawing ref': ['Drawing'], 'Planned start': ['Start'], 'Planned finish': ['Finish'] }}
        example={['A', 'L2', 'C12', 'column', 'B/3', 'S-201 rev B', '400x400x3000', '2026-11-01', '2026-11-10']}
        validate={validateElements} commit={commitElements}
        note={`Type is one of: ${ELEMENT_TYPES.join(', ')} (others allowed but get no activity sequence). Missing blocks and levels are created. Existing elements (same block/level/ID) are updated.`} />}
      {kind === 'takeoffs' && <ImportWizard key="to" title="Import take-off quantities" templateFile="takeoff-template.xlsx" headers={toHeaders} required={['Element ID', 'Material', 'Planned qty']}
        aliases={{ 'Element ID': ['Element', 'Code'], Grade: ['Specification'], 'Planned qty': ['Quantity', 'Qty'], 'BoQ item no': ['BoQ item', 'Item no'] }}
        example={['C12', 'A', 'L2', 'Rebar', 'S-400 Ø16', 400, '3.2.1']}
        validate={validateTakeoffs} commit={commitTakeoffs}
        note="Material and Grade must match the material master exactly (case-insensitive). Re-importing replaces the planned quantity." />}
    </div>
  );
}

function ScheduleElements({ projectId }: { projectId: string }) {
  const sq = useAsync(() => loadSchedules(projectId), [projectId], { key: 'schedules', staleTime: 60_000 });
  const [sid, setSid] = useState('');
  const list = sq.data?.schedules ?? [];
  const sched = list.find((x) => x.id === sid) ?? list[0];
  if (sq.error) return <ErrorBanner error={sq.error} onRetry={sq.reload} />;
  if (!sq.data) return <Loading lines={3} />;
  if (!sched) return <Empty title="No schedule imported yet">Import the MS Project schedule first (Planning › Import schedule).</Empty>;
  return (
    <div className="stack">
      {list.length > 1 && (
        <Card><label className="field"><span>Schedule</span>
          <select value={sched.id} onChange={(e) => setSid(e.target.value)}>{list.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select>
        </label></Card>
      )}
      <ElementsFromSchedule key={sched.id} scheduleId={sched.id} scheduleName={sched.name} />
    </div>
  );
}
