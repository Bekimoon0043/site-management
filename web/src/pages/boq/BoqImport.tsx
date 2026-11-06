// /boq/import — bill of quantities, separate from the schedule import: either from the BoQ columns
// (Unit / Qty / Rate / Amount) of an already imported MS Project schedule, or from an Excel sheet.
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarRange, FileSpreadsheet } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { invalidate, useAsync } from '../../lib/hooks';
import { useUrlParam } from '../../lib/url';
import { fetchAll, supabase, check } from '../../lib/supabase';
import type { BoqSource, CustomFieldDef } from '../../lib/msp';
import { Banner, Card, Empty, ErrorBanner, Field, Loading, Page, Stepper } from '../../components/ui';
import { BoqExcelImport } from '../../components/boq/BoqExcelImport';
import { canEditSchedule, loadSchedules, type SchedHeader } from '../../components/schedule/data';
import {
  BaselineOffer, BoqResult, EmbeddedBoqCard, EmbeddedBoqStep, boqPayload, initEmbeddedBoq, runCreateBoq,
  type BoqRunState, type EmbeddedBoqCfg, type EmbeddedBoqState,
} from '../../components/schedule/EmbeddedBoq';
import { ElementsFromSchedule } from '../../components/schedule/ElementsFromSchedule';
import '../../components/schedule/schedule.css';

type SourceKind = 'schedule' | 'excel';

export function BoqImport() {
  const projectId = useProjectId();
  const auth = useAuth();
  const nav = useNavigate();
  const [from, setFrom] = useUrlParam('from');
  const sq = useAsync(() => loadSchedules(projectId), [projectId], { key: 'schedules', staleTime: 60_000 });
  const schedules = sq.data?.schedules ?? [];

  if (!canEditSchedule(auth.profile?.role)) {
    return <Page title="Import BoQ"><Empty title="No access">Only office engineers, coordinators and managers import the BoQ. You can view it under Elements &amp; BoQ.</Empty></Page>;
  }
  const kind: SourceKind = from === 'excel' || from === 'schedule' ? from : sq.data && !schedules.length ? 'excel' : 'schedule';
  const kinds: { key: SourceKind; icon: ReactNode; title: string; body: string }[] = [
    { key: 'schedule', icon: <CalendarRange size={16} aria-hidden />, title: 'From the imported schedule',
      body: 'Your MS Project file has Unit, Qty, Rate and Amount columns. Each task with a quantity becomes a BoQ item, linked to its task.' },
    { key: 'excel', icon: <FileSpreadsheet size={16} aria-hidden />, title: 'From an Excel file',
      body: 'A sheet with Item no, Description, Unit, Quantity and Rate. Link the items to tasks later on Import schedule.' },
  ];

  return (
    <Page title="Import BoQ" width="form" breadcrumbs={[{ label: 'Elements & BoQ', to: '/elements#boq' }, { label: 'Import BoQ' }]}
      subtitle="Bring in the bill of quantities. Re-importing updates items with the same item number."
      actions={<button onClick={() => nav('/elements#boq')}>Close</button>}>
      <div className="stack">
        <Card title="Where is your BoQ?">
          <div className="choice-cards">
            {kinds.map((k) => (
              <button key={k.key} className={`choice-card${kind === k.key ? ' active' : ''}`} aria-pressed={kind === k.key} onClick={() => setFrom(k.key)}>
                <strong>{k.icon}{k.title}</strong><span className="muted">{k.body}</span>
              </button>
            ))}
          </div>
        </Card>
        {kind === 'excel' ? <BoqExcelImport projectId={projectId} canSeePrices={auth.canSeePrices} />
          : sq.error ? <ErrorBanner error={sq.error} onRetry={sq.reload} />
          : !sq.data ? <Loading lines={4} />
          : !schedules.length ? (
            <Empty title="No schedule imported yet" action={<button className="primary" onClick={() => nav('/schedule/import')}>Import schedule</button>}>
              Import the MS Project schedule first, then come back here to create the BoQ from its columns.
            </Empty>
          ) : <FromSchedule projectId={projectId} schedules={schedules} canSeePrices={auth.canSeePrices} />}
      </div>
    </Page>
  );
}

interface TaskRow { id: string; msp_uid: number; parent_id: string | null; name: string; wbs: string | null; outline_number: string | null; is_summary: boolean; custom: Record<string, string> | null }

