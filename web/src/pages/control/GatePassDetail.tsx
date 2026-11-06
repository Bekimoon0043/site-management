import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, Printer, Undo2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { canControl, type GateEvent, type GatePass, type GatePassLine } from '../../lib/contract-control';
import { optStr, rpcx, uuid } from '../../lib/fieldx';
import { date, dateTime, dueIn, humanize, num, since } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import { Attachments } from '../../components/Attachments';
import { QrCode } from '../../components/control/QrCode';
import { SBadge } from '../../components/field/StatusBadge';
import {
  Banner, Card, DataTable, Drawer, Empty, ErrorBanner, Field, Loading, Menu, Modal, Page, Popover, PrintHeader, QtyInput, ReasonModal, Signatures, toast, useBusy,
} from '../../components/ui';
import { GP_STATUS_LABEL, GatePassForm, gpRemaining } from './Gate';

async function load(id: string) {
  const [gp, lines, events] = await Promise.all([
    supabase.from('gate_passes').select('*').eq('id', id).single().then(check) as Promise<GatePass>,
    supabase.from('gate_pass_lines').select('*').eq('gate_pass_id', id).is('deleted_at', null).order('line_no').then(check) as Promise<GatePassLine[]>,
    supabase.from('gate_events').select('*').eq('gate_pass_id', id).order('at', { ascending: false }).then(check) as Promise<GateEvent[]>,
  ]);
  return { gp, lines, events };
}

