import { useMemo, useState } from 'react';
import { Inbox, KeyRound, Pencil, Plus, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { PendingItems, RoleMatrix } from '../components/admin/AdminTools';
import { useAuth } from '../lib/auth';
import { invalidateLookups, useAsync } from '../lib/hooks';
import { adminUsers, check, supabase } from '../lib/supabase';
import { invalidateAfterWrite } from '../lib/query';
import { ROLE_LABELS, type AppRole, type Profile } from '../lib/contract';
import { useUrlFilters } from '../lib/url';
import { Badge, DataTable, Drawer, ErrorBanner, Field, FilterBar, FilterSelect, Modal, Page, SearchInput, confirm, toast, useBusy } from '../components/ui';

const ROLES = Object.keys(ROLE_LABELS) as AppRole[];

export function Users() {
  const auth = useAuth();
  const isAdmin = auth.profile?.role === 'admin';
  const q = useAsync(async () => {
    const [profiles, members] = await Promise.all([
      supabase.from('profiles').select('*').order('full_name').then(check),
      supabase.from('project_members').select('project_id, user_id').then(check),
    ]);
    return { profiles: profiles as Profile[], members: members as { project_id: string; user_id: string }[] };
  }, [], { key: 'users' });
  const [f, setF, { active, clear }] = useUrlFilters({ role: '', status: 'active', project: '', q: '' });
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);
  const [pwFor, setPwFor] = useState<Profile | null>(null);
  const [pendingFor, setPendingFor] = useState<Profile | null>(null);
  const [matrix, setMatrix] = useState(false);
  const { busy, error, run } = useBusy();

  const projCode = useMemo(() => new Map(auth.projects.map((p) => [p.id, p.code])), [auth.projects]);
  const projectsOf = (id: string) => (q.data?.members ?? []).filter((m) => m.user_id === id).map((m) => projCode.get(m.project_id) ?? '').filter(Boolean);
  const term = f.q.toLowerCase();
  const rows = (q.data?.profiles ?? []).filter((p) => (!f.role || p.role === f.role) && (!f.status || (f.status === 'active') === p.is_active)
    && (!f.project || (q.data?.members ?? []).some((m) => m.user_id === p.id && m.project_id === f.project))
    && (!term || [p.full_name, p.email, p.phone].some((v) => (v ?? '').toLowerCase().includes(term))));

  const setActive = async (list: Profile[], value: boolean) => {
    const targets = list.filter((p) => p.id !== auth.profile?.id && p.is_active !== value && (isAdmin || p.role !== 'admin'));
    if (!targets.length) return;
    const who = targets.length === 1 ? (targets[0].full_name || targets[0].email || 'this user') : `${targets.length} users`;
    if (!(await confirm({ title: `${value ? 'Reactivate' : 'Deactivate'} ${who}?`, body: value ? undefined : <p className="muted mb-0">Their sessions will be ended (FR-ACC-05).{isAdmin ? ' Check what is waiting on them first (inbox button in their row).' : ''}</p>, confirm: value ? 'Reactivate' : 'Deactivate', danger: !value }))) return;
    void run(async () => {
      for (const p of targets) await adminUsers({ action: 'set_active', user_id: p.id, is_active: value });
      invalidateAfterWrite({ lookups: true });
      toast.success(`${who} ${value ? 'reactivated' : 'deactivated'}`);
    });
  };

  return (
    <Page title="Users" subtitle="Accounts, roles and project assignments"
      actions={<>
        <button onClick={() => setMatrix(true)}><ShieldCheck size={14} aria-hidden />Role permissions</button>
        <button className="primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden />New user</button>
      </>}>
      <ErrorBanner error={error ?? q.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Name, email, phone" />
        <FilterSelect label="Role" value={f.role} onChange={(v) => setF('role', v)} options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} />
        <FilterSelect label="Project" value={f.project} onChange={(v) => setF('project', v)} options={auth.projects.map((p) => ({ value: p.id, label: p.code }))} />
        <FilterSelect label="Status" value={f.status} onChange={(v) => setF('status', v)} options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data} exportName="users" urlKey="" stickyFirst filtered={active > 0} onClearFilters={clear}
        onRowClick={(p) => { if (p.role !== 'admin' || isAdmin) setEditing(p); }}
        selectable bulkActions={(sel, clearSel) => (
          <>
            <button className="small" onClick={() => { void setActive(sel, false); clearSel(); }}><UserX size={14} aria-hidden />Deactivate</button>
            <button className="small" onClick={() => { void setActive(sel, true); clearSel(); }}><UserCheck size={14} aria-hidden />Reactivate</button>
          </>
        )}
        empty={{ title: 'No users yet', action: <button className="primary small" onClick={() => setEditing('new')}>New user</button> }}
        columns={[
          { key: 'full_name', label: 'Name', render: (p) => <div><div className="strong">{p.full_name || '—'}</div><div className="muted small-text">{p.email ?? p.phone}</div></div> },
          { key: 'phone', label: 'Phone', hidden: true },
          { key: 'email', label: 'Email', hidden: true },
          { key: 'role', label: 'Role', value: (p) => ROLE_LABELS[p.role], render: (p) => <Badge tone={p.role === 'admin' ? 'primary' : 'neutral'} icon={null} label={ROLE_LABELS[p.role]} /> },
          { key: 'projects', label: 'Projects', value: (p) => projectsOf(p.id).join(', '), render: (p) => {
            const list = projectsOf(p.id);
            return list.length ? <span className="badges">{list.slice(0, 3).map((c) => <span className="chip" key={c}>{c}</span>)}{list.length > 3 && <span className="chip">+{list.length - 3}</span>}</span> : <span className="muted-dash">—</span>;
          } },
          { key: 'is_active', label: 'Status', value: (p) => (p.is_active ? 'Active' : 'Deactivated'), render: (p) => <Badge value={p.is_active ? 'active' : 'inactive'} /> },
          { key: '_a', label: '', noExport: true, align: 'right', sortable: false, render: (p) => {
            const locked = p.role === 'admin' && !isAdmin;
            return (
              <div className="row end">
                <button className="icon-btn sm" title="Edit" aria-label="Edit user" disabled={locked} onClick={() => setEditing(p)}><Pencil size={14} /></button>
                <button className="icon-btn sm" title="Reset password" aria-label="Reset password" disabled={locked} onClick={() => setPwFor(p)}><KeyRound size={14} /></button>
                {isAdmin && <button className="icon-btn sm" title="What is waiting on this user" aria-label="Pending items" onClick={() => setPendingFor(p)}><Inbox size={14} /></button>}
                <button className="icon-btn sm" title={p.is_active ? 'Deactivate' : 'Reactivate'} aria-label={p.is_active ? 'Deactivate' : 'Reactivate'}
                  disabled={busy || p.id === auth.profile?.id || locked} onClick={() => void setActive([p], !p.is_active)}>{p.is_active ? <UserX size={14} /> : <UserCheck size={14} />}</button>
              </div>
            );
          } },
        ]} />
      {editing && <UserDialog user={editing === 'new' ? null : editing} isAdmin={isAdmin}
        memberOf={editing === 'new' ? [] : (q.data?.members ?? []).filter((m) => m.user_id === editing.id).map((m) => m.project_id)}
        onClose={() => setEditing(null)} onDone={() => { toast.success(editing === 'new' ? 'User created' : 'User saved'); setEditing(null); invalidateAfterWrite(); invalidateLookups(); }} />}
      {pwFor && <PasswordDialog user={pwFor} onClose={() => setPwFor(null)} />}
      {pendingFor && <PendingItems user={pendingFor} onClose={() => setPendingFor(null)} />}
      {matrix && <RoleMatrix onClose={() => setMatrix(false)} />}
    </Page>
  );
}

