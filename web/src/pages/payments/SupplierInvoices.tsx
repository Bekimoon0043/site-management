// /payments/invoices — supplier invoices against purchase orders with a 3-way match (PO price · goods accepted on GRNs ·
// invoiced quantity): record → coordinator checks → manager approves (variance needs a written reason) → finance pays.
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilePlus2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import { FINANCE_STATUS_LABELS, type FinanceDocStatus, type PoInvoiceable, type SupplierInvoice } from '../../lib/contract-finance';
import { Badge, Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, FilterBar, FilterSelect, Kpi, Loading, Page, toast, useBusy } from '../../components/ui';
import { PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb } from '../../components/payments/data';
import { FinanceActions } from '../../components/finance/FinanceActions';
import { canFin, finRpc, loadInvoiceLines, loadInvoiceable, loadInvoices } from '../../components/finance/data';
import '../../components/payments/payments.css';

const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
const plusDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);

export function SupplierInvoices() {
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const q = useAsync(() => loadInvoices(projectId), [projectId], { key: 'supplier-invoices' });
  const [open, setOpen] = useState<SupplierInvoice | 'new' | null>(null);
  const [st, setSt] = useState('');
  if (!canFin(role, 'invoiceView') || !auth.canSeePrices) {
    return <Page title="Supplier invoices"><Empty title="No access">Supplier invoices show prices — procurement, finance and management only.</Empty></Page>;
  }
  const rows = q.data ?? [];
  const t = today();
  const sum = (xs: SupplierInvoice[]) => xs.reduce((s, r) => s + Number(r.net_payable), 0);
  const inFlow = rows.filter((r) => r.status === 'submitted' || r.status === 'checked');
  const toPay = rows.filter((r) => r.status === 'approved');
  const overdue = rows.filter((r) => ['submitted', 'checked', 'approved'].includes(r.status) && r.due_date < t);
  const variance = rows.filter((r) => r.match_status === 'variance' && !['paid', 'rejected'].includes(r.status));
  return (
    <Page title="Supplier invoices" subtitle="Invoices matched to the purchase order and the goods accepted on site, then approved and paid"
      actions={canFin(role, 'invoicePrepare') ? <button className="primary" onClick={() => setOpen('new')}><FilePlus2 size={16} aria-hidden />Record invoice</button> : undefined}>
      <div className="kpis">
        <Kpi label="In approval" value={etb(sum(inFlow))} unit="ETB" hint={`${inFlow.length} invoice${inFlow.length === 1 ? '' : 's'}`} />
        <Kpi label="Approved, to pay" value={etb(sum(toPay))} unit="ETB" hint={`${toPay.length} invoice${toPay.length === 1 ? '' : 's'}`} />
        <Kpi label="Past due date" value={etb(sum(overdue))} unit="ETB" hint={`${overdue.length} unpaid after the due date`} />
        <Kpi label="Match variances" value={String(variance.length)} hint="Price above the PO or more than was received" />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <Card flush>
        <div className="pad" style={{ paddingBottom: 0 }}>
          <FilterBar><FilterSelect label="Status" value={st} onChange={setSt} options={(Object.keys(FINANCE_STATUS_LABELS) as FinanceDocStatus[]).map((k) => ({ value: k, label: FINANCE_STATUS_LABELS[k] }))} /></FilterBar>
        </div>
        <DataTable rows={rows.filter((r) => !st || r.status === st)} rowKey={(r) => r.id} loading={!q.data} onRowClick={(r) => setOpen(r)} exportName="supplier-invoices"
          empty={{ title: 'No supplier invoices yet', body: 'Record the supplier\'s invoice once the goods have been received on a GRN.' }}
          columns={[
            { key: 'number', label: 'No.', id: true },
            { key: 'supplier_name', label: 'Supplier' },
            { key: 'invoice_no', label: 'Supplier invoice' },
            { key: 'po_number', label: 'PO' },
            { key: 'invoice_date', label: 'Date', render: (r) => date(r.invoice_date) },
            { key: 'due_date', label: 'Due', render: (r) => <span className={r.due_date < t && !['paid', 'rejected'].includes(r.status) ? 'warn-text strong' : undefined}>{date(r.due_date)}</span> },
            { key: 'total', label: 'Total incl. VAT', align: 'right', render: (r) => etb(r.total) },
            { key: 'withholding', label: 'Withholding', align: 'right', render: (r) => etb(r.withholding) },
            { key: 'net_payable', label: 'Net payable', align: 'right', render: (r) => <b>{etb(r.net_payable)}</b> },
            { key: 'match', label: '3-way match', value: (r) => r.match_status, render: (r) => <Badge tone={r.match_status === 'matched' ? 'success' : 'warning'} label={r.match_status === 'matched' ? 'Matched' : 'Variance'} icon={null} /> },
            { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <PaymentStatusBadge status={r.status} /> },
          ]} />
      </Card>
      {open === 'new' && <InvoiceForm projectId={projectId} onClose={() => { setOpen(null); q.reload(); }} />}
      {open && open !== 'new' && <InvoiceDrawer key={open.id} inv={open} projectId={projectId} onClose={() => { setOpen(null); q.reload(); }} />}
    </Page>
  );
}

