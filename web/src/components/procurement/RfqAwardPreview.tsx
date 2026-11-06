// Approvals inbox: an RFQ with its quotations in, waiting for management to award (v_my_approvals kind 'rfq_award').
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAsync, type Lookups } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { loadRfqDetail } from '../../lib/procurement';
import { canProcure } from '../../lib/contract-procurement';
import type { PlanQueueRow } from '../../lib/approvals';
import { ErrorBanner, Loading } from '../ui';
import { Comparison } from './Comparison';

export function RfqAwardPreview({ row, L, onActions }: { row: PlanQueueRow; L: Lookups; onDone: (msg: string) => void; onActions: (a: object) => void }) {
  const auth = useAuth();
  const q = useAsync(() => loadRfqDetail(row.entity_id, auth.canSeePrices), [row.entity_id, auth.canSeePrices], { key: 'rfq-detail' });
  useEffect(() => { onActions({}); });
  if (!q.data) return q.error ? <ErrorBanner error={q.error} onRetry={q.reload} /> : <Loading lines={6} />;
  return (
    <>
      <div className="inbox-preview-head">
        <h2>{row.title}</h2>
        <div className="meta">{row.number} · sent by {L.person(row.requested_by)} · {dateTime(row.requested_at)} · <Link to={`/procurement/rfq/${row.entity_id}`}>Open RFQ</Link></div>
      </div>
      <div className="inbox-preview-body">
        <Comparison d={q.data} L={L} canAward={canProcure(auth.profile?.role, 'rfq.award') && auth.canSeePrices} />
      </div>
    </>
  );
}
