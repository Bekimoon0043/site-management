// /billing — client billing: interim payment certificates (IPC), variations and the contract's payment terms.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FilePlus2, Plus, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, money, num } from '../../lib/format';
import {
  IPC_STATUS_LABELS, VARIATION_STATUS_LABELS, type ClientContract, type IpcStatus, type Variation, type VariationLine, type VariationStatus,
} from '../../lib/contract-billing';
import {
  Badge, Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, Kpi, Loading, Page, ReasonModal, Tabs, toast, useBusy, useHashTab, type Tone,
} from '../../components/ui';
import { billRpc, canBill, loadBoqRated, loadContract, loadIpcs, loadVariations, totalsOf } from '../../components/billing/data';
import { todayStr } from '../../components/schedule/data';
import { Attachments } from '../../components/Attachments';

const TABS = ['ipcs', 'variations', 'terms'] as const;
export const IPC_TONE: Record<IpcStatus, Tone> = {
  draft: 'neutral', prepared: 'warning', checked: 'warning', submitted: 'info', certified: 'primary', paid: 'success', cancelled: 'neutral',
};
const VO_TONE: Record<VariationStatus, Tone> = { draft: 'neutral', pending: 'warning', submitted: 'info', approved: 'success', rejected: 'danger', cancelled: 'neutral' };

export function Billing() {
  const projectId = useProjectId();
  const auth = useAuth();
  const [tab, setTab] = useHashTab(TABS, 'ipcs');
  const cq = useAsync(() => loadContract(projectId), [projectId], { key: 'client-contract' });
  if (!auth.canSeePrices) {
    return <Page title="Client billing"><Empty title="No access">Client billing shows contract prices — only roles with price access can open it.</Empty></Page>;
  }
  return (
    <Page title="Client billing" subtitle="Payment certificates to the client from verified progress, variations and the contract's payment terms">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'ipcs', label: 'Payment certificates' }, { key: 'variations', label: 'Variations' }, { key: 'terms', label: 'Contract terms' }]} />
      <div className="mt-3">
        <ErrorBanner error={cq.error} onRetry={cq.reload} />
        {cq.data === undefined ? <Loading lines={5} />
          : tab === 'terms' ? <Terms projectId={projectId} c={cq.data} />
          : tab === 'variations' ? <Variations projectId={projectId} />
          : <Ipcs projectId={projectId} contract={cq.data} onTerms={() => setTab('terms')} />}
      </div>
    </Page>
  );
}

