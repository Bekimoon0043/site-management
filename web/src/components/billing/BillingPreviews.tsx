// Approvals inbox: client payment certificates (kind 'client_ipc') and variations (kind 'variation') —
// from app.billing_approvals_for (20261103000060_client_billing.sql).
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, ExternalLink } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PlanQueueRow } from '../../lib/approvals';
import { money } from '../../lib/format';
import { IPC_STATUS_LABELS, type IpcTotals } from '../../lib/contract-billing';
import { Badge, Banner, ErrorBanner, Loading, ReasonModal, useBusy } from '../ui';
import { billRpc, canBill, loadIpc, loadVariations } from './data';

interface Props { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }

export function ClientIpcPreview({ row, L, onDone, onActions }: Props) {
  const auth = useAuth();
  const nav = useNavigate();
  const role = auth.profile?.role;
  const q = useAsync(() => loadIpc(row.entity_id), [row.entity_id, row.status], { key: 'client-ipc' });
  const [ret, setRet] = useState(false);
  const { busy, error, run } = useBusy();
  const ipc = q.data?.ipc;
  const action = ipc?.status === 'prepared' && canBill(role, 'check') ? 'check' as const : ipc?.status === 'checked' && canBill(role, 'submit') ? 'submit' as const : null;
  const go = () => void run(async () => {
    if (!action || !ipc) return;
    await billRpc('decide_client_ipc', { ipc_id: ipc.id, action });
    onDone(action === 'check' ? `IPC ${ipc.ipc_no} checked — sent to the manager` : `IPC ${ipc.ipc_no} submitted to the consultant`);
  });
  useEffect(() => { onActions(action ? { approve: go, reject: () => setRet(true) } : {}); });
  if (!ipc) return <div className="inbox-preview-body">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />}</div>;
  const t = (ipc.certified ?? ipc.claimed) as Partial<IpcTotals>;
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/billing/ipc/${ipc.id}`}>Payment certificate {ipc.ipc_no} <ExternalLink size={14} aria-hidden /></Link></h2>
          <div className="meta"><Badge tone="warning" label={IPC_STATUS_LABELS[ipc.status]} icon={null} /> · valuation {ipc.period_to} · prepared by {L.person(ipc.prepared_by) || '—'}</div>
        </div>
        <ErrorBanner error={error} />
        {ipc.status === 'certified' && <Banner tone="info">Certified — record the client's payment on the certificate page when it is received.</Banner>}
        <dl className="kv">
          <dt>Work executed to date</dt><dd>{money(t.work_cum)}</dd>
          <dt>Retention / advance repayment</dt><dd>{money(t.retention_cum)} / {money(t.advance_recovery_cum)}</dd>
          <dt>This certificate (ex VAT)</dt><dd>{money(t.this_net)}</dd>
          <dt>VAT / withholding</dt><dd>{money(t.vat)} / −{money(t.wht)}</dd>
          <dt>Net payable</dt><dd className="strong">{money(t.payable)}</dd>
          <dt>Measured lines</dt><dd>{q.data?.lines.filter((l) => Number(l.cum_qty) > 0).length ?? 0}{q.data?.lines.some((l) => l.remeasured) ? ' (some re-measured)' : ''}</dd>
        </dl>
      </div>
      <div className="action-bar">
        <span className="grow" />
        {action && <button disabled={busy} onClick={() => setRet(true)}>Return…<kbd style={{ marginLeft: 4 }}>R</kbd></button>}
        {action && <button className="primary" disabled={busy} onClick={go}>{busy ? <span className="spinner" /> : <Check size={14} aria-hidden />}{action === 'check' ? 'Checked' : 'Approve & submit'}<kbd style={{ marginLeft: 4 }}>A</kbd></button>}
        {!action && <button className="primary" onClick={() => nav(`/billing/ipc/${ipc.id}`)}>Open certificate</button>}
      </div>
      {ret && <ReasonModal title={`Return IPC ${ipc.ipc_no}`} label="What needs correcting" onClose={() => setRet(false)}
        onSubmit={async (comment) => { await billRpc('decide_client_ipc', { ipc_id: ipc.id, action: 'return', comment }); setRet(false); onDone(`IPC ${ipc.ipc_no} returned`); }} />}
    </>
  );
}

export function VariationPreview({ row, L, onDone, onActions }: Props) {
  const auth = useAuth();
  const q = useAsync(() => loadVariations(row.project_id), [row.project_id, row.entity_id], { key: 'variations' });
  const [ret, setRet] = useState(false);
  const { busy, error, run } = useBusy();
  const vo = q.data?.find((v) => v.id === row.entity_id);
  const can = vo?.status === 'pending' && canBill(auth.profile?.role, 'variationApprove');
  const approve = () => void run(async () => {
    if (!vo) return;
    await billRpc('decide_variation', { variation_id: vo.id, action: 'approve' });
    onDone(`${vo.number} approved — submit it to the client`);
  });
  useEffect(() => { onActions(can ? { approve, reject: () => setRet(true) } : {}); });
  if (!vo) return <div className="inbox-preview-body">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={5} />}</div>;
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to="/billing#variations">{vo.number} · {vo.title} <ExternalLink size={14} aria-hidden /></Link></h2>
          <div className="meta">{vo.instruction_ref ? `Instruction ${vo.instruction_ref} · ` : ''}by {L.person(vo.created_by)} · {money(vo.amount)} ex VAT</div>
        </div>
        <ErrorBanner error={error} />
        {vo.reason && <p className="mb-0">{vo.reason}</p>}
        <ul className="small-text">
          {vo.lines.map((l) => <li key={l.id}><b>{l.item_no}</b> {l.description} — {Number(l.qty)} {l.unit} × {money(l.rate)} = {money(l.amount)}{l.boq_item_id ? ' (change to existing item)' : ' (new item)'}</li>)}
        </ul>
      </div>
      <div className="action-bar">
        <span className="grow" />
        {can && <button disabled={busy} onClick={() => setRet(true)}>Return…<kbd style={{ marginLeft: 4 }}>R</kbd></button>}
        {can && <button className="primary" disabled={busy} onClick={approve}>{busy ? <span className="spinner" /> : <Check size={14} aria-hidden />}Approve — submit to client<kbd style={{ marginLeft: 4 }}>A</kbd></button>}
      </div>
      {ret && <ReasonModal title={`Return ${vo.number}`} label="What needs changing" onClose={() => setRet(false)}
        onSubmit={async (comment) => { await billRpc('decide_variation', { variation_id: vo.id, action: 'return', comment }); setRet(false); onDone(`${vo.number} returned`); }} />}
    </>
  );
}
