// Users page tools: who can open which page / do which action (role permission matrix), and what is waiting on a
// user before they are deactivated (user_pending_items, admin only).
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { dateTime } from '../../lib/format';
import { ROLE_LABELS, can, type Action, type AppRole, type Profile } from '../../lib/contract';
import { NAV, navFor } from '../../nav';
import { supabase } from '../../lib/supabase';
import { DataTable, Drawer, Empty, ErrorBanner, Loading } from '../ui';
import '../finance/finance.css';

const ACTION_LABELS: Record<Action, string> = {
  'mr.create': 'Create material requests', 'mr.review': 'Review requests', 'mr.approve': 'Approve requests', 'mr.viewAll': 'See all requests',
  'grn.post': 'Receive goods (GRN)', 'grn.confirm': 'Confirm receipts', 'miv.post': 'Issue materials', 'miv.acknowledge': 'Acknowledge issues',
  'mrn.post': 'Return materials', 'adjustment.create': 'Stock adjustments', 'adjustment.decide': 'Decide adjustments', 'count.submit': 'Stock counts',
  'count.decide': 'Decide counts', 'transfer.post': 'Transfers', 'reverse': 'Reverse documents', 'progress.report': 'Report progress',
  'progress.verify': 'Verify progress', 'master.edit': 'Edit master data', 'prices.view': 'See prices & costs', 'users.manage': 'Manage users',
  'audit.view': 'Audit trail',
};

export function RoleMatrix({ onClose }: { onClose: () => void }) {
  const auth = useAuth();
  const roles = Object.keys(ROLE_LABELS) as AppRole[];
  const canAs = (r: AppRole) => (a: Action) => (a === 'prices.view' ? r === 'admin' || auth.priceRoles.includes(r) : can(r, a));
  const pages = NAV.map((n) => ({ to: n.to, label: n.label, group: n.group, by: Object.fromEntries(roles.map((r) => [r, navFor(r, canAs(r)).some((x) => x.to === n.to)])) }));
  const actions = (Object.keys(ACTION_LABELS) as Action[]).map((a) => ({ a, by: Object.fromEntries(roles.map((r) => [r, canAs(r)(a)])) }));
  const cols = roles.map((r) => ({ key: r, label: ROLE_LABELS[r], align: 'center' as const, value: (x: { by: Record<string, boolean> }) => (x.by[r] ? 'Yes' : ''),
    render: (x: { by: Record<string, boolean> }) => (x.by[r] ? <span className="yes" title="Allowed">●</span> : <span className="no">·</span>) }));
  return (
    <Drawer size="lg" onClose={onClose} title="Role permissions" subtitle="What each role can open and do. The server enforces the same rules; price access follows Settings → Who can see prices.">
      <div className="perm-matrix stack">
        <h3 className="mb-0">Pages</h3>
        <DataTable rows={pages} rowKey={(p) => p.to} exportName="role-pages" stickyFirst
          columns={[{ key: 'label', label: 'Page', id: true, render: (p) => <span>{p.label} <span className="muted small-text">{p.group}</span></span> }, ...cols]} />
        <h3 className="mb-0">Actions</h3>
        <DataTable rows={actions} rowKey={(x) => x.a} exportName="role-actions" stickyFirst
          columns={[{ key: 'a', label: 'Action', id: true, value: (x) => ACTION_LABELS[x.a] }, ...cols]} />
        <p className="small-text muted mb-0">Payments: the office engineer prepares, the coordinator checks, the manager approves and finance pays; a person cannot check or approve what they prepared.</p>
      </div>
    </Drawer>
  );
}

interface Pending { kind: string; entity_type: string; entity_id: string; project_id: string; number: string; title: string; status: string; requested_at: string; actions: string[]; age_hours: number }

export function PendingItems({ user, onClose }: { user: Profile; onClose: () => void }) {
  const auth = useAuth();
  const q = useAsync(async () => {
    const { data, error } = await supabase.rpc('user_pending_items', { p_user: user.id });
    if (error) throw new Error(error.message);
    return (data ?? []) as Pending[];
  }, [user.id], { key: 'user-pending' });
  const code = (id: string) => auth.projects.find((p) => p.id === id)?.code ?? '';
  return (
    <Drawer size="lg" onClose={onClose} title={`Waiting on ${user.full_name || user.email}`}
      subtitle={`${ROLE_LABELS[user.role]} · items in their Approvals inbox. Before deactivating, make sure another ${ROLE_LABELS[user.role].toLowerCase()} is on these projects.`}>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      {!q.data ? <Loading lines={4} /> : !q.data.length ? <Empty title="Nothing is waiting on this user">They can be deactivated without blocking anyone.</Empty> : (
        <DataTable rows={q.data} rowKey={(r) => `${r.entity_type}:${r.entity_id}:${r.actions.join()}`} exportName={`pending-${user.full_name}`}
          columns={[
            { key: 'project', label: 'Project', value: (r) => code(r.project_id) },
            { key: 'number', label: 'Document', id: true },
            { key: 'title', label: 'What', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.title}</span> },
            { key: 'action', label: 'Their step', value: (r) => r.actions.join(', ') },
            { key: 'requested_at', label: 'Since', render: (r) => dateTime(r.requested_at) },
          ]} />
      )}
      <p className="small-text muted">Role-based items move to whoever else holds the role on the project. <Link to="/approvals">Open the Approvals inbox</Link>.</p>
    </Drawer>
  );
}
