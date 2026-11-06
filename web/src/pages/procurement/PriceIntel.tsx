import { lazy, Suspense, useMemo, useState } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { canProcure, type PriceObservation, type PriceTrendRow } from '../../lib/contract-procurement';
import { procRpc } from '../../lib/procurement';
import { date, humanize, money, num, today } from '../../lib/format';
import { useUrlFilters, useUrlParam } from '../../lib/url';
import { Badge, Card, DataTable, Drawer, Empty, ErrorBanner, Field, FilterBar, FilterSelect, FilterToggle, Kpi, Loading, Page, QtyInput, SearchInput, toast, useBusy } from '../../components/ui';

const PriceChart = lazy(() => import('../../components/procurement/PriceChart').then((m) => ({ default: m.PriceChart })));

interface SpecSummary {
  material_spec_id: string; label: string; category: string; uom: string; latest_price: number; latest_on: string; avg_90d: number | null;
  latest_vs_90d_pct: number | null; weeks: number; observations: number; spike: boolean;
}

/** Price intelligence (P1 #3): weekly trend per material spec, 90-day average, spikes, quick market-price log. */
export function PriceIntel() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const cur = auth.project?.currency ?? 'ETB';
  const spikePct = Number((auth.settings as { price_spike_pct?: number } | null)?.price_spike_pct ?? 15);
  const [log, setLog] = useUrlParam('log');
  const q = useAsync(() => fetchAll<PriceTrendRow>((a, b) => supabase.from('v_price_trend').select('*').order('week').range(a, b)), [], { key: 'price-trend', enabled: auth.canSeePrices });
  const spikes = useAsync(async () => check(await supabase.from('price_observations').select('*').eq('is_spike', true).order('observed_on', { ascending: false }).limit(25)) as PriceObservation[],
    [], { key: 'price-spikes', enabled: auth.canSeePrices });
  const [f, setF, { active, clear }] = useUrlFilters({ q: '', category: '', spikes: '', spec: '' });

  const summary = useMemo<SpecSummary[]>(() => {
    const m = new Map<string, SpecSummary>();
    const recent = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    for (const r of q.data ?? []) {
      const s = m.get(r.material_spec_id) ?? { material_spec_id: r.material_spec_id, label: r.label, category: r.category, uom: r.uom, latest_price: Number(r.latest_price),
        latest_on: r.latest_on, avg_90d: r.avg_90d, latest_vs_90d_pct: r.latest_vs_90d_pct, weeks: 0, observations: 0, spike: false };
      s.weeks += 1; s.observations += Number(r.observations);
      if (r.has_spike && r.week >= recent) s.spike = true;
      m.set(r.material_spec_id, s);
    }
    for (const s of m.values()) if (s.latest_vs_90d_pct !== null && Number(s.latest_vs_90d_pct) > spikePct) s.spike = true;
    return [...m.values()].sort((a, b) => Number(b.spike) - Number(a.spike) || Number(b.latest_vs_90d_pct ?? 0) - Number(a.latest_vs_90d_pct ?? 0));
  }, [q.data, spikePct]);

  if (!auth.canSeePrices) return <Page title="Price intelligence"><Empty title="Prices are restricted">Your role can't see prices. Ask an administrator to add it to the price roles.</Empty></Page>;
  const term = f.q.toLowerCase();
  const rows = summary.filter((s) => (!f.category || s.category === f.category) && (!f.spikes || s.spike) && (!term || s.label.toLowerCase().includes(term)));
  const selected = f.spec || rows[0]?.material_spec_id || '';
  const sel = summary.find((s) => s.material_spec_id === selected);
  const categories = [...new Set(summary.map((s) => s.category))].sort();
  const canLog = canProcure(auth.profile?.role, 'price.log');

  return (
    <Page width="dash" title="Price intelligence" subtitle={`Ex-VAT unit prices from quotations, approved POs and market checks · spike = more than ${num(spikePct)}% above the 90-day average`}
      actions={canLog && <button className="primary" onClick={() => setLog('1', true)}><Plus size={14} aria-hidden />Log market price</button>}>
      <ErrorBanner error={q.error ?? spikes.error ?? lk.error} onRetry={q.reload} />
      <div className="kpis">
        <Kpi label="Materials tracked" value={num(summary.length, 0)} loading={!q.data} />
        <Kpi label="Spiking now" value={num(summary.filter((s) => s.spike).length, 0)} status={summary.some((s) => s.spike) ? 'warning' : undefined} loading={!q.data} />
        <Kpi label="Price observations" value={num(summary.reduce((s, x) => s + x.observations, 0), 0)} loading={!q.data} />
        <Kpi label="Spike alerts (latest 25)" value={num(spikes.data?.length ?? 0, 0)} loading={!spikes.data} />
      </div>
      <FilterBar active={active - (f.spec ? 1 : 0)} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Material" />
        <FilterSelect label="Category" value={f.category} onChange={(v) => setF('category', v)} options={categories.map((c) => ({ value: c, label: c }))} />
        <FilterToggle label="Spikes only" checked={!!f.spikes} onChange={(v) => setF('spikes', v ? '1' : '')} />
      </FilterBar>
      <div className="grid-2">
        <DataTable rows={rows} rowKey={(r) => r.material_spec_id} loading={!q.data} error={q.error} onRetry={q.reload} exportName="price-movement" urlKey="" stickyFirst
          activeKey={selected} onRowClick={(r) => setF('spec', r.material_spec_id)} rowClass={(r) => (r.spike ? 'row-warn' : undefined)}
          filtered={active - (f.spec ? 1 : 0) > 0} onClearFilters={clear}
          empty={{ title: 'No prices recorded yet', body: 'Prices are captured automatically when RFQs are awarded and POs approved, or log a market price.' }}
          columns={[
            { key: 'label', label: 'Material / grade', id: true, render: (r) => <>{r.spike && <span className="danger-text" title="Price spike"><TriangleAlert size={13} aria-hidden /> </span>}{r.label}</> },
            { key: 'category', label: 'Category', hidden: true },
            { key: 'latest_price', label: 'Latest', align: 'right', render: (r) => <>{money(r.latest_price, cur)}<span className="unit">/{r.uom}</span></> },
            { key: 'latest_on', label: 'On', render: (r) => date(r.latest_on) },
            { key: 'avg_90d', label: '90-day avg', align: 'right', render: (r) => money(r.avg_90d, cur) },
            { key: 'latest_vs_90d_pct', label: 'Δ vs avg', align: 'right', render: (r) => (r.latest_vs_90d_pct === null ? '—'
              : <span className={Number(r.latest_vs_90d_pct) > spikePct ? 'danger-text strong' : Number(r.latest_vs_90d_pct) > 0 ? 'warn-text' : 'ok-text'}>{Number(r.latest_vs_90d_pct) > 0 ? '+' : ''}{num(r.latest_vs_90d_pct, 1)}%</span>) },
            { key: 'observations', label: 'Obs.', align: 'right' },
          ]} />
        <div className="stack">
          <Card title={sel ? sel.label : 'Trend'} sub={sel ? `${sel.category} · per ${sel.uom} · ${sel.weeks} weeks with prices` : undefined}>
            {!sel ? <Empty inline>Choose a material to see its trend.</Empty>
              : <Suspense fallback={<Loading lines={6} />}><PriceChart rows={(q.data ?? []).filter((r) => r.material_spec_id === selected)} currency={cur} /></Suspense>}
          </Card>
          {sel && lk.data && <Observations specId={selected} L={lk.data} currency={cur} />}
        </div>
      </div>
      <Card title="Recent spike alerts" flush>
        <DataTable rows={spikes.data ?? []} loading={!spikes.data} maxHeight="none" empty="No price spikes recorded." onRowClick={(r) => setF('spec', r.material_spec_id)} columns={[
          { key: 'observed_on', label: 'Date', render: (r) => date(r.observed_on) },
          { key: 'spec', label: 'Material', value: (r) => lk.data?.spec(r.material_spec_id) },
          { key: 'unit_price', label: 'Price', align: 'right', render: (r) => money(r.unit_price, r.currency) },
          { key: 'avg_90d', label: '90-day avg', align: 'right', render: (r) => money(r.avg_90d, r.currency) },
          { key: 'pct', label: 'Δ', align: 'right', value: (r) => (r.avg_90d ? (Number(r.unit_price) / Number(r.avg_90d) - 1) * 100 : null), render: (r) => (r.avg_90d ? <span className="danger-text strong">+{num((Number(r.unit_price) / Number(r.avg_90d) - 1) * 100, 1)}%</span> : '—') },
          { key: 'source', label: 'Source', render: (r) => <Badge tone="neutral" label={humanize(r.source)} icon={null} /> },
          { key: 'supplier', label: 'Supplier', value: (r) => lk.data?.suppliers.find((s) => s.id === r.supplier_id)?.name ?? '' },
        ]} />
      </Card>
      {log && lk.data && <LogPriceDrawer L={lk.data} projectId={projectId} defaultSpec={selected} onClose={() => setLog(null)} />}
    </Page>
  );
}