function Ipcs({ projectId, contract, onTerms }: { projectId: string; contract: ClientContract | null; onTerms: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const q = useAsync(() => loadIpcs(projectId), [projectId], { key: 'client-ipcs' });
  const [periodTo, setPeriodTo] = useState(todayStr());
  const { busy, error, run } = useBusy();
  const role = auth.profile?.role;
  if (!contract) {
    return <Empty title="Enter the contract terms first" action={canBill(role, 'terms') ? <button className="primary" onClick={onTerms}>Contract terms</button> : undefined}>
      Contract sum, advance, retention and taxes are needed to prepare a payment certificate.</Empty>;
  }
  const rows = q.data ?? [];
  const open = rows.find((r) => ['draft', 'prepared', 'checked'].includes(r.status));
  const last = rows.find((r) => r.status !== 'cancelled');
  const certifiedCum = rows.filter((r) => r.certified).reduce((m, r) => Math.max(m, Number(r.certified?.work_cum ?? 0)), 0);
  const paid = rows.reduce((s, r) => s + Number(r.paid_amount), 0);
  const owed = rows.filter((r) => r.status === 'certified').reduce((s, r) => s + Number(r.certified?.payable ?? 0) - Number(r.paid_amount), 0);
  const create = () => void run(async () => {
    const id = crypto.randomUUID();
    await billRpc('save_client_ipc', { id, project_id: projectId, period_to: periodTo });
    nav(`/billing/ipc/${id}`);
  });
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Contract sum (ex VAT)" value={money(contract.contract_sum)} />
        <Kpi label="Certified work to date" value={money(certifiedCum)} hint={contract.contract_sum ? `${num((certifiedCum / contract.contract_sum) * 100, 1)} % of the contract` : undefined} />
        <Kpi label="Received from the client" value={money(paid)} />
        <Kpi label="Certified, not yet paid" value={money(owed)} />
      </div>
      <ErrorBanner error={error ?? q.error} />
      {canBill(role, 'prepare') && !open && (
        <Card title={`Prepare IPC ${(last?.ipc_no ?? 0) + 1}`} sub="Quantities to date come from verified site progress; you can re-measure any line before sending it for checking.">
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Measured up to"><input type="date" value={periodTo} max={todayStr()} onChange={(e) => setPeriodTo(e.target.value)} /></Field>
            <button className="primary" disabled={busy || !periodTo} onClick={create}>{busy ? <span className="spinner" /> : <FilePlus2 size={16} aria-hidden />}Prepare certificate</button>
          </div>
        </Card>
      )}
      {open && <Banner tone="info" action={<Link to={`/billing/ipc/${open.id}`}>Open IPC {open.ipc_no} →</Link>}>IPC {open.ipc_no} is {IPC_STATUS_LABELS[open.status].toLowerCase()}.</Banner>}
      <Card flush>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => nav(`/billing/ipc/${r.id}`)} exportName="payment-certificates"
          empty={{ title: 'No payment certificates yet', body: 'Prepare IPC 1 once progress has been verified.' }}
          columns={[
            { key: 'ipc_no', label: 'IPC', id: true, value: (r) => r.ipc_no, render: (r) => `IPC ${r.ipc_no}${r.is_final ? ' (final)' : ''}` },
            { key: 'period', label: 'Period', value: (r) => r.period_to, render: (r) => `${r.period_from ? date(r.period_from) : '—'} → ${date(r.period_to)}` },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={IPC_TONE[r.status]} label={IPC_STATUS_LABELS[r.status]} icon={null} /> },
            { key: 'work', label: 'Work to date', align: 'right', value: (r) => Number(totalsOf(r).work_cum ?? 0), render: (r) => money(totalsOf(r).work_cum) },
            { key: 'net', label: 'This certificate (ex VAT)', align: 'right', value: (r) => Number(totalsOf(r).this_net ?? 0), render: (r) => money(totalsOf(r).this_net) },
            { key: 'payable', label: 'Payable', align: 'right', value: (r) => Number(totalsOf(r).payable ?? 0), render: (r) => <b>{money(totalsOf(r).payable)}</b> },
            { key: 'paid', label: 'Received', align: 'right', value: (r) => Number(r.paid_amount), render: (r) => (Number(r.paid_amount) ? money(r.paid_amount) : '—') },
          ]} />
      </Card>
    </div>
  );
}

