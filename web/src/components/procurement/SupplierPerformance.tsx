// Procurement tab "Supplier performance": scorecard per supplier (v_supplier_performance; 20261105000052) — quality
// (accepted ÷ delivered), on-time delivery vs the promised date, price vs the 90-day average (price roles only),
// service rating from store keepers and buyers. Drawer: every receipt with days late and rejections, plus rating an order.
import { useState } from 'react';
import { Star } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { num, shortDate } from '../../lib/format';
import { useUrlParam } from '../../lib/url';
import type { SupplierPerformance } from '../../lib/contract-store';
import { Badge, Banner, DataTable, Drawer, ErrorBanner, Field, Loading, SearchInput, toast, useBusy, type Tone } from '../ui';
import { loadSupplierDeliveries, loadSupplierPerformance, storeRpc } from '../store/data';

const GRADE_TONE: Record<string, Tone> = { A: 'success', B: 'primary', C: 'warning', D: 'danger' };
const pct = (v: number | null) => (v == null ? '—' : `${num(v, 1)} %`);
export const RATE_ROLES = ['store_keeper', 'procurement', 'coordinator', 'manager', 'admin'];

export function SupplierPerformanceTab() {
  const auth = useAuth();
  const q = useAsync(loadSupplierPerformance, [], { key: 'supplier-performance' });
  const [term, setTerm] = useState('');
  const [open, setOpen] = useUrlParam('supplier');
  const t = term.trim().toLowerCase();
  const rows = (q.data ?? []).filter((r) => !t || r.name.toLowerCase().includes(t));
  const sel = (q.data ?? []).find((r) => r.supplier_id === open);
  return (
    <div className="stack">
      <Banner tone="info">
        Score = quality 50 % (accepted ÷ delivered) + on-time delivery 35 % + price 15 % (vs the 90-day average){auth.canSeePrices ? '' : ' — without price access the score uses quality and delivery only'}.
        Grade A ≥ 90 · B ≥ 80 · C ≥ 70 · D below.
      </Banner>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={rows} loading={!q.data} rowKey={(r) => r.supplier_id} onRowClick={(r) => setOpen(r.supplier_id)} activeKey={open} exportName="supplier-performance"
        defaultSort={{ key: 'score', dir: 'desc' }}
        rowClass={(r) => (r.grade === 'D' ? 'row-error' : r.overdue_orders > 0 ? 'row-warn' : undefined)}
        toolbar={<SearchInput value={term} onChange={setTerm} placeholder="Supplier" />}
        empty={{ title: 'No supplier history yet', body: 'Scores appear once orders are received against purchase orders.' }}
        columns={[
          { key: 'name', label: 'Supplier', render: (r) => <span className="strong">{r.name}</span> },
          { key: 'grade', label: 'Grade', value: (r) => r.grade ?? '', render: (r) => (r.grade ? <Badge tone={GRADE_TONE[r.grade]} label={`${r.grade} · ${num(r.score, 0)}`} icon={null} /> : <span className="muted">—</span>) },
          { key: 'score', label: 'Score', align: 'right', hidden: true, value: (r) => (r.score == null ? null : Number(r.score)) },
          { key: 'quality_pct', label: 'Quality', align: 'right', value: (r) => r.quality_pct, render: (r) => pct(r.quality_pct) },
          { key: 'on_time_pct', label: 'On time', align: 'right', value: (r) => r.on_time_pct, render: (r) => pct(r.on_time_pct) },
          { key: 'avg_days_late', label: 'Avg days late', align: 'right', render: (r) => (r.avg_days_late == null ? '—' : num(r.avg_days_late, 1)) },
          ...(auth.canSeePrices ? [{ key: 'price_index', label: 'Price vs avg', align: 'right' as const, value: (r: SupplierPerformance) => r.price_index,
            render: (r: SupplierPerformance) => (r.price_index == null ? '—' : <span className={Number(r.price_index) > 1.05 ? 'warn-text' : undefined}>{Number(r.price_index) >= 1 ? '+' : ''}{num((Number(r.price_index) - 1) * 100, 1)} %</span>) }] : []),
          { key: 'service_rating', label: 'Service', align: 'right', value: (r) => r.service_rating, render: (r) => (r.service_rating == null ? '—' : `${num(r.service_rating, 1)} ★ (${r.ratings})`) },
          { key: 'orders', label: 'Orders', align: 'right' },
          { key: 'deliveries', label: 'Receipts', align: 'right' },
          { key: 'overdue_orders', label: 'Overdue now', align: 'right', render: (r) => (r.overdue_orders ? <span className="danger-text strong">{r.overdue_orders}</span> : '0') },
          { key: 'rejected_lines', label: 'Rejected lines', align: 'right', hidden: true },
          { key: 'last_delivery', label: 'Last delivery', render: (r) => shortDate(r.last_delivery) },
        ]} />
      {sel && <SupplierDrawer key={sel.supplier_id} s={sel} onClose={() => setOpen(null)} onRated={q.reload} />}
    </div>
  );
}

