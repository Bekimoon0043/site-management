// /payments/payroll — daily-labour payrolls (attendance + piece-rate work) and the project's workers register.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { date } from '../../lib/format';
import { LABOUR_TAX_RATES, canPay, type LabourPayroll, type LabourWorker } from '../../lib/contract-payments';
import { Card, DataTable, Empty, ErrorBanner, Field, Modal, Page, Tabs, toast, useBusy, useHashTab } from '../../components/ui';
import { PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb, loadPayrolls, loadWorkers, payRpc } from '../../components/payments/data';
import '../../components/payments/payments.css';

const TABS = ['payrolls', 'workers'] as const;

export function Payroll() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const [tab, setTab] = useHashTab(TABS, 'payrolls');
  const viewer = canPay(role, 'payment.view') || canPay(role, 'piece.verify');
  if (!viewer) return <Page title="Labour payroll"><Empty title="No access">Labour payrolls are for site and office engineers, the coordinator, the manager and finance.</Empty></Page>;
  return (
    <Page title="Labour payroll" subtitle="Daily labour paid by the day (attendance) or by the piece (berga, m², m³ …, verified on site) → coordinator check → manager approval → finance payment">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'payrolls', label: 'Payrolls' }, { key: 'workers', label: 'Workers' }]} />
      <div className="mt-3">{tab === 'payrolls' ? <PayrollList projectId={projectId} /> : <WorkerList projectId={projectId} />}</div>
    </Page>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function lastWeek(): { from: string; to: string } {
  const now = new Date(Date.now() + 3 * 3600_000);
  const dow = (now.getUTCDay() + 6) % 7;          // Monday = 0
  const mon = new Date(now); mon.setUTCDate(now.getUTCDate() - dow);
  const to = new Date(now); to.setUTCDate(Math.min(now.getUTCDate(), mon.getUTCDate() + 6));
  return { from: iso(mon), to: iso(now < to ? now : to) };
}

