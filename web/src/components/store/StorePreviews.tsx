// Approvals inbox previews for the store keeper: a tool past its return date ('tool_overdue') and expired /
// expiring stock lots ('stock_expiry') — from app.tools_approvals_for / app.stock_expiry_approvals_for.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PlanQueueRow } from '../../lib/approvals';
import { check, supabase } from '../../lib/supabase';
import { qty as fmtQty, shortDate } from '../../lib/format';
import type { StockLot, ToolCondition, ToolRow } from '../../lib/contract-store';
import { Badge, Banner, ErrorBanner, Field, Loading, useBusy } from '../ui';
import { storeRpc } from './data';

interface Props { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void }

export function ToolOverduePreview({ row, onDone }: Props) {
  const q = useAsync(async () => check(await supabase.from('v_tools').select('*').eq('id', row.entity_id).maybeSingle()) as ToolRow | null,
    [row.entity_id], { key: 'tool-one' });
  const [cond, setCond] = useState<ToolCondition>('good');
  const [note, setNote] = useState('');
  const { busy, error, run } = useBusy();
  const t = q.data;
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!t) return <Loading lines={4} />;
  const ret = () => void run(async () => {
    await storeRpc('tool_action', { tool_id: t.id, action: 'return', condition: cond, note: note || undefined });
    onDone(`${t.tag} returned${cond === 'damaged' ? ' — sent for repair' : ''}`);
  });
  return (
    <div className="stack">
      <h2 className="mb-0">{t.tag} · {t.name}</h2>
      <Banner tone="warn">With <b>{t.holder ?? '?'}</b> — due back {shortDate(t.due_on)}, {t.days_overdue} day{t.days_overdue === 1 ? '' : 's'} late.</Banner>
      <ErrorBanner error={error} />
      <dl className="kv"><dt>Issued</dt><dd>{shortDate(t.issued_at)}</dd><dt>Store</dt><dd>{t.store_name ?? '—'}</dd><dt>Serial no.</dt><dd>{t.serial_no ?? '—'}</dd></dl>
      <div className="form-grid">
        <Field label="Condition on return">
          <select value={cond} onChange={(e) => setCond(e.target.value as ToolCondition)}>
            <option value="good">Good</option><option value="fair">Fair</option><option value="damaged">Damaged → repair</option>
          </select>
        </Field>
        <Field label={cond === 'damaged' ? 'Describe the damage' : 'Note'} required={cond === 'damaged'}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <div className="row">
        <button className="primary" disabled={busy || (cond === 'damaged' && !note.trim())} onClick={ret}>{busy && <span className="spinner" />}It's back — record return</button>
        <Link to={`/store?tool=${t.id}#tools`}>Open in the tools register</Link>
      </div>
    </div>
  );
}

export function StockExpiryPreview({ row }: Props) {
  const q = useAsync(async () => check(await supabase.from('v_stock_lots').select('*').eq('project_id', row.project_id)
    .eq('material_spec_id', row.entity_id).in('expiry_status', ['expired', 'expiring']).order('received_on')) as StockLot[],
    [row.entity_id, row.project_id], { key: 'stock-lots-one' });
  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  if (!q.data) return <Loading lines={4} />;
  const expired = q.data.some((l) => l.expiry_status === 'expired');
  return (
    <div className="stack">
      <h2 className="mb-0">{q.data[0]?.label ?? row.title}</h2>
      <Banner tone={expired ? 'error' : 'warn'}>
        {expired ? 'Past its shelf life: have it re-tested before structural use, or write it off with an adjustment.' : 'Issue these lots first, before newer deliveries.'}
      </Banner>
      <div className="table-wrap"><table>
        <thead><tr><th>Received with</th><th>Store</th><th>Received</th><th className="right">Left</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {q.data.map((l) => (
            <tr key={l.ledger_id}>
              <td>{l.doc_number}</td><td>{l.store_name}</td><td>{shortDate(l.received_on)}</td>
              <td className="right">{fmtQty(l.remaining_qty, l.uom)} {l.uom}</td><td>{shortDate(l.expiry_date)}</td>
              <td><Badge tone={l.expiry_status === 'expired' ? 'danger' : 'warning'} label={l.expiry_status === 'expired' ? 'Expired' : 'Use first'} icon={null} /></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Link to="/store?expiry=expired#ageing">Shelf life list</Link>
        {expired && <Link to="/store#adjustments">Write off (adjustment)</Link>}
      </div>
    </div>
  );
}