function InvoiceDrawer({ inv, projectId, onClose }: { inv: SupplierInvoice; projectId: string; onClose: () => void }) {
  const auth = useAuth();
  const lk = useLookups(projectId);
  const lq = useAsync(() => loadInvoiceLines(inv.id), [inv.id], { key: 'supplier-invoice-lines' });
  const [edit, setEdit] = useState(false);
  const editable = ['draft', 'returned'].includes(inv.status) && canFin(auth.profile?.role, 'invoicePrepare');
  if (edit) return <InvoiceForm projectId={projectId} existing={inv} existingLines={lq.data ?? []} onClose={onClose} />;
  return (
    <Drawer size="lg" onClose={onClose} title={`${inv.number} · ${inv.supplier_name}`} subtitle={<PaymentStatusBadge status={inv.status} />}>
      {inv.return_comment && <Banner tone={inv.status === 'rejected' ? 'error' : 'warn'}>{inv.status === 'rejected' ? 'Rejected' : 'Returned'}: “{inv.return_comment}”</Banner>}
      {inv.match_status === 'variance'
        ? <Banner tone="warn"><b>3-way match variance</b>{inv.match_notes.map((m) => <div key={m}>{m}</div>)}{inv.override_comment && <div className="mt-1">Approved because: “{inv.override_comment}”</div>}</Banner>
        : <Banner tone="ok">Matches the PO prices and the quantities accepted on GRNs.</Banner>}
      <dl className="kv">
        <dt>Supplier invoice</dt><dd>{inv.invoice_no} · {date(inv.invoice_date)}</dd>
        <dt>Purchase order</dt><dd><Link to={`/procurement/po/${inv.po_id}`}>{inv.po_number}</Link></dd>
        <dt>Supplier TIN</dt><dd>{inv.supplier_tin ?? <span className="warn-text">none recorded — server rate {num(inv.withholding_rate, 0)} %; verify TIN and business licence</span>}</dd>
        <dt>Due</dt><dd>{date(inv.due_date)}</dd>
        <dt>Recorded by</dt><dd>{lk.data?.person(inv.prepared_by) ?? ''}</dd>
        {inv.payment_date && <><dt>Paid</dt><dd>{date(inv.payment_date)} · {inv.payment_method?.replace('_', ' ')} {inv.payment_ref ?? ''}</dd></>}
      </dl>
      <DataTable rows={lq.data ?? []} rowKey={(l) => l.id} loading={!lq.data}
        columns={[
          { key: 'line_no', label: '#' },
          { key: 'item', label: 'Item', value: (l) => l.description ?? '', render: (l) => l.description ?? <span className="muted">PO line</span> },
          { key: 'qty', label: 'Invoiced', align: 'right', render: (l) => num(l.qty, 2) },
          { key: 'qty_accepted', label: 'Accepted on GRNs', align: 'right', render: (l) => num(l.qty_accepted, 2) },
          { key: 'before', label: 'Matched against', align: 'right', render: (l) => num(l.qty_invoiced_before, 2) },
          { key: 'unit_price', label: 'Price', align: 'right', render: (l) => etb(l.unit_price) },
          { key: 'po_unit_price', label: 'PO price', align: 'right', render: (l) => etb(l.po_unit_price) },
          { key: 'amount', label: 'Amount', align: 'right', render: (l) => etb(l.amount) },
          { key: 'flag', label: 'Match', render: (l) => (l.flag ? <Badge tone="warning" label={l.flag === 'price' ? 'Price' : l.flag === 'qty' ? 'Quantity' : 'Price & qty'} icon={null} /> : <Badge tone="success" label="OK" icon={null} />) },
        ]} />
      <dl className="pay-summary mt-3">
        <dt>Subtotal</dt><dd>{etb(inv.subtotal)}</dd>
        <dt>VAT</dt><dd>+ {etb(inv.vat)}</dd>
        <dt>Withholding {num(inv.withholding_rate, 0)} %</dt><dd className="minus">− {etb(inv.withholding)}</dd>
        <dt className="total">Net payable (ETB)</dt><dd className="total">{etb(inv.net_payable)}</dd>
      </dl>
      <div className="row mt-3" style={{ flexWrap: 'wrap' }}>
        {editable && <button onClick={() => setEdit(true)}>Edit invoice</button>}
      </div>
      <div className="mt-2">
        <FinanceActions docType="supplier_invoice" id={inv.id} number={inv.number} status={inv.status} preparedBy={inv.prepared_by} checkedBy={inv.checked_by}
          net={Number(inv.net_payable)} variance={inv.match_status === 'variance'} onDone={onClose} />
      </div>
    </Drawer>
  );
}

