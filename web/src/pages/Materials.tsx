import { Star } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { invalidateLookups, useAsync, type SpecRow } from '../lib/hooks';
import { check, fetchAll, supabase } from '../lib/supabase';
import { invalidateAfterWrite } from '../lib/query';
import type { Material } from '../lib/contract';
import { cellNum, cellStr, money, num, pick, shortDate } from '../lib/format';
import { useUrlFilters } from '../lib/url';
import { CrudTable } from '../components/CrudTable';
import { ImportWizard, type ImportRow } from '../components/ImportWizard';
import { DataTable, Empty, ErrorBanner, FilterBar, FilterSelect, Page, SearchInput, Tabs, toast, useBusy, useHashTab } from '../components/ui';

const TABS = ['specs', 'materials', 'conversions', 'prices', 'suppliers', 'import'] as const;
type Tab = (typeof TABS)[number];

export function Materials() {
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'specs');
  const canEdit = auth.can('master.edit');
  const role = auth.profile?.role;
  const canEditPrices = auth.canSeePrices && !!role && ['coordinator', 'manager', 'procurement', 'admin'].includes(role);
  const canEditSuppliers = !!role && ['coordinator', 'manager', 'procurement', 'admin'].includes(role);
  // Cached across tab switches (was refetched on every switch).
  const mats = useAsync(async () => check(await supabase.from('materials').select('*').is('deleted_at', null).order('category').order('name')) as Material[], [], { key: 'materials', staleTime: 5 * 60_000 });
  const specs = useAsync(() => fetchAll<SpecRow>((a, b) => supabase.from('v_specs').select('*').order('label').range(a, b)), [], { key: 'v_specs', staleTime: 5 * 60_000 });
  const [f, setF, { active, clear }] = useUrlFilters({ category: '', material: '', q: '' });

  const categories = [...new Set((mats.data ?? []).map((m) => m.category))];
  const matById = new Map((mats.data ?? []).map((m) => [m.id, m]));
  const matOptions = (mats.data ?? []).filter((m) => !f.category || m.category === f.category).map((m) => ({ value: m.id, label: `${m.category} — ${m.name}` }));
  const specOptions = (specs.data ?? []).map((s) => ({ value: s.id, label: `${s.label} (${s.uom})` }));
  const saved = () => { invalidateLookups(); };
  const term = f.q.toLowerCase();

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'specs', label: 'Grades / specifications', count: specs.data?.length },
    { key: 'materials', label: 'Materials', count: mats.data?.length },
    { key: 'conversions', label: 'Unit conversions' },
    ...(auth.canSeePrices ? [{ key: 'prices' as Tab, label: 'Prices' }] : []),
    { key: 'suppliers', label: 'Suppliers' },
    { key: 'import', label: 'Import from Excel' },
  ];

  return (
    <Page title="Materials" subtitle="Company-wide material master, grades, units, prices and suppliers">
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      <ErrorBanner error={mats.error ?? specs.error} />
      {tab === 'specs' && (
        <div className="stack">
          <FilterBar active={active} onClear={clear}>
            <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Grade, material" />
            <FilterSelect label="Category" value={f.category} onChange={(v) => setF('category', v)} options={categories.map((c) => ({ value: c, label: c }))} />
            <FilterSelect label="Material" value={f.material} onChange={(v) => setF('material', v)} options={matOptions} />
          </FilterBar>
          <CrudTable table="material_specs" title="Specification" canEdit={canEdit} onSaved={saved} exportName="material-specs" viewKey="specs"
            filtered={active > 0} onClearFilters={clear}
            defaults={{ grade: '', wastage_pct: 0, min_level: 0, reorder_level: 0, lead_time_days: 0, is_active: true, track_batches: false }}
            filterRows={(rows) => rows.filter((r) => {
              const m = matById.get(String(r.material_id));
              return (!f.material || r.material_id === f.material) && (!f.category || m?.category === f.category)
                && (!term || `${m?.name ?? ''} ${r.grade}`.toLowerCase().includes(term));
            }).sort((a, b) => {
              const ma = matById.get(String(a.material_id)), mb = matById.get(String(b.material_id));
              return `${ma?.category}|${ma?.name}|${a.grade}`.localeCompare(`${mb?.category}|${mb?.name}|${b.grade}`);
            })}
            fields={[
              { key: 'material_id', label: 'Material', type: 'select', required: true, options: (mats.data ?? []).map((m) => ({ value: m.id, label: `${m.category} — ${m.name}` })),
                render: (r) => { const m = matById.get(String(r.material_id)); return m ? <><span className="muted">{m.category} · </span><span className="strong">{m.name}</span></> : '?'; } },
              { key: 'grade', label: 'Grade / spec', hint: 'e.g. C-25/30, S-400 Ø16, OPC 42.5' },
              { key: 'uom', label: 'Unit', required: true },
              { key: 'wastage_pct', label: 'Wastage %', type: 'number' },
              { key: 'min_level', label: 'Min level', type: 'number', hidden: true },
              { key: 'reorder_level', label: 'Reorder level', type: 'number' },
              { key: 'lead_time_days', label: 'Lead time (days)', type: 'number' },
              { key: 'shelf_life_days', label: 'Shelf life (days)', type: 'number', hidden: true, hint: 'Empty = does not expire. Cement ≈ 90 days; the store flags older stock (Store › Shelf life).' },
              { key: 'track_batches', label: 'Batch tracking', type: 'bool', hidden: true },
              { key: 'is_active', label: 'Active', type: 'bool' },
              { key: 'description', label: 'Description', type: 'textarea', inTable: false },
            ]} />
        </div>
      )}
      {tab === 'materials' && (
        <CrudTable table="materials" title="Material" canEdit={canEdit} onSaved={saved} orderBy="category" exportName="materials"
          fields={[
            { key: 'category', label: 'Category', required: true, hint: 'e.g. Concrete, Reinforcement, Cement, Blocks' },
            { key: 'name', label: 'Name', required: true },
            { key: 'standard_ref', label: 'Standard reference' },
          ]} />
      )}
      {tab === 'conversions' && (
        <CrudTable table="spec_conversions" title="Conversion" canEdit={canEdit} exportName="unit-conversions"
          fields={[
            { key: 'material_spec_id', label: 'Material / grade', type: 'select', required: true, options: specOptions },
            { key: 'alt_uom', label: 'Alternative unit', required: true, hint: 'e.g. bag (50kg), bar 12m, truck (7m3)' },
            { key: 'factor', label: 'Factor (base units per alt unit)', type: 'number', required: true },
          ]} />
      )}
      {tab === 'prices' && auth.canSeePrices && <Prices specs={specs.data} canEdit={canEditPrices} />}
      {tab === 'suppliers' && (
        <CrudTable table="suppliers" title="Supplier" canEdit={canEditSuppliers} orderBy="name" onSaved={invalidateLookups} exportName="suppliers"
          defaults={{ categories: [], vat_registered: true }}
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'contact_person', label: 'Contact person' },
            { key: 'phone', label: 'Phone' },
            { key: 'email', label: 'Email' },
            { key: 'tin', label: 'TIN' },
            { key: 'vat_registered', label: 'VAT registered', type: 'bool', inTable: false },
            { key: 'payment_terms', label: 'Default payment terms', inTable: false },
            { key: 'address', label: 'Address', inTable: false },
            { key: 'categories', label: 'Categories supplied', type: 'tags' },
            { key: 'rating', label: 'Rating (0–5)', type: 'number',
              render: (r) => (r.rating === null || r.rating === undefined ? <span className="muted-dash">—</span> : <span className="row nowrap" style={{ justifyContent: 'flex-end', gap: 4 }}>{num(r.rating, 1)}<Star size={13} fill="var(--accent)" stroke="var(--accent)" aria-hidden /></span>) },
          ]} />
      )}
      {tab === 'import' && <MaterialImport canEdit={canEdit} canEditPrices={canEditPrices} onDone={saved} />}
    </Page>
  );
}

