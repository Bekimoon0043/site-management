// /payments/petty-cash — imprest petty cash: managers / finance open a float for a custodian; the custodian records
// expenses against the cash in hand and claims replenishment (coordinator checks → manager approves → finance pays).
import { useState } from 'react';
import { Plus, Send, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date } from '../../lib/format';
import { PETTY_CATEGORY_LABELS, type PettyCategory, type PettyClaim, type PettyFloat } from '../../lib/contract-finance';
import { Banner, Card, DataTable, Empty, ErrorBanner, Field, Kpi, Loading, Modal, Page, toast, useBusy } from '../../components/ui';
import { PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb } from '../../components/payments/data';
import { FinanceActions } from '../../components/finance/FinanceActions';
import { canFin, finRpc, loadFloats, loadPettyClaims, loadPettyEntries } from '../../components/finance/data';
import '../../components/payments/payments.css';
import '../../components/finance/finance.css';

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export function PettyCash() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const me = auth.profile?.id;
  const lk = useLookups(projectId);
  const fq = useAsync(() => loadFloats(projectId), [projectId], { key: 'petty-floats' });
  const eq = useAsync(() => loadPettyEntries(projectId), [projectId], { key: 'petty-entries' });
  const cq = useAsync(() => loadPettyClaims(projectId), [projectId], { key: 'petty-claims' });
  const [floatDlg, setFloatDlg] = useState<PettyFloat | 'new' | null>(null);
  const reload = () => { fq.reload(); eq.reload(); cq.reload(); };
  const floats = fq.data ?? [];
  const manage = canFin(role, 'floatManage');
  if (fq.data && !floats.length && !manage) {
    return <Page title="Petty cash"><Empty title="You hold no petty cash float">A manager or finance opens a float for the person who keeps the site cash.</Empty></Page>;
  }
  return (
    <Page title="Petty cash" subtitle="Small site expenses paid from a cash float, replenished against receipts"
      actions={manage ? <button className="primary" onClick={() => setFloatDlg('new')}><Plus size={16} aria-hidden />New float</button> : undefined}>
      <ErrorBanner error={fq.error ?? eq.error ?? cq.error} onRetry={reload} />
      {!fq.data ? <Loading lines={4} /> : !floats.length ? <Empty title="No petty cash floats">Open a float and name the custodian who keeps the cash.</Empty> : (
        <div className="stack">
          {floats.map((f) => (
            <FloatCard key={f.id} f={f} mine={f.custodian_id === me || role === 'admin'} manage={manage}
              entries={(eq.data ?? []).filter((e) => e.float_id === f.id)} claims={(cq.data ?? []).filter((c) => c.float_id === f.id)}
              person={(id) => lk.data?.person(id) ?? ''} onEdit={() => setFloatDlg(f)} onDone={reload} />
          ))}
        </div>
      )}
      {floatDlg && <FloatModal projectId={projectId} f={floatDlg === 'new' ? null : floatDlg} onClose={() => { setFloatDlg(null); reload(); }} />}
    </Page>
  );
}

function FloatCard({ f, mine, manage, entries, claims, person, onEdit, onDone }: {
  f: PettyFloat; mine: boolean; manage: boolean; entries: import('../../lib/contract-finance').PettyEntry[]; claims: PettyClaim[];
  person: (id: string | null) => string; onEdit: () => void; onDone: () => void;
}) {
  const [add, setAdd] = useState(false);
  const { busy, error, run } = useBusy();
  const open = claims.find((c) => ['submitted', 'checked', 'returned'].includes(c.status));
  const unclaimed = entries.filter((e) => !e.voided && !e.claim_id);
  const claim = () => void run(async () => {
    const r = await finRpc('submit_petty_claim', { id: open?.status === 'returned' ? open.id : crypto.randomUUID(), float_id: f.id });
    toast.success(`${String(r.number)} sent for checking · ${etb(Number(r.total))} ETB`);
    onDone();
  });
  const voidIt = (id: string) => void run(async () => { await finRpc('record_petty_expense', { id, void: true }); toast.success('Expense voided'); onDone(); });
  const low = Number(f.balance) < Number(f.float_amount) * 0.2;
  return (
    <Card title={`${f.name}${f.is_active ? '' : ' (closed)'}`} sub={`Custodian ${f.custodian_name}`}
      actions={manage ? <button className="small" onClick={onEdit}>Edit float</button> : undefined}>
      <ErrorBanner error={error} />
      <div className="kpis">
        <Kpi label="Cash in hand" value={etb(f.balance)} unit="ETB" hint={low ? 'Low — claim replenishment' : undefined} />
        <Kpi label="Float" value={etb(f.float_amount)} unit="ETB" />
        <Kpi label="Spent, not claimed" value={etb(f.unclaimed)} unit="ETB" />
        <Kpi label="In a claim" value={etb(f.in_claim)} unit="ETB" />
      </div>
      {mine && f.is_active && (
        <div className="row mt-2" style={{ flexWrap: 'wrap' }}>
          <button className="primary" onClick={() => setAdd(true)}><Plus size={14} aria-hidden />Record expense</button>
          <button disabled={busy || !unclaimed.length || (!!open && open.status !== 'returned')} onClick={claim}
            title={open && open.status !== 'returned' ? `${open.number} is in approval` : undefined}>
            <Send size={14} aria-hidden />{open?.status === 'returned' ? `Re-submit ${open.number}` : 'Claim replenishment'}{unclaimed.length ? ` (${unclaimed.length})` : ''}</button>
        </div>
      )}
      {claims.length > 0 && (
        <div className="stack mt-3">
          <h3 className="mb-0">Replenishment claims</h3>
          {claims.map((c) => (
            <div key={c.id} className="pay-claim">
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                <b>{c.number}</b><PaymentStatusBadge status={c.status} /><span>{etb(c.total)} ETB · {c.entries} receipt{c.entries === 1 ? '' : 's'}</span>
                <span className="muted small-text">by {person(c.prepared_by)}{c.payment_date ? ` · paid ${date(c.payment_date)}` : ''}</span>
              </div>
              {c.return_comment && <Banner tone={c.status === 'rejected' ? 'error' : 'warn'}>“{c.return_comment}”</Banner>}
              <FinanceActions docType="petty_cash" id={c.id} number={c.number} status={c.status} preparedBy={c.prepared_by} checkedBy={c.checked_by} net={Number(c.total)} onDone={onDone} />
            </div>
          ))}
        </div>
      )}
      <h3 className="mt-3 mb-0">Expenses</h3>
      <DataTable rows={entries} rowKey={(e) => e.id} exportName={`petty-cash-${f.name}`} maxHeight="45vh"
        empty={{ title: 'No expenses yet' }}
        columns={[
          { key: 'number', label: 'No.', id: true, render: (e) => (e.voided ? <s>{e.number}</s> : e.number) },
          { key: 'entry_date', label: 'Date', render: (e) => date(e.entry_date) },
          { key: 'category', label: 'Category', value: (e) => PETTY_CATEGORY_LABELS[e.category] },
          { key: 'description', label: 'Description' },
          { key: 'payee', label: 'Paid to' },
          { key: 'receipt_no', label: 'Receipt' },
          { key: 'amount', label: 'Amount', align: 'right', render: (e) => etb(e.amount) },
          { key: 'claim', label: 'Claim', value: (e) => (e.voided ? 'voided' : claims.find((c) => c.id === e.claim_id)?.number ?? 'not claimed') },
          { key: 'x', label: '', render: (e) => (mine && !e.voided && !e.claim_id
            ? <button className="icon-btn" aria-label={`Void ${e.number}`} disabled={busy} onClick={() => voidIt(e.id)}><Trash2 size={14} /></button> : null) },
        ]} />
      {add && <ExpenseModal f={f} onClose={() => { setAdd(false); onDone(); }} />}
    </Card>
  );
}

