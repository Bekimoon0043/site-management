import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAsync, type Lookups } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { DELAY_CAUSE_LABELS, type DiaryDelay, type SiteDiary } from '../../lib/contract-field';
import { rpcx } from '../../lib/fieldx';
import { date, dateTime, hoursSince, humanize, num } from '../../lib/format';
import type { PreviewActions } from '../approval/Previews';
import { Attachments } from '../Attachments';
import { ErrorBanner, Loading, useBusy } from '../ui';
import { SBadge } from './StatusBadge';

export type DiaryQueueRow = SiteDiary;

/** Inbox preview for a submitted site diary: key facts, sign / return (sign_site_diary). */
export function DiaryPreview({ row, L, onDone, onActions }: { row: DiaryQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: PreviewActions) => void }) {
  const q = useAsync(async () => {
    const [labour, delays] = await Promise.all([
      supabase.from('diary_labour').select('headcount').eq('diary_id', row.id).is('deleted_at', null).then(check) as Promise<{ headcount: number }[]>,
      supabase.from('diary_delays').select('*').eq('diary_id', row.id).is('deleted_at', null).then(check) as Promise<DiaryDelay[]>,
    ]);
    return { headcount: labour.reduce((s, l) => s + Number(l.headcount), 0), delays };
  }, [row.id], { key: 'diary-preview' });
  const [comment, setComment] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const { busy, error, run } = useBusy();
  const decide = (approve: boolean) => {
    if (!approve && !comment.trim()) { ref.current?.focus(); return; }
    void run(async () => {
      await rpcx('sign_site_diary', { diary_id: row.id, approve, comment: comment.trim() || undefined });
      onDone(`${row.number} ${approve ? 'signed' : 'returned'}`);
    });
  };
  useEffect(() => { onActions({ approve: () => decide(true), reject: () => decide(false) }); });
  const waiting = hoursSince(row.submitted_at);
  return (
    <>
      <div className="inbox-preview-body">
        <div className="inbox-preview-head">
          <h2><Link to={`/diary/${row.id}?from=approvals`}>{row.number} <ExternalLink size={14} aria-hidden /></Link><SBadge value={row.status} label="Awaiting sign-off" /></h2>
          <div className="meta">{date(row.diary_date)} · {row.block_id ? `Block ${L.block(row.block_id)}` : 'Whole site'} · by {L.person(row.created_by)} · submitted {dateTime(row.submitted_at)} ({num(waiting, 0)} h)</div>
        </div>
        <ErrorBanner error={error ?? q.error} />
        <dl className="kv">
          <dt>Weather</dt><dd>{[row.weather_am, row.weather_pm].filter(Boolean).map((w) => humanize(w)).join(' / ') || '—'}{row.rain_hours ? ` · rain ${num(row.rain_hours, 1)} h` : ''}</dd>
          <dt>Labour</dt><dd>{q.data ? `${q.data.headcount} people` : '…'}</dd>
          <dt>Delays</dt><dd>{!q.data ? '…' : q.data.delays.length ? q.data.delays.map((d) => `${DELAY_CAUSE_LABELS[d.cause] ?? d.cause}${d.hours_lost ? ` ${num(d.hours_lost, 1)} h` : ''}`).join(', ') : 'None'}</dd>
          <dt>Safety</dt><dd>{row.safety_notes || '—'}</dd>
        </dl>
        <div><h3>Work done</h3><p style={{ whiteSpace: 'pre-wrap' }}>{row.work_summary || <span className="muted">No summary written.</span>}</p></div>
        {!q.data ? <Loading lines={2} /> : <div><h3>Photos</h3><Attachments entityType="site_diary" entityId={row.id} /></div>}
      </div>
      <div className="action-bar">
        <textarea ref={ref} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What needs correcting (required to return)" aria-label="Comment" />
        <button disabled={busy} onClick={() => decide(false)}>Return<kbd style={{ marginLeft: 4 }}>R</kbd></button>
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{busy && <span className="spinner" />}Sign diary<kbd style={{ marginLeft: 4 }}>A</kbd></button>
      </div>
    </>
  );
}
