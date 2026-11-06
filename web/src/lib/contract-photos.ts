// Photos & documents on any record (migration 20261105000020_photos.sql). Copy next to contract.ts in each app
// (npm run sync:contract).
//
// Storage path: <project_id>/<entity_type>/<attachment id>.<ext> in the private 'attachments' bucket. Who can see a
// file follows its entity_type (app.attachment_visible): payment documents → payment roles, price documents →
// price roles, stock books → not the gate guard, everything else → project members.

export interface Op { op_id?: string }

export type AttachmentKindAll =
  | 'photo' | 'delivery_note' | 'signature' | 'document' | 'proforma' | 'batch_ticket' | 'bbs' | 'drawing' | 'diary'
  | 'measurement' | 'attendance_sheet' | 'signed_certificate' | 'site_instruction' | 'invoice' | 'report';
export type AttachmentTag = 'before' | 'after' | 'progress' | 'issue' | 'handover' | 'other';
export type AttachmentSource = 'camera' | 'gallery' | 'upload';

export interface AttachmentRow {
  id: string; project_id: string; entity_type: string; entity_id: string; kind: AttachmentKindAll; storage_path: string;
  mime_type: string | null; latitude: number | null; longitude: number | null; created_by: string; created_at: string;
  captured_at: string | null; source: AttachmentSource | null; sha256: string | null; outside_site: boolean | null;
  caption: string | null; tag: AttachmentTag | null; block_id: string | null; level_id: string | null;
  file_name: string | null; size_bytes: number | null; deleted_at: string | null; deleted_by: string | null;
  client_visible: boolean; client_approved_at: string | null; client_approved_by: string | null;
}

/** public.update_attachment — caption / tag / location, or delete (uploader within 24 h, coordinator / manager / admin). */
export interface UpdateAttachmentPayload extends Op {
  id: string; caption?: string; tag?: AttachmentTag | ''; block_id?: string | null; level_id?: string | null; delete?: boolean;
}

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKindAll, string> = {
  photo: 'Photo', delivery_note: 'Delivery note', signature: 'Signature', document: 'Document', proforma: 'Proforma / quotation',
  batch_ticket: 'Batch ticket', bbs: 'Bar bending schedule', drawing: 'Drawing', diary: 'Diary page', measurement: 'Measurement sheet',
  attendance_sheet: 'Attendance sheet', signed_certificate: 'Signed certificate', site_instruction: 'Site instruction', invoice: 'Invoice / receipt',
  report: 'Report',
};
export const ATTACHMENT_TAG_LABELS: Record<AttachmentTag, string> = {
  before: 'Before', after: 'After', progress: 'Progress', issue: 'Issue', handover: 'Handover', other: 'Other',
};

/** Record types that carry photos / documents, with the label used in the gallery filter. */
export const ENTITY_LABELS: Record<string, string> = {
  site: 'General site photo', element: 'Element', progress_update: 'Element progress', task_progress: 'Task progress report', schedule_task: 'Schedule activity',
  lookahead_item: 'Monthly task', site_diary: 'Site diary', inspection: 'Inspection', inspection_item: 'Inspection item', snag: 'Snag',
  pour: 'Concrete pour', pour_truck: 'Concrete truck', cube_set: 'Cube test', bbs: 'Bar bending schedule',
  material_request: 'Material request', grn: 'Goods received (GRN)', miv: 'Issue (MIV)', mrn: 'Return (MRN)', transfer: 'Transfer',
  adjustment: 'Adjustment / wastage', stock_count: 'Stock count', gate_pass: 'Gate pass', vehicle: 'Vehicle',
  rfq: 'RFQ', quotation: 'Quotation', purchase_order: 'Purchase order', sc_certificate: 'Subcontract certificate',
  payroll: 'Labour payroll', client_ipc: 'Client payment certificate', variation: 'Variation', supplier_invoice: 'Supplier invoice',
  document: 'Office document', submittal: 'Submittal', rfi: 'RFI', plant_log: 'Plant log', hse_incident: 'Safety incident',
  work_permit: 'Work permit', toolbox_talk: 'Toolbox talk',
};

export const ACCEPT_FILES = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
