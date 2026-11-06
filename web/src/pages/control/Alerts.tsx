import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, RefreshCw } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups } from '../../lib/hooks';
import { check, fetchAll, supabase } from '../../lib/supabase';
import { canControl, type Alert, type AlertRule, type AlertRuleKey, type AlertSeverity } from '../../lib/contract-control';
import { rpcx } from '../../lib/fieldx';
import { dateTime, humanize, num, since } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { SBadge } from '../../components/field/StatusBadge';
import {
  Badge, Banner, DataTable, ErrorBanner, Field, FilterBar, FilterSelect, Modal, Page, ReasonModal, SearchInput, Tabs, confirm, toast, useBusy, useHashTab,
} from '../../components/ui';

const TABS = ['alerts', 'rules'] as const;
type Tab = (typeof TABS)[number];

export const RULE_LABEL: Record<string, { label: string; threshold: string }> = {
  consumption_variance: { label: 'Consumption over take-off', threshold: '% over earned qty' },
  large_adjustment: { label: 'Large stock adjustment', threshold: 'quantity' },
  emergency_not_regularised: { label: 'Emergency issue not regularised', threshold: 'hours' },
  gate_pass_overdue: { label: 'Returnable gate pass overdue', threshold: 'days grace' },
  delivery_outside_geofence: { label: 'Evidence outside the site geofence', threshold: '—' },
  gate_mismatch: { label: 'Gate check mismatch', threshold: '' },
  unmatched_vehicle_exit: { label: 'Loaded vehicle left without a pass', threshold: '' },
};
const SEV_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/** Where an alert's entity lives in the console. */
export const alertLink = (a: Pick<Alert, 'entity_type' | 'entity_id'>): string | null => {
  if (!a.entity_id) return null;
  switch (a.entity_type) {
    case 'gate_pass': return `/gate/${a.entity_id}`;
    case 'vehicle_movement': return '/gate#vehicles';
    case 'miv': return `/store?open=${a.entity_id}#miv`;
    case 'grn': return `/store?open=${a.entity_id}#grn`;
    case 'adjustment': return `/store?open=${a.entity_id}#adjustments`;
    case 'element': return `/elements?peek=${a.entity_id}`;
    case 'material_request': return `/requests/${a.entity_id}`;
    default: return null;
  }
};

/** Variance & anomaly alerts with acknowledge/close, rule thresholds and on-demand evaluation (D2). */
export function Alerts() {
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'alerts');
  const canManage = canControl(auth.profile?.role, 'alert.manage');
  return (
    <Page title="Alerts" subtitle="Rules on stock, gate and evidence data — raised every 15 minutes and on posting">
      <Tabs label="Alert sections" value={tab} onChange={setTab} tabs={[{ key: 'alerts', label: 'Alerts' }, { key: 'rules', label: 'Rules' }]} />
      {tab === 'alerts' ? <AlertsTab canManage={canManage} /> : <RulesTab canManage={canManage} />}
    </Page>
  );
}