interface LineDraft { po_line_id: string; on: boolean; qty: string; price: string }

function InvoiceForm({ projectId, existing, existingLines, onClose }: {
  projectId: string; existing?: SupplierInvoice; existingLines?: { po_line_id: string; qty: number; unit_price: number }[]; onClose: () => void;
}) {
  const lk = useLookups(projectId);
  const iq = useAsync(() => loadInvoiceable(projectId), [projectId], { key: 'po-invoiceable' });
  const byPo = useMemo(() => {
    const m = new Map<string, PoInvoiceable[]>();
    for (const r of iq.data ?? []) m.set(r.po_id, [...(m.get(r.po_id) ?? []), r]);
    return m;
  }, [iq.data]);
  const openPos = [...byPo.entries()].filter(([id, ls]) => id === existing?.po_id || ls.some((l) => Number(l.qty_accepted) > Number(l.qty_invoiced) + 0.0005));
  const [poId, setPoId] = useState(existing?.po_id ?? '');
  const [invNo, setInvNo] = useState(existing?.invoice_no ?? '');
  const [invDate, setInvDate] = useState(existing?.invoice_date ?? today());
  const [due, setDue] = useState(existing?.due_date ?? '');
  const [remarks, setRemarks] = useState(existing?.remarks ?? '');
  const [lines, setLines] = useState<Record<string, LineDraft>>({});
  const { busy, error, run } = useBusy();
  const poLines = byPo.get(poId) ?? [];
  const draftOf = (l: PoInvoiceable): LineDraft => {
    if (lines[l.po_line_id]) return lines[l.po_line_id];
    const ex = existingLines?.find((x) => x.po_line_id === l.po_line_id);
    if (existing) return { po_line_id: l.po_line_id, on: !!ex, qty: ex ? String(Number(ex.qty)) : '', price: String(Number(ex?.unit_price ?? l.unit_price)) };
    const left = Math.max(Number(l.qty_accepted) - Number(l.qty_invoiced), 0);
    return { po_line_id: l.po_line_id, on: left > 0, qty: left > 0 ? String(left) : '', price: String(Number(l.unit_price)) };
  };
  const set = (l: PoInvoiceable, patch: Partial<LineDraft>) => setLines({ ...lines, [l.po_line_id]: { ...draftOf(l), ...patch } });
  const chosen = poLines.map(draftOf).filter((d) => d.on && Number(d.qty) > 0);
  const subtotal = chosen.reduce((s, d) => s + Number(d.qty) * Number(d.price || 0), 0);
  const save = (submit: boolean) => void run(async () => {
    const r = await finRpc('save_supplier_invoice', { id: existing?.id ?? crypto.randomUUID(), po_id: poId, invoice_no: invNo.trim(), invoice_date: invDate,
      due_date: due || undefined, remarks: remarks || undefined, submit,
      lines: chosen.map((d) => ({ po_line_id: d.po_line_id, qty: Number(d.qty), unit_price: Number(d.price) })) });
    const notes = (r.match_notes as string[] | undefined) ?? [];
    if (notes.length) toast.error(`${String(r.number)} saved with a 3-way match variance: ${notes[0]}`);
    else toast.success(`${String(r.number)} ${submit ? 'sent for checking' : 'saved'} — matched`);
    onClose();
  });
  return (
    <Drawer size="lg" onClose={onClose} title={existing ? `Edit ${existing.number}` : 'Record a supplier invoice'}
      subtitle="Pick the purchase order; lines start with the quantity accepted on GRNs and not yet invoiced"
      footer={<>
        <button onClick={onClose}>Cancel</button>
        <button disabled={busy || !poId || !invNo.trim() || !chosen.length} onClick={() => save(false)}>Save draft</button>
        <button className="primary" disabled={busy || !poId || !invNo.trim() || !chosen.length} onClick={() => save(true)}>{busy && <span className="spinner" />}Save &amp; send for checking</button>
      </>}>
      <ErrorBanner error={error ?? iq.error} />
      {!iq.data ? <Loading lines={4} /> : !openPos.length ? <Empty title="Nothing to invoice">No purchase order has goods received that are not yet invoiced.</Empty> : (
        <div className="stack">
          <div className="form-grid">
            <Field label="Purchase order" required wide>
              <select value={poId} disabled={!!existing} onChange={(e) => { setPoId(e.target.value); setLines({}); }}>
                <option value="">Choose…</option>
                {openPos.map(([id, ls]) => <option key={id} value={id}>{ls[0].po_number} · {lk.data?.suppliers.find((s) => s.id === ls[0].supplier_id)?.name ?? ''}</option>)}
              </select>
            </Field>
            <Field label="Supplier's invoice no." required><input value={invNo} onChange={(e) => setInvNo(e.target.value)} placeholder="e.g. AC-778" /></Field>
            <Field label="Invoice date" required><input type="date" value={invDate} max={today()} onChange={(e) => setInvDate(e.target.value)} /></Field>
            <Field label="Due date" hint={due ? undefined : `Default ${date(plusDays(invDate || today(), 30))} (30 days)`}><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            <Field label="Remarks" wide><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
          </div>
          {poId && (
            <div className="table-wrap pay-table"><div className="table-scroll">
              <table>
                <thead><tr><th /><th>Material</th><th className="right">Ordered</th><th className="right">Accepted</th><th className="right">Invoiced</th>
                  <th className="right">Invoice qty</th><th className="right">PO price</th><th className="right">Invoice price</th><th className="right">Amount</th></tr></thead>
                <tbody>
                  {poLines.map((l) => {
                    const d = draftOf(l);
                    const over = Number(d.qty) + Number(l.qty_invoiced) - (existingLines?.find((x) => x.po_line_id === l.po_line_id) ? Number(existingLines.find((x) => x.po_line_id === l.po_line_id)!.qty) : 0) > Number(l.qty_accepted) + 0.0005;
                    const dear = Number(d.price) > Number(l.unit_price) + 0.005;
                    return (
                      <tr key={l.po_line_id}>
                        <td><input type="checkbox" checked={d.on} aria-label={`Invoice line ${l.line_no}`} onChange={(e) => set(l, { on: e.target.checked })} /></td>
                        <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{l.material} {l.spec}</td>
                        <td className="right">{num(l.qty_ordered, 2)} {l.uom ?? ''}</td>
                        <td className="right">{num(l.qty_accepted, 2)}</td>
                        <td className="right">{num(l.qty_invoiced, 2)}</td>
                        <td className="right"><input type="number" min={0} step="any" style={{ width: 100 }} disabled={!d.on} value={d.qty} className={over ? 'warn-input' : undefined}
                          title={over ? 'More than was accepted on GRNs' : undefined} onChange={(e) => set(l, { qty: e.target.value })} /></td>
                        <td className="right">{etb(l.unit_price)}</td>
                        <td className="right"><input type="number" min={0} step="0.01" style={{ width: 110 }} disabled={!d.on} value={d.price} className={dear ? 'warn-input' : undefined}
                          title={dear ? 'Above the PO price' : undefined} onChange={(e) => set(l, { price: e.target.value })} /></td>
                        <td className="right">{d.on ? etb(Number(d.qty || 0) * Number(d.price || 0)) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div></div>
          )}
          {poId && <p className="strong mb-0">Subtotal {etb(subtotal)} ETB <span className="muted small-text">· VAT and withholding are calculated by the server on save</span></p>}
        </div>
      )}
    </Drawer>
  );
}
