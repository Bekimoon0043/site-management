import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync } from '../../lib/hooks';
import { countRows, supabase } from '../../lib/supabase';
import { canField } from '../../lib/contract-field';
import { Page, Tabs, useHashTab } from '../../components/ui';
import { InspectionsTab } from './QualityInspections';
import { SnagsTab } from './QualitySnags';
import { TemplatesTab } from './QualityTemplates';

const TABS = ['inspections', 'snags', 'templates'] as const;
type Tab = (typeof TABS)[number];

/** Quality: inspection register (ITP), snag list and checklist templates (P1-7). */
export function Quality() {
  const projectId = useProjectId();
  const auth = useAuth();
  const [tab, setTab] = useHashTab<Tab>(TABS, 'inspections');
  const counts = useAsync(async () => {
    const [requested, open] = await Promise.all([
      countRows(() => supabase.from('inspections').select('id', { count: 'exact', head: true }).eq('project_id', projectId).eq('status', 'requested')),
      countRows(() => supabase.from('snags').select('id', { count: 'exact', head: true }).eq('project_id', projectId).in('status', ['open', 'in_progress', 'ready_for_review', 'reopened'])),
    ]);
    return { requested, open };
  }, [projectId], { key: 'quality-counts' });
  const canTemplates = canField(auth.profile?.role, 'checklist.edit');
  return (
    <Page title="Quality" subtitle="Inspections against checklists, hold points and the snag list">
      <Tabs label="Quality sections" value={tab} onChange={setTab} tabs={[
        { key: 'inspections', label: 'Inspections', count: counts.data?.requested, hot: !!counts.data?.requested },
        { key: 'snags', label: 'Snags', count: counts.data?.open, hot: !!counts.data?.open },
        { key: 'templates', label: canTemplates ? 'Checklist templates' : 'Checklists' },
      ]} />
      {tab === 'inspections' && <InspectionsTab />}
      {tab === 'snags' && <SnagsTab />}
      {tab === 'templates' && <TemplatesTab />}
    </Page>
  );
}
