// Office registers data layer (contract: lib/contract-office.ts; migrations 20261105000040…42).
import { check, fetchAll, supabase } from '../../lib/supabase';
import { invalidateAfterWrite } from '../../lib/query';
import type { AppRole } from '../../lib/contract';
import {
  CA_DEFAULTS, OFFICE_ROLES, type CompletionDates, type ContractAdminSettings, type DelayEvidence, type DocumentRevision, type EotClaim, type Meeting,
  type MeetingAction, type PortfolioRow, type ProjectDocument, type Receivable, type RetentionRelease, type RetentionStatus, type RfiRow, type Risk,
  type RpcMapOffice, type SubmittalRevision, type SubmittalRow,
} from '../../lib/contract-office';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export async function officeRpc<N extends keyof RpcMapOffice>(name: N, payload: DistOmit<RpcMapOffice[N], 'op_id'>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc(name, { p: { op_id: crypto.randomUUID(), ...payload } });
  if (error) throw new Error(error.message);
  invalidateAfterWrite();
  return (data ?? {}) as Record<string, unknown>;
}

export const canOffice = (role: AppRole | null | undefined, what: keyof typeof OFFICE_ROLES) =>
  !!role && (OFFICE_ROLES[what] as readonly string[]).includes(role);

export const todayEat = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

export async function loadSettings(projectId: string): Promise<ContractAdminSettings> {
  const s = check(await supabase.from('contract_admin_settings').select('*').eq('project_id', projectId).maybeSingle()) as ContractAdminSettings | null;
  return s ?? { project_id: projectId, ...CA_DEFAULTS };
}
export const loadRfis = (projectId: string) => fetchAll<RfiRow>((a, b) => supabase.from('v_rfi_register').select('*')
  .eq('project_id', projectId).order('raised_on', { ascending: false }).order('number', { ascending: false }).range(a, b));
export const loadDocuments = (projectId: string) => fetchAll<ProjectDocument>((a, b) => supabase.from('project_documents').select('*')
  .eq('project_id', projectId).is('deleted_at', null).order('doc_no').range(a, b));
export async function loadRevisions(documentId: string) {
  return check(await supabase.from('document_revisions').select('*').eq('document_id', documentId).order('created_at', { ascending: false })) as DocumentRevision[];
}
export const loadSubmittals = (projectId: string) => fetchAll<SubmittalRow>((a, b) => supabase.from('v_submittal_register').select('*')
  .eq('project_id', projectId).order('number', { ascending: false }).range(a, b));
export async function loadSubmittalRevisions(id: string) {
  return check(await supabase.from('submittal_revisions').select('*').eq('submittal_id', id).order('rev', { ascending: false })) as SubmittalRevision[];
}
export async function loadMeetings(projectId: string) {
  const [meetings, actions] = await Promise.all([
    fetchAll<Meeting>((a, b) => supabase.from('meetings').select('*').eq('project_id', projectId).order('held_on', { ascending: false }).range(a, b)),
    fetchAll<MeetingAction>((a, b) => supabase.from('meeting_actions').select('*').eq('project_id', projectId).order('due_date', { ascending: true, nullsFirst: false }).range(a, b)),
  ]);
  return { meetings, actions };
}
export const loadRisks = (projectId: string) => fetchAll<Risk>((a, b) => supabase.from('risks').select('*')
  .eq('project_id', projectId).order('score', { ascending: false }).order('number').range(a, b));
export async function loadClaims(projectId: string) {
  const [claims, dates] = await Promise.all([
    check(await supabase.from('eot_claims').select('*').eq('project_id', projectId).order('event_from', { ascending: false })) as EotClaim[],
    supabase.from('v_completion_dates').select('*').eq('project_id', projectId).maybeSingle().then(check) as Promise<CompletionDates | null>,
  ]);
  return { claims, dates };
}
export async function loadEvidence(projectId: string, from: string, to: string | null) {
  const { data, error } = await supabase.rpc('eot_delay_evidence', { p_project: projectId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return (data ?? []) as DelayEvidence[];
}
export async function loadReceivables(projectId: string) {
  const [rows, retention, releases] = await Promise.all([
    check(await supabase.from('v_client_receivables').select('*').eq('project_id', projectId).order('ipc_no')) as Receivable[],
    supabase.from('v_retention_status').select('*').eq('project_id', projectId).maybeSingle().then(check) as Promise<RetentionStatus | null>,
    supabase.from('retention_releases').select('*').eq('project_id', projectId).order('requested_on').then(check) as Promise<RetentionRelease[]>,
  ]);
  return { rows, retention, releases };
}
export async function loadPortfolio() {
  return check(await supabase.from('v_office_portfolio').select('*').order('code')) as PortfolioRow[];
}
/** Variations of the project for linking (price-gated table: empty for roles without price access). */
export async function loadVariationOptions(projectId: string) {
  const { data } = await supabase.from('variations').select('id, number, title, status').eq('project_id', projectId).order('number');
  return (data ?? []) as { id: string; number: string; title: string; status: string }[];
}
/** Diary instructions not yet in the SI register. */
export async function loadUnregisteredInstructions(projectId: string, registered: Set<string>) {
  const rows = check(await supabase.from('diary_instructions').select('id, given_by, organisation, instruction, site_diaries(diary_date, number)' as '*')
    .eq('project_id', projectId).is('deleted_at', null).limit(500)) as unknown as {
      id: string; given_by: string | null; organisation: string | null; instruction: string; site_diaries: { diary_date: string; number: string } | null }[];
  return rows.filter((r) => !registered.has(r.id)).sort((a, b) => (b.site_diaries?.diary_date ?? '').localeCompare(a.site_diaries?.diary_date ?? ''));
}
