// /payments/subcontracts — subcontractor payments: interim payment certificates, subcontracts (scope = BoQ items /
// schedule tasks at agreed rates, retention, advance) and the subcontractor register.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import { canPay, WHT_PCT_DEFAULT, type ScCertificate, type Subcontractor, type SubcontractRow } from '../../lib/contract-payments';
import { Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, Loading, Modal, Page, Tabs, toast, useBusy, useHashTab } from '../../components/ui';
import { loadBoqItems, loadSchedules, loadTasks } from '../../components/schedule/data';
import { PaymentStatusBadge } from '../../components/payments/PaymentActions';
import '../../components/payments/payments.css';
import { etb, loadCertificates, loadSubcontractItems, loadSubcontractors, loadSubcontracts, payRpc } from '../../components/payments/data';

const TABS = ['certificates', 'subcontracts', 'subcontractors'] as const;

export function Subcontracts() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const [tab, setTab] = useHashTab(TABS, 'certificates');
  if (!canPay(role, 'payment.view')) return <Page title="Subcontractor payments"><Empty title="No access">Payment documents are for the office engineer, coordinator, manager and finance.</Empty></Page>;
  return (
    <Page title="Subcontractor payments" subtitle="Measured work → verified quantities → payment certificate → coordinator check → manager approval → finance payment">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'certificates', label: 'Payment certificates' }, { key: 'subcontracts', label: 'Subcontracts' }, { key: 'subcontractors', label: 'Subcontractors' }]} />
      <div className="mt-3">
        {tab === 'certificates' && <CertificateList projectId={projectId} />}
        {tab === 'subcontracts' && <SubcontractList projectId={projectId} />}
        {tab === 'subcontractors' && <SubcontractorList />}
      </div>
    </Page>
  );
}

function CertificateList({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const auth = useAuth();
  const q = useAsync(() => loadCertificates(projectId), [projectId], { key: 'sc-certs' });
  const sq = useAsync(() => loadSubcontracts(projectId), [projectId], { key: 'subcontracts' });
  const [pick, setPick] = useState('');
  const scById = useMemo(() => new Map((sq.data ?? []).map((s) => [s.id, s])), [sq.data]);
  const active = (sq.data ?? []).filter((s) => s.status === 'active');
  return (
    <div className="stack">
      {canPay(auth.profile?.role, 'payment.prepare') && (
        <Card>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="New payment certificate for">
              <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ minWidth: 280 }}>
                <option value="">Choose a subcontract…</option>
                {active.map((s) => <option key={s.id} value={s.id}>{s.number} · {s.subcontractor_name} · {s.title}</option>)}
              </select>
            </Field>
            <button className="primary" disabled={!pick} onClick={() => nav(`/payments/certificates/new?sc=${pick}`)}><Plus size={14} aria-hidden />Prepare certificate</button>
            {!active.length && sq.data && <span className="small-text muted">Create a subcontract first (Subcontracts tab).</span>}
          </div>
        </Card>
      )}
      <ErrorBanner error={q.error ?? sq.error} onRetry={q.reload} />
      <Card flush>
        <DataTable rows={q.data ?? []} rowKey={(c: ScCertificate) => c.id} loading={!q.data} exportName="payment-certificates" maxHeight="65vh"
          empty={{ title: 'No payment certificates yet', body: 'Prepare one from a subcontract above.' }}
          onRowClick={(c) => nav(`/payments/certificates/${c.id}`)}
          columns={[
            { key: 'number', label: 'Certificate', id: true },
            { key: 'sub', label: 'Subcontractor', value: (c) => scById.get(c.subcontract_id)?.subcontractor_name ?? '' },
            { key: 'period', label: 'Period', value: (c) => c.period_to, render: (c) => `${date(c.period_from)} → ${date(c.period_to)}${c.is_final ? ' · final' : ''}` },
            { key: 'gross_this', label: 'Work this period', align: 'right', render: (c) => etb(c.gross_this) },
            { key: 'net_payable', label: 'Net payable', align: 'right', render: (c) => <b>{etb(c.net_payable)}</b> },
            { key: 'status', label: 'Status', render: (c) => <PaymentStatusBadge status={c.status} /> },
          ]} />
      </Card>
    </div>
  );
}

