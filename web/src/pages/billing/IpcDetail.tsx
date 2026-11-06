// /billing/ipc/:id — one interim payment certificate: quantities to date per BoQ item (re-measurable while draft),
// summary in the usual Ethiopian IPC layout, workflow actions per role, consultant certification and payment.
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Printer, RefreshCw } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, dateTime, money, num } from '../../lib/format';
import { IPC_STATUS_LABELS, type ClientIpcLine, type IpcTotals } from '../../lib/contract-billing';
import {
  Badge, Banner, Card, DataTable, ErrorBanner, Field, Loading, Modal, Page, ReasonModal, SearchInput, toast, useBusy,
} from '../../components/ui';
import { billRpc, byItemNo, canBill, loadApprovedVos, loadContract, loadIpc, loadIpcs } from '../../components/billing/data';
import { IpcCertificate } from '../../components/billing/IpcCertificate';
import { Attachments } from '../../components/Attachments';
import { IPC_TONE } from './Billing';
import '../../components/billing/billing.css';

const r2 = (v: number) => Math.round(v * 100) / 100;

export function IpcDetail() {
  const { id = '' } = useParams();
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const q = useAsync(() => loadIpc(id), [id], { key: 'client-ipc' });
  const cq = useAsync(() => loadContract(projectId), [projectId], { key: 'client-contract' });
  const allq = useAsync(() => loadIpcs(projectId), [projectId], { key: 'client-ipcs' });
  const voq = useAsync(() => loadApprovedVos(projectId), [projectId], { key: 'approved-vos' });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [head, setHead] = useState<{ mos: string; pa: string; pen: string; mat: string; remarks: string } | null>(null);
  const [term, setTerm] = useState('');
  const [dlg, setDlg] = useState<'return' | 'certify' | 'pay' | null>(null);
  const { busy, error, run } = useBusy();

  const lines = useMemo(() => [...(q.data?.lines ?? [])].sort(byItemNo), [q.data]);
  if (!auth.canSeePrices) return <Page title="Payment certificate"><Banner tone="warn">Payment certificates show prices — your role has no price access.</Banner></Page>;
  if (!q.data || cq.data === undefined) {
    return <Page title="Payment certificate" breadcrumbs={[{ label: 'Client billing', to: '/billing' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const { ipc } = q.data;
  const c = cq.data;
  const draft = ipc.status === 'draft' && canBill(role, 'prepare');
  const basis = (ipc.certified ?? ipc.claimed) as IpcTotals;
  const h = head ?? { mos: String(ipc.mos_value), pa: String(ipc.price_adjustment), pen: String(ipc.penalty ?? 0), mat: String(ipc.material_delivered ?? 0), remarks: ipc.remarks ?? '' };
  const previous = (allq.data ?? []).filter((x) => x.ipc_no < ipc.ipc_no && x.status !== 'cancelled').sort((a, b) => a.ipc_no - b.ipc_no);
  const person = (id: string | null) => (id ? lk.data?.person(id) ?? undefined : undefined);
  const dirty = Object.keys(edits).length > 0 || head !== null;
  const cumOf = (l: ClientIpcLine) => (edits[l.boq_item_id] !== undefined ? Number(edits[l.boq_item_id] || 0) : Number(ipc.certified ? l.certified_cum_qty ?? l.cum_qty : l.cum_qty));
  const tl = term.trim().toLowerCase();
  const shown = lines.filter((l) => !tl || l.item_no.toLowerCase().startsWith(tl) || l.description.toLowerCase().includes(tl));

  const save = (extra: { prepare?: boolean; refresh?: boolean } = {}) => void run(async () => {
    await billRpc('save_client_ipc', { id: ipc.id, project_id: ipc.project_id, mos_value: Number(h.mos || 0), price_adjustment: Number(h.pa || 0),
      penalty: Number(h.pen || 0), material_delivered: Number(h.mat || 0), remarks: h.remarks || undefined, lines: Object.entries(edits).map(([boq_item_id, v]) => ({ boq_item_id, cum_qty: Number(v || 0) })), ...extra });
    setEdits({}); setHead(null);
    toast.success(extra.prepare ? `IPC ${ipc.ipc_no} sent to the coordinator to check` : extra.refresh ? 'Quantities refreshed from verified progress' : 'Saved');
    q.reload();
  });
  const act = (action: 'check' | 'submit' | 'cancel') => void run(async () => {
    await billRpc('decide_client_ipc', { ipc_id: ipc.id, action });
    toast.success({ check: 'Checked — sent to the manager', submit: 'Submitted to the consultant', cancel: 'Cancelled' }[action]);
    q.reload();
  });

  const actions = (
    <>
      <button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>
      {draft && <button disabled={busy} onClick={() => save({ refresh: true })}><RefreshCw size={14} aria-hidden />Refresh from progress</button>}
      {draft && <button disabled={busy || !dirty} onClick={() => save()}>Save</button>}
      {draft && <button className="primary" disabled={busy} onClick={() => save({ prepare: true })}>{busy && <span className="spinner" />}Send for checking</button>}
      {ipc.status === 'prepared' && canBill(role, 'check') && ipc.prepared_by !== auth.profile?.id && <button className="primary" disabled={busy} onClick={() => act('check')}>Checked</button>}
      {ipc.status === 'checked' && canBill(role, 'submit') && <button className="primary" disabled={busy} onClick={() => act('submit')}>Approve &amp; submit to consultant</button>}
      {['prepared', 'checked', 'submitted'].includes(ipc.status) && canBill(role, 'certify') && <button disabled={busy} onClick={() => setDlg('return')}>Return…</button>}
      {ipc.status === 'submitted' && canBill(role, 'certify') && <button className="primary" disabled={busy} onClick={() => setDlg('certify')}>Record certification…</button>}
      {ipc.status === 'certified' && canBill(role, 'pay') && <button className="primary" disabled={busy} onClick={() => setDlg('pay')}>Record payment…</button>}
      {['draft', 'prepared'].includes(ipc.status) && canBill(role, 'certify') && <button disabled={busy} onClick={() => act('cancel')}>Cancel IPC</button>}
    </>
  );

  return (
    <Page title={`Interim Payment Certificate No. ${ipc.ipc_no}${ipc.is_final ? ' (final)' : ''}`}
      titleExtra={<Badge tone={IPC_TONE[ipc.status]} label={IPC_STATUS_LABELS[ipc.status]} icon={null} />}
      breadcrumbs={[{ label: 'Client billing', to: '/billing' }, { label: `IPC ${ipc.ipc_no}` }]}
      subtitle={`${ipc.period_from ? date(ipc.period_from) : 'Start'} → ${date(ipc.period_to)} · ${auth.project?.name ?? ''}`} actions={actions}>
      <div className="print-doc">
        <div className="no-print stack">
          <ErrorBanner error={error} />
          {ipc.return_comment && ipc.status === 'draft' && <Banner tone="warn">Returned: “{ipc.return_comment}”</Banner>}
          {ipc.certified && <Banner tone="info">Certified by the consultant{ipc.consultant_ref ? ` (${ipc.consultant_ref})` : ''} on {date(ipc.certified_on)} — the figures below are the certified ones.</Banner>}
          {dirty && <Banner tone="warn">Unsaved changes — save to recalculate the certificate.</Banner>}
        </div>

        <IpcCertificate ipc={ipc} t={basis} contract={c} previous={previous} projectName={auth.project?.name ?? ''} clientFallback={auth.project?.client}
          companyName={auth.companyName} companyLogo={auth.companyLogo} voTotal={voq.data?.total ?? 0} voCount={voq.data?.count ?? 0}
          names={{ requested: person(ipc.prepared_by), checked: person(ipc.checked_by), approved: person(ipc.submitted_by) }} />

        <Card title="Other items" className="no-print mt-4">
          <fieldset disabled={!draft} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
            <Field label="Materials on site — value at valuation date (ETB)" hint={c?.mos_pct ? `Paid at ${num(c.mos_pct, 0)} %` : 'Not paid under this contract (0 %)'}>
              <input type="number" min={0} step="0.01" value={h.mos} onChange={(e) => setHead({ ...h, mos: e.target.value })} />
            </Field>
            <Field label="Price adjustment to date (ETB)" hint="Cumulative, per the contract's price-adjustment clause">
              <input type="number" step="0.01" value={h.pa} onChange={(e) => setHead({ ...h, pa: e.target.value })} />
            </Field>
            <Field label="5. Penalty (ETB)" hint="Delay damages deducted on this certificate">
              <input type="number" min={0} step="0.01" value={h.pen} onChange={(e) => setHead({ ...h, pen: e.target.value })} />
            </Field>
            <Field label="6. Material delivered (ETB)" hint="Materials the client supplied, deducted on this certificate">
              <input type="number" min={0} step="0.01" value={h.mat} onChange={(e) => setHead({ ...h, mat: e.target.value })} />
            </Field>
            <Field label="Remarks" wide><textarea rows={2} value={h.remarks} onChange={(e) => setHead({ ...h, remarks: e.target.value })} /></Field>
          </fieldset>
          <dl className="kv small-text mt-2">
            <dt>Prepared</dt><dd>{ipc.prepared_by ? `${person(ipc.prepared_by) ?? ''} · ${dateTime(ipc.prepared_at)}` : '—'}</dd>
            <dt>Checked</dt><dd>{ipc.checked_by ? `${person(ipc.checked_by) ?? ''} · ${dateTime(ipc.checked_at)}` : '—'}</dd>
            <dt>Submitted</dt><dd>{ipc.submitted_by ? `${person(ipc.submitted_by) ?? ''} · ${dateTime(ipc.submitted_at)}` : '—'}</dd>
            <dt>Received</dt><dd>{Number(ipc.paid_amount) ? `${money(ipc.paid_amount)}${ipc.paid_on ? ` · ${date(ipc.paid_on)}` : ''}${ipc.payment_ref ? ` · ${ipc.payment_ref}` : ''}` : '—'}</dd>
          </dl>
        </Card>

        <Card title="Signed copies & documents" className="no-print mt-4" sub="Scan of the certificate signed by the consultant, the client's payment advice, measurement sheets.">
          <Attachments entityType="client_ipc" entityId={ipc.id} canAdd={canBill(role, 'prepare') || canBill(role, 'certify') || canBill(role, 'pay')}
            kinds={['signed_certificate', 'measurement', 'invoice', 'document', 'photo']} emptyText="No scans yet." />
        </Card>

        <Card className="ipc-statement mt-4" title={`Attached statement — measured work, IPC No. ${ipc.ipc_no} (${auth.project?.name ?? ''})`} sub={draft ? 'Quantities to date come from verified site progress — type a re-measured quantity where the measurement differs.' : undefined} flush
          actions={<SearchInput value={term} onChange={setTerm} placeholder="Item or description" />}>
          <DataTable rows={shown} rowKey={(l) => l.boq_item_id} maxHeight="60vh" stickyFirst exportName={`ipc-${ipc.ipc_no}`}
            columns={[
              { key: 'item_no', label: 'Item', id: true },
              { key: 'description', label: 'Description', render: (l) => <span>{l.description}{l.remeasured && <> <Badge tone="info" label="re-measured" icon={null} /></>}</span> },
              { key: 'unit', label: 'Unit' },
              { key: 'contract_qty', label: 'Contract qty', align: 'right', value: (l) => Number(l.contract_qty), render: (l) => num(l.contract_qty, 2) },
              { key: 'rate', label: 'Rate', align: 'right', value: (l) => Number(l.rate), render: (l) => num(l.rate, 2) },
              { key: 'prev_qty', label: 'Previous qty', align: 'right', value: (l) => Number(l.prev_qty), render: (l) => num(l.prev_qty, 2) },
              { key: 'this_qty', label: 'This qty', align: 'right', value: (l) => cumOf(l) - Number(l.prev_qty), render: (l) => num(cumOf(l) - Number(l.prev_qty), 2) },
              { key: 'cum_qty', label: 'Qty to date', align: 'right', value: (l) => cumOf(l), render: (l) => (draft
                ? <input className="ipc-qty" type="number" min={0} step="any" aria-label={`Quantity to date ${l.item_no}`} value={edits[l.boq_item_id] ?? String(Number(l.cum_qty))}
                    title={`Verified on site: ${num(l.verified_qty, 2)}`} onChange={(e) => setEdits({ ...edits, [l.boq_item_id]: e.target.value })} />
                : <span>{num(cumOf(l), 2)}{ipc.certified && l.certified_cum_qty != null && Number(l.certified_cum_qty) !== Number(l.cum_qty) ? <span className="muted small-text"> (claimed {num(l.cum_qty, 2)})</span> : null}</span>) },
              { key: 'prev_amt', label: 'Previous amount', align: 'right', value: (l) => r2(Number(l.prev_qty) * Number(l.rate)), render: (l) => num(Number(l.prev_qty) * Number(l.rate), 2) },
              { key: 'this_amt', label: 'This amount', align: 'right', value: (l) => r2((cumOf(l) - Number(l.prev_qty)) * Number(l.rate)), render: (l) => num((cumOf(l) - Number(l.prev_qty)) * Number(l.rate), 2) },
              { key: 'cum_amt', label: 'Amount to date', align: 'right', value: (l) => r2(cumOf(l) * Number(l.rate)), render: (l) => <b>{num(cumOf(l) * Number(l.rate), 2)}</b> },
            ]}
            empty={{ title: 'No measured work', body: 'Verify site progress first, or add a re-measured item.' }} />
        </Card>
      </div>

      {dlg === 'return' && <ReasonModal title={`Return IPC ${ipc.ipc_no}`} label="What needs correcting" onClose={() => setDlg(null)}
        onSubmit={async (comment) => { await billRpc('decide_client_ipc', { ipc_id: ipc.id, action: 'return', comment }); setDlg(null); toast.success('Returned to draft'); q.reload(); }} />}
      {dlg === 'certify' && <CertifyModal lines={lines} mos={Number(ipc.mos_value)} pa={Number(ipc.price_adjustment)} onClose={() => setDlg(null)}
        onSubmit={async (p) => { await billRpc('decide_client_ipc', { ipc_id: ipc.id, action: 'certify', ...p }); setDlg(null); toast.success('Certification recorded'); q.reload(); }} />}
      {dlg === 'pay' && <PayModal due={Number(ipc.certified?.payable ?? 0) - Number(ipc.paid_amount)} onClose={() => setDlg(null)}
        onSubmit={async (p) => { await billRpc('decide_client_ipc', { ipc_id: ipc.id, action: 'pay', ...p }); setDlg(null); toast.success('Payment recorded'); q.reload(); }} />}
    </Page>
  );
}

function CertifyModal({ lines, mos, pa, onClose, onSubmit }: {
  lines: ClientIpcLine[]; mos: number; pa: number; onClose: () => void;
  onSubmit: (p: { consultant_ref?: string; certified_on?: string; certified_mos_value: number; certified_price_adjustment: number; certified_lines: { boq_item_id: string; cum_qty: number }[] }) => Promise<void>;
}) {
  const [ref, setRef] = useState('');
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [m, setM] = useState(String(mos));
  const [p, setP] = useState(String(pa));
  const [cut, setCut] = useState<Record<string, string>>({});
  const { busy, error, run } = useBusy();
  return (
    <Modal title="Record the consultant's certification" size="lg" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={() => void run(() => onSubmit({
        consultant_ref: ref || undefined, certified_on: on, certified_mos_value: Number(m || 0), certified_price_adjustment: Number(p || 0),
        certified_lines: Object.entries(cut).filter(([, v]) => v !== '').map(([boq_item_id, v]) => ({ boq_item_id, cum_qty: Number(v) })) }))}>{busy && <span className="spinner" />}Save certification</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Consultant's reference"><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. MH/TWR/IPC-01" /></Field>
        <Field label="Certified on"><input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Materials on site certified (value)"><input type="number" min={0} step="0.01" value={m} onChange={(e) => setM(e.target.value)} /></Field>
        <Field label="Price adjustment certified"><input type="number" step="0.01" value={p} onChange={(e) => setP(e.target.value)} /></Field>
      </div>
      <p className="small-text muted">Only change the lines the consultant certified differently (quantity to date). Empty = as claimed.</p>
      <div className="ipc-cert-lines">
        {lines.filter((l) => Number(l.cum_qty) > 0).map((l) => (
          <label key={l.boq_item_id} className="ipc-cert-line">
            <span className="grow"><b>{l.item_no}</b> {l.description.slice(0, 70)} <span className="muted">· claimed {num(l.cum_qty, 2)} {l.unit}</span></span>
            <input type="number" min={0} step="any" placeholder={String(Number(l.cum_qty))} value={cut[l.boq_item_id] ?? ''} onChange={(e) => setCut({ ...cut, [l.boq_item_id]: e.target.value })} />
          </label>
        ))}
      </div>
    </Modal>
  );
}

function PayModal({ due, onClose, onSubmit }: { due: number; onClose: () => void; onSubmit: (p: { amount: number; paid_on: string; payment_ref?: string }) => Promise<void> }) {
  const [amount, setAmount] = useState(String(Math.max(r2(due), 0)));
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [ref, setRef] = useState('');
  const { busy, error, run } = useBusy();
  return (
    <Modal title="Record payment received from the client" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !Number(amount)} onClick={() => void run(() => onSubmit({ amount: Number(amount), paid_on: on, payment_ref: ref || undefined }))}>{busy && <span className="spinner" />}Save payment</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Amount received (ETB)" hint={`Outstanding ${money(due)}`}><input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Received on"><input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
        <Field label="Bank / transfer ref."><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
