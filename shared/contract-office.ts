// Contract for the office registers (migrations 20261105000040_contract_admin.sql, 041_receivables_retention.sql,
// 042_office_inbox.sql): RFIs & site instructions, drawing register, submittals, meetings & action items, risks,
// extension-of-time claims, client receivables ageing and retention release. Copy next to contract.ts in each app
// (npm run sync:contract). Read: every project member (receivables/retention: price roles). Write: the RPCs below.

export interface Op { op_id?: string }

export type Discipline = 'architectural' | 'structural' | 'electrical' | 'sanitary' | 'mechanical' | 'civil' | 'general';
export const DISCIPLINES: Discipline[] = ['architectural', 'structural', 'electrical', 'sanitary', 'mechanical', 'civil', 'general'];
export type Impact = 'none' | 'tbd' | 'yes';
export const IMPACT_LABELS: Record<Impact, string> = { none: 'None', tbd: 'To be determined', yes: 'Yes' };

export interface ContractAdminSettings {
  project_id: string; rfi_response_days: number; si_response_days: number; submittal_response_days: number;
  claim_notice_days: number; claim_particulars_days: number; reminder_days: number;
}
export const CA_DEFAULTS: Omit<ContractAdminSettings, 'project_id'> = {
  rfi_response_days: 7, si_response_days: 7, submittal_response_days: 14, claim_notice_days: 28, claim_particulars_days: 42, reminder_days: 2,
};

export type RfiKind = 'rfi' | 'si';
export type RfiStatus = 'open' | 'answered' | 'closed' | 'void';
export const RFI_STATUS_LABELS: Record<RfiStatus, string> = { open: 'Open', answered: 'Answered', closed: 'Closed', void: 'Void' };
export interface Rfi {
  id: string; project_id: string; kind: RfiKind; number: string; subject: string; description: string; discipline: Discipline | null;
  location: string | null; drawing_refs: string | null; priority: 'normal' | 'urgent'; addressed_to: string | null; issued_by: string | null;
  raised_on: string; due_date: string | null; ball_in_court: 'contractor' | 'consultant' | 'client'; status: RfiStatus;
  answer: string | null; answered_on: string | null; answered_by: string | null; cost_impact: Impact; cost_amount: number | null;
  time_impact: Impact; time_days: number | null; variation_id: string | null; eot_claim_id: string | null; diary_instruction_id: string | null;
  void_reason: string | null; created_by: string; closed_by: string | null; closed_at: string | null; created_at: string; updated_at: string;
}
/** v_rfi_register */
export interface RfiRow extends Rfi { days_overdue: number; days_open: number; variation_number: string | null; eot_number: string | null }

export type DocType = 'drawing' | 'specification' | 'report' | 'calculation' | 'schedule' | 'other';
export type RevStatus = 'for_construction' | 'for_approval' | 'for_information' | 'as_built';
export const REV_STATUS_LABELS: Record<RevStatus, string> = {
  for_construction: 'For construction', for_approval: 'For approval', for_information: 'For information', as_built: 'As built',
};
export interface ProjectDocument {
  id: string; project_id: string; doc_no: string; title: string; discipline: Discipline | null; doc_type: DocType;
  current_rev: string | null; current_status: RevStatus | null; created_by: string; created_at: string; updated_at: string; deleted_at: string | null;
}
export interface DocumentRevision {
  id: string; document_id: string; project_id: string; rev: string; rev_date: string | null; status: RevStatus; received_on: string;
  transmittal_ref: string | null; notes: string | null; superseded_at: string | null; created_by: string; created_at: string;
}

