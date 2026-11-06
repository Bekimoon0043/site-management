import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, ClipboardList, Flame, Package, TrendingUp } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import type { AppNotification } from '../../lib/contract';
import { ago } from '../../lib/format';
import { Popover } from '../Popover';
import { Tabs } from '../Tabs';

const ACTIONABLE = new Set(['material_request', 'adjustment', 'stock_count', 'progress_update', 'miv', 'delivery_notice', 'holiday_decision',
  'hse_incident', 'work_permit', 'rfi', 'submittal', 'meeting_action', 'risk', 'eot_claim', 'supplier_invoice', 'petty_cash', 'retention_release']);

/** Where a notification about an entity should take the user. */
export function notificationTarget(n: Pick<AppNotification, 'entity_type' | 'entity_id'>): string | null {
  switch (n.entity_type) {
    case 'material_request': return n.entity_id ? `/requests/${n.entity_id}` : '/requests';
    case 'adjustment': return `/approvals?type=adjustment${n.entity_id ? `&id=${n.entity_id}` : ''}`;
    case 'stock_count': return `/approvals?type=count${n.entity_id ? `&id=${n.entity_id}` : ''}`;
    case 'progress_update': return `/approvals?type=progress${n.entity_id ? `&id=${n.entity_id}` : ''}`;
    case 'miv': return n.entity_id ? `/store?open=${n.entity_id}#miv` : '/store#miv';
    case 'grn': return n.entity_id ? `/store?open=${n.entity_id}#grn` : '/store#grn';
    case 'delivery_notice': return n.entity_id ? `/deliveries?open=${n.entity_id}` : '/deliveries';
    case 'approval_delegation': return '/preferences';
    case 'holiday_decision': return `/calendar${n.entity_id ? `?decision=${n.entity_id}` : ''}`;
    case 'hse_incident': return '/safety#incidents';
    case 'work_permit': return '/safety#permits';
    case 'plant_item': case 'plant_log': return '/plant#log';
    case 'tool_item': return '/store#tools';
    case 'supplier_invoice': return '/payments/invoices';
    case 'petty_cash': return '/payments/petty-cash';
    case 'rfi': return '/office#rfis';
    case 'submittal': return '/office#submittals';
    case 'meeting_action': return '/office#meetings';
    case 'risk': return '/office#risks';
    case 'eot_claim': return '/office#claims';
    case 'retention_release': return '/office/receivables#retention';
    default: return null;
  }
}

function iconFor(n: AppNotification) {
  if (n.is_critical) return <Flame size={16} className="danger-text" aria-hidden />;
  if (n.entity_type === 'material_request') return <ClipboardList size={16} aria-hidden />;
  if (n.entity_type === 'progress_update') return <TrendingUp size={16} aria-hidden />;
  return <Package size={16} aria-hidden />;
}

/** Bell + 380px popover: For me / All, unread dots, mark read on click, mark all. Polls 60 s while visible. */
export function Notifications() {
  const auth = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const uid = auth.session?.user.id;
  const [tab, setTab] = useState<'me' | 'all'>('me');
  const q = useAsync(async () => check(await supabase.from('notifications').select('id, user_id, project_id, title, body, entity_type, entity_id, is_critical, read_at, created_at')
    .eq('user_id', uid!).order('created_at', { ascending: false }).limit(40)) as AppNotification[],
  [uid], { key: 'notifications', enabled: !!uid, refetchInterval: 60_000, staleTime: 30_000 });

  const rows = q.data ?? [];
  const unread = rows.filter((n) => !n.read_at).length;
  const forMe = rows.filter((n) => !n.read_at && (n.is_critical || ACTIONABLE.has(n.entity_type ?? '')));
  const shown = tab === 'me' ? forMe : rows;

  const markRead = async (ids?: string[]) => {
    // Optimistic: low-risk toggle (spec §5.20).
    qc.setQueriesData<AppNotification[]>({ queryKey: ['notifications'] }, (old) => old?.map((n) => (!ids || ids.includes(n.id) ? { ...n, read_at: n.read_at ?? new Date().toISOString() } : n)));
    await supabase.rpc('mark_notifications_read', { p: { op_id: crypto.randomUUID(), ...(ids ? { ids } : {}) } });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <Popover align="right" className="notif-pop" trigger={(p) => (
      <button className="icon-btn bell" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} title="Notifications" {...p}>
        <Bell size={18} />{unread > 0 && <span className="count">{unread > 99 ? '99+' : unread}</span>}
      </button>
    )}>
      {(close) => (
        <>
          <div className="row" style={{ padding: '8px 12px 0', justifyContent: 'space-between' }}>
            <strong>Notifications</strong>
            <button className="link-btn small-text" disabled={!unread} onClick={() => void markRead()}><CheckCheck size={14} aria-hidden /> Mark all read</button>
          </div>
          <div style={{ padding: '0 8px' }}>
            <Tabs value={tab} onChange={setTab} tabs={[{ key: 'me', label: 'For me', count: forMe.length, hot: true }, { key: 'all', label: 'All' }]} />
          </div>
          <div className="popover-scroll">
            {!shown.length && <div className="empty inline">{tab === 'me' ? "You're all caught up." : 'No notifications yet.'}</div>}
            {shown.map((n) => (
              <button key={n.id} className={`notif-item${n.read_at ? ' read' : ''}`} onClick={() => {
                if (!n.read_at) void markRead([n.id]);
                const to = notificationTarget(n);
                close();
                if (to) nav(to);
              }}>
                <span className="unread-dot" aria-hidden />
                {iconFor(n)}
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: n.read_at ? 400 : 500 }}>{n.title}</span>
                  {n.body && <span className="small-text muted" style={{ display: 'block' }}>{n.body}</span>}
                </span>
                <span className="when">{ago(n.created_at)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}