function ExpenseModal({ f, onClose }: { f: PettyFloat; onClose: () => void }) {
  const [v, setV] = useState({ entry_date: today(), category: 'transport' as PettyCategory, description: '', payee: '', receipt_no: '', amount: '' });
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    const r = await finRpc('record_petty_expense', { id: crypto.randomUUID(), float_id: f.id, entry_date: v.entry_date, category: v.category,
      description: v.description.trim(), payee: v.payee || undefined, receipt_no: v.receipt_no || undefined, amount: Number(v.amount) });
    toast.success(`${String(r.number)} recorded · ${etb(Number(r.balance))} ETB left`);
    onClose();
  });
  return (
    <Modal title={`Record expense — ${f.name}`} subtitle={`Cash in hand ${etb(f.balance)} ETB`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !v.description.trim() || !(Number(v.amount) > 0)} onClick={save}>{busy && <span className="spinner" />}Save</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Date" required><input type="date" value={v.entry_date} max={today()} onChange={(e) => setV({ ...v, entry_date: e.target.value })} /></Field>
        <Field label="Category"><select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value as PettyCategory })}>
          {(Object.keys(PETTY_CATEGORY_LABELS) as PettyCategory[]).map((c) => <option key={c} value={c}>{PETTY_CATEGORY_LABELS[c]}</option>)}</select></Field>
        <Field label="What for" required wide><input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} placeholder="e.g. Bajaj to take cube samples to the lab" /></Field>
        <Field label="Paid to"><input value={v.payee} onChange={(e) => setV({ ...v, payee: e.target.value })} /></Field>
        <Field label="Receipt no."><input value={v.receipt_no} onChange={(e) => setV({ ...v, receipt_no: e.target.value })} /></Field>
        <Field label="Amount (ETB)" required><input type="number" min={0} step="0.01" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function FloatModal({ projectId, f, onClose }: { projectId: string; f: PettyFloat | null; onClose: () => void }) {
  const lk = useLookups(projectId);
  const [name, setName] = useState(f?.name ?? 'Site petty cash');
  const [custodian, setCustodian] = useState(f?.custodian_id ?? '');
  const [amount, setAmount] = useState(f ? String(f.float_amount) : '');
  const [active, setActive] = useState(f?.is_active ?? true);
  const { busy, error, run } = useBusy();
  const save = () => void run(async () => {
    await finRpc('save_petty_float', { id: f?.id ?? crypto.randomUUID(), project_id: projectId, name, custodian_id: custodian, float_amount: Number(amount), is_active: active });
    toast.success('Float saved');
    onClose();
  });
  return (
    <Modal title={f ? `Edit ${f.name}` : 'New petty cash float'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy || !custodian || !(Number(amount) > 0)} onClick={save}>{busy && <span className="spinner" />}Save</button></>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Custodian (keeps the cash)" required>
          <select value={custodian} onChange={(e) => setCustodian(e.target.value)}>
            <option value="">Choose…</option>
            {(lk.data?.profiles ?? []).filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Field>
        <Field label="Float amount (ETB)" required hint="The fixed cash the custodian holds; each paid claim tops it back up"><input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        {f && <Field label="Active" check><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /></Field>}
      </div>
    </Modal>
  );
}