export type SubmittalKind = 'material' | 'shop_drawing' | 'method_statement' | 'sample' | 'test_report' | 'other';
export type SubmittalStatus = 'draft' | 'submitted' | 'approved' | 'approved_as_noted' | 'revise_resubmit' | 'rejected' | 'void';
export const SUBMITTAL_STATUS_LABELS: Record<SubmittalStatus, string> = {
  draft: 'Draft', submitted: 'With reviewer', approved: 'A · Approved', approved_as_noted: 'B · Approved as noted',
  revise_resubmit: 'C · Revise & resubmit', rejected: 'D · Rejected', void: 'Void',
};
export const REVIEW_CODES = { A: 'Approved', B: 'Approved as noted', C: 'Revise & resubmit', D: 'Rejected' } as const;
export type ReviewCode = keyof typeof REVIEW_CODES;
export interface Submittal {
  id: string; project_id: string; number: string; title: string; kind: SubmittalKind; spec_section: string | null; material_spec_id: string | null;
  supplier: string | null; required_by: string | null; status: SubmittalStatus; current_rev: number | null; notes: string | null;
  created_by: string; created_at: string; updated_at: string;
}
/** v_submittal_register: the submittal with its current revision. */
export interface SubmittalRow extends Submittal {
  submitted_on: string | null; response_due: string | null; code: ReviewCode | null; responded_on: string | null; reviewer: string | null;
  comments: string | null; transmittal_ref: string | null; days_overdue: number; at_risk: boolean;
}
export interface SubmittalRevision {
  id: string; submittal_id: string; rev: number; submitted_on: string; response_due: string; transmittal_ref: string | null;
  code: ReviewCode | null; responded_on: string | null; reviewer: string | null; comments: string | null; created_by: string;
}

export type MeetingKind = 'progress' | 'coordination' | 'client' | 'subcontractor' | 'safety' | 'kickoff' | 'other';
export interface Meeting {
  id: string; project_id: string; number: string; kind: MeetingKind; title: string; held_on: string; location: string | null;
  chaired_by: string | null; attendees: string | null; agenda: string | null; minutes: string | null; next_meeting_on: string | null;
  status: 'draft' | 'issued'; issued_at: string | null; created_by: string; created_at: string;
}
export interface MeetingAction {
  id: string; project_id: string; meeting_id: string | null; seq: number; description: string; owner_id: string | null; owner_name: string | null;
  due_date: string | null; status: 'open' | 'done' | 'cancelled'; done_at: string | null; done_by: string | null; done_note: string | null;
  created_by: string; created_at: string;
}

export type RiskCategory = 'design' | 'ground' | 'client' | 'finance' | 'procurement' | 'labour' | 'equipment' | 'weather' | 'safety'
  | 'regulatory' | 'subcontractor' | 'other';
export const RISK_CATEGORIES: RiskCategory[] = ['design', 'ground', 'client', 'finance', 'procurement', 'labour', 'equipment', 'weather',
  'safety', 'regulatory', 'subcontractor', 'other'];
export interface Risk {
  id: string; project_id: string; number: string; kind: 'risk' | 'issue'; title: string; description: string | null; category: RiskCategory;
  likelihood: number; impact: number; score: number; owner_id: string | null; response_type: 'avoid' | 'reduce' | 'transfer' | 'accept' | null;
  response: string | null; cost_exposure: number | null; time_exposure_days: number | null; review_by: string | null;
  status: 'open' | 'occurred' | 'closed'; closed_at: string | null; created_by: string; created_at: string; updated_at: string;
}

export type EotCause = 'variation' | 'late_information' | 'late_possession' | 'client_payment' | 'suspension' | 'weather' | 'force_majeure'
  | 'utility' | 'permit' | 'other';
