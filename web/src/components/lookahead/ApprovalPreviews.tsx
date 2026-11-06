// /approvals previews for planning items from v_my_approvals: look-ahead constraints, week close, EVM period close.
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { date, dateTime, num } from '../../lib/format';
import type { LookaheadConstraint } from '../../lib/contract-lookahead';
import type { PlanQueueRow } from '../../lib/approvals';
import { Badge } from '../Badge';
import { ReasonModal } from '../Dialog';
import { ErrorBanner, Loading } from '../Page';
import { useBusy } from '../Form';
import { PeriodPanel } from '../evm/PeriodPanel';
import { planRpc, tr, type PeriodRow } from '../evm/data';
import { ConstraintStatusBadge } from './chips';
import { CloseWeekModal } from './WeeklyPlan';
import { ctypeLabel } from './la';
import '../evm/evm.css';

interface Common { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }
type PlanRef = { period_year: number; period_month: number; calendar_mode: string } | null;
const laLink = (p: PlanRef, peek?: string, hash = '') => (p ? `/lookahead?m=${p.period_year}-${p.period_month}&mode=${p.calendar_mode}${peek ? `&peek=${peek}` : ''}${hash}` : '/lookahead');

function Head({ title, badges, meta }: { title: string; badges?: ReactNode; meta: ReactNode }) {
  return <div className="inbox-preview-head"><h2>{title}{badges}</h2><div className="meta">{meta}</div></div>;
}

export function ConstraintPreview({ row, L, onDone, onActions }: Common) {
  const q = useAsync(async () => check(await supabase.from('lookahead_constraints')
    .select('*, lookahead_items(id, name, planned_start, planned_finish, window_role, lookahead_plans(period_year, period_month, calendar_mode, period_label))')
    .eq('id', row.entity_id).maybeSingle()) as (LookaheadConstraint & { lookahead_items: { id: string; name: string; planned_start: string | null; planned_finish: string | null; lookahead_plans: PlanRef & { period_label: string } } | null }) | null,
  [row.entity_id], { key: 'appr-la-constraint' });
  const [act, setAct] = useState<'cleared' | 'waived' | null>(null);
  const [due, setDue] = useState('');
  const { busy, error, run } = useBusy();
  const c = q.data;
  useEffect(() => { onActions({ approve: () => setAct('cleared'), reject: () => setAct('waived') }); });
  if (!c) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  const it = c.lookahead_items;
  const needComment = act === 'waived' || (act === 'cleared' && c.auto && c.ctype === 'material');
  return (
    <>
      <Head title={`${ctypeLabel(c.ctype)}: ${it?.name ?? ''}`} badges={<> <ConstraintStatusBadge status={c.status} />{row.is_urgent && <Badge tone="danger" label={tr('Overdue', 'ያለፈ')} />}</>}
        meta={<>{it?.lookahead_plans?.period_label} · {tr('due', 'ቀን')} {date(c.due_date) || '—'} · {tr('owner', 'ኃላፊ')} {L.person(c.owner_id) || c.owner_role || '—'}</>} />
      <div className="inbox-preview-body stack">
        <ErrorBanner error={error} />
        <p className="mb-0">{c.description}{c.qty_short ? <span className="muted"> · short {num(c.qty_short)}</span> : null}</p>
        <dl className="kv">
          <dt>{tr('Task dates', 'የሥራ ቀናት')}</dt><dd>{date(it?.planned_start)} → {date(it?.planned_finish)}</dd>
          <dt>{tr('Source', 'ምንጭ')}</dt><dd>{c.auto ? `${tr('Automatic', 'ራስ-ሰር')} (${(c.source_type ?? '').replace('_', ' ')})` : `${tr('Added by', 'የጨመረው')} ${L.person(c.created_by)}`}</dd>
          <dt>{tr('Updated', 'የተሻሻለ')}</dt><dd>{dateTime(c.updated_at)}</dd>
        </dl>
        <div className="row">
          <label className="row small-text">{tr('New due date', 'አዲስ ቀን')} <input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <button className="small" disabled={!due || busy} onClick={() => void run(async () => { await planRpc('update_constraint', { id: c.id, due_date: due }); onDone(`Due date moved to ${date(due)}`); })}>{tr('Move due date', 'ቀኑን ቀይር')}</button>
          <Link to={laLink(it?.lookahead_plans ?? null, it?.id)} className="small-text"><ExternalLink size={12} aria-hidden /> {tr('Open in look-ahead', 'በዕቅዱ ክፈት')}</Link>
        </div>
      </div>
      <div className="action-bar">
        <span className="grow" />
        {!c.auto && <button onClick={() => setAct('waived')}>{tr('Waive…', 'እለፍ…')} <kbd>R</kbd></button>}
        <button className="primary" onClick={() => setAct('cleared')}>{tr('Clear constraint', 'እንቅፋቱን ፍታ')} <kbd>A</kbd></button>
      </div>
      {act && (
        <ReasonModal title={act === 'cleared' ? 'Clear constraint' : 'Waive constraint'} required={needComment} label={tr('Comment', 'አስተያየት')} danger={act === 'waived'}
          confirm={act === 'cleared' ? 'Clear' : 'Waive'} onClose={() => setAct(null)}
          onSubmit={async (comment) => { await planRpc('update_constraint', { id: c.id, status: act, comment: comment || undefined }); onDone(`Constraint ${act === 'cleared' ? 'cleared' : 'waived'} · ${it?.name ?? ''}`); }} />
      )}
    </>
  );
}

