import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { PlanQueueRow } from '../../lib/approvals';
import { dateTime, humanize } from '../../lib/format';
import { toast } from '../ui';
import { officeRpc } from '../office/data';

const TARGET: Record<string, string> = {
  rfi: '/office#rfis', submittal: '/office#submittals', meeting_action: '/office#meetings', risk: '/office#risks',
  eot_claim: '/office#claims', client_ipc_due: '/office/receivables#ageing', retention_release: '/office/receivables#retention',
};

export function OfficePreview({ row, onDone, onActions }: {
  row: PlanQueueRow; onDone: (msg: string) => void; onActions: (a: object) => void;
}) {
  useEffect(() => { onActions({}); });
  const markDone = async () => {
    await officeRpc('save_action_item', { id: row.entity_id, project_id: row.project_id, action: 'done' });
    toast.success(`${row.number} marked done`);
    onDone(`${row.number} done`);
  };
  return (
    <>
      <div className="inbox-preview-head">
        <h2>{row.number}</h2>
        <div className="meta">{humanize(row.entity_type)} · {humanize(row.status)} · {row.requested_at ? dateTime(row.requested_at) : ''}</div>
      </div>
      <div className="inbox-preview-body stack">
        <p>{row.title}</p>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {row.entity_type === 'meeting_action' && row.actions.includes('done') && <button className="primary" onClick={() => void markDone()}>Mark action done</button>}
          <Link className="button" to={TARGET[row.entity_type] ?? '/office'}>Open register <ExternalLink size={14} aria-hidden /></Link>
        </div>
      </div>
    </>
  );
}
