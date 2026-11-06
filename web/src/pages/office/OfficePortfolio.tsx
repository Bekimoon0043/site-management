// Cross-project office portfolio for managers: open administration work and completion exposure.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { date, num } from '../../lib/format';
import type { PortfolioRow } from '../../lib/contract-office';
import { Badge, Card, DataTable, ErrorBanner, Kpi, Page, Tabs } from '../../components/ui';
import { loadPortfolio } from '../../components/office/data';

export function OfficePortfolio() {
  const auth = useAuth();
  const nav = useNavigate();
  const q = useAsync(loadPortfolio, [], { key: 'office-portfolio' });
  const [view, setView] = useState<'active' | 'all'>('active');
  const all = q.data ?? [];
  const rows = all.filter((r) => view === 'all' || r.is_active);
  const sum = (key: keyof Pick<PortfolioRow, 'rfis_overdue' | 'actions_overdue' | 'risks_high' | 'claims_open'>) => rows.reduce((s, r) => s + Number(r[key]), 0);
  const openProject = (r: PortfolioRow) => {
    auth.setProjectId(r.project_id);
    nav('/office#rfis');
  };
  return (
    <Page title="Office portfolio" subtitle="Contract administration workload and completion exposure across your projects" width="dash">
      <div className="kpis">
        <Kpi label="Projects in view" value={rows.length} hint={`${all.filter((r) => r.is_active).length} active`} />
        <Kpi label="Overdue RFIs" value={sum('rfis_overdue')} status={sum('rfis_overdue') ? 'danger' : 'ok'} />
        <Kpi label="Overdue meeting actions" value={sum('actions_overdue')} status={sum('actions_overdue') ? 'warning' : 'ok'} />
        <Kpi label="High risks / issues" value={sum('risks_high')} status={sum('risks_high') ? 'danger' : 'ok'} />
        <Kpi label="Open EOT claims" value={sum('claims_open')} />
      </div>
      <ErrorBanner error={q.error} onRetry={q.reload} />
      <div className="row mb-2">
        <Tabs variant="segmented" value={view} onChange={setView} tabs={[{ key: 'active', label: 'Active projects' }, { key: 'all', label: 'All projects' }]} />
      </div>
      <Card flush title="Project administration register" sub="Select a project to open its contract administration registers.">
        <DataTable rows={rows} rowKey={(r) => r.project_id} loading={!q.data} onRowClick={openProject} exportName="office-portfolio"
          rowClass={(r) => (r.rfis_overdue > 0 || r.actions_overdue > 0 || r.risks_high > 0 ? 'row-warn' : undefined)}
          empty={{ title: 'No projects in this view', body: view === 'active' ? 'Switch to All projects to include completed or inactive work.' : 'The portfolio contains projects of which you are a member.' }}
          columns={[
            { key: 'code', label: 'Project', id: true, render: (r) => <span><strong>{r.code}</strong><span className="muted"> · {r.name}</span></span>, value: (r) => `${r.code} ${r.name}` },
            { key: 'client', label: 'Client', render: (r) => r.client ?? '—' },
            { key: 'is_active', label: 'State', value: (r) => (r.is_active ? 'active' : 'inactive'), render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
            { key: 'end_date', label: 'Original completion', value: (r) => r.end_date ?? '', render: (r) => (r.end_date ? date(r.end_date) : '—') },
            { key: 'revised_completion', label: 'Revised completion', value: (r) => r.revised_completion ?? '', render: (r) => <span>{r.revised_completion ? date(r.revised_completion) : '—'}{Number(r.days_granted) > 0 && <span className="muted small-text"> (+{num(r.days_granted, 1)} d)</span>}</span> },
            { key: 'days_pending', label: 'EOT days pending', align: 'right', render: (r) => num(r.days_pending, 1) },
            { key: 'rfis_open', label: 'Open RFIs', align: 'right', render: (r) => <span>{r.rfis_open}{r.rfis_overdue > 0 && <span className="danger-text strong"> · {r.rfis_overdue} late</span>}</span> },
            { key: 'sis_open', label: 'Open SIs', align: 'right' },
            { key: 'submittals_pending', label: 'Submittals pending', align: 'right' },
            { key: 'actions_overdue', label: 'Actions overdue', align: 'right', render: (r) => (r.actions_overdue ? <span className="danger-text strong">{r.actions_overdue}</span> : 0) },
            { key: 'risks_high', label: 'High risks', align: 'right', render: (r) => (r.risks_high ? <span className="danger-text strong">{r.risks_high}</span> : 0) },
            { key: 'claims_open', label: 'Open claims', align: 'right' },
          ]} />
      </Card>
    </Page>
  );
}
