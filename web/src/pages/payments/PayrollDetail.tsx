// /payments/payroll/:id — one daily-labour payroll: attendance grid (day-rate), piece-rate work (berga = 12 m rebar
// bar, m², m³, pcs …) verified on site, pay lines (gross, 15 % / 30 % tax, deductions, net), approval chain, print
// with signature column.
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Plus, Printer, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import { LABOUR_TAX_RATES, PIECE_UNITS, canPay, type LabourWorker } from '../../lib/contract-payments';
import { Banner, Card, ErrorBanner, Field, Loading, Page, PrintHeader, toast, useBusy } from '../../components/ui';
import { loadBoqItems, loadSchedules, loadTasks, type BoqItemRow, type SchedTask } from '../../components/schedule/data';
import { PaymentActions, PaymentHistory, PaymentStatusBadge } from '../../components/payments/PaymentActions';
import { etb, loadBergaFactors, loadPayroll, loadWorkers, payRpc, periodDays, type PayrollDetail as Detail } from '../../components/payments/data';
import '../../components/payments/payments.css';
import { Attachments } from '../../components/Attachments';

const WD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function PayrollDetail() {
  const { id = '' } = useParams();
  const projectId = useProjectId();
  const q = useAsync(() => loadPayroll(id), [id], { key: 'payroll' });
  const w = useAsync(() => loadWorkers(projectId), [projectId], { key: 'labour-workers' });
  const lk = useLookups(projectId);
  const refs = useAsync(async () => {
    const s = await loadSchedules(projectId);
    const [tasks, boq, berga] = await Promise.all([s.schedules[0] ? loadTasks(s.schedules[0].id) : Promise.resolve([]), loadBoqItems(projectId), loadBergaFactors()]);
    return { tasks: tasks.filter((t) => !t.is_summary), boq, berga };
  }, [projectId], { key: 'payroll-refs', staleTime: 5 * 60_000 });
  if (!q.data || !w.data || !lk.data || !refs.data) {
    return <Page title="Payroll">{q.error || w.error || refs.error ? <ErrorBanner error={q.error ?? w.error ?? refs.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  return <PayrollBody key={`${q.data.pr.id}:${q.data.pr.status}:${q.data.pr.gross}:${q.data.piece.map((p) => `${p.id}=${p.qty_verified}`).join()}`} d={q.data} workers={w.data} L={lk.data}
    tasks={refs.data.tasks} boq={refs.data.boq} berga={refs.data.berga} reload={q.reload} />;
}

interface PieceDraft {
  id: string; worker_id: string; work_date: string; description: string; unit: string; qty_claimed: string; rate: string; task_id: string | null;
  element_id: string | null; boq_item_id: string | null; material_spec_id: string | null; remark: string; qty_verified: number | null; ver: string; saved: boolean;
}

function PayrollBody({ d, workers, L, tasks, boq, berga, reload }: {
  d: Detail; workers: LabourWorker[]; L: Lookups; tasks: SchedTask[]; boq: BoqItemRow[]; berga: Map<string, number>; reload: () => void;
}) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const pr = d.pr;
  const open = pr.status === 'draft' || pr.status === 'returned';
  const editable = open && canPay(role, 'payment.prepare');
  const canVerify = open && canPay(role, 'piece.verify');
  const seesPay = canPay(role, 'payment.view');
  const [h, setH] = useState({ period_from: pr.period_from, period_to: pr.period_to, frequency: pr.frequency, tax_pct: String(pr.tax_pct), ot_multiplier: String(pr.ot_multiplier), remarks: pr.remarks ?? '' });
  const days = periodDays(h.period_from, h.period_to);
  const init = () => {
    const m: Record<string, number> = {};
    for (const a of d.attendance) m[`${a.worker_id}|${a.work_date}`] = Number(a.day_value);
    return m;
  };
  const [att, setAtt] = useState<Record<string, number>>(init);
  const [ot, setOt] = useState<Record<string, string>>(() => {
    const m: Record<string, number> = {};
    for (const a of d.attendance) m[a.worker_id] = (m[a.worker_id] ?? 0) + Number(a.ot_hours);
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v > 0).map(([k, v]) => [k, String(v)]));
  });
  const [wTask, setWTask] = useState<Record<string, string>>(() => Object.fromEntries(d.attendance.filter((a) => a.task_id).map((a) => [a.worker_id, a.task_id!])));
  const [ded, setDed] = useState<Record<string, { d: string; n: string }>>(() => Object.fromEntries(d.lines.map((l) => [l.worker_id, { d: Number(l.other_deduction) ? String(Number(l.other_deduction)) : '', n: l.deduction_note ?? '' }])));
  const [pieces, setPieces] = useState<PieceDraft[]>(() => d.piece.map((p) => ({
    id: p.id, worker_id: p.worker_id, work_date: p.work_date, description: p.description, unit: p.unit, qty_claimed: String(Number(p.qty_claimed)), rate: String(Number(p.rate)),
    task_id: p.task_id, element_id: p.element_id, boq_item_id: p.boq_item_id, material_spec_id: p.material_spec_id, remark: p.remark ?? '',
    qty_verified: p.qty_verified == null ? null : Number(p.qty_verified), ver: p.qty_verified == null ? '' : String(Number(p.qty_verified)), saved: true,
  })));
  const inPayroll = new Set([...d.attendance.map((a) => a.worker_id), ...d.piece.map((p) => p.worker_id), ...d.lines.map((l) => l.worker_id)]);
  const rows = workers.filter((x) => x.is_active || inPayroll.has(x.id));
  const dayRateRows = rows.filter((x) => Number(x.daily_rate) > 0 || d.attendance.some((a) => a.worker_id === x.id));
  const taskLabel = (t: SchedTask) => `${t.wbs ? `${t.wbs} ` : ''}${t.name}`;
  const rebarSpecs = useMemo(() => L.specs.filter((s) => berga.has(s.id)), [L.specs, berga]);
  const setP = (i: number, patch: Partial<PieceDraft>) => setPieces(pieces.map((p, j) => (j === i ? { ...p, ...patch, ...(('qty_claimed' in patch || 'rate' in patch) ? { saved: false } : {}) } : p)));
  const cycle = (k: string) => setAtt((prev) => { const v = prev[k] ?? 0; return { ...prev, [k]: v === 0 ? 1 : v === 1 ? 0.5 : 0 }; });
  const { busy, error, run } = useBusy();

  const save = () => void run(async () => {
    const attendance: { worker_id: string; work_date: string; day_value: number; ot_hours?: number; task_id?: string | null }[] = [];
    for (const wk of dayRateRows) {
      const worked = days.filter((dd) => (att[`${wk.id}|${dd}`] ?? 0) > 0);
      const otH = Number(ot[wk.id] || 0);
      for (const dd of days) {
        const v = att[`${wk.id}|${dd}`] ?? 0;
        const isOtDay = otH > 0 && (worked.length ? dd === worked[worked.length - 1] : dd === days[0]);
        if (v > 0 || isOtDay) attendance.push({ worker_id: wk.id, work_date: dd, day_value: v, ot_hours: isOtDay ? otH : 0, task_id: wTask[wk.id] || null });
      }
    }
    await payRpc('save_payroll', {
      id: pr.id, project_id: pr.project_id, period_from: h.period_from, period_to: h.period_to, frequency: h.frequency, tax_pct: Number(h.tax_pct),
      ot_multiplier: Number(h.ot_multiplier), remarks: h.remarks || undefined, attendance,
      piecework: pieces.map((p) => ({ id: p.id, worker_id: p.worker_id, work_date: p.work_date, description: p.description, unit: p.unit,
        qty_claimed: Number(p.qty_claimed || 0), rate: Number(p.rate || 0), task_id: p.task_id, element_id: p.element_id, boq_item_id: p.boq_item_id,
        material_spec_id: p.unit.toLowerCase() === 'berga' ? p.material_spec_id : null, remark: p.remark || undefined })),
      deductions: Object.entries(ded).map(([worker_id, x]) => ({ worker_id, other_deduction: Number(x.d || 0), deduction_note: x.n || undefined })),
    });
    toast.success(`${pr.number} saved`);
    reload();
  });
  const verify = () => void run(async () => {
    const lines = pieces.filter((p) => p.saved && p.ver !== '').map((p) => ({ id: p.id, qty_verified: Number(p.ver), remark: p.remark || undefined }));
    if (!lines.length) throw new Error('Enter the verified quantity of at least one saved line');
    await payRpc('verify_piecework', { payroll_id: pr.id, lines });
    toast.success(`${lines.length} piece-work line(s) verified`);
    reload();
  });
  const unverified = d.piece.filter((p) => p.qty_verified == null).length;
  const totals = d.lines.reduce((s, l) => ({ gross: s.gross + Number(l.gross), tax: s.tax + Number(l.tax), ded: s.ded + Number(l.other_deduction), net: s.net + Number(l.net) }), { gross: 0, tax: 0, ded: 0, net: 0 });
  const wName = (id: string) => workers.find((x) => x.id === id)?.full_name ?? '?';

  return (
    <Page title={pr.number} titleExtra={<PaymentStatusBadge status={pr.status} />}
      breadcrumbs={[{ label: 'Labour payroll', to: '/payments/payroll' }, { label: pr.number }]}
      subtitle={`${date(pr.period_from)} → ${date(pr.period_to)} · ${pr.frequency} · tax ${num(pr.tax_pct, 0)} %${seesPay ? ` · ${pr.workers} workers · net ${etb(pr.net)} ETB` : ''}`}
      actions={<button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>}>
      <div className="print-doc stack">
        <PrintHeader title={`Daily labour payroll ${pr.number} — ${date(pr.period_from)} to ${date(pr.period_to)}`} />
        <ErrorBanner error={error} />
        {pr.return_comment && <Banner tone={pr.status === 'rejected' ? 'error' : 'warn'}>{pr.status === 'rejected' ? 'Rejected' : 'Returned for correction'}: “{pr.return_comment}”</Banner>}
        {editable && (
          <Card title="Payroll" className="no-print">
            <div className="form-grid">
              <Field label="From"><input type="date" value={h.period_from} onChange={(e) => setH({ ...h, period_from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={h.period_to} onChange={(e) => setH({ ...h, period_to: e.target.value })} /></Field>
              <Field label="Tax rate"><select value={h.tax_pct} onChange={(e) => setH({ ...h, tax_pct: e.target.value })}>
                {LABOUR_TAX_RATES.map((r) => <option key={r} value={r}>{r} %</option>)}<option value="0">0 % (exempt)</option></select></Field>
              <Field label="Overtime multiplier" hint="× daily rate / 8 per hour"><input type="number" min={1} max={3} step="0.25" value={h.ot_multiplier} onChange={(e) => setH({ ...h, ot_multiplier: e.target.value })} /></Field>
              <Field label="Remarks" wide><input value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} /></Field>
            </div>
          </Card>
        )}

        {seesPay && (
          <Card title="Attendance (day-rate)" sub={editable ? 'Click a day: 1 = full day, ½ = half day, blank = absent. Overtime hours are for the whole period.' : undefined} flush>
            {!dayRateRows.length ? <div className="pad muted">No day-rate workers. Add workers on the Workers tab.</div> : (
              <div className="table-wrap pay-table att-grid"><div className="table-scroll">
                <table>
                  <thead><tr><th className="wk-name">Worker</th>
                    {days.map((dd) => { const wd = (new Date(`${dd}T00:00:00Z`).getUTCDay() + 6) % 7; return <th key={dd}><div className={`day-h${wd === 6 ? ' off' : ''}`}>{WD[wd]}<br />{dd.slice(8)}</div></th>; })}
                    <th>Days</th><th>OT h</th><th>Activity</th></tr></thead>
                  <tbody>
                    {dayRateRows.map((wk) => {
                      const n = days.reduce((s, dd) => s + (att[`${wk.id}|${dd}`] ?? 0), 0);
                      return (
                        <tr key={wk.id}>
                          <td className="wk-name">{wk.full_name}<div className="small-text muted">{wk.trade_name ?? ''} · {etb(wk.daily_rate)}/day</div></td>
                          {days.map((dd) => {
                            const k = `${wk.id}|${dd}`; const v = att[k] ?? 0;
                            return <td key={dd}><button type="button" className={`att-cell${v === 1 ? ' v1' : v === 0.5 ? ' v05' : ''}`} aria-disabled={!editable}
                              aria-label={`${wk.full_name} ${dd}: ${v === 1 ? 'full day' : v === 0.5 ? 'half day' : 'absent'}`} onClick={() => editable && cycle(k)}>{v === 1 ? '1' : v === 0.5 ? '½' : ''}</button></td>;
                          })}
                          <td className="right"><b>{num(n, 1)}</b></td>
                          <td><input type="number" min={0} max={60} step="0.5" style={{ width: 60 }} disabled={!editable} value={ot[wk.id] ?? ''} onChange={(e) => setOt({ ...ot, [wk.id]: e.target.value })} /></td>
                          <td><select disabled={!editable} value={wTask[wk.id] ?? ''} onChange={(e) => setWTask({ ...wTask, [wk.id]: e.target.value })} style={{ maxWidth: 220 }}>
                            <option value="">— spread by daily output —</option>{tasks.map((t) => <option key={t.id} value={t.id}>{taskLabel(t)}</option>)}</select></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div></div>
            )}
          </Card>
        )}

        <Card title="Piece-rate work" sub="Paid by the unit of output — berga (one 12 m bar), m², m³, pcs … The site or office engineer verifies each quantity before the payroll is submitted." flush>
          <div className="table-wrap pay-table"><div className="table-scroll">
            <table>
              <thead><tr><th>Worker / crew</th><th>Date</th><th>Work</th><th>Unit</th><th>Bar Ø</th><th className="right">Claimed</th><th className="right">Rate</th>
                <th>Activity / BoQ</th><th className="right">Verified</th><th className="right">kg</th><th className="right">Amount</th><th>Remark</th><th /></tr></thead>
              <tbody>
                {!pieces.length && <tr><td colSpan={13} className="muted">No piece-rate work on this payroll.</td></tr>}
                {pieces.map((p, i) => {
                  const isBerga = p.unit.toLowerCase() === 'berga';
                  const f = p.material_spec_id ? berga.get(p.material_spec_id) : undefined;
                  const vq = p.qty_verified;
                  return (
                    <tr key={p.id}>
                      <td><select disabled={!editable} value={p.worker_id} onChange={(e) => setP(i, { worker_id: e.target.value })} style={{ maxWidth: 180 }}>
                        <option value="">Choose…</option>{rows.map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></td>
                      <td><input type="date" disabled={!editable} value={p.work_date} min={h.period_from} max={h.period_to} onChange={(e) => setP(i, { work_date: e.target.value })} /></td>
                      <td><input disabled={!editable} value={p.description} placeholder="e.g. Cut & bend Ø16 for raft" onChange={(e) => setP(i, { description: e.target.value })} style={{ minWidth: 180 }} /></td>
                      <td><input list="piece-units" disabled={!editable} value={p.unit} onChange={(e) => setP(i, { unit: e.target.value })} style={{ width: 70 }} /></td>
                      <td>{isBerga ? <select disabled={!editable} value={p.material_spec_id ?? ''} onChange={(e) => setP(i, { material_spec_id: e.target.value || null })}>
                        <option value="">Ø…</option>{rebarSpecs.map((s) => <option key={s.id} value={s.id}>{s.grade} ({num(berga.get(s.id), 2)} kg)</option>)}</select> : <span className="muted">—</span>}</td>
                      <td className="right"><input type="number" min={0} step="any" disabled={!editable} value={p.qty_claimed} onChange={(e) => setP(i, { qty_claimed: e.target.value })} style={{ width: 80 }} /></td>
                      <td className="right"><input type="number" min={0} step="any" disabled={!editable} value={p.rate} onChange={(e) => setP(i, { rate: e.target.value })} style={{ width: 80 }} /></td>
                      <td><select disabled={!editable} value={p.task_id ? `t:${p.task_id}` : p.boq_item_id ? `b:${p.boq_item_id}` : ''} style={{ maxWidth: 200 }}
                        onChange={(e) => { const v = e.target.value; setP(i, { task_id: v.startsWith('t:') ? v.slice(2) : null, boq_item_id: v.startsWith('b:') ? v.slice(2) : null }); }}>
                        <option value="">—</option>
                        <optgroup label="Schedule activity">{tasks.map((t) => <option key={t.id} value={`t:${t.id}`}>{taskLabel(t)}</option>)}</optgroup>
                        <optgroup label="BoQ item">{boq.map((b) => <option key={b.id} value={`b:${b.id}`}>{b.item_no} {b.description.slice(0, 50)}</option>)}</optgroup>
                      </select></td>
                      <td className="right">{canVerify && p.saved
                        ? <input type="number" min={0} step="any" value={p.ver} placeholder={vq == null ? 'verify' : ''} onChange={(e) => setPieces(pieces.map((x, j) => (j === i ? { ...x, ver: e.target.value } : x)))} style={{ width: 80 }} />
                        : vq == null ? <span className="warn-text small-text">not verified</span> : num(vq, 2)}</td>
                      <td className="right">{isBerga && f ? num((vq ?? Number(p.qty_claimed || 0)) * f, 1) : ''}</td>
                      <td className="right">{etb((vq ?? 0) * Number(p.rate || 0))}</td>
                      <td><input disabled={!editable && !canVerify} value={p.remark} onChange={(e) => setPieces(pieces.map((x, j) => (j === i ? { ...x, remark: e.target.value } : x)))} style={{ width: 130 }} /></td>
                      <td>{editable && <button className="icon-btn" aria-label="Remove line" onClick={() => setPieces(pieces.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div></div>
          <datalist id="piece-units">{PIECE_UNITS.map((u) => <option key={u} value={u} />)}</datalist>
          {(editable || canVerify) && (
            <div className="row pad no-print" style={{ flexWrap: 'wrap' }}>
              {editable && <button onClick={() => setPieces([...pieces, { id: crypto.randomUUID(), worker_id: '', work_date: h.period_to, description: '', unit: 'berga', qty_claimed: '', rate: '', task_id: null, element_id: null, boq_item_id: null, material_spec_id: null, remark: '', qty_verified: null, ver: '', saved: false }])}>
                <Plus size={14} aria-hidden />Add piece-work</button>}
              {canVerify && d.piece.length > 0 && <button disabled={busy} onClick={verify}><ShieldCheck size={14} aria-hidden />Save verified quantities</button>}
              {canVerify && pieces.some((p) => !p.saved) && <span className="small-text muted">New or changed lines are verified after the payroll is saved.</span>}
            </div>
          )}
        </Card>

        {editable && (
          <div className="row no-print">
            <button className="primary" disabled={busy} onClick={save}>{busy ? <span className="spinner" /> : <Save size={14} aria-hidden />}Save payroll & recalculate</button>
          </div>
        )}

        {seesPay && (
          <Card title="Pay sheet" sub={`Gross ${etb(totals.gross)} · tax ${etb(totals.tax)} · deductions ${etb(totals.ded)} · net ${etb(totals.net)} ETB`} flush>
            <div className="table-wrap pay-table"><div className="table-scroll">
              <table>
                <thead><tr><th>Worker</th><th className="right">Days</th><th className="right">OT h</th><th className="right">Rate</th><th className="right">Piece-work</th>
                  <th className="right">Gross</th><th className="right">Tax</th><th className="right">Deduction</th><th>Reason</th><th className="right">Net pay</th><th className="pay-sign">Signature</th></tr></thead>
                <tbody>
                  {!d.lines.length && <tr><td colSpan={11} className="muted">Save the attendance / piece-work to compute the pay sheet.</td></tr>}
                  {d.lines.map((l) => (
                    <tr key={l.id}>
                      <td>{wName(l.worker_id)}</td><td className="right">{num(l.days, 1)}</td><td className="right">{num(l.ot_hours, 1)}</td>
                      <td className="right">{etb(l.daily_rate)}</td><td className="right">{etb(l.piece_amount)}</td><td className="right">{etb(l.gross)}</td>
                      <td className="right">{num(l.tax_pct, 0)} % · {etb(l.tax)}</td>
                      <td className="right">{editable ? <input type="number" min={0} style={{ width: 80 }} value={ded[l.worker_id]?.d ?? ''} onChange={(e) => setDed({ ...ded, [l.worker_id]: { d: e.target.value, n: ded[l.worker_id]?.n ?? '' } })} /> : etb(l.other_deduction)}</td>
                      <td>{editable ? <input style={{ width: 120 }} value={ded[l.worker_id]?.n ?? ''} onChange={(e) => setDed({ ...ded, [l.worker_id]: { d: ded[l.worker_id]?.d ?? '', n: e.target.value } })} /> : l.deduction_note ?? ''}</td>
                      <td className="right"><b>{etb(l.net)}</b></td><td className="pay-sign" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          </Card>
        )}

        {seesPay && (
          <Card>
            {pr.status === 'paid' && <p className="mb-2">Paid {date(pr.payment_date)} by {pr.payment_method?.replace('_', ' ')}{pr.payment_ref ? ` · ref ${pr.payment_ref}` : ''} · {L.person(pr.paid_by)}</p>}
            <PaymentActions docType="payroll" id={pr.id} number={pr.number} status={pr.status} preparedBy={pr.prepared_by} checkedBy={pr.checked_by} net={Number(pr.net)}
              blocked={unverified ? `${unverified} piece-work line(s) not verified yet` : null} onDone={reload} />
          </Card>
        )}
        {seesPay && (
          <div className="signatures" aria-hidden>
            <div>Prepared by<br />{L.person(pr.prepared_by)}</div><div>Checked by<br />{L.person(pr.checked_by)}</div><div>Approved by<br />{L.person(pr.approved_by)}</div>
          </div>
        )}
        <Card className="no-print" title="Attendance sheets & documents" sub="Scan or photo of the signed daily attendance sheet and the signed pay sheet (workers' signatures / thumbprints).">
          <Attachments entityType="payroll" entityId={pr.id} canAdd={editable || canVerify || seesPay}
            kinds={['attendance_sheet', 'signed_certificate', 'photo', 'document']} emptyText="No sheets attached yet." />
        </Card>
        {seesPay && <Card title="History"><PaymentHistory events={d.events} L={L} /></Card>}
      </div>
    </Page>
  );
}