function Terms({ projectId, c }: { projectId: string; c: ClientContract | null }) {
  const auth = useAuth();
  const edit = canBill(auth.profile?.role, 'terms');
  const [f, setF] = useState({
    contract_no: c?.contract_no ?? '', client_name: c?.client_name ?? auth.project?.client ?? '', consultant_name: c?.consultant_name ?? '',
    contract_sum: String(c?.contract_sum ?? ''), vat_pct: String(c?.vat_pct ?? 15), advance_amount: String(c?.advance_amount ?? 0),
    advance_recovery_pct: c ? String(c.advance_recovery_pct) : '', retention_pct: String(c?.retention_pct ?? 5),
    retention_limit_pct: String(c?.retention_limit_pct ?? 5), mos_pct: String(c?.mos_pct ?? 0), wht_pct: String(c?.wht_pct ?? 3),
    supplementary_sum: String(c?.supplementary_sum ?? 0), rebate_pct: String(c?.rebate_pct ?? 0), signed_on: c?.signed_on ?? '',
  });
  const boq = useAsync(() => loadBoqRated(projectId), [projectId], { key: 'boq-rated', staleTime: 60_000 });
  const boqTotal = (boq.data ?? []).reduce((s, b) => s + Number(b.quantity) * Number(b.rate ?? 0), 0);
  const { busy, error, run } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => void run(async () => {
    const n = (v: string) => (v === '' ? undefined : Number(v));
    await billRpc('save_client_contract', { project_id: projectId, contract_no: f.contract_no, client_name: f.client_name, consultant_name: f.consultant_name,
      contract_sum: Number(f.contract_sum || 0), vat_pct: n(f.vat_pct), advance_amount: n(f.advance_amount), advance_recovery_pct: n(f.advance_recovery_pct),
      retention_pct: n(f.retention_pct), retention_limit_pct: n(f.retention_limit_pct), mos_pct: n(f.mos_pct), wht_pct: n(f.wht_pct),
      supplementary_sum: n(f.supplementary_sum), rebate_pct: n(f.rebate_pct), signed_on: f.signed_on || undefined });
    toast.success('Contract terms saved');
  });
  return (
    <Card title="Contract payment terms" sub="Used on every payment certificate. Defaults follow common Ethiopian practice — check them against the Special Conditions of Contract.">
      <ErrorBanner error={error} />
      <fieldset disabled={!edit} className="form-grid" style={{ border: 0, padding: 0, margin: 0 }}>
        <Field label="Contract no."><input value={f.contract_no} onChange={set('contract_no')} /></Field>
        <Field label="Client (employer)"><input value={f.client_name} onChange={set('client_name')} /></Field>
        <Field label="Consultant (engineer)"><input value={f.consultant_name} onChange={set('consultant_name')} /></Field>
        <Field label="Contract sum, ex VAT (ETB)" required hint={boqTotal ? `BoQ total: ${money(boqTotal)}` : undefined}>
          <span className="row" style={{ gap: 6 }}><input type="number" min={0} step="0.01" value={f.contract_sum} onChange={set('contract_sum')} />
            {boqTotal > 0 && edit && <button type="button" className="small" onClick={() => setF({ ...f, contract_sum: boqTotal.toFixed(2) })}>Use BoQ total</button>}</span>
        </Field>
        <Field label="Date of contract signing"><input type="date" value={f.signed_on} onChange={set('signed_on')} /></Field>
        <Field label="Supplementary contract, ex VAT (ETB)"><input type="number" min={0} step="0.01" value={f.supplementary_sum} onChange={set('supplementary_sum')} /></Field>
        <Field label="Rebate %" hint="Discount on the contract; deducted as rebate % × (1 − 2) on each certificate"><input type="number" min={0} max={100} step="0.01" value={f.rebate_pct} onChange={set('rebate_pct')} /></Field>
        <Field label="VAT %"><input type="number" min={0} max={100} step="0.01" value={f.vat_pct} onChange={set('vat_pct')} /></Field>
        <Field label="Advance paid (ETB)"><input type="number" min={0} step="0.01" value={f.advance_amount} onChange={set('advance_amount')} /></Field>
        <Field label="Advance recovered per certificate (% of work)" hint="Empty = same share as the advance (advance ÷ contract sum)"><input type="number" min={0} max={100} step="0.01" value={f.advance_recovery_pct} onChange={set('advance_recovery_pct')} /></Field>
        <Field label="Retention %"><input type="number" min={0} max={100} step="0.01" value={f.retention_pct} onChange={set('retention_pct')} /></Field>
        <Field label="Retention limit (% of contract sum)"><input type="number" min={0} max={100} step="0.01" value={f.retention_limit_pct} onChange={set('retention_limit_pct')} /></Field>
        <Field label="Materials on site paid at (%)" hint="0 = materials on site are not paid"><input type="number" min={0} max={100} step="0.01" value={f.mos_pct} onChange={set('mos_pct')} /></Field>
        <Field label="Withholding tax by the client %" hint="3 % (Proclamation 1395/2025); 30 % if no TIN"><input type="number" min={0} max={100} step="0.01" value={f.wht_pct} onChange={set('wht_pct')} /></Field>
      </fieldset>
      {edit && <div className="row mt-2"><button className="primary" disabled={busy || !f.contract_sum} onClick={save}>{busy && <span className="spinner" />}Save terms</button></div>}
      {!edit && <p className="muted small-text mb-0">Coordinators and managers set the contract terms.</p>}
    </Card>
  );
}

type VoRow = Variation & { lines: VariationLine[] };

