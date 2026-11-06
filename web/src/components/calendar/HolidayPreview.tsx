// Approvals inbox: a public holiday within 30 days that needs a work / no-work decision (kind 'holiday',
// app.calendar_approvals_for in 20261105000010_project_calendar.sql).
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { useAsync, type Lookups } from '../../lib/hooks';
import type { PlanQueueRow } from '../../lib/approvals';
import { ErrorBanner, Loading } from '../ui';
import { loadDecision } from './data';
import { HolidayPanel } from './HolidayPanel';
import './calendar.css';

interface Props { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: { approve?: () => void; reject?: () => void }) => void }

export function HolidayPreview({ row, L, onDone, onActions }: Props) {
  const q = useAsync(() => loadDecision(row.entity_id), [row.entity_id, row.status], { key: 'holiday-decision' });
  useEffect(() => { onActions({}); });
  if (!q.data) return <div className="inbox-preview-body">{q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={4} />}</div>;
  return (
    <div className="inbox-preview-body">
      <div className="inbox-preview-head">
        <h2><Link to={`/calendar?decision=${q.data.id}`}>Public holiday — work or not? <ExternalLink size={14} aria-hidden /></Link></h2>
      </div>
      <HolidayPanel d={q.data} L={L} onChanged={onDone} />
    </div>
  );
}
