import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FlaskConical, Printer } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { canField, type CubeSet, type Pour, type PourBatch, type PourElement, type PourSummaryRow, type PourTruck } from '../../lib/contract-field';
import { date, dateTime, humanize, num } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import { Attachments } from '../../components/Attachments';
import { SBadge } from '../../components/field/StatusBadge';
import { Badge, Banner, Card, DataTable, ErrorBanner, Loading, Page, PrintHeader, Signatures } from '../../components/ui';
import { CubeResultsDrawer } from './CubeResults';

const time = (v: string | null) => (v ? new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const WARN_LABEL: Record<string, string> = { late_arrival: 'Late arrival', water_added: 'Water added', slump_out_of_range: 'Slump out of range', hot_concrete: 'Hot concrete' };

async function load(id: string) {
  const pour = check(await supabase.from('pours').select('*, mix_designs(code, grade, target_strength_mpa, cement_kg_per_m3, target_slump_mm, slump_tolerance_mm)').eq('id', id).single()) as Pour
    & { mix_designs: { code: string; grade: string; target_strength_mpa: number; cement_kg_per_m3: number | null; target_slump_mm: number | null; slump_tolerance_mm: number } | null };
  const [sum, elements, trucks, batches, cubes] = await Promise.all([
    supabase.from('v_pour_summary').select('*').eq('pour_id', id).maybeSingle().then(check) as Promise<PourSummaryRow | null>,
    supabase.from('pour_elements').select('*').eq('pour_id', id).is('deleted_at', null).then(check) as Promise<PourElement[]>,
    supabase.from('pour_trucks').select('*').eq('pour_id', id).order('seq').then(check) as Promise<PourTruck[]>,
    supabase.from('pour_batches').select('*').eq('pour_id', id).order('seq').then(check) as Promise<PourBatch[]>,
    supabase.from('cube_sets').select('*, cube_results(age_days, strength_mpa, passed)').eq('pour_id', id).order('sampled_at').then(check) as Promise<(CubeSet & { cube_results: { age_days: number; strength_mpa: number; passed: boolean }[] })[]>,
  ]);
  return { pour, sum, elements, trucks, batches, cubes };
}

/** Pour record: elements, ready-mix trucks (ticket data, warnings, receipt status), site batches, cement/m³ vs design, cube sets. */
export function PourDetail() {
  const { id = '' } = useParams();
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => load(id), [id], { key: 'pour-detail' });
  const [cubeSet, setCubeSet] = useState<string | null>(null);
  useEffect(() => { if (q.data) pushRecent({ label: q.data.pour.number, hint: 'Pour', to: `/concrete/pours/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="Pour" breadcrumbs={[{ label: 'Concrete', to: '/concrete' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const { pour, sum, elements, trucks, batches, cubes } = q.data;
  const L = lk.data;
  const md = pour.mix_designs;
  const canCubes = canField(auth.profile?.role, 'cube.results');
  const cementKgM3 = sum?.issued_cement_kg_per_m3 ?? sum?.batched_cement_kg_per_m3 ?? null;
  const variance = sum?.cement_variance_pct ?? (cementKgM3 !== null && md?.cement_kg_per_m3 ? (cementKgM3 / md.cement_kg_per_m3 - 1) * 100 : null);

  return (
    <Page width="form" title={pour.number} titleExtra={<SBadge value={pour.status} />}
      breadcrumbs={[{ label: 'Concrete', to: '/concrete' }, { label: pour.number }]}
      subtitle={<>{date(pour.pour_date)} · {md ? `${md.grade} (${md.code})` : ''} · {pour.method === 'ready_mix' ? `Ready-mix${pour.supplier_name ? ` from ${pour.supplier_name}` : ''}` : 'Site batched'} · logged by {L.person(pour.created_by)}</>}
      actions={<button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>}>
      <div className="print-doc">
        <PrintHeader title={`Concrete pour ${pour.number}`} />
        {sum && sum.trucks_awaiting > 0 && <Banner tone="warn">{sum.trucks_awaiting} truck{sum.trucks_awaiting === 1 ? '' : 's'} awaiting store receipt (GRN + MIV not yet posted).</Banner>}
        {sum && sum.cube_sets_failed > 0 && <Banner tone="error">{sum.cube_sets_failed} cube set{sum.cube_sets_failed === 1 ? '' : 's'} failed at 28 days — see the critical snag.</Banner>}
        <div className="summary-strip mt-3">
          <div><span className="muted small-text">Planned</span><div className="strong">{num(pour.planned_m3, 2)} m³</div></div>
          <div><span className="muted small-text">Actual</span><div className="strong">{pour.actual_m3 === null ? '—' : `${num(pour.actual_m3, 2)} m³`}{sum?.over_pour_pct !== null && sum?.over_pour_pct !== undefined && <span className={Number(sum.over_pour_pct) > 5 ? 'danger-text' : 'muted'}> ({Number(sum.over_pour_pct) > 0 ? '+' : ''}{num(sum.over_pour_pct, 1)}%)</span>}</div></div>
          <div><span className="muted small-text">Accepted / rejected</span><div className="strong">{num(sum?.accepted_m3, 2)} / {num(sum?.rejected_m3, 2)} m³</div></div>
          <div><span className="muted small-text">Cement per m³</span><div className="strong">{cementKgM3 === null ? '—' : `${num(cementKgM3, 0)} kg`}{md?.cement_kg_per_m3 ? <span className="muted"> vs {num(md.cement_kg_per_m3, 0)} design</span> : null}
            {variance !== null && <span className={variance > 5 ? 'danger-text' : variance < -5 ? 'warn-text' : 'ok-text'}> ({variance > 0 ? '+' : ''}{num(variance, 1)}%)</span>}</div></div>
          <div><span className="muted small-text">Cubes</span><div className="strong">{sum ? `${sum.cube_sets_passed}/${sum.cube_sets} passed` : '—'}</div></div>
        </div>
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Elements" flush>
              <DataTable rows={elements} maxHeight="none" empty="No elements" columns={[
                { key: 'element', label: 'Element', value: (r) => L.element(r.element_id), render: (r) => <Link to={`/elements?peek=${r.element_id}`}>{L.element(r.element_id)}</Link> },
                { key: 'planned_m3', label: 'Planned', align: 'right', render: (r) => (r.planned_m3 === null ? '' : <>{num(r.planned_m3, 2)}<span className="unit">m³</span></>) },
              ]} />
            </Card>
            {(pour.method === 'ready_mix' || trucks.length > 0) && (
              <Card title="Ready-mix trucks" sub={`${trucks.length} tickets`} flush>
                <DataTable rows={trucks} maxHeight="none" exportName={`${pour.number}-trucks`} empty="No trucks recorded" columns={[
                  { key: 'seq', label: '#', align: 'right', width: 36 },
                  { key: 'ticket_no', label: 'Ticket', id: true },
                  { key: 'truck_plate', label: 'Truck' },
                  { key: 'volume_m3', label: 'Volume', align: 'right', render: (r) => <>{num(r.volume_m3, 2)}<span className="unit">m³</span></> },
                  { key: 'times', label: 'Batched / arrived / discharge', value: (r) => [time(r.batched_at), time(r.arrived_at), [time(r.discharge_start), time(r.discharge_end)].filter(Boolean).join('–')].join(' / ') },
                  { key: 'slump_mm', label: 'Slump', align: 'right', render: (r) => (r.slump_mm === null ? '' : <span className={md?.target_slump_mm && Math.abs(r.slump_mm - md.target_slump_mm) > md.slump_tolerance_mm ? 'danger-text' : ''}>{r.slump_mm}<span className="unit">mm</span></span>) },
                  { key: 'concrete_temp_c', label: 'Temp', align: 'right', render: (r) => (r.concrete_temp_c === null ? '' : <>{num(r.concrete_temp_c, 1)}<span className="unit">°C</span></>) },
                  { key: 'water_added_l', label: 'Water added', align: 'right', render: (r) => (r.water_added_l ? <span className="danger-text">{num(r.water_added_l, 0)}<span className="unit">L</span></span> : '') },
                  { key: 'status', label: 'Status', value: (r) => humanize(r.status), render: (r) => <SBadge value={r.accepted ? r.status : 'rejected'} /> },
                  { key: 'warnings', label: 'Warnings', value: (r) => r.warnings.map((w) => WARN_LABEL[w] ?? w).join(', '), render: (r) => <span className="badges">{r.warnings.map((w) => <Badge key={w} tone="warning" outline label={WARN_LABEL[w] ?? humanize(w)} icon={null} />)}</span> },
                  { key: 'reject_reason', label: 'Reject reason', hidden: true },
                  { key: 'docs', label: 'GRN / MIV', value: (r) => (r.grn_id ? 'Posted' : ''), render: (r) => (r.grn_id ? <span className="nowrap"><Link to={`/store?open=${r.grn_id}#grn`}>GRN</Link>{r.miv_id && <> · <Link to={`/store?open=${r.miv_id}#miv`}>MIV</Link></>}</span> : '') },
                ]} />
              </Card>
            )}
            {(pour.method === 'site_batched' || batches.length > 0) && (
              <Card title="Site batches" sub={sum ? `${sum.batches} batches · ${num(sum.batched_m3, 2)} m³ · ${sum.cement_bags} bags` : undefined} flush>
                <DataTable rows={batches} maxHeight="none" empty="No batches recorded" columns={[
                  { key: 'seq', label: '#', align: 'right', width: 36 },
                  { key: 'batched_at', label: 'Time', render: (r) => time(r.batched_at) },
                  { key: 'volume_m3', label: 'Volume', align: 'right', render: (r) => (r.volume_m3 === null ? '' : <>{num(r.volume_m3, 2)}<span className="unit">m³</span></>) },
                  { key: 'cement_bags', label: 'Cement', align: 'right', render: (r) => <>{num(r.cement_bags, 1)}<span className="unit">bags</span></> },
                  { key: 'per_m3', label: 'kg/m³', align: 'right', value: (r) => (r.volume_m3 ? (Number(r.cement_bags) * 50) / Number(r.volume_m3) : null),
                    render: (r) => { if (!r.volume_m3) return ''; const v = (Number(r.cement_bags) * 50) / Number(r.volume_m3); return <span className={md?.cement_kg_per_m3 && v > md.cement_kg_per_m3 * 1.05 ? 'danger-text' : ''}>{num(v, 0)}</span>; } },
                  { key: 'sand_m3', label: 'Sand', align: 'right', render: (r) => num(r.sand_m3, 2) },
                  { key: 'aggregate_m3', label: 'Aggregate', align: 'right', render: (r) => num(r.aggregate_m3, 2) },
                  { key: 'water_l', label: 'Water', align: 'right', render: (r) => num(r.water_l, 0) },
                  { key: 'slump_mm', label: 'Slump', align: 'right' },
                  { key: 'mixer', label: 'Mixer' },
                ]} />
              </Card>
            )}
            <Card title="Cube sets" flush>
              <DataTable rows={cubes} maxHeight="none" empty="No samples taken" onRowClick={canCubes ? (r) => setCubeSet(r.id) : undefined} columns={[
                { key: 'number', label: 'Set', id: true },
                { key: 'sampled_at', label: 'Sampled', render: (r) => dateTime(r.sampled_at) },
                { key: 'element', label: 'Element', value: (r) => L.element(r.element_id) },
                { key: 'test_ages', label: 'Ages', value: (r) => r.test_ages.join(' / ') + ' d' },
                { key: 'early', label: 'Early', render: (r) => <SBadge value={r.result_early} label={r.result_early === 'low' ? 'Low' : undefined} /> },
                { key: 'result_28d', label: '28-day', render: (r) => <SBadge value={r.result_28d} /> },
                { key: 'mean_28d_mpa', label: 'Mean', align: 'right', render: (r) => (r.mean_28d_mpa === null ? '' : <>{num(r.mean_28d_mpa, 1)}<span className="unit">/ {num(r.required_strength_mpa, 0)} MPa</span></>) },
                { key: 'tested', label: 'Results', align: 'right', value: (r) => r.cube_results.length },
                { key: 'snag', label: 'Snag', render: (r) => (r.snag_id ? <Link to={`/quality?peek=${r.snag_id}#snags`} onClick={(e) => e.stopPropagation()}>Open snag</Link> : '') },
                { key: 'act', label: '', noExport: true, sortable: false, render: (r) => canCubes && <button className="small" onClick={(e) => { e.stopPropagation(); setCubeSet(r.id); }}><FlaskConical size={14} aria-hidden />Results</button> },
              ]} />
            </Card>
          </div>
          <div className="side-panel">
            <Card title="Details">
              <dl className="kv">
                <dt>Mix</dt><dd>{md ? `${md.code} · fck ${num(md.target_strength_mpa, 0)} MPa` : '—'}</dd>
                <dt>Design cement</dt><dd>{md?.cement_kg_per_m3 ? `${num(md.cement_kg_per_m3, 0)} kg/m³` : '—'}</dd>
                <dt>Cement issued</dt><dd>{sum?.cement_kg_issued ? `${num(sum.cement_kg_issued, 0)} kg` : '—'}{sum?.design_cement_kg ? <span className="muted"> (design {num(sum.design_cement_kg, 0)} kg)</span> : null}</dd>
                <dt>Store</dt><dd>{L.store(pour.store_id) || '—'}</dd>
                <dt>Request</dt><dd>{pour.mr_id ? <Link to={`/requests/${pour.mr_id}`}>Material request</Link> : '—'}</dd>
                <dt>Start / end</dt><dd>{[dateTime(pour.start_at), dateTime(pour.end_at)].filter(Boolean).join(' → ') || '—'}</dd>
                <dt>Weather</dt><dd>{pour.weather ?? '—'}</dd>
                <dt>Curing</dt><dd>{pour.curing_method ?? '—'}</dd>
                <dt>Remarks</dt><dd>{pour.remarks ?? '—'}</dd>
                <dt>Closed by</dt><dd>{L.person(pour.closed_by) || '—'}</dd>
              </dl>
            </Card>
            <Card title="Tickets & photos"><Attachments entityType="pour" entityId={pour.id} canAdd={canField(auth.profile?.role, 'pour.write') || canField(auth.profile?.role, 'pour.receiveTruck')} kinds={['photo', 'batch_ticket', 'delivery_note', 'document']} /></Card>
          </div>
        </div>
        <Signatures />
      </div>
      {cubeSet && <CubeResultsDrawer cubeSetId={cubeSet} onClose={() => setCubeSet(null)} />}
    </Page>
  );
}
