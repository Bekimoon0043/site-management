// Weekly plan (Last Planner): commit ready work per Mon–Sat week, report outcomes, close the week (PPC, reasons, roll-forward).
import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { date, num } from '../../lib/format';
import { canCommitWeek, ppcTone, RNC_LABELS, type LookaheadPlan, type PpcWeek, type RncCode, type WeeklyCommitment } from '../../lib/contract-lookahead';
import { Badge } from '../Badge';
import { DataTable } from '../DataTable';
import { Modal, confirm } from '../Dialog';
import { Field, useBusy } from '../Form';
import { Banner, Card, ErrorBanner, Loading } from '../Page';
import { Tabs } from '../Tabs';
import { toast } from '../toast';
import { eatToday, isAm, planRpc, tr } from '../evm/data';
import { ReadyBadge } from './chips';
import { CommitModal } from './ItemDrawer';
import { can, lbl, type LaCommit, type LaItem, type LaWeek } from './la';

const RNC = Object.keys(RNC_LABELS) as RncCode[];
type Row = LaCommit & { item: LaItem };

export function WeeklyPlan({ plan, weeks, items, ppc, L, onOpen }: { plan: LookaheadPlan; weeks: LaWeek[]; items: LaItem[]; ppc: PpcWeek[]; L: Lookups; onOpen: (it: LaItem) => void }) {
  const auth = useAuth();
  const role = auth.profile?.role;
  const today = eatToday();
  const real = weeks.filter((w) => w.id);
  const def = real.find((w) => w.week_end >= today) ?? real[real.length - 1];
  const [wid, setWid] = useState<string>(def?.id ?? '');
  const week = real.find((w) => w.id === wid) ?? def;
  const [commitItem, setCommitItem] = useState<LaItem | null>(null);
  const [miss, setMiss] = useState<Row | null>(null);
  const [closing, setClosing] = useState(false);
  const pw = ppc.find((p) => p.week_id === week?.id);

  const rows: Row[] = week ? items.flatMap((it) => it.commitments.filter((c) => c.week_id === week.id).map((c) => ({ ...c, item: it }))) : [];
  const committedIds = new Set(rows.map((r) => r.item.id));
  const cands = week ? items.filter((it) => it.status === 'active' && (it.week_days[week.week_start] ?? 0) > 0 && !committedIds.has(it.id))
    .sort((a, b) => Number(b.readiness === 'ready') - Number(a.readiness === 'ready') || Number(b.is_critical) - Number(a.is_critical)) : [];
  const commitOpen = !!week && !!role && plan.status === 'published' && can(role, 'lookahead.commit') && canCommitWeek({ status: week.status as 'open', week_start: week.week_start }, today, role);
  const canReport = !!week && week.status !== 'closed' && can(role, 'lookahead.report') && week.week_start <= today;
  // report_commitment: a site engineer reports work he committed or is responsible for; coordinators / admins report any.
  const me = auth.profile?.id;
  const mayReport = (r: Row) => role !== 'site_engineer' || r.committed_by === me || r.item.responsible_id === me;
  const canClose = !!week && week.status !== 'closed' && plan.status === 'published' && can(role, 'lookahead.close_week');

  const report = async (r: Row, outcome: 'completed' | 'not_completed', rnc_code?: RncCode, rnc_note?: string) => {
    try {
      await planRpc('report_commitment', { commitment_id: r.id, outcome, rnc_code, rnc_note });
      toast.success(`"${r.description}" marked ${outcome === 'completed' ? 'done' : 'not done'}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const bulkCommit = async (sel: LaItem[], clear: () => void) => {
    const ready = sel.filter((s) => s.readiness === 'ready');
    if (!ready.length) { toast.info('Only ready tasks can be committed in bulk; open a not-ready task to commit it with a reason.'); return; }
    if (!(await confirm({ title: `Commit ${ready.length} ready task${ready.length === 1 ? '' : 's'} for week ${week!.week_no}?`, confirm: `Commit ${ready.length}` }))) return;
    let ok = 0;
    for (const it of ready) {
      const cand = it.commitments.find((c) => c.week_id === week!.id && c.kind === 'candidate');
      try { await planRpc('commit_lookahead_item', { id: cand?.id ?? crypto.randomUUID(), item_id: it.id, week_id: week!.id! }); ok++; } catch (e) { toast.error(`${it.name}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ok) { toast.success(`${ok} committed for week ${week!.week_no}`); clear(); }
  };

  if (!real.length) return <Banner tone="info">Generate the look-ahead to plan weeks.</Banner>;
  return (
    <div className="stack">
      <div className="row">
        <Tabs variant="segmented" label="Week" value={week?.id ?? ''} onChange={(v) => setWid(v)}
          tabs={real.map((w) => ({ key: w.id!, label: `W${w.week_no}${w.in_buffer ? '*' : ''}` }))} />
        {week && <span className="muted small-text">{date(week.week_start)} – {date(week.week_end)} · {num(week.working_days, 1)} {tr('working days', 'የሥራ ቀናት')} · <Badge value={week.status === 'closed' ? 'closed' : week.status === 'committed' ? 'in_progress' : 'pending'} label={week.status === 'closed' ? tr('Closed', 'ተዘግቷል') : week.status === 'committed' ? tr('Under way', 'በሂደት') : tr('Planning', 'በዕቅድ')} /></span>}
        <span className="grow" />
        {pw && pw.committed > 0 && <span className={`strong la-ppc-v ${ppcTone(pw.ppc, pw.ppc_target ?? 80)}`}>PPC {pw.completed}/{pw.committed} · {pw.ppc == null ? '—' : `${Math.round(pw.ppc)} %`}</span>}
        {canClose && <button className="primary" disabled={week!.week_end > today} title={week!.week_end > today ? `Can be closed from ${date(week!.week_end)}` : undefined} onClick={() => setClosing(true)}>{tr('Close week', 'ሳምንቱን ዝጋ')} {week!.week_no}</button>}
      </div>
      {pw && pw.committed > 0 && (
        <p className="muted small-text mb-0">{isAm() ? `በዚህ ሳምንት ቃል ከገባናቸው ${pw.committed} ሥራዎች ${pw.completed} ጨርሰናል።` : `We finished ${pw.completed} of the ${pw.committed} tasks we promised this week.`}{pw.overrides ? ` ${pw.overrides} committed while not ready.` : ''}</p>
      )}

      <Card flush title={tr('Commitments', 'ቃል የተገቡ')} sub={tr('What the team promised to finish this week', 'በዚህ ሳምንት ለመጨረስ የተገባ ቃል')}>
        <DataTable rows={rows} rowKey={(r) => r.id} maxHeight="none" exportName={`commitments-W${week?.week_no}`}
          empty={{ title: tr('No commitments yet', 'ገና ቃል አልተገባም'), body: commitOpen ? 'Commit ready tasks below (site engineer before the week starts; coordinator up to day 1).' : 'Commitments are made before the week starts.' }}
          columns={[
            { key: 'task', label: tr('Task', 'ሥራ'), render: (r) => <button className="link-btn" onClick={() => onOpen(r.item)}>{r.item.name}</button>, value: (r) => r.item.name },
            { key: 'description', label: tr('Promise', 'ቃል'), render: (r) => <>{r.description !== r.item.name ? r.description : <span className="muted">whole step</span>}{r.target_pct != null ? ` → ${num(r.target_pct, 0)} %` : ''}</> },
            { key: 'kind', label: '', render: (r) => (r.kind === 'candidate' ? <Badge tone="warning" label={tr('Rolled forward — confirm', 'የተሸጋገረ')} icon={null} /> : null) },
            { key: 'committed_by', label: tr('By', 'በ'), render: (r) => L.person(r.committed_by) },
            { key: 'outcome', label: tr('Result', 'ውጤት'), render: (r) => (r.outcome === 'completed' ? <Badge value="completed" label={tr('Done', 'ተጠናቋል')} />
              : r.outcome === 'not_completed' ? <Badge value="rejected" label={`${tr('Not done', 'አልተጠናቀቀም')}${r.rnc_code ? ` · ${lbl(RNC_LABELS[r.rnc_code])}` : ''}`} /> : <Badge value="pending" label={tr('Pending', 'በመጠባበቅ')} />) },
            { key: 'act', label: '', sortable: false, noExport: true, render: (r) => (
              r.kind === 'candidate' ? (commitOpen ? <button className="small" onClick={() => setCommitItem(r.item)}>{tr('Confirm', 'አረጋግጥ')}</button> : null)
                : canReport && r.outcome === 'pending' ? (mayReport(r) ? <span className="row nowrap">
                  <button className="small" onClick={() => void report(r, 'completed')}>{tr('Done', 'ተጠናቋል')}</button>
                  <button className="small ghost" onClick={() => setMiss(r)}>{tr('Not done…', 'አልተጠናቀቀም…')}</button>
                </span> : <span className="muted xs-text">{tr('Reported by', 'የሚያሳውቀው')} {L.person(r.committed_by) || tr('the committer', 'ቃል የገባው')}</span>) : null) },
          ]} />
      </Card>

      {week && week.status === 'open' && (
        <Card flush title={tr('Planned this week — not yet committed', 'በዚህ ሳምንት የታቀዱ')} sub={commitOpen ? tr('Select ready tasks to commit', 'ዝግጁ ሥራዎችን ይምረጡ') : tr('Commitments for this week are locked', 'ተቆልፏል')}>
          <DataTable rows={cands} rowKey={(it) => it.id} maxHeight="none" selectable={commitOpen}
            bulkActions={(sel, clear) => <button className="small primary" onClick={() => void bulkCommit(sel, clear)}>{tr('Commit ready', 'ዝግጁዎቹን ቃል ግባ')} ({sel.filter((s) => s.readiness === 'ready').length})</button>}
            empty={tr('Every task planned for this week is committed.', 'ሁሉም ቃል ተገብቷል።')}
            columns={[
              { key: 'name', label: tr('Task', 'ሥራ'), render: (it) => <button className="link-btn" onClick={() => onOpen(it)}>{it.name}</button>, value: (it) => it.name },
              { key: 'days', label: tr('Days this week', 'ቀናት'), align: 'right', render: (it) => num(it.week_days[week.week_start] ?? 0, 1) },
              { key: 'readiness', label: tr('Readiness', 'ዝግጁነት'), render: (it) => <ReadyBadge item={it} /> },
              { key: 'resp', label: tr('Responsible', 'ኃላፊ'), render: (it) => it.responsible_name ?? '' },
              { key: 'act', label: '', sortable: false, noExport: true, render: (it) => (commitOpen ? <button className="small" onClick={() => setCommitItem(it)}>{tr('Commit…', 'ቃል ግባ…')}</button> : null) },
            ]} />
        </Card>
      )}

      {commitItem && week && <CommitModal item={commitItem} week={week} candidateId={commitItem.commitments.find((c) => c.week_id === week.id && c.kind === 'candidate')?.id} onClose={() => setCommitItem(null)} />}
      {miss && <MissModal title={miss.description} onClose={() => setMiss(null)} onSave={(code, note) => report(miss, 'not_completed', code, note)} />}
      {closing && week?.id && <CloseWeekModal weekId={week.id} weekNo={week.week_no} onClose={() => setClosing(false)} />}
    </div>
  );
}

function MissModal({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (code: RncCode, note?: string) => Promise<void> }) {
  const [code, setCode] = useState<RncCode | ''>('');
  const [note, setNote] = useState('');
  return (
    <Modal title={tr('Why was it not finished?', 'ለምን አልተጠናቀቀም?')} subtitle={title} onClose={onClose} size="md" footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={!code} onClick={() => void onSave(code as RncCode, note.trim() || undefined).then(onClose)}>Save</button>
    </>}>
      <RncPicker value={code} onChange={setCode} />
      <Field label={tr('Note', 'ማስታወሻ')} wide><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

function RncPicker({ value, onChange }: { value: RncCode | ''; onChange: (c: RncCode) => void }) {
  return (
    <div className="row" role="radiogroup" aria-label="Reason">
      {RNC.map((c) => <button key={c} type="button" role="radio" aria-checked={value === c} className={`small${value === c ? ' primary' : ''}`} onClick={() => onChange(c)}>{lbl(RNC_LABELS[c])}</button>)}
    </div>
  );
}

type Res = { outcome: 'completed' | 'not_completed' | ''; rnc_code: RncCode | ''; rnc_note: string; roll: boolean; actual_pct: string };

/** Close a week: every commitment needs an outcome; misses need a reason; misses roll forward unless unticked. */
export function CloseWeekModal({ weekId, weekNo, onClose, onDone }: { weekId: string; weekNo: number; onClose: () => void; onDone?: (msg: string) => void }) {
  const q = useAsync(async () => check(await supabase.from('weekly_commitments').select('*, lookahead_items(name)').eq('week_id', weekId).eq('kind', 'commitment').order('committed_at')) as (WeeklyCommitment & { lookahead_items: { name: string } | null })[],
    [weekId], { key: 'la-week-close' });
  const [res, setRes] = useState<Record<string, Res>>({});
  const { busy, error, run } = useBusy();
  const rows = q.data ?? [];
  const get = (c: WeeklyCommitment): Res => res[c.id] ?? { outcome: c.outcome === 'pending' ? '' : c.outcome, rnc_code: c.rnc_code ?? '', rnc_note: c.rnc_note ?? '', roll: true, actual_pct: c.actual_pct != null ? String(c.actual_pct) : '' };
  const set = (c: WeeklyCommitment, p: Partial<Res>) => setRes((s) => ({ ...s, [c.id]: { ...get(c), ...p } }));
  const missing = rows.filter((c) => { const r = get(c); return !r.outcome || (r.outcome === 'not_completed' && !r.rnc_code); }).length;
  const done = rows.filter((c) => get(c).outcome === 'completed').length;
  const save = () => run(async () => {
    const r = await planRpc('close_week', { week_id: weekId, results: rows.map((c) => { const x = get(c); return {
      commitment_id: c.id, outcome: x.outcome as 'completed' | 'not_completed', actual_pct: x.actual_pct ? Number(x.actual_pct) : undefined,
      rnc_code: x.outcome === 'not_completed' ? (x.rnc_code as RncCode) : undefined, rnc_note: x.outcome === 'not_completed' ? x.rnc_note || undefined : undefined,
      roll_forward: x.outcome === 'not_completed' ? x.roll : undefined }; }) });
    const msg = `Week ${weekNo} closed · PPC ${r.ppc == null ? '—' : `${Math.round(Number(r.ppc))} %`}${Number(r.rolled) ? ` · ${r.rolled} rolled forward` : ''}`;
    if (onDone) onDone(msg); else toast.success(msg);
    onClose();
  });
  return (
    <Modal title={`${tr('Close week', 'ሳምንቱን ዝጋ')} ${weekNo}`} size="lg" onClose={onClose} footer={<>
      <span className="grow muted small-text">{rows.length ? `${done} of ${rows.length} done · PPC ${Math.round((100 * done) / rows.length)} %` : ''}</span>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy || !rows.length || missing > 0} title={missing ? `${missing} commitment(s) need a result or reason` : undefined} onClick={() => void save()}>{busy && <span className="spinner" />}{tr('Close week', 'ሳምንቱን ዝጋ')}</button>
    </>}>
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      {!q.data ? <Loading lines={4} /> : !rows.length ? <p className="muted">No commitments in this week.</p> : (
        <div className="stack tight">
          {rows.map((c) => {
            const r = get(c);
            return (
              <div key={c.id} className="card-lite">
                <div className="row">
                  <strong className="grow">{c.lookahead_items?.name ?? c.description}{c.description !== c.lookahead_items?.name ? <span className="muted"> · {c.description}</span> : null}{c.target_pct != null ? <span className="muted"> → {num(c.target_pct, 0)} %</span> : null}</strong>
                  <div className="segmented" role="radiogroup" aria-label="Result">
                    <button type="button" role="radio" aria-checked={r.outcome === 'completed'} className={r.outcome === 'completed' ? 'active' : ''} onClick={() => set(c, { outcome: 'completed' })}>{tr('Done', 'ተጠናቋል')}</button>
                    <button type="button" role="radio" aria-checked={r.outcome === 'not_completed'} className={r.outcome === 'not_completed' ? 'active' : ''} onClick={() => set(c, { outcome: 'not_completed' })}>{tr('Not done', 'አልተጠናቀቀም')}</button>
                  </div>
                </div>
                {r.outcome === 'not_completed' && (
                  <div className="stack tight mt-2">
                    <RncPicker value={r.rnc_code} onChange={(code) => set(c, { rnc_code: code })} />
                    <div className="form-grid">
                      <Field label={tr('Actual % reached', 'የደረሰበት %')}><input type="number" min={0} max={100} value={r.actual_pct} onChange={(e) => set(c, { actual_pct: e.target.value })} /></Field>
                      <Field label={tr('Note', 'ማስታወሻ')}><input value={r.rnc_note} onChange={(e) => set(c, { rnc_note: e.target.value })} /></Field>
                      <Field label={tr('Roll forward to next week', 'ወደ ቀጣይ ሳምንት አሸጋግር')} check><input type="checkbox" checked={r.roll} onChange={(e) => set(c, { roll: e.target.checked })} /></Field>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