async function loadBoqSource(s: SchedHeader): Promise<BoqSource> {
  const rows = await fetchAll<TaskRow>((a, b) => supabase.from('schedule_tasks').select('id, msp_uid, parent_id, name, wbs, outline_number, is_summary, custom')
    .eq('schedule_id', s.id).is('deleted_at', null).eq('source_state', 'active').order('sort_order').range(a, b), 60000);
  const uid = new Map(rows.map((r) => [r.id, r.msp_uid]));
  let custom_fields: CustomFieldDef[] = [];
  if (s.current_version_id) {
    const v = check(await supabase.from('schedule_versions').select('header').eq('id', s.current_version_id).maybeSingle()) as { header: { custom_fields?: CustomFieldDef[] } | null } | null;
    custom_fields = v?.header?.custom_fields ?? [];
  }
  return {
    custom_fields,
    tasks: rows.map((r) => ({
      uid: r.msp_uid, name: r.name, wbs: r.wbs, outline_number: r.outline_number, is_summary: r.is_summary, custom: r.custom ?? {},
      parent_uid: r.parent_id ? uid.get(r.parent_id) ?? null : null,
    })),
  };
}

function FromSchedule({ projectId, schedules, canSeePrices }: { projectId: string; schedules: SchedHeader[]; canSeePrices: boolean }) {
  const [sid, setSid] = useUrlParam('schedule');
  const schedule = schedules.find((s) => s.id === sid) ?? schedules[0];
  const src = useAsync(() => loadBoqSource(schedule), [schedule.id, schedule.current_version_id], { key: 'boq-source' });
  return (
    <>
      {schedules.length > 1 && (
        <Card>
          <Field label="Schedule">
            <select value={schedule.id} onChange={(e) => setSid(e.target.value)}>
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
            </select>
          </Field>
        </Card>
      )}
      {src.error ? <ErrorBanner error={src.error} onRetry={src.reload} />
        : !src.data ? <Loading lines={6} />
        : <FromScheduleWizard key={`${schedule.id}:${schedule.current_version_id}`} src={src.data} schedule={schedule} projectId={projectId} canSeePrices={canSeePrices} />}
    </>
  );
}

function FromScheduleWizard({ src, schedule, projectId, canSeePrices }: { src: BoqSource; schedule: SchedHeader; projectId: string; canSeePrices: boolean }) {
  const nav = useNavigate();
  const [state, setState] = useState<EmbeddedBoqState>(() => { const s = initEmbeddedBoq(src); return { ...s, cfg: { ...s.cfg, enabled: true } }; });
  const [step, setStep] = useState(0);
  const [run, setRun] = useState<BoqRunState | null>(null);
  const cfg = state.cfg;
  const running = !!run && !run.res && !run.error;
  const setCfg = (c: EmbeddedBoqCfg) => setState((x) => ({ ...x, cfg: c }));
  const start = () => {
    const payload = boqPayload(schedule.id, cfg, canSeePrices);
    setRun({ payload });
    runCreateBoq(payload).then((res) => { setRun({ payload, res }); setStep(2); invalidate('boq-items', 'sched-tasks', 'schedules'); },
      (e: Error) => setRun({ payload, error: e.message }));
  };
  const leaves = src.tasks.filter((t) => !t.is_summary).length;

  return (
    <>
      <Stepper steps={['Columns', 'Preview', 'Done']} current={step} onStep={running || step === 2 ? undefined : (i) => i < 2 && setStep(i)} />
      {step === 0 ? (
        <>
          {state.det.confidence === 'none' && (
            <Banner tone="warn">No Unit / Qty columns were found automatically in “{schedule.name}” ({leaves} work tasks). Pick the column that holds the quantity, or import the BoQ from Excel instead.</Banner>
          )}
          <EmbeddedBoqCard s={src} state={state} setCfg={setCfg} canSeePrices={canSeePrices} standalone />
          <div className="imp-actions"><span />
            <button className="primary" disabled={!cfg.qtyField} onClick={() => setStep(1)}>Next: Preview ›</button>
          </div>
        </>
      ) : step === 1 ? (
        <>
          {run?.error && <BoqResult st={run} onRetry={start} />}
          <EmbeddedBoqStep s={src} cfg={cfg} projectId={projectId} canSeePrices={canSeePrices} onBack={() => setStep(0)} onNext={start}
            nextLabel={running ? 'Creating BoQ items…' : 'Create BoQ items'} busy={running} />
        </>
      ) : run?.res ? (
        <>
          <BoqResult st={run} onRetry={start} />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => nav('/elements#boq')}>Open the BoQ</button>
            <button onClick={() => nav('/schedule#boq')}>BoQ progress on the schedule</button>
            <button onClick={() => { setRun(null); setStep(0); }}>Run again with other columns</button>
          </div>
          {!schedule.approved_baseline_id && <BaselineOffer scheduleId={schedule.id} canSeePrices={canSeePrices} hasBoq />}
          <ElementsFromSchedule key={`els-${schedule.id}`} scheduleId={schedule.id} scheduleName={schedule.name} compact />
        </>
      ) : null}
    </>
  );
}