export const EOT_CAUSE_LABELS: Record<EotCause, string> = {
  variation: 'Variation / extra work', late_information: 'Late drawings / information', late_possession: 'Late site possession',
  client_payment: 'Late payment by the client', suspension: 'Suspension by the engineer', weather: 'Exceptional weather',
  force_majeure: 'Force majeure', utility: 'Utilities (power / water)', permit: 'Permits / authorities', other: 'Other',
};
export type EotStatus = 'draft' | 'notice_sent' | 'submitted' | 'granted' | 'partly_granted' | 'rejected' | 'withdrawn';
export const EOT_STATUS_LABELS: Record<EotStatus, string> = {
  draft: 'Event recorded', notice_sent: 'Notice sent', submitted: 'Claim submitted', granted: 'Granted', partly_granted: 'Partly granted',
  rejected: 'Rejected', withdrawn: 'Withdrawn',
};
export interface EotClaim {
  id: string; project_id: string; number: string; title: string; cause: EotCause; description: string | null; event_from: string; event_to: string | null;
  notice_date: string | null; notice_ref: string | null; particulars_date: string | null; days_claimed: number; cost_claimed: number;
  status: EotStatus; days_granted: number | null; cost_granted: number | null; decided_on: string | null; consultant_ref: string | null;
  decision_comment: string | null; variation_id: string | null; created_by: string; created_at: string; updated_at: string;
}
/** public.eot_delay_evidence(project, from, to) */
export interface DelayEvidence { cause: string; diaries: number; hours_lost: number; days_lost: number; first_date: string; last_date: string }
export interface CompletionDates {
  project_id: string; start_date: string | null; original_completion: string | null; days_granted: number; days_pending: number; revised_completion: string | null;
}

export type ReceivableBucket = 'paid' | 'not_certified' | 'not_due' | '1_30' | '31_60' | '61_90' | '90_plus';
export const BUCKET_LABELS: Record<ReceivableBucket, string> = {
  paid: 'Paid', not_certified: 'With the consultant', not_due: 'Not yet due', '1_30': '1–30 days late', '31_60': '31–60 days late',
  '61_90': '61–90 days late', '90_plus': 'Over 90 days late',
};
/** v_client_receivables */
export interface Receivable {
  id: string; project_id: string; ipc_no: number; status: string; period_to: string; submitted_on: string | null; certified_on: string | null;
  payable: number; paid_amount: number; paid_on: string | null; payment_days: number; certify_days: number; due_on: string | null;
  outstanding: number; days_overdue: number; bucket: ReceivableBucket;
}
/** v_retention_status */
export interface RetentionStatus {
  project_id: string; held: number; practical_completion_on: string | null; dlp_months: number; retention_pc_release_pct: number; dlp_end: string | null;
  pc_release_amount: number; pc_requested: number; pc_status: string | null; final_release_amount: number; final_requested: number;
  final_status: string | null; received: number; still_held: number; pc_release_due: boolean; final_release_due: boolean;
}
export interface RetentionRelease {
  id: string; project_id: string; stage: 'practical_completion' | 'final'; amount: number; requested_on: string; certified_on: string | null;
  received_on: string | null; received_amount: number; ref: string | null; status: 'requested' | 'certified' | 'received';
}
/** v_office_portfolio */
export interface PortfolioRow {
  project_id: string; code: string; name: string; client: string | null; start_date: string | null; end_date: string | null; is_active: boolean;
  revised_completion: string | null; days_granted: number; days_pending: number; rfis_open: number; rfis_overdue: number; sis_open: number;
  submittals_pending: number; actions_overdue: number; risks_high: number; claims_open: number;
}