function Prices({ specs, canEdit }: { specs: SpecRow[] | undefined; canEdit: boolean }) {
  const prices = useAsync(async () => {
    const rows = check(await supabase.from('spec_prices').select('*')) as { material_spec_id: string; unit_price: number; currency: string; updated_at: string }[];
    return new Map(rows.map((r) => [r.material_spec_id, r]));
  }, [], { key: 'spec-prices' });
  const { error, run } = useBusy();
  const [f, setF, { active, clear }] = useUrlFilters({ pq: '' });
  const term = f.pq.toLowerCase();
  const rows = (specs ?? []).filter((s) => !term || s.label.toLowerCase().includes(term) || s.category.toLowerCase().includes(term));
  return (
    <div className="stack">
      <ErrorBanner error={error ?? prices.error} />
      <FilterBar active={active} onClear={clear}><SearchInput value={f.pq} onChange={(v) => setF('pq', v)} placeholder="Material, category" /></FilterBar>
      <DataTable rows={rows} loading={!specs || !prices.data} exportName="material-prices" filtered={active > 0} onClearFilters={clear} stickyFirst columns={[
        { key: 'label', label: 'Material / grade', id: true },
        { key: 'category', label: 'Category' },
        { key: 'uom', label: 'Unit' },
        { key: 'price', label: 'Unit price (ETB)', align: 'right',
          value: (s) => prices.data?.get(s.id)?.unit_price ?? '',
          render: (s) => {
            const p = prices.data?.get(s.id);
            if (!canEdit) return p ? money(p.unit_price, p.currency) : <span className="muted-dash">—</span>;
            return (
              <input type="number" inputMode="decimal" step="any" className="num-input" style={{ width: 130 }} defaultValue={p?.unit_price ?? ''} aria-label={`Price for ${s.label}`} onBlur={(e) => {
                const v = e.target.value;
                if (v === String(p?.unit_price ?? '')) return;
                void run(async () => {
                  if (v === '') check(await supabase.from('spec_prices').delete().eq('material_spec_id', s.id));
                  else check(await supabase.from('spec_prices').upsert({ material_spec_id: s.id, unit_price: Number(v) }));
                  invalidateAfterWrite();
                  toast.success(`Price saved for ${s.label}`);
                });
              }} />
            );
          } },
        { key: 'updated', label: 'Updated', value: (s) => prices.data?.get(s.id)?.updated_at ?? '', render: (s) => shortDate(prices.data?.get(s.id)?.updated_at) || <span className="muted-dash">—</span> },
      ]} />
    </div>
  );
}

