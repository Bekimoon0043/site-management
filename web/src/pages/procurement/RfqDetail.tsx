import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy, FilePlus2, Pencil, Printer, Send, ShoppingCart } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { canProcure, type Quotation } from '../../lib/contract-procurement';
import { copyText, loadRfqDetail, procRpc, telegramShare } from '../../lib/procurement';
import { date, dateTime, humanize, num } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import { Badge, Card, DataTable, Empty, ErrorBanner, Loading, Menu, Page, Popover, PrintHeader, ReasonModal, Signatures, toast, useBusy } from '../../components/ui';
import { RfqBadge } from '../../components/procurement/badges';
import { RfqEditor, newRfqLine, type RfqDraft } from '../../components/procurement/RfqEditor';
import { QuotationDrawer } from '../../components/procurement/QuotationDrawer';
import { Attachments } from '../../components/Attachments';

// The comparison grid is only useful (and only loaded) for price roles.
const Comparison = lazy(() => import('../../components/procurement/Comparison').then((m) => ({ default: m.Comparison })));

export function RfqDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const projectId = useProjectId();
  const auth = useAuth();
  const role = auth.profile?.role;
  const lk = useLookups(projectId);
  const q = useAsync(() => loadRfqDetail(id, auth.canSeePrices), [id, auth.canSeePrices], { key: 'rfq-detail' });
  const [editing, setEditing] = useState<RfqDraft | null>(null);
  const [quote, setQuote] = useState<Quotation | 'new' | null>(null);
  const [dialog, setDialog] = useState<'cancel' | null>(null);
  const { busy, error, run } = useBusy();

  useEffect(() => { if (q.data) pushRecent({ label: q.data.rfq.number, hint: 'RFQ', to: `/procurement/rfq/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="RFQ" breadcrumbs={[{ label: 'Procurement', to: '/procurement#rfqs' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const d = q.data;
  const { rfq } = d;
  const L = lk.data;
  const canEdit = canProcure(role, 'rfq.create');
  const canQuote = canProcure(role, 'quotation.record') && auth.canSeePrices && ['sent', 'closed'].includes(rfq.status);
  const canAward = canProcure(role, 'rfq.award') && auth.canSeePrices;
  const action = (a: 'send' | 'close' | 'cancel', comment?: string) => procRpc('rfq_action', { rfq_id: rfq.id, action: a, comment }).then(() => {
    toast.success(`${rfq.number} ${a === 'send' ? 'sent' : a === 'close' ? 'closed for quotations' : 'cancelled'}`);
    q.reload();
  });
  const edit = () => setEditing({
    id: rfq.id, number: rfq.number, title: rfq.title, required_by: rfq.required_by ?? '', delivery_store_id: rfq.delivery_store_id ?? '',
    min_quotes: String(rfq.min_quotes), notes: rfq.notes ?? '',
    lines: d.lines.map((l) => newRfqLine({ id: l.id, material_spec_id: l.material_spec_id, qty: String(l.qty), required_date: l.required_date ?? '', remarks: l.remarks ?? '', mr_line_id: l.mr_line_id })),
    suppliers: d.suppliers.map((s) => ({ supplier_id: s.supplier_id, sent_via: s.sent_via ?? '' })),
  });
  const text = [
    `REQUEST FOR QUOTATION ${rfq.number}`, `${auth.companyName} — ${auth.project?.name ?? ''}`, rfq.title,
    rfq.required_by ? `Required by: ${date(rfq.required_by)}` : '', rfq.delivery_store_id ? `Deliver to: ${L.store(rfq.delivery_store_id)}` : '', '',
    ...d.lines.map((l, i) => `${i + 1}. ${L.spec(l.material_spec_id)} — ${num(l.qty, 3)} ${L.specUom(l.material_spec_id)}${l.remarks ? ` (${l.remarks})` : ''}`),
    '', 'Please quote unit price (state if VAT incl.), transport, delivery days, validity and payment terms.', rfq.notes ?? '',
  ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
  const quotedBy = new Map(d.quotations.map((x) => [x.supplier_id, x]));
  const overflow = [
    { label: 'Copy RFQ text', icon: <Copy size={14} />, onClick: () => void copyText(text).then(() => toast.success('RFQ text copied')) },
    { label: 'Share on Telegram', onClick: () => window.open(telegramShare(text), '_blank', 'noopener') },
    { label: 'Print (A4)', icon: <Printer size={14} />, onClick: () => window.print() },
    ...(canEdit && ['draft', 'sent', 'closed'].includes(rfq.status) ? [{ label: 'Cancel RFQ…', danger: true, onClick: () => setDialog('cancel') }] : []),
    ...(rfq.status === 'awarded' && canProcure(role, 'po.create') && auth.canSeePrices ? [{ label: 'New PO from award…', icon: <ShoppingCart size={14} />, onClick: () => nav(`/procurement/po/new?rfq=${rfq.id}`) }] : []),
  ];

  return (
    <Page width="dash" title={rfq.number} titleExtra={<RfqBadge status={rfq.status} />}
      breadcrumbs={[{ label: 'Procurement', to: '/procurement#rfqs' }, { label: rfq.number }]}
      subtitle={<>{rfq.title} · created {dateTime(rfq.created_at)} by {L.person(rfq.created_by)}{rfq.required_by ? ` · required ${date(rfq.required_by)}` : ''}</>}
      actions={<>
        {rfq.status === 'draft' && canEdit && <button disabled={busy} onClick={edit}><Pencil size={14} aria-hidden />Edit</button>}
        {rfq.status === 'draft' && canEdit && <button className="primary" disabled={busy} onClick={() => void run(() => action('send'))}><Send size={14} aria-hidden />Send to suppliers</button>}
        {rfq.status === 'sent' && canEdit && <button disabled={busy} onClick={() => void run(() => action('close'))}>Close for quotes</button>}
        {canQuote && <button className="primary" onClick={() => setQuote('new')}><FilePlus2 size={14} aria-hidden />Record quotation</button>}
        <Popover align="right" trigger={(p) => <button {...p} aria-label="More actions">⋯</button>}>
          {(close) => <Menu items={overflow.map((o) => ({ ...o, onClick: () => { close(); o.onClick(); } }))} />}
        </Popover>
      </>}>
      <div className="print-doc">
        <PrintHeader title={`Request for quotation ${rfq.number}`} />
        <ErrorBanner error={error} />
        <div className="detail-layout">
          <div className="stack">
            <Card title="Lines" flush>
              <DataTable rows={d.lines} maxHeight="none" columns={[
                { key: 'line_no', label: '#', align: 'right', width: 36 },
                { key: 'spec', label: 'Material / grade', value: (l) => L.spec(l.material_spec_id) },
                { key: 'qty', label: 'Qty', align: 'right', render: (l) => <>{num(l.qty, 3)}<span className="unit">{L.specUom(l.material_spec_id)}</span></> },
                { key: 'required_date', label: 'Required', render: (l) => date(l.required_date) },
                { key: 'mr', label: 'Request line', value: (l) => (l.mr_line_id ? 'Linked' : ''), render: (l) => (l.mr_line_id ? <Badge tone="info" label="From request" icon={null} /> : null) },
                { key: 'remarks', label: 'Remarks' },
              ]} />
            </Card>
            {auth.canSeePrices
              ? <Suspense fallback={<Card title="Quotation comparison"><Loading lines={5} /></Card>}><Comparison d={d} L={L} canAward={canAward} /></Suspense>
              : <Card title="Quotation comparison"><Empty inline>Prices are restricted for your role.</Empty></Card>}
            <Card title="Quotations" flush>
              <DataTable rows={d.quotations} maxHeight="none" empty={rfq.status === 'draft' ? 'Send the RFQ before recording quotations.' : 'No quotations recorded yet.'}
                onRowClick={canProcure(role, 'quotation.record') && auth.canSeePrices ? (r) => setQuote(r) : undefined}
                columns={[
                  { key: 'number', label: 'Quotation', id: true },
                  { key: 'supplier', label: 'Supplier', value: (r) => L.suppliers.find((s) => s.id === r.supplier_id)?.name },
                  { key: 'quote_ref', label: 'Supplier ref.' },
                  { key: 'quote_date', label: 'Date', render: (r) => date(r.quote_date) },
                  { key: 'valid_until', label: 'Valid until', render: (r) => date(r.valid_until) },
                  { key: 'delivery_days', label: 'Delivery', align: 'right', render: (r) => (r.delivery_days === null ? '—' : `${r.delivery_days} d`) },
                  { key: 'prices_include_vat', label: 'VAT', value: (r) => (r.prices_include_vat ? 'Incl.' : 'Excl.') },
                  { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} tone={r.status === 'awarded' ? 'success' : r.status === 'not_awarded' ? 'neutral' : 'info'} /> },
                ]} />
            </Card>
          </div>
          <div className="side-panel">
            <Card title="Details">
              <dl className="kv">
                <dt>Deliver to</dt><dd>{L.store(rfq.delivery_store_id) || '—'}</dd>
                <dt>Min. quotes</dt><dd>{rfq.min_quotes}</dd>
                <dt>Sent</dt><dd>{dateTime(rfq.sent_at) || '—'}</dd>
                <dt>Closed</dt><dd>{dateTime(rfq.closed_at) || '—'}</dd>
                <dt>Awarded</dt><dd>{rfq.awarded_by ? `${L.person(rfq.awarded_by)} · ${dateTime(rfq.awarded_at)}` : '—'}</dd>
                {rfq.min_quotes_override_reason && <><dt>Override</dt><dd>{rfq.min_quotes_override_reason}</dd></>}
                {rfq.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{rfq.notes}</dd></>}
              </dl>
            </Card>
            {auth.canSeePrices && (
              <Card title="Documents" className="no-print" sub="Specifications, drawings and the signed comparison / award minutes">
                <Attachments entityType="rfq" entityId={rfq.id} canAdd={canProcure(role, 'rfq.create') || ['coordinator', 'manager', 'admin'].includes(role ?? '')}
                  kinds={['document', 'drawing', 'signed_certificate', 'proforma']} emptyText="No documents yet." />
              </Card>
            )}
            <Card title={`Invited suppliers (${d.suppliers.length})`}>
              {!d.suppliers.length ? <Empty inline>No suppliers invited yet.</Empty> : (
                <ul className="timeline">
                  {d.suppliers.map((s) => {
                    const sup = L.suppliers.find((x) => x.id === s.supplier_id);
                    const qt = quotedBy.get(s.supplier_id);
                    return (
                      <li key={s.id}>
                        <div><strong>{sup?.name ?? '?'}</strong> {qt ? <Badge tone="success" label="Quoted" icon={null} /> : <Badge tone="neutral" label="Awaiting" icon={null} />}</div>
                        <div className="t-meta">{[s.sent_via && humanize(s.sent_via), s.sent_at && `sent ${dateTime(s.sent_at)}`, sup?.phone].filter(Boolean).join(' · ') || 'Not sent yet'}</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
            {d.awards.length > 0 && (
              <Card title="Award">
                <ul className="timeline">
                  {d.awards.map((a) => (
                    <li key={a.id}>
                      <div><strong>Line {d.lines.find((l) => l.id === a.rfq_line_id)?.line_no}</strong> → {L.suppliers.find((s) => s.id === a.supplier_id)?.name} · {num(a.qty, 3)}
                        {!a.is_lowest && <> <Badge tone="warning" label="Not lowest" icon={null} /></>}</div>
                      <div className="t-meta">{L.person(a.awarded_by)} · {dateTime(a.awarded_at)}</div>
                      {a.reason && <div className="t-comment">{a.reason}</div>}
                    </li>
                  ))}
                </ul>
                {canProcure(role, 'po.create') && auth.canSeePrices && <Link to="/procurement?p.status=draft#pos" className="small-text">Draft purchase orders →</Link>}
              </Card>
            )}
          </div>
        </div>
        <Signatures />
      </div>

      {editing && <RfqEditor initial={editing} L={L} projectId={projectId} onClose={() => { setEditing(null); q.reload(); }} />}
      {quote && <QuotationDrawer d={d} L={L} quotation={quote === 'new' ? undefined : quote} onClose={() => { setQuote(null); q.reload(); }} />}
      {dialog === 'cancel' && <ReasonModal title={`Cancel ${rfq.number}`} danger confirm="Cancel RFQ" onClose={() => setDialog(null)} onSubmit={(c) => action('cancel', c)} />}
    </Page>
  );
}