function Observations({ specId, L, currency }: { specId: string; L: Lookups; currency: string }) {
  const q = useAsync(async () => check(await supabase.from('price_observations').select('*').eq('material_spec_id', specId).order('observed_on', { ascending: false }).limit(50)) as PriceObservation[],
    [specId], { key: 'price-obs' });
  return (
    <Card title="Observations" flush>
      <DataTable rows={q.data ?? []} loading={!q.data} error={q.error} onRetry={q.reload} maxHeight="320px" exportName="price-observations" empty="No observations." columns={[
        { key: 'observed_on', label: 'Date', render: (r) => date(r.observed_on) },
        { key: 'unit_price', label: 'Price ex-VAT', align: 'right', render: (r) => <>{money(r.unit_price, r.currency || currency)}{r.is_spike && <> <Badge tone="danger" label="Spike" icon={null} /></>}</> },
        { key: 'source', label: 'Source', value: (r) => humanize(r.source) },
        { key: 'supplier', label: 'Supplier', value: (r) => L.suppliers.find((s) => s.id === r.supplier_id)?.name ?? '' },
        { key: 'location', label: 'Location / note', value: (r) => [r.location, r.note].filter(Boolean).join(' · ') },
      ]} />
    </Card>
  );
}

function LogPriceDrawer({ L, projectId, defaultSpec, onClose }: { L: Lookups; projectId: string; defaultSpec: string; onClose: () => void }) {
  const auth = useAuth();
  const [f, setF] = useState({ spec: defaultSpec, price: '', vat: false, on: today(), supplier: '', location: '', note: '' });
  const { busy, error, run } = useBusy();
  const go = () => run(async () => {
    if (!f.spec) throw new Error('Choose the material');
    if (f.price === '' || !(Number(f.price) >= 0)) throw new Error('Enter the unit price');
    const res = await procRpc('log_market_price', { id: crypto.randomUUID(), project_id: projectId, material_spec_id: f.spec, unit_price: Number(f.price), observed_on: f.on,
      prices_include_vat: f.vat, supplier_id: f.supplier || undefined, location: f.location || undefined, note: f.note || undefined });
    if (res.is_spike) toast.info(`${L.spec(f.spec)}: price spike — management notified`); else toast.success('Market price logged');
    onClose();
  });
  return (
    <Drawer title="Log market price" subtitle="From a phone call, Telegram channel or market visit" onClose={onClose}
      footer={<><button onClick={onClose} disabled={busy}>Cancel</button><button className="primary" disabled={busy} onClick={() => void go()}>{busy && <span className="spinner" />}Log price</button></>}>
      <div className="stack tight">
        <ErrorBanner error={error} />
        <Field label="Material / grade" required>
          <select value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} data-autofocus>
            <option value="">Choose…</option>{L.specs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Unit price" required hint={f.vat ? 'VAT is removed using the tax settings for that date.' : 'Ex-VAT, per base unit.'}>
          <QtyInput value={f.price} onChange={(v) => setF({ ...f, price: v })} unit={`${auth.project?.currency ?? 'ETB'}/${L.specUom(f.spec) || 'unit'}`} min={0} width={220} />
        </Field>
        <Field label="Price includes VAT" check><input type="checkbox" checked={f.vat} onChange={(e) => setF({ ...f, vat: e.target.checked })} /></Field>
        <Field label="Observed on"><input type="date" value={f.on} max={today()} onChange={(e) => setF({ ...f, on: e.target.value })} /></Field>
        <Field label="Supplier"><select value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}><option value="">Not a supplier quote</option>{L.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Location"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Merkato, Addis Ababa" /></Field>
        <Field label="Note"><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Drawer>
  );
}