/** Gate pass: items, approval, gate checks, returns of returnables, printable pass with signed QR. */
export function GatePassDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const fromInbox = params.get('from') === 'approvals';
  const nav = useNavigate();
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => load(id), [id], { key: 'gate-pass-detail' });
  const [dialog, setDialog] = useState<'reject' | 'cancel' | 'return' | 'verify' | 'edit' | null>(null);
  const { busy, error, run } = useBusy();
  useEffect(() => { if (q.data) pushRecent({ label: q.data.gp.number, hint: 'Gate pass', to: `/gate/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="Gate pass" breadcrumbs={[{ label: 'Gate & vehicles', to: '/gate' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const { gp, lines, events } = q.data;
  const L = lk.data;
  const role = auth.profile?.role;
  const isOwner = gp.requested_by === auth.profile?.id;
  const mgmt = canControl(role, 'gatepass.approve');
  const done = (msg: string) => { toast.success(msg); if (fromInbox) nav('/approvals?type=gate_pass'); };
  const can = {
    approve: mgmt && gp.status === 'pending',
    edit: (isOwner || mgmt) && ['draft', 'pending', 'rejected'].includes(gp.status),
    cancel: (isOwner || mgmt) && ['draft', 'pending', 'approved', 'rejected'].includes(gp.status),
    verify: canControl(role, 'gatepass.verify') && gp.status === 'approved',
    ret: canControl(role, 'gatepass.return') && gp.pass_type === 'returnable' && ['exited', 'partially_returned'].includes(gp.status),
  };
  const approve = () => run(async () => { await rpcx('gate_pass_action', { gate_pass_id: gp.id, action: 'approve' }); done(`${gp.number} approved`); });
  const due = ['exited', 'partially_returned'].includes(gp.status) ? dueIn(gp.expected_return) : null;
  const overflow = [
    can.edit ? { label: gp.status === 'draft' ? 'Edit / submit…' : 'Edit…', onClick: () => setDialog('edit') } : null,
    can.cancel ? { label: 'Cancel gate pass…', danger: true, onClick: () => setDialog('cancel') } : null,
    { label: 'Print pass (A4)', icon: <Printer size={14} />, onClick: () => window.print() },
  ].filter((x): x is NonNullable<typeof x> => !!x);

  return (
    <Page width="form" title={gp.number} titleExtra={<SBadge gate value={gp.status} label={GP_STATUS_LABEL[gp.status]} />}
      breadcrumbs={[{ label: 'Gate & vehicles', to: '/gate' }, { label: gp.number }]}
      subtitle={<>{gp.pass_type === 'returnable' ? 'Returnable' : 'Non-returnable'} · to {gp.destination} · requested by {L.person(gp.requested_by)} {gp.submitted_at ? `· ${dateTime(gp.submitted_at)}` : ''}</>}
      actions={<>
        {can.approve && <button disabled={busy} onClick={() => setDialog('reject')}>Reject…</button>}
        {can.ret && <button className={can.verify ? '' : 'primary'} onClick={() => setDialog('return')}><Undo2 size={14} aria-hidden />Record return…</button>}
        {can.verify && <button className={can.approve ? '' : 'primary'} onClick={() => setDialog('verify')}>Check out at gate…</button>}
        {can.approve && <button className="primary" disabled={busy} onClick={() => void approve()}>{busy && <span className="spinner" />}<Check size={14} aria-hidden />Approve</button>}
        <Popover align="right" trigger={(p) => <button {...p} aria-label="More actions">⋯</button>}>
          {(close) => <Menu items={overflow.map((o) => ({ ...o, onClick: () => { close(); o.onClick(); } }))} />}
        </Popover>
      </>}>
      <div className="print-doc">
        <PrintHeader title={`Material gate pass ${gp.number}`} />
        <ErrorBanner error={error} />
        {gp.decision_comment && <Banner tone={gp.status === 'rejected' ? 'error' : 'info'}>{gp.status === 'rejected' ? 'Rejected' : 'Approval comment'}: “{gp.decision_comment}”</Banner>}
        {due?.late && <Banner tone="error">Return overdue — expected {date(gp.expected_return)} ({due.text}).</Banner>}
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Items" flush>
              <DataTable rows={lines} maxHeight="none" columns={[
                { key: 'line_no', label: '#', align: 'right', width: 36 },
                { key: 'item', label: 'Item', value: (r) => [r.material_spec_id ? L.spec(r.material_spec_id) : null, r.description].filter(Boolean).join(' — ') },
                { key: 'qty', label: 'Qty', align: 'right', render: (r) => <>{num(r.qty, 3)}<span className="unit">{r.uom}</span></> },
                ...(gp.pass_type === 'returnable' ? [
                  { key: 'qty_returned', label: 'Returned', align: 'right' as const, render: (r: GatePassLine) => num(r.qty_returned, 3) },
                  { key: 'out', label: 'Still out', align: 'right' as const, value: gpRemaining, render: (r: GatePassLine) => <span className={gpRemaining(r) > 0 && ['exited', 'partially_returned'].includes(gp.status) ? 'warn-text strong' : ''}>{num(gpRemaining(r), 3)}</span> },
                ] : []),
                { key: 'stock', label: 'Stock item', value: (r) => (r.material_spec_id ? 'Yes' : 'No') },
              ]} />
            </Card>
            <Card title="Gate events">
              {!events.length ? <Empty inline>No checks at the gate yet.</Empty> : (
                <ul className="timeline">
                  {events.map((e) => (
                    <li key={e.id}>
                      <div><SBadge value={e.event} />{e.plate_seen && <> · plate {e.plate_seen}</>}</div>
                      <div className="t-meta">{L.person(e.actor) || 'guard'} · <span title={dateTime(e.at)}>{dateTime(e.at)} ({since(e.at)})</span></div>
                      {e.note && <div className="t-comment">{e.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Photos"><Attachments entityType="gate_pass" entityId={gp.id} canAdd={canControl(role, 'gatepass.create') || canControl(role, 'gatepass.verify')} kinds={['photo', 'document', 'signature']} /></Card>
          </div>
          <div className="side-panel">
            <Card title="Pass QR" sub={gp.qr_code ? 'Guard scans this at the gate (signed, verifiable offline)' : undefined}>
              {gp.qr_code ? <div style={{ textAlign: "center" }}><QrCode code={gp.qr_code} size={160} label={`QR for ${gp.number}`} /></div>
                : <span className="muted small-text">The signed QR is issued on approval.</span>}
            </Card>
            <Card title="Details">
              <dl className="kv">
                <dt>Store</dt><dd>{L.store(gp.store_id) || '—'}</dd>
                <dt>Purpose</dt><dd>{gp.purpose}</dd>
                <dt>Vehicle</dt><dd>{gp.vehicle_plate ?? '—'}</dd>
                <dt>Driver</dt><dd>{[gp.driver_name, gp.driver_phone].filter(Boolean).join(' · ') || '—'}</dd>
                {gp.pass_type === 'returnable' && <><dt>Return due</dt><dd>{date(gp.expected_return)}{due?.text && <span className={due.late ? 'danger-text' : 'muted'}> · {due.text}</span>}</dd></>}
                <dt>Approved</dt><dd>{gp.approved_by ? `${L.person(gp.approved_by)} · ${dateTime(gp.approved_at)}` : '—'}</dd>
                <dt>Left site</dt><dd>{dateTime(gp.exited_at) || '—'}</dd>
                <dt>Returned</dt><dd>{dateTime(gp.returned_at) || '—'}</dd>
                {gp.linked_doc_type && <><dt>Linked</dt><dd>{humanize(gp.linked_doc_type)}</dd></>}
              </dl>
            </Card>
          </div>
        </div>
        <Signatures />
      </div>
      {dialog === 'reject' && <ReasonModal title={`Reject ${gp.number}`} danger confirm="Reject gate pass" onClose={() => setDialog(null)}
        onSubmit={async (c) => { await rpcx('gate_pass_action', { gate_pass_id: gp.id, action: 'reject', comment: c }); done(`${gp.number} rejected`); }} />}
      {dialog === 'cancel' && <ReasonModal title={`Cancel ${gp.number}`} required={false} label="Reason (optional)" danger confirm="Cancel gate pass" onClose={() => setDialog(null)}
        onSubmit={async (c) => { await rpcx('gate_pass_action', { gate_pass_id: gp.id, action: 'cancel', comment: c || undefined }); toast.success(`${gp.number} cancelled`); }} />}
      {dialog === 'return' && <ReturnDrawer gp={gp} lines={lines} onClose={() => setDialog(null)} />}
      {dialog === 'verify' && <VerifyModal gp={gp} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <GatePassForm pass={gp} lines={lines} onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />}
      <Link to="/gate" className="sr-only">Back to gate passes</Link>
    </Page>
  );
}

function ReturnDrawer({ gp, lines, onClose }: { gp: GatePass; lines: GatePassLine[]; onClose: () => void }) {
  const lk = useLookups(gp.project_id);
  const out = lines.filter((l) => gpRemaining(l) > 0);
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(out.map((l) => [l.id, String(gpRemaining(l))])));
  const [plate, setPlate] = useState(gp.vehicle_plate ?? '');
  const [note, setNote] = useState('');
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    const sel = out.filter((l) => Number(qty[l.id]) > 0).map((l) => ({ gate_pass_line_id: l.id, qty_returned: Number(qty[l.id]) }));
    if (!sel.length) throw new Error('Enter the returned quantities.');
    const bad = out.find((l) => Number(qty[l.id]) > gpRemaining(l) + 0.0005);
    if (bad) throw new Error(`Line ${bad.line_no}: only ${num(gpRemaining(bad), 3)} is out.`);
    const r = await rpcx('return_gate_pass', { id: uuid(), gate_pass_id: gp.id, plate_seen: optStr(plate), note: optStr(note), lines: sel });
    toast.success(`${gp.number}: ${r.status === 'returned' ? 'fully returned' : 'partial return recorded'}`);
    onClose();
  });
  return (
    <Drawer title={`Record return — ${gp.number}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Record return</button>
    </>}>
      <ErrorBanner error={error} />
      <DataTable rows={out} maxHeight="none" columns={[
        { key: 'item', label: 'Item', value: (r) => [r.material_spec_id ? lk.data?.spec(r.material_spec_id) : null, r.description].filter(Boolean).join(' — ') },
        { key: 'out', label: 'Out', align: 'right', render: (r) => num(gpRemaining(r), 3) },
        { key: 'ret', label: 'Returned now', align: 'right', render: (r) => <QtyInput value={qty[r.id] ?? ''} onChange={(v) => setQty({ ...qty, [r.id]: v })} unit={r.uom ?? undefined} min={0} max={gpRemaining(r)} aria-label={`Returned qty line ${r.line_no}`} /> },
      ]} />
      <div className="form-grid mt-2">
        <Field label="Vehicle plate"><input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></Field>
        <Field label="Note" wide><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition, missing items…" /></Field>
      </div>
    </Drawer>
  );
}

function VerifyModal({ gp, onClose }: { gp: GatePass; onClose: () => void }) {
  const [plate, setPlate] = useState(gp.vehicle_plate ?? '');
  const [matches, setMatches] = useState(true);
  const [note, setNote] = useState('');
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    if (!matches && !note.trim()) throw new Error('Describe the mismatch.');
    const r = await rpcx('verify_gate_pass', { id: uuid(), gate_pass_id: gp.id, plate_seen: optStr(plate), matches, note: optStr(note) });
    if (r.matched) toast.success(`${gp.number} left site`); else toast.error(`${gp.number}: mismatch recorded — critical alert raised`);
    onClose();
  });
  return (
    <Modal title={`Check out ${gp.number}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className={matches ? 'primary' : 'danger'} disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}{matches ? 'Load matches — let out' : 'Record mismatch'}</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid one">
        <Field label="Plate seen" hint={gp.vehicle_plate ? `Pass says ${gp.vehicle_plate}; a different plate is recorded as a mismatch.` : undefined}><input data-autofocus value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></Field>
        <Field label="Load matches the pass" check><input type="checkbox" checked={matches} onChange={(e) => setMatches(e.target.checked)} /></Field>
        <Field label={matches ? 'Note' : 'What does not match?'} required={!matches}><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