function UserDialog({ user, isAdmin, memberOf, onClose, onDone }: { user: Profile | null; isAdmin: boolean; memberOf: string[]; onClose: () => void; onDone: () => void }) {
  const auth = useAuth();
  const [form, setForm] = useState({
    full_name: user?.full_name ?? '', email: user?.email ?? '', phone: user?.phone ?? '', role: (user?.role ?? 'site_engineer') as AppRole, password: '',
  });
  const [projects, setProjects] = useState<string[]>(user ? memberOf : auth.projectId ? [auth.projectId] : []);
  const { busy, error, run } = useBusy();
  const roles = ROLES.filter((r) => isAdmin || r !== 'admin');

  const save = () => run(async () => {
    if (!form.full_name.trim()) throw new Error('Full name is required');
    if (!user) {
      if (!form.email.trim() && !form.phone.trim()) throw new Error('Email or phone is required');
      if (form.password.length < 8) throw new Error('Password must be at least 8 characters');
      await adminUsers({ action: 'create', email: form.email.trim() || undefined, phone: form.phone.trim() || undefined, password: form.password,
        full_name: form.full_name.trim(), role: form.role, project_ids: projects });
    } else {
      await adminUsers({ action: 'update', user_id: user.id, full_name: form.full_name.trim(), role: form.role, phone: form.phone.trim() || undefined });
      // Project assignments (FR-ACC-04) are plain table writes for projects the current user manages.
      const add = projects.filter((p) => !memberOf.includes(p));
      const remove = memberOf.filter((p) => !projects.includes(p) && auth.projects.some((x) => x.id === p));
      if (add.length) check(await supabase.from('project_members').insert(add.map((project_id) => ({ project_id, user_id: user.id }))));
      for (const p of remove) check(await supabase.from('project_members').delete().match({ project_id: p, user_id: user.id }));
    }
    onDone();
  });

  return (
    <Drawer title={user ? `Edit ${user.full_name || user.email}` : 'New user'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Full name" required><input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
        <Field label="Email" hint={user ? 'Email cannot be changed here' : 'Email or phone required'}>
          <input type="email" value={form.email} disabled={!!user} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone" hint="International format, e.g. +2519…"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Role" required>
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as AppRole })}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </Field>
        {!user && <Field label="Initial password" required hint="At least 8 characters; ask the user to change it"><input type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>}
      </div>
      <h3>Projects</h3>
      {!auth.projects.length && <div className="muted">You are not a member of any project.</div>}
      {auth.projects.map((p) => (
        <label key={p.id} className="row" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={projects.includes(p.id)} onChange={(e) => setProjects(e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))} />
          <span className="strong">{p.code}</span> <span className="muted">{p.name}</span>
        </label>
      ))}
    </Drawer>
  );
}

function PasswordDialog({ user, onClose }: { user: Profile; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, run } = useBusy();
  return (
    <Modal title={`Reset password — ${user.full_name || user.email}`} onClose={onClose} footer={<>
      <button onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
      {!done && <button className="primary" disabled={busy || pw.length < 8} onClick={() => void run(async () => { await adminUsers({ action: 'reset_password', user_id: user.id, password: pw }); setDone(true); })}>Set password</button>}
    </>}>
      <ErrorBanner error={error} />
      {done ? <div className="banner ok" role="status">Password updated. Share it with the user securely.</div> : (
        <Field label="New password" hint="At least 8 characters"><input type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
      )}
    </Modal>
  );
}