export interface RpcMapOffice {
  save_contract_admin_settings: Op & Partial<Omit<ContractAdminSettings, 'project_id'>> & { project_id: string };
  save_rfi: Op & { id: string; project_id: string; kind?: RfiKind; subject: string; description: string; discipline?: Discipline | ''; location?: string;
    drawing_refs?: string; priority?: 'normal' | 'urgent'; addressed_to?: string; issued_by?: string; raised_on?: string; due_date?: string;
    cost_impact?: Impact; cost_amount?: number | null; time_impact?: Impact; time_days?: number | null; diary_instruction_id?: string };
  decide_rfi: Op & { rfi_id: string; action: 'answer' | 'close' | 'reopen' | 'void' | 'link' | 'ball'; answer?: string; answered_on?: string;
    answered_by?: string; cost_impact?: Impact; cost_amount?: number | null; time_impact?: Impact; time_days?: number | null; comment?: string;
    variation_id?: string | null; eot_claim_id?: string | null; ball_in_court?: Rfi['ball_in_court'] };
  save_document: Op & { id: string; project_id: string; doc_no: string; title: string; discipline?: Discipline | ''; doc_type?: DocType;
    revision?: { rev: string; rev_date?: string; status?: RevStatus; received_on?: string; transmittal_ref?: string; notes?: string } };
  save_submittal: Op & { id: string; project_id: string; title: string; kind?: SubmittalKind; spec_section?: string; material_spec_id?: string | null;
    supplier?: string; required_by?: string | null; notes?: string };
  decide_submittal: Op & { submittal_id: string; action: 'submit' | 'respond' | 'void'; submitted_on?: string; response_due?: string;
    transmittal_ref?: string; code?: ReviewCode; responded_on?: string; reviewer?: string; comments?: string; comment?: string };
  save_meeting: Op & { id: string; project_id: string; kind?: MeetingKind; title: string; held_on: string; location?: string; chaired_by?: string;
    attendees?: string; agenda?: string; minutes?: string; next_meeting_on?: string | null; issue?: boolean;
    actions?: { id?: string; description: string; owner_id?: string | null; owner_name?: string; due_date?: string | null }[] };
  save_action_item: Op & { id: string; project_id: string; action?: 'done' | 'reopen' | 'cancel'; note?: string; description?: string;
    owner_id?: string | null; owner_name?: string; due_date?: string | null; meeting_id?: string | null };
  save_risk: Op & { id: string; project_id: string; kind?: Risk['kind']; title: string; description?: string; category?: RiskCategory;
    likelihood?: number; impact?: number; owner_id?: string | null; response_type?: Risk['response_type'] | ''; response?: string;
    cost_exposure?: number | null; time_exposure_days?: number | null; review_by?: string | null; status?: Risk['status'] };
  save_eot_claim: Op & { id: string; project_id: string; title: string; cause?: EotCause; description?: string; event_from: string;
    event_to?: string | null; days_claimed?: number; cost_claimed?: number; variation_id?: string | null };
  decide_eot_claim: Op & { claim_id: string; action: 'send_notice' | 'submit' | 'decide' | 'withdraw'; notice_date?: string; notice_ref?: string;
    particulars_date?: string; days_claimed?: number; cost_claimed?: number; days_granted?: number; cost_granted?: number; decided_on?: string;
    consultant_ref?: string; comment?: string };
  save_contract_completion: Op & { project_id: string; payment_days?: number; certify_days?: number; practical_completion_on?: string | null;
    dlp_months?: number; retention_pc_release_pct?: number };
  save_retention_release: Op & { id?: string; project_id: string; stage: RetentionRelease['stage']; amount?: number; requested_on?: string;
    certified_on?: string; received_on?: string; received_amount?: number; ref?: string; early?: boolean };
}
export type RpcNameOffice = keyof RpcMapOffice;

/** Who does what (the server re-checks every call). */
export const OFFICE_ROLES = {
  raiseRfi: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
  answerRfi: ['office_engineer', 'coordinator', 'manager', 'admin'],
  documents: ['office_engineer', 'coordinator', 'manager', 'admin'],
  createSubmittal: ['office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
  decideSubmittal: ['office_engineer', 'coordinator', 'manager', 'admin'],
  meetings: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'admin'],
  office: ['office_engineer', 'coordinator', 'manager', 'admin'],
  createRisk: ['site_engineer', 'office_engineer', 'coordinator', 'manager', 'procurement', 'admin'],
  createClaim: ['office_engineer', 'coordinator', 'manager', 'admin'],
  decideClaim: ['coordinator', 'manager', 'admin'],
  settings: ['coordinator', 'manager', 'admin'],
  completion: ['coordinator', 'manager', 'admin'],
  requestRetention: ['coordinator', 'manager', 'admin'],
  receiveMoney: ['finance', 'manager', 'admin'],
} as const;
