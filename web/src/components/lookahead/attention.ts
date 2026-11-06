// Dashboard "Needs attention" rows from planning: SPI / CPI critical, overdue look-ahead constraints, PPC below target.
// No heavy imports (Dashboard chunk). Each source fails soft so a missing view never breaks the dashboard.
import { countRows, supabase } from '../../lib/supabase';

export interface AttentionRow { sev: 'danger' | 'warning' | 'info'; text: string; to: string; cta: string }
const soft = async <T>(p: PromiseLike<T>, fb: T): Promise<T> => { try { return await p; } catch { return fb; } };
const eatToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

export async function loadPlanningAttention(projectId: string, canSeePrices: boolean): Promise<AttentionRow[]> {
  const today = eatToday();
  const [ov, evm, overdue, ppc] = await Promise.all([
    soft(supabase.from('v_progress_overview').select('spi, spi_status, sv_t_days, spi_t_status').eq('project_id', projectId).eq('level', 'project')
      .then((r) => (r.data ?? []) as { spi: number | null; spi_status: string | null; sv_t_days: number | null; spi_t_status: string | null }[]), []),
    canSeePrices ? soft(supabase.from('v_evm_project').select('cpi, cpi_status, vac').eq('project_id', projectId)
      .then((r) => (r.data ?? []) as { cpi: number | null; cpi_status: string | null; vac: number | null }[]), []) : Promise.resolve([]),
    soft(countRows(() => supabase.from('lookahead_constraints').select('id', { count: 'exact', head: true }).eq('project_id', projectId)
      .in('status', ['open', 'in_progress', 'blocked']).eq('advisory', false).lt('due_date', today)), 0),
    soft(supabase.from('v_ppc').select('week_no, period_label, ppc, ppc_target, committed, completed').eq('project_id', projectId).eq('status', 'closed').gt('committed', 0)
      .order('week_start', { ascending: false }).limit(1)
      .then((r) => (r.data ?? []) as { week_no: number; period_label: string; ppc: number | null; ppc_target: number | null; committed: number; completed: number }[]), []),
  ]);
  const out: AttentionRow[] = [];
  const spi = ov.find((r) => r.spi_status === 'critical' || r.spi_t_status === 'critical');
  if (spi) out.push({ sev: 'danger', text: `Schedule performance is critical (SPI ${spi.spi == null ? '—' : Number(spi.spi).toFixed(2)}${spi.sv_t_days != null && spi.sv_t_days < 0 ? ` · ${Math.round(-spi.sv_t_days)} working days behind` : ''})`, to: '/evm', cta: 'Earned value' });
  const cpi = evm.find((r) => r.cpi_status === 'critical');
  if (cpi) out.push({ sev: 'danger', text: `Cost performance is critical (CPI ${cpi.cpi == null ? '—' : Number(cpi.cpi).toFixed(2)}): work is costing more than its budget`, to: '/evm', cta: 'Earned value' });
  if (overdue) out.push({ sev: 'warning', text: `${overdue} look-ahead constraint${overdue === 1 ? '' : 's'} past due (tasks not ready)`, to: '/approvals?type=lookahead_constraint', cta: 'Clear' });
  const last = ppc[0];
  const target = Number(last?.ppc_target ?? 80);
  if (last && last.ppc != null && Number(last.ppc) < target) out.push({ sev: 'warning', text: `Plan reliability ${Math.round(Number(last.ppc))} % last week (${last.completed}/${last.committed} promised tasks done; target ${target} %)`, to: '/lookahead#reliability', cta: 'Reasons' });
  return out;
}