function PayrollList({ projectId }: { projectId: string }) {
  const nav = useNavigate();
  const auth = useAuth();
  const q = useAsync(() => loadPayrolls(projectId), [projectId], { key: 'payrolls' });
  const canPrep = canPay(auth.profile?.role, 'payment.prepare');
  const [open, setOpen] = useState(false);
  const [p, setP] = useState(() => ({ ...lastWeek(), frequency: 'weekly', tax_pct: '15' }));
  const { busy, error, run } = useBusy();
  const create = () => void run(async () => {
    const id = crypto.randomUUID();
    await payRpc('save_payroll', { id, project_id: projectId, period_from: p.from, period_to: p.to, frequency: p.frequency as LabourPayroll['frequency'], tax_pct: Number(p.tax_pct) });
    toast.success('Payroll created — record the attendance');
    nav(`/payments/payroll/${id}`);
  });
  return (
    <div className="stack">
      {canPrep && <div className="row"><button className="primary" onClick={() => setOpen(true)}><Plus size={14} aria-hidden />New payroll</button></div>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush>
        <DataTable rows={q.data ?? []} rowKey={(r: LabourPayroll) => r.id} loading={!q.data} exportName="payrolls" onRowClick={(r) => nav(`/payments/payroll/${r.id}`)}
          empty={{ title: 'No payrolls yet', body: 'Register the workers (Workers tab), then create the week\'s payroll.' }}
          columns={[
            { key: 'number', label: 'Payroll', id: true },
            { key: 'period', label: 'Period', value: (r) => r.period_from, render: (r) => `${date(r.period_from)} → ${date(r.period_to)}` },
            { key: 'workers', label: 'Workers', align: 'right' },
            { key: 'days', label: 'Man-days', align: 'right' },
            { key: 'gross', label: 'Gross', align: 'right', render: (r) => etb(r.gross) },
            { key: 'tax', label: 'Tax', align: 'right', render: (r) => etb(r.tax) },
            { key: 'net', label: 'Net pay', align: 'right', render: (r) => <b>{etb(r.net)}</b> },
            { key: 'status', label: 'Status', render: (r) => <PaymentStatusBadge status={r.status} /> },
          ]} />
      </Card>
      {open && (
        <Modal title="New payroll" onClose={() => setOpen(false)} footer={<><button onClick={() => setOpen(false)}>Cancel</button>
          <button className="primary" disabled={busy || !p.from || !p.to} onClick={create}>{busy && <span className="spinner" />}Create</button></>}>
          <ErrorBanner error={error} />
          <div className="form-grid">
            <Field label="From" required><input type="date" value={p.from} onChange={(e) => setP({ ...p, from: e.target.value })} /></Field>
            <Field label="To" required><input type="date" value={p.to} onChange={(e) => setP({ ...p, to: e.target.value })} /></Field>
            <Field label="Pay period"><select value={p.frequency} onChange={(e) => setP({ ...p, frequency: e.target.value })}>
              <option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option></select></Field>
            <Field label="Tax rate" hint="Workers with their own rate keep it"><select value={p.tax_pct} onChange={(e) => setP({ ...p, tax_pct: e.target.value })}>
              {LABOUR_TAX_RATES.map((r) => <option key={r} value={r}>{r} %</option>)}<option value="0">0 % (exempt)</option></select></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WorkerList({ projectId }: { projectId: string }) {
  const auth = useAuth();
  const q = useAsync(() => loadWorkers(projectId), [projectId], { key: 'labour-workers' });
  const [open, setOpen] = useState<LabourWorker | 'new' | null>(null);
  const canEdit = ['office_engineer', 'coordinator', 'manager', 'admin'].includes(auth.profile?.role ?? '');
  return (
    <div className="stack">
      {canEdit && <div className="row"><button className="primary" onClick={() => setOpen('new')}><Plus size={14} aria-hidden />Add worker</button></div>}
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush>
        <DataTable rows={q.data ?? []} rowKey={(w: LabourWorker) => w.id} loading={!q.data} exportName="labour-workers" onRowClick={(w) => setOpen(w)}
          empty={{ title: 'No workers registered' }}
          columns={[
            { key: 'full_name', label: 'Name', id: true }, { key: 'trade_name', label: 'Trade' },
            { key: 'daily_rate', label: 'Daily rate', align: 'right', render: (w) => (Number(w.daily_rate) ? etb(w.daily_rate) : 'piece-rate') },
            { key: 'tin', label: 'TIN' },
            { key: 'tax', label: 'Tax', value: (w) => (w.tax_pct == null ? 'payroll rate' : `${w.tax_pct} %`) },
            { key: 'phone', label: 'Phone' }, { key: 'active', label: 'Active', value: (w) => (w.is_active ? 'yes' : 'no') },
          ]} />
      </Card>
      {open && <WorkerModal projectId={projectId} w={open === 'new' ? null : open} canEdit={canEdit} onClose={() => setOpen(null)} />}
    </div>
  );
}

function WorkerModal({ projectId, w, canEdit, onClose }: { projectId: string; w: LabourWorker | null; canEdit: boolean; onClose: () => void }) {
  const trades = useAsync(async () => check(await supabase.from('labour_trades').select('id, name').order('sort_order')) as { id: string; name: string }[], [], { key: 'labour-trades', staleTime: 10 * 60_000 });
  const [f, setF] = useState({
    full_name: w?.full_name ?? '', trade_id: w?.trade_id ?? '', trade_name: w?.trade_name ?? '', daily_rate: String(w?.daily_rate ?? ''), tin: w?.tin ?? '',
    tax_pct: w?.tax_pct == null ? '' : String(w.tax_pct), id_no: w?.id_no ?? '', phone: w?.phone ?? '', bank_account: w?.bank_account ?? '', is_active: w?.is_active ?? true,
  });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await payRpc('save_labour_worker', { id: w?.id, project_id: projectId, full_name: f.full_name, trade_id: f.trade_id || null,
      trade_name: f.trade_name || trades.data?.find((t) => t.id === f.trade_id)?.name, daily_rate: Number(f.daily_rate || 0), tin: f.tin || undefined,
      tax_pct: f.tax_pct === '' ? null : Number(f.tax_pct), id_no: f.id_no || undefined, phone: f.phone || undefined, bank_account: f.bank_account || undefined, is_active: f.is_active });
    toast.success(`${f.full_name} saved`);
    onClose();
  });
  return (
    <Modal title={w ? w.full_name : 'Add worker'} onClose={onClose} footer={canEdit ? <><button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !f.full_name.trim() || f.daily_rate === ''} onClick={save}>{busy && <span className="spinner" />}Save</button></> : undefined}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Full name" required><input value={f.full_name} disabled={!canEdit} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Trade"><select value={f.trade_id} disabled={!canEdit} onChange={(e) => setF({ ...f, trade_id: e.target.value, trade_name: '' })}>
          <option value="">Other / type below</option>{(trades.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        {!f.trade_id && <Field label="Trade (other)"><input value={f.trade_name} disabled={!canEdit} onChange={(e) => setF({ ...f, trade_name: e.target.value })} placeholder="e.g. Bar bender" /></Field>}
        <Field label="Daily rate (ETB)" required hint="0 for workers paid only by the piece"><input type="number" min={0} value={f.daily_rate} disabled={!canEdit} onChange={(e) => setF({ ...f, daily_rate: e.target.value })} /></Field>
        <Field label="TIN"><input value={f.tin} disabled={!canEdit} inputMode="numeric" onChange={(e) => setF({ ...f, tin: e.target.value })} /></Field>
        <Field label="Tax rate" hint="Leave on 'payroll rate' unless this worker differs (e.g. 30 % without TIN)">
          <select value={f.tax_pct} disabled={!canEdit} onChange={(e) => setF({ ...f, tax_pct: e.target.value })}>
            <option value="">Payroll rate</option>{LABOUR_TAX_RATES.map((r) => <option key={r} value={r}>{r} %</option>)}<option value="0">0 % (exempt)</option></select></Field>
        <Field label="ID / Kebele no."><input value={f.id_no} disabled={!canEdit} onChange={(e) => setF({ ...f, id_no: e.target.value })} /></Field>
        <Field label="Phone"><input value={f.phone} disabled={!canEdit} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Bank account"><input value={f.bank_account} disabled={!canEdit} onChange={(e) => setF({ ...f, bank_account: e.target.value })} /></Field>
        <Field label="Active" check><input type="checkbox" checked={f.is_active} disabled={!canEdit} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /></Field>
      </div>
    </Modal>
  );
}
