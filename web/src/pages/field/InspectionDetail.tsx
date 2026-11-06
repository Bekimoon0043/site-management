import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Printer, TriangleAlert } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { canField, type InspectionItem } from '../../lib/contract-field';
import { rpcx } from '../../lib/fieldx';
import { dateTime, humanize, num } from '../../lib/format';
import { pushRecent } from '../../lib/prefs';
import { Attachments } from '../../components/Attachments';
import { SBadge } from '../../components/field/StatusBadge';
import { Banner, Card, DataTable, ErrorBanner, Loading, Page, PrintHeader, ReasonModal, Signatures, toast } from '../../components/ui';
import type { InspRow } from './QualityInspections';
import '../../components/field/field.css';

async function load(id: string) {
  const ins = check(await supabase.from('inspections').select('*, checklist_templates(code, name)').eq('id', id).single()) as InspRow;
  const [items, reinspections, act, tplItems] = await Promise.all([
    supabase.from('inspection_items').select('*').eq('inspection_id', id).order('seq').then(check) as Promise<InspectionItem[]>,
    supabase.from('inspections').select('id, number, status, result').eq('reinspection_of', id).then(check) as Promise<{ id: string; number: string; status: string; result: string | null }[]>,
    ins.element_activity_id
      ? supabase.from('element_activities').select('name, is_hold_point').eq('id', ins.element_activity_id).maybeSingle().then(check) as Promise<{ name: string; is_hold_point: boolean } | null>
      : Promise.resolve(null),
    supabase.from('checklist_template_items').select('id, min_value, max_value, unit, photo_required').eq('template_id', ins.template_id).then(check) as Promise<{ id: string; min_value: number | null; max_value: number | null; unit: string | null; photo_required: boolean }[]>,
  ]);
  return { ins, items, reinspections, act, tplItems: new Map(tplItems.map((t) => [t.id, t])) };
}

