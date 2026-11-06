import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { check, supabase } from '../../lib/supabase';
import { canControl, type ProjectChannel } from '../../lib/contract-control';
import { optStr, rpcx, uuid } from '../../lib/fieldx';
import { Badge, Card, DataTable, ErrorBanner, Field, Modal, toast, useBusy } from '../ui';

const KINDS = [{ value: 'daily_summary', label: 'Daily summary' }, { value: 'alerts', label: 'Alerts' }];

/** Settings card: Telegram group(s) that receive the project's daily summary and alerts (save_project_channel). */
export function ProjectChannels() {
  const auth = useAuth();
  const projectId = auth.projectId ?? '';
  const canManage = canControl(auth.profile?.role, 'channel.manage');
  const q = useAsync(async () => check(await supabase.from('project_channels').select('*').eq('project_id', projectId).order('created_at')) as ProjectChannel[],
    [projectId], { key: 'project-channels', enabled: !!projectId });
  const [editing, setEditing] = useState<ProjectChannel | 'new' | null>(null);
  return (
    <Card title={`Telegram channel${auth.project ? ` — ${auth.project.code}` : ''}`} sub="Add the bot to the project's Telegram group, then enter the group's chat id (a negative number, e.g. -1001234567890)."
      actions={canManage && projectId && <button className="small" onClick={() => setEditing('new')}><Plus size={14} aria-hidden />Add channel</button>}>
      {!projectId ? <p className="muted mb-0">Select a project first.</p> : (
        <>
          <ErrorBanner error={q.error} onRetry={q.reload} />
          <DataTable rows={q.data ?? []} loading={!q.data} maxHeight="none" onRowClick={canManage ? (r) => setEditing(r) : undefined}
            empty="No Telegram group linked to this project." columns={[
              { key: 'title', label: 'Group', value: (r) => r.title || String(r.chat_id) },
              { key: 'chat_id', label: 'Chat id' },
              { key: 'kinds', label: 'Posts', value: (r) => r.kinds.map((k) => KINDS.find((x) => x.value === k)?.label ?? k).join(', ') },
              { key: 'is_active', label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
            ]} />
        </>
      )}
      <p className="muted small-text mb-0">Personal Telegram linking and notification channels are under <Link to="/preferences">My preferences</Link>.</p>
      {editing && <ChannelModal channel={editing === 'new' ? null : editing} projectId={projectId} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ChannelModal({ channel, projectId, onClose }: { channel: ProjectChannel | null; projectId: string; onClose: () => void }) {
  const [form, setForm] = useState({ chat_id: channel ? String(channel.chat_id) : '', title: channel?.title ?? '', kinds: channel?.kinds ?? ['daily_summary', 'alerts'], is_active: channel?.is_active ?? true });
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    if (!/^-?\d{5,20}$/.test(form.chat_id.trim())) throw new Error('Chat id must be a number such as -1001234567890.');
    await rpcx('save_project_channel', { id: channel?.id ?? uuid(), project_id: projectId, chat_id: Number(form.chat_id.trim()), title: optStr(form.title), kinds: form.kinds, is_active: form.is_active });
    toast.success('Telegram channel saved');
    onClose();
  });
  return (
    <Modal title={channel ? 'Edit Telegram channel' : 'Add Telegram channel'} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid one">
        <Field label="Chat id" required hint="Forward a group message to @userinfobot or check the bot's update log to find it"><input data-autofocus inputMode="numeric" value={form.chat_id} onChange={(e) => setForm({ ...form, chat_id: e.target.value })} /></Field>
        <Field label="Name"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Site A — management" /></Field>
        <Field label="Post">
          <div className="check-list">
            {KINDS.map((k) => <label key={k.value}><input type="checkbox" checked={form.kinds.includes(k.value)} onChange={(e) => setForm({ ...form, kinds: e.target.checked ? [...form.kinds, k.value] : form.kinds.filter((x) => x !== k.value) })} />{k.label}</label>)}
          </div>
        </Field>
        <Field label="Active" check><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /></Field>
      </div>
    </Modal>
  );
}