function SupplierDrawer({ s, onClose, onRated }: { s: SupplierPerformance; onClose: () => void; onRated: () => void }) {
  const auth = useAuth();
  const d = useAsync(() => loadSupplierDeliveries(s.supplier_id), [s.supplier_id], { key: 'supplier-deliveries' });
  return (
    <Drawer size="lg" title={s.name} subtitle={s.grade ? <Badge tone={GRADE_TONE[s.grade]} label={`Grade ${s.grade} · ${num(s.score, 1)}`} icon={null} /> : 'Not enough history'} onClose={onClose}>
      <dl className="kv">
        <dt>Quality</dt><dd>{pct(s.quality_pct)}{s.rejected_lines ? ` · ${s.rejected_lines} receipt line(s) with rejections` : ''}</dd>
        <dt>On time</dt><dd>{pct(s.on_time_pct)} of {s.dated ?? 0} dated receipts{s.avg_days_late != null ? ` · avg ${num(s.avg_days_late, 1)} days late` : ''}</dd>
        {auth.canSeePrices && <><dt>Price</dt><dd>{s.price_index == null ? 'No price history' : `${num((Number(s.price_index) - 1) * 100, 1)} % vs the 90-day average (score ${num(s.price_score, 0)})`}</dd></>}
        <dt>Service</dt><dd>{s.service_rating == null ? 'Not rated yet' : `${num(s.service_rating, 1)} ★ from ${s.ratings} rating(s)`}</dd>
        <dt>Phone</dt><dd>{s.phone ?? '—'}</dd>
      </dl>
      <h3 className="mt-4">Receipts against orders</h3>
      {d.error ? <ErrorBanner error={d.error} onRetry={d.reload} /> : !d.data ? <Loading lines={4} /> : (
        <DataTable rows={d.data} rowKey={(r) => r.grn_id} pageSize={25} exportName={`deliveries-${s.name}`} empty="No receipts yet."
          rowClass={(r) => (Number(r.qty_rejected) > 0 ? 'row-warn' : undefined)}
          columns={[
            { key: 'grn_number', label: 'GRN', id: true },
            { key: 'po_number', label: 'PO' },
            { key: 'promised_on', label: 'Promised', render: (r) => shortDate(r.promised_on) },
            { key: 'received_on', label: 'Received', render: (r) => shortDate(r.received_on) },
            { key: 'days_late', label: 'Days late', align: 'right', render: (r) => (r.days_late == null ? '—' : r.days_late > 0 ? <span className="danger-text">{r.days_late}</span> : 'On time') },
            { key: 'qty_rejected', label: 'Rejected qty', align: 'right', render: (r) => (Number(r.qty_rejected) ? num(r.qty_rejected, 2) : '—') },
          ]} />
      )}
      {RATE_ROLES.includes(auth.profile?.role ?? '') && <RateOrder supplierId={s.supplier_id} onRated={onRated} />}
    </Drawer>
  );
}

/** Rate one order of this supplier 1–5 (rate_supplier). */
function RateOrder({ supplierId, onRated }: { supplierId: string; onRated: () => void }) {
  const pos = useAsync(async () => check(await supabase.from('purchase_orders').select('id, number, status, order_date')
    .eq('supplier_id', supplierId).in('status', ['sent', 'partially_received', 'received', 'closed']).order('order_date', { ascending: false }).limit(50)) as { id: string; number: string }[],
    [supplierId], { key: 'supplier-pos' });
  const [po, setPo] = useState('');
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState('');
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await storeRpc('rate_supplier', { po_id: po, score, comment: comment || undefined });
    toast.success('Rating saved');
    setScore(0); setComment('');
    onRated();
  });
  if (!pos.data?.length) return null;
  return (
    <div className="card mt-4 stack" style={{ padding: 'var(--sp-3)' }}>
      <h3 className="mb-0">Rate an order</h3>
      <p className="small-text muted mb-0">Paperwork, responsiveness, packaging, behaviour at the gate — one rating per order and person (rating again replaces yours).</p>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Order"><select value={po} onChange={(e) => setPo(e.target.value)}><option value="">Choose…</option>{pos.data.map((p) => <option key={p.id} value={p.id}>{p.number}</option>)}</select></Field>
        <Field label="Score">
          <span className="row" role="radiogroup" aria-label="Score" style={{ gap: 2 }}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="ghost small" role="radio" aria-checked={score === n} aria-label={`${n} of 5`} onClick={() => setScore(n)}>
                <Star size={18} fill={n <= score ? 'currentColor' : 'none'} className={n <= score ? 'warn-text' : 'muted'} aria-hidden />
              </button>
            ))}
          </span>
        </Field>
        <Field label="Comment" wide required={score > 0 && score <= 2}><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={score > 0 && score <= 2 ? 'What went wrong?' : ''} /></Field>
      </div>
      <div><button className="primary" disabled={busy || !po || !score || (score <= 2 && !comment.trim())} onClick={save}>{busy && <span className="spinner" />}Save rating</button></div>
    </div>
  );
}
