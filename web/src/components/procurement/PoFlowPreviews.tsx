// Approvals inbox: approved POs procurement still has to send (kind 'po_send') and orders the store keeper
// should receive now (kind 'po_receive') — both from app.purchase_store_approvals_for.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, PackageCheck, Send } from 'lucide-react';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PlanQueueRow } from '../../lib/approvals';
import { procRpc } from '../../lib/procurement';
import { date, qty as fmtQty } from '../../lib/format';
import { Badge, Banner, DataTable, ErrorBanner, Loading, useBusy } from '../ui';
import { GrnFromPoDrawer, loadIncomingPo, poStage } from '../store/Incoming';

interface Props { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }

function Lines({ id, L, outstandingOnly }: { id: string; L: Lookups; outstandingOnly: boolean }) {
  const q = useAsync(() => loadIncomingPo(id), [id], { key: 'incoming-po' });
  if (!q.data) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={4} />;
  const { po, notice } = q.data;
  const s = poStage(po, notice);
  const lines = po.po_lines.filter((l) => !l.deleted_at).map((l) => ({ ...l, out: l.closed ? 0 : Math.max(Number(l.qty) - Number(l.qty_accepted), 0) }))
    .filter((l) => !outstandingOnly || l.out > 0);
  return (
    <>
      <p className="mb-0"><Badge tone={s.tone} label={s.label} icon={null} />{notice && <span className="small-text muted"> · delivery announced for {date(notice.expected_date)}</span>}</p>
      <DataTable rows={lines} rowKey={(l) => l.id} maxHeight="none" columns={[
        { key: 'line_no', label: '#', align: 'right', width: 32 },
        { key: 'spec', label: 'Material', value: (l) => L.spec(l.material_spec_id) },
        { key: 'qty', label: 'Ordered', align: 'right', render: (l) => fmtQty(l.qty, L.specUom(l.material_spec_id)) },
        { key: 'out', label: 'Still to come', align: 'right', render: (l) => fmtQty(l.out, L.specUom(l.material_spec_id)) },
      ]} />
    </>
  );
}

export function PoSendPreview({ row, L, onDone, onActions }: Props) {
  const { busy, error, run } = useBusy();
  const send = () => void run(async () => {
    await procRpc('po_action', { po_id: row.entity_id, action: 'send' });
    onDone(`${row.number} sent — the store keeper is told to expect it`);
  });
  useEffect(() => { onActions({ approve: send }); });
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/procurement/po/${row.entity_id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link></h2>
          <div className="meta">{row.title} · approved {date(row.requested_at)}</div>
        </div>
        <ErrorBanner error={error} />
        <Banner tone="info">Approved and ready. Send it to the supplier (print / email from the PO page if needed), then mark it sent here — the store keeper sees it as an incoming order.</Banner>
        <Lines id={row.entity_id} L={L} outstandingOnly={false} />
      </div>
      <div className="action-bar">
        <span className="grow" />
        <button className="primary" disabled={busy} onClick={send}>{busy ? <span className="spinner" /> : <Send size={14} aria-hidden />}Mark sent to supplier<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}

export function PoReceivePreview({ row, L, onDone, onActions }: Props) {
  const q = useAsync(() => loadIncomingPo(row.entity_id), [row.entity_id], { key: 'incoming-po' });
  const [open, setOpen] = useState(false);
  useEffect(() => { onActions({ approve: () => setOpen(true) }); });
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/procurement/po/${row.entity_id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link></h2>
          <div className="meta">{row.title}{row.requested_at ? ` · expected ${date(row.requested_at)}` : ''}{row.is_urgent ? ' · late' : ''}</div>
        </div>
        <Lines id={row.entity_id} L={L} outstandingOnly />
      </div>
      <div className="action-bar">
        <span className="grow" />
        <button className="primary" disabled={!q.data} onClick={() => setOpen(true)}><PackageCheck size={14} aria-hidden />Receive (GRN)<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
      {open && q.data && <GrnFromPoDrawer po={q.data.po} notice={q.data.notice} L={L} onClose={() => setOpen(false)} onDone={() => onDone(`${row.number} received`)} />}
    </>
  );
}