function SubcontractList({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const q = useAsync(() => loadSubcontracts(projectId), [projectId], { key: 'subcontracts' });
  const [open, setOpen] = useState<SubcontractRow | 'new' | null>(null);
  const canEdit = canPay(auth.profile?.role, 'payment.prepare') || auth.profile?.role === 'manager';
  return (
    <div className="stack">
      {canEdit && <div className="row"><button className="primary" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />New subcontract</button></div>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush>
        <DataTable rows={q.data ?? []} rowKey={(s: SubcontractRow) => s.id} loading={!q.data} exportName="subcontracts"
          empty={{ title: 'No subcontracts yet', body: 'Register the subcontractor, then create the subcontract with its BoQ items and agreed rates.' }}
          onRowClick={(s) => setOpen(s)}
          columns={[
            { key: 'number', label: 'Subcontract', id: true },
            { key: 'subcontractor_name', label: 'Subcontractor' },
            { key: 'title', label: 'Scope' },
            { key: 'contract_value', label: 'Contract value', align: 'right', render: (s) => etb(s.contract_value) },
            { key: 'certified_to_date', label: 'Certified', align: 'right', render: (s) => etb(s.certified_to_date) },
            { key: 'paid_to_date', label: 'Paid (net)', align: 'right', render: (s) => etb(s.paid_to_date) },
            { key: 'retention_held', label: 'Retention held', align: 'right', render: (s) => etb(s.retention_held) },
            { key: 'last', label: 'Last certificate', value: (s) => s.last_certificate_status ?? '', render: (s) => (s.last_certificate_status ? <PaymentStatusBadge status={s.last_certificate_status} /> : '—') },
          ]} />
      </Card>
      {open && <SubcontractEditor key={open === 'new' ? 'new' : open.id} projectId={projectId} sc={open === 'new' ? null : open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </div>
  );
}

interface ItemDraft { id: string; boq_item_id: string | null; task_id: string | null; description: string; unit: string; qty: string; rate: string }

function SubcontractEditor({ projectId, sc, canEdit, onClose }: { projectId: string; sc: SubcontractRow | null; canEdit: boolean; onClose: () => void }) {
  const subs = useAsync(() => loadSubcontractors(), [], { key: 'subcontractors' });
  const boq = useAsync(() => loadBoqItems(projectId), [projectId], { key: 'boq-items', staleTime: 5 * 60_000 });
  const tasks = useAsync(async () => {
    const s = await loadSchedules(projectId);
    const sid = s.schedules[0]?.id;
    return sid ? (await loadTasks(sid)).filter((t) => !t.is_summary) : [];
  }, [projectId], { key: 'payments-tasks', staleTime: 5 * 60_000 });
  const items = useAsync(() => (sc ? loadSubcontractItems(sc.id) : Promise.resolve([])), [sc?.id], { key: 'subcontract-items' });
  const [h, setH] = useState({
    subcontractor_id: sc?.subcontractor_id ?? '', title: sc?.title ?? '', scope: sc?.scope ?? '', start_date: sc?.start_date ?? '', end_date: sc?.end_date ?? '',
    retention_pct: String(sc?.retention_pct ?? 5), advance_amount: String(sc?.advance_amount ?? 0), advance_recovery_pct: String(sc?.advance_recovery_pct ?? 0),
    wht_pct: String(sc?.wht_pct ?? WHT_PCT_DEFAULT), status: sc?.status ?? 'active',
  });
  const [lines, setLines] = useState<ItemDraft[] | null>(null);
  const rows: ItemDraft[] = lines ?? (items.data ?? []).map((i) => ({ id: i.id, boq_item_id: i.boq_item_id, task_id: i.task_id, description: i.description, unit: i.unit, qty: String(i.qty), rate: String(i.rate) }));
  const set = (i: number, patch: Partial<ItemDraft>) => setLines(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const boqByNo = useMemo(() => new Map((boq.data ?? []).map((b) => [b.item_no, b])), [boq.data]);
  const boqById = useMemo(() => new Map((boq.data ?? []).map((b) => [b.id, b])), [boq.data]);
  const taskLabel = (t: { wbs: string | null; name: string }) => `${t.wbs ? `${t.wbs} ` : ''}${t.name}`;
  const taskByLabel = useMemo(() => new Map((tasks.data ?? []).map((t) => [taskLabel(t), t])), [tasks.data]);
  const taskById = useMemo(() => new Map((tasks.data ?? []).map((t) => [t.id, t])), [tasks.data]);
  const sub = (subs.data ?? []).find((s) => s.id === h.subcontractor_id);
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.rate) || 0), 0);
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const r = await payRpc('save_subcontract', {
      id: sc?.id ?? crypto.randomUUID(), project_id: projectId, subcontractor_id: h.subcontractor_id, title: h.title, scope: h.scope || undefined,
      start_date: h.start_date || null, end_date: h.end_date || null, retention_pct: Number(h.retention_pct), advance_amount: Number(h.advance_amount),
      advance_recovery_pct: Number(h.advance_recovery_pct), wht_pct: Number(h.wht_pct), vat_pct: sub?.vat_registered ? 15 : 0, status: h.status as SubcontractRow['status'],
      items: rows.map((x) => ({ id: x.id, boq_item_id: x.boq_item_id, task_id: x.task_id, description: x.description, unit: x.unit, qty: Number(x.qty), rate: Number(x.rate) })),
    });
    toast.success(`Subcontract ${String(r.number)} saved`);
    onClose();
  });
  if (!subs.data || (sc && !items.data)) return <Drawer title="Subcontract" onClose={onClose} size="lg"><Loading lines={6} /></Drawer>;
  return (
    <Drawer title={sc ? `${sc.number} · ${sc.title}` : 'New subcontract'} subtitle={sc ? sc.subcontractor_name : 'Scope, agreed rates, retention and advance'} size="lg" onClose={onClose}
      footer={canEdit ? <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !h.subcontractor_id || !h.title.trim() || !rows.length} onClick={save}>{busy && <span className="spinner" />}Save subcontract</button></> : undefined}>
      <ErrorBanner error={error} />
      {!subs.data.length && <Banner tone="warn">Register the subcontractor first (Subcontractors tab).</Banner>}
      <div className="form-grid">
        <Field label="Subcontractor" required><select value={h.subcontractor_id} disabled={!canEdit} onChange={(e) => setH({ ...h, subcontractor_id: e.target.value })}>
          <option value="">Choose…</option>{subs.data.filter((s) => s.is_active || s.id === h.subcontractor_id).map((s) => <option key={s.id} value={s.id}>{s.name}{s.trade ? ` · ${s.trade}` : ''}</option>)}</select></Field>
        <Field label="Title / scope" required><input value={h.title} disabled={!canEdit} onChange={(e) => setH({ ...h, title: e.target.value })} placeholder="e.g. Formwork & concrete, B2–G" /></Field>
        <Field label="Start"><input type="date" value={h.start_date} disabled={!canEdit} onChange={(e) => setH({ ...h, start_date: e.target.value })} /></Field>
        <Field label="Finish"><input type="date" value={h.end_date} disabled={!canEdit} onChange={(e) => setH({ ...h, end_date: e.target.value })} /></Field>
        <Field label="Retention %" hint="Typical 5–10 %, released at completion"><input type="number" min={0} max={20} step="0.5" value={h.retention_pct} disabled={!canEdit} onChange={(e) => setH({ ...h, retention_pct: e.target.value })} /></Field>
        <Field label="Advance paid (ETB)"><input type="number" min={0} value={h.advance_amount} disabled={!canEdit} onChange={(e) => setH({ ...h, advance_amount: e.target.value })} /></Field>
        <Field label="Advance recovery % per certificate" hint="All of the rest is recovered on the final certificate"><input type="number" min={0} max={100} value={h.advance_recovery_pct} disabled={!canEdit} onChange={(e) => setH({ ...h, advance_recovery_pct: e.target.value })} /></Field>
        <Field label="Withholding tax %" hint="3 % on services ≥ ETB 10,000 (Proc. 1395/2025)"><input type="number" min={0} max={30} step="0.5" value={h.wht_pct} disabled={!canEdit} onChange={(e) => setH({ ...h, wht_pct: e.target.value })} /></Field>
        <Field label="Status"><select value={h.status} disabled={!canEdit} onChange={(e) => setH({ ...h, status: e.target.value as SubcontractRow['status'] })}>
          <option value="active">Active</option><option value="completed">Completed</option><option value="terminated">Terminated</option></select></Field>
        <Field label="Notes" wide><input value={h.scope} disabled={!canEdit} onChange={(e) => setH({ ...h, scope: e.target.value })} /></Field>
      </div>
      <p className="small-text muted">{sub ? (sub.vat_registered ? 'VAT-registered: 15 % VAT is added to each certificate.' : 'Not VAT-registered: no VAT on the certificates.') : ''}</p>
      <h3 className="mt-3">Items and agreed rates <span className="muted small-text">· contract value {etb(total)} ETB</span></h3>
      <datalist id="sc-boq">{(boq.data ?? []).map((b) => <option key={b.id} value={b.item_no}>{b.description}</option>)}</datalist>
      <datalist id="sc-task">{(tasks.data ?? []).map((t) => <option key={t.id} value={taskLabel(t)} />)}</datalist>
      <div className="table-wrap pay-table"><div className="table-scroll">
        <table>
          <thead><tr><th>BoQ item</th><th>Schedule task</th><th>Description</th><th>Unit</th><th className="right">Qty</th><th className="right">Rate (ETB)</th><th className="right">Amount</th><th /></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td><input list="sc-boq" style={{ width: 110 }} disabled={!canEdit} defaultValue={r.boq_item_id ? boqById.get(r.boq_item_id)?.item_no ?? '' : ''}
                  onChange={(e) => { const b = boqByNo.get(e.target.value); set(i, b ? { boq_item_id: b.id, description: r.description || b.description, unit: r.unit || b.unit, qty: r.qty || String(b.quantity) } : { boq_item_id: null }); }} /></td>
                <td><input list="sc-task" style={{ width: 200 }} disabled={!canEdit} defaultValue={r.task_id ? taskLabel(taskById.get(r.task_id) ?? { wbs: null, name: '' }) : ''}
                  onChange={(e) => set(i, { task_id: taskByLabel.get(e.target.value)?.id ?? null })} /></td>
                <td><input value={r.description} disabled={!canEdit} onChange={(e) => set(i, { description: e.target.value })} style={{ minWidth: 200 }} /></td>
                <td><input value={r.unit} disabled={!canEdit} onChange={(e) => set(i, { unit: e.target.value })} style={{ width: 60 }} /></td>
                <td className="right"><input type="number" min={0} value={r.qty} disabled={!canEdit} onChange={(e) => set(i, { qty: e.target.value })} style={{ width: 90 }} /></td>
                <td className="right"><input type="number" min={0} value={r.rate} disabled={!canEdit} onChange={(e) => set(i, { rate: e.target.value })} style={{ width: 100 }} /></td>
                <td className="right">{etb((Number(r.qty) || 0) * (Number(r.rate) || 0))}</td>
                <td>{canEdit && <button className="icon-btn" aria-label="Remove line" onClick={() => setLines(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>
      {canEdit && <button className="mt-2" onClick={() => setLines([...rows, { id: crypto.randomUUID(), boq_item_id: null, task_id: null, description: '', unit: '', qty: '', rate: '' }])}><Plus size={14} aria-hidden />Add item</button>}
      {sc && <p className="small-text muted mt-2">Certified {etb(sc.certified_to_date)} of {etb(sc.contract_value)} · paid {etb(sc.paid_to_date)} · retention held {etb(sc.retention_held)} · advance recovered {etb(sc.advance_recovered)} of {etb(sc.advance_amount)} · {num(sc.contract_value ? (sc.certified_to_date / sc.contract_value) * 100 : 0, 0)} % certified</p>}
    </Drawer>
  );
}

function SubcontractorList() {
  const auth = useAuth();
  const q = useAsync(() => loadSubcontractors(), [], { key: 'subcontractors' });
  const [open, setOpen] = useState<Subcontractor | 'new' | null>(null);
  const canEdit = ['office_engineer', 'coordinator', 'manager', 'finance', 'admin'].includes(auth.profile?.role ?? '');
  return (
    <div className="stack">
      {canEdit && <div className="row"><button className="primary" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Register subcontractor</button></div>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush>
        <DataTable rows={q.data ?? []} rowKey={(s: Subcontractor) => s.id} loading={!q.data} exportName="subcontractors"
          empty={{ title: 'No subcontractors registered' }} onRowClick={(s) => setOpen(s)}
          columns={[
            { key: 'name', label: 'Company', id: true }, { key: 'trade', label: 'Trade' }, { key: 'tin', label: 'TIN' },
            { key: 'vat', label: 'VAT', value: (s) => (s.vat_registered ? 'registered' : 'no') },
            { key: 'contact', label: 'Contact', value: (s) => [s.contact_person, s.phone].filter(Boolean).join(' · ') },
            { key: 'bank', label: 'Bank', value: (s) => [s.bank_name, s.bank_account].filter(Boolean).join(' ') },
            { key: 'active', label: 'Active', value: (s) => (s.is_active ? 'yes' : 'no') },
          ]} />
      </Card>
      {open && <SubcontractorModal s={open === 'new' ? null : open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SubcontractorModal({ s, canEdit, onClose }: { s: Subcontractor | null; canEdit: boolean; onClose: () => void }) {
  const [f, setF] = useState({
    name: s?.name ?? '', trade: s?.trade ?? '', tin: s?.tin ?? '', vat_registered: s?.vat_registered ?? false, contact_person: s?.contact_person ?? '',
    phone: s?.phone ?? '', email: s?.email ?? '', address: s?.address ?? '', bank_name: s?.bank_name ?? '', bank_account: s?.bank_account ?? '', is_active: s?.is_active ?? true,
  });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await payRpc('save_subcontractor', { id: s?.id, ...f });
    toast.success(`${f.name} saved`);
    onClose();
  });
  const txt = (k: keyof typeof f, label: string, extra: object = {}) => (
    <Field label={label} {...extra}><input value={String(f[k])} disabled={!canEdit} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
  );
  return (
    <Modal title={s ? s.name : 'Register subcontractor'} onClose={onClose} wide footer={canEdit ? <><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !f.name.trim()} onClick={save}>{busy && <span className="spinner" />}Save</button></> : undefined}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        {txt('name', 'Company name', { required: true })}{txt('trade', 'Trade (e.g. formwork, finishing)')}
        <Field label="TIN" hint="10 digits"><input value={f.tin} inputMode="numeric" maxLength={10} disabled={!canEdit} onChange={(e) => setF({ ...f, tin: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="VAT registered (15 % VAT on certificates)" check><input type="checkbox" checked={f.vat_registered} disabled={!canEdit} onChange={(e) => setF({ ...f, vat_registered: e.target.checked })} /></Field>
        {txt('contact_person', 'Contact person')}{txt('phone', 'Phone')}{txt('email', 'Email')}{txt('address', 'Address')}
        {txt('bank_name', 'Bank')}{txt('bank_account', 'Account number')}
        <Field label="Active" check><input type="checkbox" checked={f.is_active} disabled={!canEdit} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /></Field>
      </div>
    </Modal>
  );
}