function AlertsTab({ canManage }: { canManage: boolean }) {
  const projectId = useProjectId();
  const lk = useLookups(projectId);
  const q = useAsync(() => fetchAll<Alert>((a, b) => supabase.from('alerts').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).range(a, b), 5000),
    [projectId], { key: 'alerts' });
  const [f, setF, { active, clear }] = useUrlFilters({ status: 'active', severity: '', rule: '', q: '' });
  const [closing, setClosing] = useState<Alert[] | null>(null);
  const { busy, error, run } = useBusy();
  const all = q.data ?? [];
  const term = f.q.toLowerCase();
  const rows = all.filter((a) => (f.status === 'active' ? a.status !== 'closed' : f.status === 'any' || a.status === f.status) && (!f.severity || a.severity === f.severity)
    && (!f.rule || a.rule === f.rule) && (!term || `${a.title} ${a.details?.summary ?? ''}`.toLowerCase().includes(term)))
    .sort((a, b) => (Number(a.status === 'closed') - Number(b.status === 'closed')) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || b.created_at.localeCompare(a.created_at));
  const openCritical = all.filter((a) => a.status === 'open' && a.severity === 'critical').length;
  const evaluate = () => run(async () => {
    const r = await rpcx('evaluate_alerts', { project_id: projectId }) as { created?: number };
    q.reload();
    toast.success(r.created ? `${r.created} new alert${r.created === 1 ? '' : 's'} raised` : 'Rules evaluated — no new alerts');
  });
  const ack = async (sel: Alert[], done?: () => void) => {
    let ok = 0;
    for (const a of sel.filter((x) => x.status === 'open')) {
      try { await rpcx('alert_action', { alert_id: a.id, action: 'acknowledge' }); ok++; } catch (e) { toast.error(`${a.title}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (ok) toast.success(`${ok} alert${ok === 1 ? '' : 's'} acknowledged`);
    done?.();
  };
  return (
    <>
      {openCritical > 0 && <Banner tone="error">{openCritical} critical alert{openCritical === 1 ? '' : 's'} not yet acknowledged.</Banner>}
      <ErrorBanner error={q.error ?? error ?? lk.error} onRetry={q.reload} />
      <FilterBar active={active} onClear={clear}
        right={canManage && <button className="primary" disabled={busy} onClick={() => void evaluate()}>{busy ? <span className="spinner" /> : <RefreshCw size={14} aria-hidden />}Evaluate now</button>}>
        <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Search alerts" />
        <FilterSelect label="Status" value={f.status === 'active' ? '' : f.status} onChange={(v) => setF('status', v || 'active')} allLabel="Open or acknowledged"
          options={[{ value: 'any', label: 'Any status' }, { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'closed', label: 'Closed' }]} />
        <FilterSelect label="Severity" value={f.severity} onChange={(v) => setF('severity', v)} options={[{ value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }]} />
        <FilterSelect label="Rule" value={f.rule} onChange={(v) => setF('rule', v)} options={Object.entries(RULE_LABEL).map(([k, v]) => ({ value: k, label: v.label }))} />
      </FilterBar>
      <DataTable rows={rows} loading={!q.data || !lk.data} error={q.error} onRetry={q.reload} urlKey="" exportName="alerts" viewKey="alerts"
        filtered={active > 0} onClearFilters={clear} selectable={canManage}
        bulkActions={(sel, clr) => <>
          <button className="small" onClick={() => void ack(sel, clr)} disabled={!sel.some((a) => a.status === 'open')}><Check size={14} aria-hidden />Acknowledge</button>
          <button className="small" onClick={() => { setClosing(sel.filter((a) => a.status !== 'closed')); clr(); }} disabled={!sel.some((a) => a.status !== 'closed')}>Close…</button>
        </>}
        empty={{ title: 'No alerts', body: 'When a rule trips (variance, large adjustments, overdue returns, gate mismatches…) the alert appears here.' }}
        columns={[
          { key: 'severity', label: 'Severity', value: (r) => SEV_RANK[r.severity], render: (r) => <SBadge value={r.severity} /> },
          { key: 'title', label: 'Alert', render: (r) => { const to = alertLink(r); return <div><div className="strong">{to ? <Link to={to}>{r.title}</Link> : r.title}</div>{r.details?.summary && <div className="muted small-text">{String(r.details.summary)}</div>}</div>; },
            value: (r) => r.title },
          { key: 'rule', label: 'Rule', value: (r) => RULE_LABEL[r.rule]?.label ?? humanize(r.rule) },
          { key: 'status', label: 'Status', render: (r) => <SBadge value={r.status} /> },
          { key: 'created_at', label: 'Raised', value: (r) => r.created_at, render: (r) => <span title={dateTime(r.created_at)}>{since(r.created_at)}</span> },
          { key: 'acked', label: 'Acknowledged', value: (r) => (r.acked_by ? `${lk.data?.person(r.acked_by)} · ${dateTime(r.acked_at)}` : '') },
          { key: 'closed', label: 'Closed', hidden: true, value: (r) => (r.closed_by ? `${lk.data?.person(r.closed_by)} · ${dateTime(r.closed_at)} · ${r.close_note ?? ''}` : '') },
          { key: 'act', label: '', noExport: true, sortable: false, render: (r) => canManage && r.status !== 'closed' && (
            <span className="nowrap">
              {r.status === 'open' && <button className="small" onClick={(e) => { e.stopPropagation(); void ack([r]); }}>Acknowledge</button>}
              <button className="small" onClick={(e) => { e.stopPropagation(); setClosing([r]); }}>Close…</button>
            </span>) },
        ]} />
      {closing && closing.length > 0 && (
        <ReasonModal title={closing.length === 1 ? `Close alert` : `Close ${closing.length} alerts`} label="Closing note (what was done)" confirm={closing.length === 1 ? 'Close alert' : `Close ${closing.length}`}
          onClose={() => setClosing(null)}
          onSubmit={async (note) => {
            let ok = 0;
            for (const a of closing) { await rpcx('alert_action', { alert_id: a.id, action: 'close', note }); ok++; }
            toast.success(`${ok} alert${ok === 1 ? '' : 's'} closed`);
          }}>
          {closing.length === 1 && <p className="muted">{closing[0].title}</p>}
        </ReasonModal>
      )}
    </>
  );
}

const RULE_KEYS: AlertRuleKey[] = ['consumption_variance', 'large_adjustment', 'emergency_not_regularised', 'gate_pass_overdue', 'delivery_outside_geofence'];

function RulesTab({ canManage }: { canManage: boolean }) {
  const projectId = useProjectId();
  const auth = useAuth();
  const q = useAsync(async () => check(await supabase.from('alert_rules').select('*').or(`project_id.is.null,project_id.eq.${projectId}`)) as AlertRule[],
    [projectId], { key: 'alert-rules' });
  const [editing, setEditing] = useState<{ rule: AlertRuleKey; base: AlertRule | undefined; scope: 'project' | 'company' } | null>(null);
  const rows = RULE_KEYS.map((rule) => {
    const proj = q.data?.find((r) => r.rule === rule && r.project_id === projectId);
    const def = q.data?.find((r) => r.rule === rule && !r.project_id);
    return { id: rule, rule, eff: proj ?? def, proj, def };
  });
  const isAdmin = auth.profile?.role === 'admin';
  return (
    <>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <p className="muted">Each rule has a company default; a project rule overrides it. {canManage ? 'Click a rule to set this project\'s threshold.' : ''}</p>
      <DataTable rows={rows} loading={!q.data} onRowClick={canManage ? (r) => setEditing({ rule: r.rule, base: r.eff, scope: 'project' }) : undefined} columns={[
        { key: 'rule', label: 'Rule', value: (r) => RULE_LABEL[r.rule].label, render: (r) => <div><div className="strong">{RULE_LABEL[r.rule].label}</div><div className="muted small-text">{String(r.eff?.params?.note ?? '')}</div></div> },
        { key: 'threshold', label: 'Threshold', align: 'right', value: (r) => r.eff?.threshold, render: (r) => (r.eff ? <>{num(r.eff.threshold)}<span className="unit">{RULE_LABEL[r.rule].threshold}</span></> : '') },
        { key: 'severity', label: 'Severity', render: (r) => <SBadge value={r.eff?.severity} /> },
        { key: 'active', label: 'Active', render: (r) => <SBadge value={r.eff?.is_active ? 'active' : 'inactive'} /> },
        { key: 'scope', label: 'Source', value: (r) => (r.proj ? 'This project' : 'Company default'), render: (r) => <Badge tone={r.proj ? 'primary' : 'neutral'} label={r.proj ? 'This project' : 'Company default'} icon={null} /> },
        { key: 'act', label: '', sortable: false, noExport: true, render: (r) => isAdmin && <button className="small" onClick={(e) => { e.stopPropagation(); setEditing({ rule: r.rule, base: r.def, scope: 'company' }); }}>Edit default</button> },
      ]} />
      {editing && <RuleModal {...editing} projectId={projectId} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleModal({ rule, base, scope, projectId, onClose }: { rule: AlertRuleKey; base: AlertRule | undefined; scope: 'project' | 'company'; projectId: string; onClose: () => void }) {
  const [threshold, setThreshold] = useState(String(base?.threshold ?? 0));
  const [severity, setSeverity] = useState<AlertSeverity>(base?.severity ?? 'warning');
  const [active, setActive] = useState(base?.is_active ?? true);
  const [params, setParams] = useState(JSON.stringify(base?.params ?? {}, null, 2));
  const { busy, error, run } = useBusy();
  const save = () => run(async () => {
    let p: Record<string, unknown>;
    try { p = JSON.parse(params || '{}') as Record<string, unknown>; } catch { throw new Error('Parameters must be valid JSON.'); }
    if (!Number.isFinite(Number(threshold))) throw new Error('Threshold must be a number.');
    if (!active && !(await confirm({ title: `Turn off “${RULE_LABEL[rule].label}”?`, body: <p className="muted mb-0">No new alerts of this kind will be raised{scope === 'project' ? ' for this project' : ''}.</p>, confirm: 'Turn off' }))) return;
    await rpcx('save_alert_rule', { project_id: scope === 'company' ? null : projectId, rule, threshold: Number(threshold), severity, is_active: active, params: p });
    toast.success(`${RULE_LABEL[rule].label}: saved`);
    onClose();
  });
  return (
    <Modal title={`${RULE_LABEL[rule].label} — ${scope === 'company' ? 'company default' : 'this project'}`} onClose={onClose} footer={<>
      <button onClick={onClose}>Cancel</button>
      <button className="primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save rule</button>
    </>}>
      <ErrorBanner error={error} />
      <div className="form-grid">
        <Field label="Threshold" hint={RULE_LABEL[rule].threshold}><input data-autofocus type="number" step="any" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
        <Field label="Severity">
          <select value={severity} onChange={(e) => setSeverity(e.target.value as AlertSeverity)}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select>
        </Field>
        <Field label="Active" check><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /></Field>
        <Field label="Parameters (JSON)" wide hint="e.g. {&quot;lookback_days&quot;: 7}"><textarea rows={4} value={params} onChange={(e) => setParams(e.target.value)} style={{ fontFamily: 'var(--font-mono, monospace)' }} /></Field>
      </div>
    </Modal>
  );
}
