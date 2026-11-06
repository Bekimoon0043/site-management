// Store tab "Shelf life": stock on hand split into received lots (oldest issued first — FIFO), with age and expiry
// (v_stock_lots; 20261105000053). Cement defaults to a 90-day shelf life; a printed pack date can be recorded per lot.
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { qty as fmtQty, shortDate } from '../../lib/format';
import { useUrlParam } from '../../lib/url';
import type { ExpiryStatus, StockLot } from '../../lib/contract-store';
import { Badge, Banner, DataTable, ErrorBanner, Field, FilterBar, FilterSelect, Kpi, Modal, SearchInput, toast, useBusy, type Tone } from '../ui';
import { loadLots, storeRpc } from './data';

const TONE: Record<ExpiryStatus, Tone> = { expired: 'danger', expiring: 'warning', ok: 'success', no_expiry: 'neutral' };
const LABEL: Record<ExpiryStatus, string> = { expired: 'Expired', expiring: 'Use first (≤ 14 days)', ok: 'OK', no_expiry: 'No expiry' };
const EDIT_ROLES = ['store_keeper', 'coordinator', 'manager', 'admin'];

export function StockAgeingTab({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const canEdit = EDIT_ROLES.includes(auth.profile?.role ?? '');
  const q = useAsync(() => loadLots(projectId), [projectId], { key: 'stock-lots' });
  const [status, setStatus] = useUrlParam('expiry');
  const [term, setTerm] = useState('');
  const [edit, setEdit] = useState<StockLot | null>(null);
  const rows = q.data ?? [];
  const t = term.trim().toLowerCase();
  const shown = rows.filter((r) => (!status || r.expiry_status === status) && (!t || r.label.toLowerCase().includes(t) || r.doc_number.toLowerCase().includes(t) || (r.batch_no ?? '').toLowerCase().includes(t)))
    .sort((a, b) => (a.days_to_expiry ?? 1e9) - (b.days_to_expiry ?? 1e9) || b.age_days - a.age_days);
  const c = (s: ExpiryStatus) => rows.filter((r) => r.expiry_status === s).length;
  const oldest = rows.reduce((m, r) => Math.max(m, r.age_days), 0);

  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Expired lots" value={c('expired')} status={c('expired') ? 'danger' : 'ok'} compact />
        <Kpi label="Use first (≤ 14 days)" value={c('expiring')} status={c('expiring') ? 'warning' : undefined} compact />
        <Kpi label="Lots on hand" value={rows.length} compact />
        <Kpi label="Oldest stock" value={`${oldest} days`} compact />
      </div>
      {c('expired') > 0 && <Banner tone="error">Expired cement or chemicals must not go into structural work untested — have them re-tested or write them off with an adjustment.</Banner>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <DataTable rows={shown} loading={!q.data} rowKey={(r) => r.ledger_id} exportName="stock-ageing" pageSize={100}
        rowClass={(r) => (r.expiry_status === 'expired' ? 'row-error' : r.expiry_status === 'expiring' ? 'row-warn' : undefined)}
        toolbar={(
          <FilterBar>
            <SearchInput value={term} onChange={setTerm} placeholder="Material, GRN, batch" />
            <FilterSelect label="Expiry" value={(status ?? '') as ExpiryStatus | ''} onChange={(v) => setStatus(v || null)}
              options={(Object.keys(LABEL) as ExpiryStatus[]).map((s) => ({ value: s, label: LABEL[s] }))} />
          </FilterBar>
        )}
        empty={{ title: 'No stock on hand', body: 'Lots appear here as materials are received.' }}
        columns={[
          { key: 'label', label: 'Material', render: (r) => <span className="strong">{r.label}</span> },
          { key: 'store_name', label: 'Store' },
          { key: 'doc_number', label: 'Received with', id: true },
          { key: 'received_on', label: 'Received', render: (r) => shortDate(r.received_on) },
          { key: 'age_days', label: 'Age (days)', align: 'right' },
          { key: 'remaining_qty', label: 'Left of this lot', align: 'right', value: (r) => Number(r.remaining_qty), render: (r) => <>{fmtQty(r.remaining_qty, r.uom)}<span className="unit">{r.uom}</span></> },
          { key: 'expiry_date', label: 'Expires', value: (r) => r.expiry_date ?? '', render: (r) => (r.expiry_date ? `${shortDate(r.expiry_date)}${r.days_to_expiry != null ? ` (${r.days_to_expiry < 0 ? `${-r.days_to_expiry} d ago` : `${r.days_to_expiry} d`})` : ''}` : '—') },
          { key: 'expiry_status', label: 'Status', value: (r) => LABEL[r.expiry_status], render: (r) => <Badge tone={TONE[r.expiry_status]} label={LABEL[r.expiry_status]} icon={null} /> },
          { key: 'batch_no', label: 'Batch', hidden: true },
          { key: 'act', label: '', noExport: true, sortable: false, render: (r) => (canEdit && r.grn_line_id ? (
            <button className="small ghost" title="Record the expiry date printed on the pack" onClick={(e) => { e.stopPropagation(); setEdit(r); }}><CalendarClock size={14} aria-hidden />Expiry</button>) : null) },
        ]} />
      <p className="small-text muted mb-0">Lots are matched first-in-first-out: issues are taken from the oldest receipt, so “left of this lot” is what should still be on the shelf. Set shelf life per material grade under Materials (cement: 90 days by default).</p>
      {edit && <ExpiryModal lot={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
    </div>
  );
}

function ExpiryModal({ lot, onClose, onSaved }: { lot: StockLot; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(lot.expiry_date ?? '');
  const { busy, error, run } = useBusy();
  const save = (v: string | null) => void run(async () => {
    await storeRpc('set_lot_expiry', { grn_line_id: lot.grn_line_id!, expiry_date: v });
    toast.success(v ? `Expiry set to ${shortDate(v)}` : 'Using the material shelf life');
    onSaved();
  });
  return (
    <Modal title={`Expiry · ${lot.label}`} subtitle={`${lot.doc_number} received ${shortDate(lot.received_on)}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button disabled={busy} onClick={() => save(null)}>Use shelf life</button>
        <button className="primary" disabled={busy || !d} onClick={() => save(d)}>{busy && <span className="spinner" />}Save</button></>}>
      <ErrorBanner error={error} />
      <Field label="Expiry date printed on the pack" hint={lot.shelf_life_days ? `Without it: received + ${lot.shelf_life_days} days` : 'This material has no shelf life set'}>
        <input type="date" value={d} onChange={(e) => setD(e.target.value)} />
      </Field>
    </Modal>
  );
}
