import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import type { GatePass, GatePassLine } from '../../lib/contract-control';
import { rpcx } from '../../lib/fieldx';
import { date, dateTime, hoursSince, num } from '../../lib/format';
import type { PreviewActions } from '../approval/Previews';
import { SBadge } from '../field/StatusBadge';
import { Badge, Banner, DataTable, ErrorBanner, Loading, useBusy } from '../ui';

export type GatePassQueueRow = GatePass & { gate_pass_lines: GatePassLine[] };

/** Inbox preview for a pending gate pass: items + on-hand stock, approve / reject (gate_pass_action). */
export function GatePassPreview({ row, L, onDone, onActions }: { row: GatePassQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: PreviewActions) => void }) {
  const lines = row.gate_pass_lines.filter((l) => !l.deleted_at);
  const specIds = [...new Set(lines.map((l) => l.material_spec_id).filter(Boolean) as string[])];
  const stock = useAsync(async () => {
    if (!row.store_id || !specIds.length) return new Map<string, number>();
    const rows = check(await supabase.from('v_stock_balance').select('material_spec_id, qty').eq('store_id', row.store_id).eq('stock_status', 'available').in('material_spec_id', specIds)) as { material_spec_id: string; qty: number }[];
    return new Map(rows.map((r) => [r.material_spec_id, Number(r.qty)]));
  }, [row.id], { key: 'gp-stock' });
  const [comment, setComment] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const decide = (approve: boolean) => {
    if (!approve && !comment.trim()) { ref.current?.focus(); return; }
    void run(async () => {
      await rpcx('gate_pass_action', { gate_pass_id: row.id, action: approve ? 'approve' : 'reject', comment: comment.trim() || undefined });
      onDone(`${row.number} ${approve ? 'approved' : 'rejected'}`);
    });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });
  const waiting = hoursSince(row.submitted_at);
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/gate/${row.id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link>
            <SBadge value={row.status} label="Awaiting approval" /><Badge tone={row.pass_type === 'returnable' ? 'info' : 'warning'} label={row.pass_type === 'returnable' ? 'Returnable' : 'Non-returnable'} icon={null} /></h2>
          <div className="meta">{L.person(row.requested_by)} · to {row.destination} · {L.store(row.store_id) || 'no store'} · <span className={waiting > 24 ? 'danger-text' : ''}>waiting {num(waiting, 0)} h</span></div>
        </div>
        <div><span className="muted">Purpose:</span> {row.purpose}</div>
        <dl className="kv">
          <dt>Vehicle</dt><dd>{row.vehicle_plate ?? '—'}{row.driver_name ? ` · ${row.driver_name}` : ''}</dd>
          {row.pass_type === 'returnable' && <><dt>Return by</dt><dd>{date(row.expected_return)}</dd></>}
          <dt>Submitted</dt><dd>{dateTime(row.submitted_at)}</dd>
        </dl>
        {row.pass_type === 'non_returnable' && <Banner tone="warn">Non-returnable — stock items leave the books permanently when the guard checks the vehicle out.</Banner>}
        <ErrorBanner error={error ?? stock.error} />
        {!stock.data ? <Loading lines={3} /> : (
          <DataTable rows={lines} maxHeight="none" columns={[
            { key: 'item', label: 'Item', value: (l) => [l.material_spec_id ? L.spec(l.material_spec_id) : null, l.description].filter(Boolean).join(' — ') },
            { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{num(l.qty, 3)}<span className="unit">{l.uom}</span></> },
            { key: 'stock', label: 'In store', align: 'right', value: (l) => (l.material_spec_id ? stock.data!.get(l.material_spec_id) ?? 0 : null),
              render: (l) => { if (!l.material_spec_id) return <span className="muted-dash">—</span>; const s = stock.data!.get(l.material_spec_id) ?? 0; return <span className={s >= Number(l.qty) ? 'ok-text' : 'danger-text strong'}>{num(s, 3)}</span>; } },
          ]} />
        )}
      </div>
      <div className="action-bar">
        <textarea ref={ref} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (required to reject)" aria-label="Comment" />
        <button disabled={busy} onClick={() => decide(false)}>Reject<kbd style={{ marginLeft: 4 }}>R</kbd></button>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}Approve<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}