/** Inspection record: items with responses/values, failed items → snags, photos (P1-7). */
export function InspectionDetail() {
  const { id = '' } = useParams();
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const q = useAsync(() => load(id), [id], { key: 'inspection-detail' });
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => { if (q.data) pushRecent({ label: q.data.ins.number, hint: 'Inspection', to: `/quality/inspections/${id}` }); }, [q.data, id]);

  if (!q.data || !lk.data) {
    return <Page title="Inspection" breadcrumbs={[{ label: 'Quality', to: '/quality#inspections' }, { label: '…' }]}>{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={8} />}</Page>;
  }
  const { ins, items, reinspections, act, tplItems } = q.data;
  const L = lk.data;
  const failed = items.filter((i) => i.response === 'fail');
  const canCancel = canField(auth.profile?.role, 'inspection.perform') && ins.status === 'requested';
  const photoItems = items.filter((i) => i.item_type === 'photo' || tplItems.get(i.template_item_id)?.photo_required);

  return (
    <Page width="form" title={ins.number} titleExtra={<span className="badges"><SBadge value={ins.status} />{ins.result && <SBadge value={ins.result} />}</span>}
      breadcrumbs={[{ label: 'Quality', to: '/quality#inspections' }, { label: ins.number }]}
      subtitle={<>{ins.checklist_templates ? `${ins.checklist_templates.code} — ${ins.checklist_templates.name}` : 'Checklist'} · {L.element(ins.element_id)}{act ? ` · ${act.name}` : ''}</>}
      actions={<>
        {canCancel && <button onClick={() => setCancelling(true)}>Cancel inspection…</button>}
        <button onClick={() => window.print()}><Printer size={14} aria-hidden />Print</button>
      </>}>
      <div className="print-doc">
        <PrintHeader title={`Inspection ${ins.number}`} />
        {ins.status === 'requested' && <Banner tone="info">Requested{ins.requested_for ? ` for ${dateTime(ins.requested_for)}` : ''} — the inspection is performed and submitted on site (mobile app).</Banner>}
        {ins.result === 'fail' && <Banner tone="error">A critical item failed — the hold point stays closed. Re-inspection is a new inspection linked to this one.</Banner>}
        {ins.result === 'conditional' && <Banner tone="warn">Only non-critical items failed — conditional pass; the hold point is cleared. Follow up the snags below.</Banner>}
        <div className="detail-layout mt-3">
          <div className="stack">
            <Card title="Checklist" sub={items.length ? `${items.length} items · ${failed.length} failed` : undefined} flush>
              <DataTable rows={items} maxHeight="none" empty={ins.status === 'requested' ? 'Not inspected yet' : 'No items'} columns={[
                { key: 'seq', label: '#', align: 'right', width: 36 },
                { key: 'text', label: 'Check', render: (r) => <>{r.is_critical && <span className="warn-line" title="Critical item"><TriangleAlert size={14} aria-hidden /></span>} {r.text}</> },
                { key: 'response', label: 'Result', render: (r) => <SBadge value={r.response === 'na' ? 'cancelled' : r.response} label={r.response === 'na' ? 'N/A' : undefined} /> },
                { key: 'value', label: 'Value', align: 'right', value: (r) => r.value_num ?? r.value_text, render: (r) => {
                  const t = tplItems.get(r.template_item_id);
                  if (r.value_num !== null) return <span title={t && (t.min_value !== null || t.max_value !== null) ? `Tolerance ${t.min_value ?? '…'}–${t.max_value ?? '…'} ${t.unit ?? ''}` : undefined}>{num(r.value_num)}<span className="unit">{t?.unit}</span></span>;
                  return r.value_text ?? '';
                } },
                { key: 'is_critical', label: 'Critical', value: (r) => (r.is_critical ? 'Yes' : ''), hidden: true },
                { key: 'snag', label: 'Snag', render: (r) => (r.snag_id ? <Link to={`/quality?peek=${r.snag_id}#snags`}>Open snag</Link> : '') },
              ]} />
            </Card>
            {photoItems.length > 0 && (
              <Card title="Item photos">
                {photoItems.map((i) => (
                  <div key={i.id} className="mt-2"><div className="small-text strong">{i.seq}. {i.text}</div><Attachments entityType="inspection_item" entityId={i.id} /></div>
                ))}
              </Card>
            )}
            <Card title="Photos & signatures"><Attachments entityType="inspection" entityId={ins.id} canAdd={canField(auth.profile?.role, 'inspection.perform')} kinds={['photo', 'signature', 'document', 'drawing']} /></Card>
          </div>
          <div className="side-panel">
            <Card title="Details">
              <dl className="kv">
                <dt>Element</dt><dd>{L.element(ins.element_id)}</dd>
                <dt>Activity</dt><dd>{act ? <>{act.name}{act.is_hold_point && <> <SBadge value="hold_point" /></>}</> : '—'}</dd>
                <dt>Requested</dt><dd>{ins.requested_by ? `${L.person(ins.requested_by)} · ${dateTime(ins.requested_at)}` : '—'}</dd>
                <dt>Inspected</dt><dd>{ins.inspected_at ? `${L.person(ins.inspector_id)} · ${dateTime(ins.inspected_at)}` : '—'}</dd>
                <dt>Consultant</dt><dd>{ins.consultant_name ?? '—'}</dd>
                <dt>Template ver.</dt><dd>{ins.template_version ?? '—'}</dd>
                <dt>Remarks</dt><dd>{ins.remarks ?? '—'}</dd>
                <dt>Re-inspection of</dt><dd>{ins.reinspection_of ? <Link to={`/quality/inspections/${ins.reinspection_of}`}>previous inspection</Link> : '—'}</dd>
                <dt>Re-inspected by</dt><dd>{reinspections.length ? reinspections.map((r) => <div key={r.id}><Link to={`/quality/inspections/${r.id}`}>{r.number}</Link> <SBadge value={r.result ?? r.status} /></div>) : '—'}</dd>
              </dl>
            </Card>
            {failed.length > 0 && (
              <Card title="Failed items">
                <ul className="summary-list">{failed.map((i) => <li key={i.id}><span className="no">{i.seq}.</span><span className="grow">{i.text}</span>{i.is_critical && <SBadge value="critical" />}</li>)}</ul>
              </Card>
            )}
          </div>
        </div>
        <Signatures />
      </div>
      {cancelling && <ReasonModal title={`Cancel ${ins.number}`} required={false} label="Reason (optional)" danger confirm="Cancel inspection" onClose={() => setCancelling(false)}
        onSubmit={async (c) => { await rpcx('cancel_inspection', { inspection_id: ins.id, comment: c || undefined }); toast.success(`${ins.number} cancelled`); q.reload(); }} />}
      <span className="sr-only">{humanize(ins.status)}</span>
    </Page>
  );
}