interface SpecImport { category: string; material: string; grade: string; uom: string; wastage_pct: number; min_level: number; reorder_level: number; lead_time_days: number; price: number | null }

function MaterialImport({ canEdit, canEditPrices, onDone }: { canEdit: boolean; canEditPrices: boolean; onDone: () => void }) {
  if (!canEdit) return <Empty title="No access">Only office engineers and management can import materials.</Empty>;
  const headers = ['Category', 'Material', 'Grade', 'Unit', 'Wastage %', 'Min level', 'Reorder level', 'Lead time days', ...(canEditPrices ? ['Unit price'] : [])];
  const validate = async (rows: Record<string, unknown>[]): Promise<ImportRow<SpecImport>[]> => {
    const seen = new Set<string>();
    return rows.map((r, i) => {
      const rec: SpecImport = {
        category: cellStr(pick(r, 'Category')), material: cellStr(pick(r, 'Material', 'Name')), grade: cellStr(pick(r, 'Grade', 'Specification')),
        uom: cellStr(pick(r, 'Unit', 'UoM')), wastage_pct: cellNum(pick(r, 'Wastage %', 'Wastage')) ?? 0,
        min_level: cellNum(pick(r, 'Min level')) ?? 0, reorder_level: cellNum(pick(r, 'Reorder level')) ?? 0,
        lead_time_days: Math.round(cellNum(pick(r, 'Lead time days', 'Lead time')) ?? 0),
        price: canEditPrices ? cellNum(pick(r, 'Unit price', 'Price')) : null,
      };
      const errors: string[] = [];
      if (!rec.category) errors.push('Category missing');
      if (!rec.material) errors.push('Material missing');
      if (!rec.uom) errors.push('Unit missing');
      if (rec.wastage_pct < 0 || rec.wastage_pct > 100) errors.push('Wastage % out of range');
      const k = `${rec.category}|${rec.material}|${rec.grade}`.toLowerCase();
      if (seen.has(k)) errors.push('Duplicate row in file');
      seen.add(k);
      return { rowNo: i + 2, errors, record: errors.length ? null : rec,
        display: Object.fromEntries(headers.map((h, j) => [h, String([rec.category, rec.material, rec.grade, rec.uom, rec.wastage_pct, rec.min_level, rec.reorder_level, rec.lead_time_days, rec.price ?? ''][j])])) };
    });
  };
  const commit = async (recs: SpecImport[]) => {
    const mats = check(await supabase.from('materials').upsert(
      [...new Map(recs.map((r) => [`${r.category}|${r.material}`, { category: r.category, name: r.material, deleted_at: null }])).values()],
      { onConflict: 'category,name' }).select('id, category, name')) as Material[];
    const mid = new Map(mats.map((m) => [`${m.category}|${m.name}`, m.id]));
    const specs = check(await supabase.from('material_specs').upsert(recs.map((r) => ({
      material_id: mid.get(`${r.category}|${r.material}`), grade: r.grade, uom: r.uom, wastage_pct: r.wastage_pct, min_level: r.min_level,
      reorder_level: r.reorder_level, lead_time_days: r.lead_time_days, deleted_at: null,
    })), { onConflict: 'material_id,grade' }).select('id, material_id, grade')) as { id: string; material_id: string; grade: string }[];
    let priced = 0;
    if (canEditPrices) {
      const sid = new Map(specs.map((s) => [`${s.material_id}|${s.grade}`, s.id]));
      const prices = recs.filter((r) => r.price !== null).map((r) => ({ material_spec_id: sid.get(`${mid.get(`${r.category}|${r.material}`)}|${r.grade}`)!, unit_price: r.price! }));
      if (prices.length) { check(await supabase.from('spec_prices').upsert(prices)); priced = prices.length; }
    }
    invalidateAfterWrite({ lookups: true });
    onDone();
    return `Imported ${specs.length} specifications across ${mats.length} materials${canEditPrices ? ` (${priced} priced)` : ''}.`;
  };
  return (
    <ImportWizard title="Import material master" templateFile="materials-template.xlsx" headers={headers} required={['Category', 'Material', 'Unit']}
      aliases={{ Material: ['Name'], Grade: ['Specification'], Unit: ['UoM'], 'Wastage %': ['Wastage'], 'Lead time days': ['Lead time'], 'Unit price': ['Price'] }}
      example={['Reinforcement', 'Rebar', 'S-400 Ø16', 'kg', 3, 500, 1000, 7, ...(canEditPrices ? [95] : [])]}
      validate={validate} commit={commit} note="Each row is one selectable grade/specification. Existing material + grade combinations are updated." />
  );
}