export function WeekClosePreview({ row, onDone, onActions }: Common) {
  const q = useAsync(async () => {
    const w = check(await supabase.from('lookahead_weeks').select('*, lookahead_plans(period_year, period_month, calendar_mode, period_label)').eq('id', row.entity_id).maybeSingle()) as
      ({ id: string; week_no: number; week_start: string; week_end: string; status: string; lookahead_plans: PlanRef & { period_label: string } }) | null;
    const cs = check(await supabase.from('weekly_commitments').select('id, description, outcome, rnc_code').eq('week_id', row.entity_id).eq('kind', 'commitment')) as { id: string; description: string; outcome: string; rnc_code: string | null }[];
    return { w, cs };
  }, [row.entity_id], { key: 'appr-la-week' });
  const [closing, setClosing] = useState(false);
  useEffect(() => { onActions({ approve: () => setClosing(true) }); });
  const d = q.data;
  if (!d?.w) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  const done = d.cs.filter((c) => c.outcome === 'completed').length, miss = d.cs.filter((c) => c.outcome === 'not_completed').length, pend = d.cs.length - done - miss;
  return (
    <>
      <Head title={row.title} meta={<>{d.w.lookahead_plans?.period_label} · {date(d.w.week_start)} – {date(d.w.week_end)}</>} />
      <div className="inbox-preview-body stack">
        <p className="mb-0">{d.cs.length} commitment{d.cs.length === 1 ? '' : 's'}: <strong>{done}</strong> done · <strong>{miss}</strong> not done · <strong className={pend ? 'warn-text' : ''}>{pend}</strong> without a result.</p>
        <ul className="summary-list">{d.cs.slice(0, 12).map((c) => <li key={c.id}><Badge value={c.outcome === 'completed' ? 'completed' : c.outcome === 'not_completed' ? 'rejected' : 'pending'} label={c.outcome.replace('_', ' ')} /> <span>{c.description}</span></li>)}</ul>
        <Link to={laLink(d.w.lookahead_plans, undefined, '#weekly')} className="small-text"><ExternalLink size={12} aria-hidden /> {tr('Open weekly plan', 'ሳምንታዊ ዕቅድ ክፈት')}</Link>
      </div>
      <div className="action-bar"><span className="grow" /><button className="primary" onClick={() => setClosing(true)}>{tr('Close week…', 'ሳምንቱን ዝጋ…')} <kbd>A</kbd></button></div>
      {closing && <CloseWeekModal weekId={d.w.id} weekNo={d.w.week_no} onClose={() => setClosing(false)} onDone={onDone} />}
    </>
  );
}

export function PeriodClosePreview({ row, L, onDone, onActions }: Common) {
  const q = useAsync(async () => check(await supabase.from('evm_periods').select('*').eq('id', row.entity_id).maybeSingle()) as PeriodRow | null, [row.entity_id], { key: 'appr-evm-period' });
  useEffect(() => { onActions({}); });
  if (!q.data) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  return (
    <>
      <Head title={row.title} meta={<>{tr('Prepared by', 'ያዘጋጀው')} {L.person(row.requested_by)} · {dateTime(row.requested_at)} · <Link to={`/evm/periods?s=${q.data.schedule_id}&open=${q.data.id}`}>{tr('Open periods', 'ወቅቶችን ክፈት')}</Link></>} />
      <div className="inbox-preview-body"><PeriodPanel period={q.data} L={L} onDone={onDone} /></div>
    </>
  );
}