function Variations({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const q = useAsync(() => loadVariations(projectId), [projectId], { key: 'variations' });
  const [open, setOpen] = useState<VoRow | 'new' | null>(null);
  const rows = q.data ?? [];
  const approved = rows.filter((v) => v.status === 'approved').reduce((s, v) => s + Number(v.amount), 0);
  const pending = rows.filter((v) => ['pending', 'submitted'].includes(v.status)).reduce((s, v) => s + Number(v.amount), 0);
  return (
    <div className="stack">
      <div className="kpis">
        <Kpi label="Approved variations" value={money(approved)} />
        <Kpi label="Pending with management / client" value={money(pending)} />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush title="Variations / change orders" actions={canBill(role, 'prepare') ? <button className="primary small" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />New variation</button> : undefined}>
        <DataTable rows={rows} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="variations"
          empty={{ title: 'No variations', body: 'Record site instructions that add, change or omit work.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'title', label: 'Title' },
            { key: 'instruction_ref', label: 'Instruction', value: (r) => r.instruction_ref ?? '', render: (r) => (r.instruction_ref ? `${r.instruction_ref}${r.instruction_date ? ` · ${date(r.instruction_date)}` : ''}` : '—') },
            { key: 'lines', label: 'Lines', align: 'right', value: (r) => r.lines.length },
            { key: 'amount', label: 'Amount (ex VAT)', align: 'right', value: (r) => Number(r.amount), render: (r) => money(r.amount) },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <Badge tone={VO_TONE[r.status]} label={VARIATION_STATUS_LABELS[r.status]} icon={null} /> },
            { key: 'by', label: 'By', value: (r) => lk.data?.person(r.created_by) ?? '' },
          ]} />
      </Card>
      {open && <VariationDrawer key={open === 'new' ? 'new' : open.id} projectId={projectId} vo={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface LineDraft { boq_item_id: string; item_no: string; description: string; unit: string; qty: string; rate: string }

function VariationDrawer({ projectId, vo, onClose }: { projectId: string; vo: VoRow | null; onClose: () => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const editable = !vo || (vo.status === 'draft' && canBill(role, 'prepare'));
  const boq = useAsync(() => loadBoqRated(projectId), [projectId], { key: 'boq-rated', staleTime: 60_000 });
  const [title, setTitle] = useState(vo?.title ?? '');
  const [ref, setRef] = useState(vo?.instruction_ref ?? '');
  const [refDate, setRefDate] = useState(vo?.instruction_date ?? '');
  const [reason, setReason] = useState(vo?.reason ?? '');
  const [timeImpact, setTimeImpact] = useState(vo?.completion_date_impact_days == null ? '' : String(vo.completion_date_impact_days));
  const [revisedFinish, setRevisedFinish] = useState(vo?.revised_completion_date ?? '');
  const [lines, setLines] = useState<LineDraft[]>(vo?.lines.map((l) => ({ boq_item_id: l.boq_item_id ?? '', item_no: l.item_no, description: l.description, unit: l.unit, qty: String(l.qty), rate: String(l.rate) }))
    ?? [{ boq_item_id: '', item_no: '', description: '', unit: '', qty: '', rate: '' }]);
  const [dlg, setDlg] = useState<'return' | 'reject' | null>(null);
  const [clientRef, setClientRef] = useState('');
  const { busy, error, run } = useBusy();
  const items = boq.data ?? [];
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.rate || 0), 0);
  const save = (submit: boolean) => void run(async () => {
    const r = await billRpc('save_variation', { id: vo?.id ?? crypto.randomUUID(), project_id: projectId, title, instruction_ref: ref || undefined,
      instruction_date: refDate || undefined, reason: reason || undefined, submit,
      lines: lines.map((l) => (l.boq_item_id ? { boq_item_id: l.boq_item_id, qty: Number(l.qty), rate: l.rate ? Number(l.rate) : undefined }
        : { item_no: l.item_no, description: l.description, unit: l.unit, qty: Number(l.qty), rate: Number(l.rate) })) });
    const { error: impactError } = await supabase.rpc('set_variation_client_impact', { p: {
      variation_id: String(r.id), completion_date_impact_days: timeImpact || null, revised_completion_date: revisedFinish || null,
    } });
    if (impactError) throw new Error(impactError.message);
    toast.success(`${String(r.number)} ${submit ? 'sent for approval' : 'saved'}`);
    onClose();
  });
  const decide = (action: 'approve' | 'return' | 'client_approve' | 'client_reject' | 'cancel', comment?: string) => void run(async () => {
    await billRpc('decide_variation', { variation_id: vo?.id ?? '', action, comment, client_ref: clientRef || undefined });
    toast.success({ approve: 'Approved — submit it to the client', return: 'Returned', client_approve: 'Client approval recorded — the BoQ is updated', client_reject: 'Client rejection recorded', cancel: 'Cancelled' }[action]);
    onClose();
  });
  return (
    <Drawer size="lg" onClose={onClose} title={vo ? `${vo.number} · ${vo.title}` : 'New variation'}
      subtitle={vo ? <Badge tone={VO_TONE[vo.status]} label={VARIATION_STATUS_LABELS[vo.status]} icon={null} /> : 'Site instruction that adds, changes or omits work'}>
      <ErrorBanner error={error} />
      {vo?.decision_comment && <Banner tone="info">Comment: “{vo.decision_comment}”</Banner>}
      <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <div className="form-grid">
          <Field label="Title" required wide><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Extra retaining wall at lift pit" /></Field>
          <Field label="Instruction ref."><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="SI-007" /></Field>
          <Field label="Instruction date"><input type="date" value={refDate} onChange={(e) => setRefDate(e.target.value)} /></Field>
          <Field label="Reason" wide><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Design change, client request, site condition…" /></Field>
          <Field label="Completion impact (days)"><input type="number" step="1" value={timeImpact} onChange={(e) => setTimeImpact(e.target.value)} placeholder="0" /></Field>
          <Field label="Revised completion date"><input type="date" value={revisedFinish} onChange={(e) => setRevisedFinish(e.target.value)} /></Field>
        </div>
        <h3 className="mb-0">Lines</h3>
        {lines.map((l, i) => (
          <div key={i} className="vo-line">
            <Field label="BoQ item (empty = new item)">
              <select value={l.boq_item_id} onChange={(e) => {
                const b = items.find((x) => x.id === e.target.value);
                setLine(i, b ? { boq_item_id: b.id, item_no: b.item_no, description: b.description, unit: b.unit, rate: b.rate == null ? '' : String(b.rate) } : { boq_item_id: '' });
              }}>
                <option value="">New item</option>
                {items.map((b) => <option key={b.id} value={b.id}>{b.item_no} · {b.description.slice(0, 60)}</option>)}
              </select>
            </Field>
            {!l.boq_item_id && <>
              <Field label="Item no."><input value={l.item_no} onChange={(e) => setLine(i, { item_no: e.target.value })} placeholder="V1.1" style={{ width: 90 }} /></Field>
              <Field label="Description"><input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
              <Field label="Unit"><input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} style={{ width: 70 }} /></Field>
            </>}
            <Field label={l.boq_item_id ? `Qty change (${l.unit})` : 'Qty'}><input type="number" step="any" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ width: 110 }} /></Field>
            <Field label="Rate (ETB)"><input type="number" min={0} step="0.01" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} style={{ width: 120 }} /></Field>
            <span className="small-text strong vo-amt">{money(Number(l.qty || 0) * Number(l.rate || 0))}</span>
            {editable && lines.length > 1 && <button type="button" className="icon-btn" aria-label="Remove line" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={14} /></button>}
          </div>
        ))}
        {editable && <button type="button" className="small" onClick={() => setLines([...lines, { boq_item_id: '', item_no: '', description: '', unit: '', qty: '', rate: '' }])}><Plus size={14} aria-hidden />Add line</button>}
      </fieldset>
      <p className="strong">Total {money(vo && !editable ? vo.amount : total)} <span className="muted small-text">ex VAT · negative quantities are omissions</span></p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {editable && <>
          <button disabled={busy || !title.trim()} onClick={() => save(false)}>Save draft</button>
          <button className="primary" disabled={busy || !title.trim()} onClick={() => save(true)}>{busy && <span className="spinner" />}Send for approval</button>
          {vo && <button disabled={busy} onClick={() => decide('cancel')}>Cancel variation</button>}
        </>}
        {vo?.status === 'pending' && canBill(role, 'variationApprove') && <>
          <button className="primary" disabled={busy} onClick={() => decide('approve')}>Approve — submit to client</button>
          <button disabled={busy} onClick={() => setDlg('return')}>Return…</button>
        </>}
        {vo?.status === 'submitted' && canBill(role, 'variationClient') && <>
          <Field label="Client approval ref."><input value={clientRef} onChange={(e) => setClientRef(e.target.value)} /></Field>
          <button className="primary" disabled={busy} onClick={() => decide('client_approve')}>Client approved</button>
          <button disabled={busy} onClick={() => setDlg('reject')}>Client rejected…</button>
        </>}
      </div>
      {vo && (
        <div className="mt-3">
          <h3>Site instruction & documents</h3>
          <Attachments entityType="variation" entityId={vo.id} canAdd={canBill(role, 'prepare') || canBill(role, 'variationClient')}
            kinds={['site_instruction', 'drawing', 'photo', 'document']} emptyText="No instruction or drawing attached yet." />
        </div>
      )}
      {vo?.status === 'approved' && <Banner tone="ok">Approved{vo.client_ref ? ` (${vo.client_ref})` : ''} — the BoQ and the contract sum include it; its work is billed in the next certificates.</Banner>}
      {dlg && <ReasonModal title={dlg === 'return' ? 'Return variation' : 'Client rejected the variation'} label="Comment" onClose={() => setDlg(null)}
        onSubmit={async (c) => { const a = dlg === 'return' ? 'return' : 'client_reject'; setDlg(null); decide(a, c); }} />}
    </Drawer>
  );
}
