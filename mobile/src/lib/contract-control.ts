// Contract for site control, evidence, communication and language
// (migration 20261029000007_control_comms.sql). Copy next to contract.ts in
// each app (src/lib/contract-control.ts). Pure TypeScript, no runtime deps —
// the QR verifier and the Ethiopian calendar work offline on any JS engine.
//
// Type-only import so Node can run this file directly with type stripping.
import type { AppRole, StockStatus, SyncTable } from './contract';

// ---------------------------------------------------------------------------
// Roles, statuses, numbering
// ---------------------------------------------------------------------------

/** `security` = gate guard: gate passes + vehicle log only (no stock books, no prices). */
export type AppRoleControl = AppRole | 'security';
export const ROLE_LABEL_SECURITY = 'Security (Gate)';
export const ROLE_LABELS_AM: Record<AppRoleControl, string> = {
  store_keeper: 'የመጋዘን ኃላፊ', site_engineer: 'የሳይት መሐንዲስ', office_engineer: 'የቢሮ መሐንዲስ',
  coordinator: 'የፕሮጀክት አስተባባሪ', manager: 'ሥራ አስኪያጅ', procurement: 'የግዥ ኃላፊ', admin: 'የሲስተም አስተዳዳሪ',
  security: 'ጥበቃ (በር)', finance: 'የፋይናንስ ኃላፊ', client: 'ደንበኛ (ለማየት ብቻ)',
};
export type DashboardKindControl = 'store' | 'site' | 'office' | 'management' | 'gate';
export const dashboardForControl = (role: AppRoleControl): DashboardKindControl =>
  role === 'security' ? 'gate'
  : role === 'store_keeper' ? 'store'
  : role === 'site_engineer' ? 'site'
  : role === 'office_engineer' ? 'office'
  : 'management';

export type StockStatusControl = StockStatus | 'on_loan';
export type TxnTypeControl =
  | 'opening' | 'grn' | 'miv' | 'mrn' | 'transfer_out' | 'transfer_in' | 'adjustment' | 'reversal' | 'gate_out' | 'gate_in';

export type DocTypeControl = 'GP' | 'VEH';
/** `<PROJECT>-GP-<DEVICE>-<SEQ>` / `<PROJECT>-VEH-<DEVICE>-<SEQ>` */
export const docNumberControl = (projectCode: string, type: DocTypeControl, devicePrefix: string, seq: number) =>
  `${projectCode}-${type}-${devicePrefix}-${String(seq).padStart(4, '0')}`;

export type ActionControl =
  | 'gatepass.create' | 'gatepass.approve' | 'gatepass.verify' | 'gatepass.return' | 'vehicle.log'
  | 'alert.manage' | 'qr.register' | 'qr.key' | 'telegram.link' | 'channel.manage';

const MGMT: AppRoleControl[] = ['coordinator', 'manager', 'admin'];
const PERMS_CONTROL: Record<ActionControl, AppRoleControl[]> = {
  'gatepass.create': ['store_keeper', 'site_engineer', 'office_engineer', ...MGMT],
  'gatepass.approve': MGMT,
  'gatepass.verify': ['security', 'store_keeper', ...MGMT],
  'gatepass.return': ['security', 'store_keeper', ...MGMT],
  'vehicle.log': ['security', 'store_keeper', ...MGMT],
  'alert.manage': MGMT,
  'qr.register': ['store_keeper', 'office_engineer', ...MGMT],
  'qr.key': ['security', 'store_keeper', ...MGMT],
  'telegram.link': ['store_keeper', 'site_engineer', 'office_engineer', 'procurement', 'security', ...MGMT],
  'channel.manage': MGMT,
};
export const canControl = (role: AppRoleControl | null | undefined, action: ActionControl) =>
  !!role && PERMS_CONTROL[action].includes(role);

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export const SYNC_TABLES_CONTROL: SyncTable[] = [
  { name: 'gate_passes', pk: ['id'] },
  { name: 'gate_pass_lines', pk: ['id'] },
  { name: 'gate_events', pk: ['id'] },
  { name: 'vehicle_movements', pk: ['id'] },
  { name: 'alert_rules', pk: ['id'] },
  { name: 'alerts', pk: ['id'] },
  { name: 'qr_labels', pk: ['id'] },
  { name: 'project_channels', pk: ['id'] },
  { name: 'telegram_links', pk: ['user_id'] },          // own row only
  { name: 'notification_prefs', pk: ['user_id', 'event'] }, // own rows only
];
// Not synced (server only): project_keys, telegram_link_codes, telegram_action_tokens.
// Note: users with role `security` get no rows from stock_ledger / adjustments / stock_counts (restrictive RLS).

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type GatePassType = 'returnable' | 'non_returnable';
export type GatePassStatus =
  | 'draft' | 'pending' | 'approved' | 'rejected' | 'exited' | 'partially_returned' | 'returned' | 'cancelled';

export interface GatePass {
  id: string; project_id: string; number: string; pass_type: GatePassType; store_id: string | null;
  destination: string; purpose: string; vehicle_plate: string | null; driver_name: string | null; driver_phone: string | null;
  expected_return: string | null; linked_doc_type: string | null; linked_doc_id: string | null; status: GatePassStatus;
  requested_by: string; submitted_at: string | null; approved_by: string | null; approved_at: string | null;
  decision_comment: string | null; qr_code: string | null; exited_at: string | null; returned_at: string | null;
  created_at: string; updated_at: string;
}
export interface GatePassLine {
  id: string; gate_pass_id: string; project_id: string; line_no: number; material_spec_id: string | null;
  description: string | null; qty: number; uom: string | null; qty_returned: number; deleted_at: string | null;
}
export interface GateEvent {
  id: string; project_id: string; gate_pass_id: string | null; event: 'exit_verified' | 'exit_mismatch' | 'return_in';
  plate_seen: string | null; matches: boolean | null; note: string | null; actor: string | null; at: string;
}
export interface VehicleMovement {
  id: string; project_id: string; number: string; direction: 'in' | 'out'; plate: string; driver_name: string | null;
  purpose: string | null; loaded: boolean; linked_doc_type: 'grn' | 'gate_pass' | 'transfer' | 'other' | null;
  linked_doc_id: string | null; flagged: boolean; at: string; actor: string | null;
}
export type AlertRuleKey =
  | 'consumption_variance' | 'large_adjustment' | 'emergency_not_regularised' | 'gate_pass_overdue' | 'delivery_outside_geofence';
/** Event-driven alerts (no rule row): 'gate_mismatch', 'unmatched_vehicle_exit'. */
export type AlertKind = AlertRuleKey | 'gate_mismatch' | 'unmatched_vehicle_exit';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export interface AlertRule {
  id: string; project_id: string | null; rule: AlertRuleKey; threshold: number; params: Record<string, unknown>;
  severity: AlertSeverity; is_active: boolean;
}
export interface Alert {
  id: string; project_id: string; rule: AlertKind; severity: AlertSeverity; entity_type: string | null; entity_id: string | null;
  dedupe_key: string; title: string; details: { summary?: string } & Record<string, unknown>;
  status: 'open' | 'acknowledged' | 'closed'; acked_by: string | null; acked_at: string | null;
  closed_by: string | null; closed_at: string | null; close_note: string | null; created_at: string;
}
export type QrEntityType = 'material' | 'spec' | 'store' | 'element' | 'tool' | 'gate_pass' | 'document';
export interface QrLabel {
  id: string; project_id: string; entity_type: QrEntityType; entity_id: string; label: string | null; code: string;
  printed_at: string | null; printed_by: string | null; deleted_at: string | null;
}
export interface TelegramLink { user_id: string; chat_id: number; username: string | null; linked_at: string }
export interface NotificationPref {
  user_id: string; event: string; in_app: boolean; push: boolean; telegram: boolean; sms: boolean;
  quiet_from: string | null; quiet_to: string | null;
}
export interface ProjectChannel {
  id: string; project_id: string; chat_id: number; title: string | null;
  kinds: ('daily_summary' | 'alerts' | string)[]; is_active: boolean;
}

export type AttachmentKindControl =
  | 'photo' | 'delivery_note' | 'signature' | 'document' | 'proforma' | 'batch_ticket' | 'bbs' | 'drawing' | 'diary';
/** Extra attachment columns. `outside_site` is computed by the server from the project geofence — never send it. */
export interface AttachmentEvidence {
  captured_at: string | null; sha256: string | null; source: 'camera' | 'gallery';
  gps_accuracy_m: number | null; outside_site: boolean | null; device_id: string | null;
}
export interface ProjectGeofence { site_lat: number | null; site_lng: number | null; site_radius_m: number }
export interface ProfileLocale { locale: 'en' | 'am'; calendar: 'gregorian' | 'ethiopian' }

/** Row of view v_my_approvals (everything waiting for the signed-in user). */
export interface MyApproval {
  kind: 'mr_review' | 'mr_approve' | 'adjustment' | 'stock_count' | 'progress_verify' | 'gate_pass_approve'
      | 'gate_exit' | 'miv_ack' | 'po_approve';
  entity_type: 'material_request' | 'adjustment' | 'stock_count' | 'progress_update' | 'gate_pass' | 'miv' | 'purchase_order';
  entity_id: string; project_id: string; number: string; title: string; status: string;
  requested_by: string | null; requested_at: string | null; is_urgent: boolean;
  actions: ('review' | 'approve' | 'reject' | 'return' | 'verify' | 'acknowledge')[]; age_hours: number;
}
/** Which existing RPC an inbox action maps to (reuse the normal payloads). */
export const APPROVAL_RPC: Record<MyApproval['entity_type'], string> = {
  material_request: 'mr_action', adjustment: 'decide_adjustment', stock_count: 'decide_stock_count',
  progress_update: 'verify_progress', gate_pass: 'gate_pass_action', miv: 'acknowledge_miv', purchase_order: 'po_action',
};

// ---------------------------------------------------------------------------
// RPC payloads — supabase.rpc(name, { p })
// ---------------------------------------------------------------------------

interface Op { op_id: string }

export interface SaveGatePassPayload extends Op {
  id: string; project_id: string; number: string; pass_type: GatePassType; store_id?: string | null;
  destination: string; purpose: string; vehicle_plate?: string; driver_name?: string; driver_phone?: string;
  expected_return?: string | null; linked_doc_type?: string; linked_doc_id?: string; submit: boolean;
  lines: { id: string; material_spec_id?: string | null; description?: string; qty: number; uom?: string }[];
}
export interface GatePassActionPayload extends Op { gate_pass_id: string; action: 'approve' | 'reject' | 'cancel'; comment?: string }
/** `id` = new gate event id. A plate that differs from the pass (ignoring spaces/dashes/case) is recorded as a mismatch. */
export interface VerifyGatePassPayload extends Op { id: string; gate_pass_id: string; plate_seen?: string; matches: boolean; note?: string; at?: string }
export interface ReturnGatePassPayload extends Op {
  id: string; gate_pass_id: string; at?: string; note?: string; plate_seen?: string;
  lines: { gate_pass_line_id: string; qty_returned: number }[];
}
export interface LogVehiclePayload extends Op {
  id: string; project_id: string; number: string; direction: 'in' | 'out'; plate: string; driver_name?: string; purpose?: string;
  loaded?: boolean; linked_doc_type?: 'grn' | 'gate_pass' | 'transfer' | 'other'; linked_doc_id?: string; at?: string;
}
export interface AlertActionPayload extends Op { alert_id: string; action: 'acknowledge' | 'close'; note?: string }
export interface SaveAlertRulePayload extends Op {
  project_id: string | null; rule: AlertRuleKey; threshold?: number; params?: Record<string, unknown>; severity?: AlertSeverity; is_active?: boolean;
}
export interface RegisterQrLabelsPayload extends Op {
  project_id: string; labels: { id: string; entity_type: QrEntityType; entity_id: string; label?: string }[];
}
export interface SetNotificationPrefsPayload extends Op {
  prefs: { event: string; in_app?: boolean; push?: boolean; telegram?: boolean; sms?: boolean; quiet_from?: string | null; quiet_to?: string | null }[];
}
export interface SaveProjectChannelPayload extends Op {
  id: string; project_id: string; chat_id: number; title?: string; kinds?: string[]; is_active?: boolean;
}

export interface RpcMapControl {
  save_gate_pass: SaveGatePassPayload;
  gate_pass_action: GatePassActionPayload;
  verify_gate_pass: VerifyGatePassPayload;          // → { ok, id, event_id, matched, status }
  return_gate_pass: ReturnGatePassPayload;          // → { ok, id, status }
  log_vehicle: LogVehiclePayload;                   // → { ok, id, flagged }
  evaluate_alerts: { project_id: string };          // → { ok, created }
  alert_action: AlertActionPayload;
  save_alert_rule: SaveAlertRulePayload;
  sign_qr: { project_id: string; entity_type: QrEntityType; entity_id: string };   // → { ok, code }
  verify_qr: { code: string };                      // → { valid, project_id, entity_type, entity_id, member }
  get_qr_key: { project_id: string };               // → { project_id, alg, format, key_hex, key_version }
  register_qr_labels: RegisterQrLabelsPayload;      // → { ok, labels: [{ id, code }] }
  mark_qr_printed: { ids: string[] };
  create_telegram_link_code: Record<string, never>; // → { ok, code, expires_at }; open t.me/<bot>?start=<code>
  unlink_telegram: Record<string, never>;
  set_notification_prefs: SetNotificationPrefsPayload;
  save_project_channel: SaveProjectChannelPayload;
  set_my_locale: Partial<ProfileLocale>;
}
export type RpcNameControl = keyof RpcMapControl;
// Service-role only (Edge Functions): tg_link_chat, tg_unlink_chat, tg_run_action,
// notification_dispatch_plan, daily_summary_plan.

// ---------------------------------------------------------------------------
// Telegram callback data: "<token>:<code>" (≤ 64 bytes)
// ---------------------------------------------------------------------------

export const TELEGRAM_ACTION_CODES = { approve: 'ap', reject: 'rj', review: 'rv', return: 'rt', acknowledge: 'ak' } as const;
export const parseTelegramCallback = (data: string): { token: string; code: string } | null => {
  const m = /^([A-Za-z0-9_-]{8,40}):([a-z]{2})$/.exec(data);
  return m ? { token: m[1], code: m[2] } : null;
};

// ---------------------------------------------------------------------------
// QR codes — offline verification
//
//   code = "SM1:<entity_type>:<project_id>:<entity_id>:<sig>"
//   msg  = everything before the last ":"   (UTF-8 bytes)
//   sig  = base64url_nopad( HMAC-SHA256(key, msg)[0..16) )   → 22 chars
//   key  = 32-byte project secret, from get_qr_key({project_id}).key_hex
//
// Verify: split on ":", require 5 parts and "SM1", recompute sig with the
// cached key for parts[2] (project id), compare. Keep the key in secure
// storage (expo-secure-store); it is only handed to security/store/mgmt roles.
// Documents created offline have no server signature until synced.
// ---------------------------------------------------------------------------

export interface QrPayload { valid: boolean; entity_type: string; project_id: string; entity_id: string }

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { inner[i] = block[i] ^ 0x36; outer[i] = block[i] ^ 0x5c; }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export const hexToBytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((b) => parseInt(b, 16)));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s;
}

export const qrSignature = (keyHex: string, msg: string) => base64url(hmacSha256(hexToBytes(keyHex), utf8(msg)).slice(0, 16));

/** Build a code (server does this for real; useful for tests/printing previews). */
export const signQr = (keyHex: string, entityType: string, projectId: string, entityId: string) => {
  const msg = `SM1:${entityType}:${projectId}:${entityId}`;
  return `${msg}:${qrSignature(keyHex, msg)}`;
};

export function parseQr(code: string): { entity_type: string; project_id: string; entity_id: string; msg: string; sig: string } | null {
  const parts = code.trim().split(':');
  if (parts.length !== 5 || parts[0] !== 'SM1') return null;
  return { entity_type: parts[1], project_id: parts[2], entity_id: parts[3], msg: parts.slice(0, 4).join(':'), sig: parts[4] };
}

/** Offline check. `keyFor(projectId)` returns the cached key_hex (or undefined if unknown). */
export function verifyQr(code: string, keyFor: (projectId: string) => string | undefined): QrPayload | null {
  const q = parseQr(code);
  if (!q) return null;
  const key = keyFor(q.project_id);
  const expected = key ? qrSignature(key, q.msg) : '';
  let diff = expected.length ^ q.sig.length;
  for (let i = 0; i < Math.min(expected.length, q.sig.length); i++) diff |= expected.charCodeAt(i) ^ q.sig.charCodeAt(i);
  return { valid: !!key && diff === 0, entity_type: q.entity_type, project_id: q.project_id, entity_id: q.entity_id };
}

// ---------------------------------------------------------------------------
// Ethiopian calendar (mirrors app.to_ethiopian / app.from_ethiopian in SQL).
// Store Gregorian; convert for display/input only. 13 months: 12 × 30 days +
// Pagume (5 days; 6 when the Ethiopian year % 4 === 3). New year (Meskerem 1)
// is 11 Sep, or 12 Sep before a Gregorian leap year. Fiscal year starts Hamle 1.
// ---------------------------------------------------------------------------

export const ETHIOPIAN_MONTHS = {
  en: ['Meskerem', 'Tikimt', 'Hidar', 'Tahsas', 'Tir', 'Yekatit', 'Megabit', 'Miyazya', 'Ginbot', 'Sene', 'Hamle', 'Nehase', 'Pagume'],
  am: ['መስከረም', 'ጥቅምት', 'ኅዳር', 'ታኅሣሥ', 'ጥር', 'የካቲት', 'መጋቢት', 'ሚያዝያ', 'ግንቦት', 'ሰኔ', 'ሐምሌ', 'ነሐሴ', 'ጳጉሜ'],
} as const;
export const ETHIOPIAN_WEEKDAYS_AM = ['እሑድ', 'ሰኞ', 'ማክሰኞ', 'ረቡዕ', 'ሐሙስ', 'ዓርብ', 'ቅዳሜ'];

export interface EthiopianDate { year: number; month: number; day: number }

const ETH_EPOCH = 1723856;      // JDN offset, Amete Mihret
const UNIX_EPOCH_JDN = 2440588; // JDN of 1970-01-01
const DAY_MS = 86400000;

const gregorianParts = (d: Date | string): [number, number, number] => {
  if (typeof d === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (!m) throw new Error(`Invalid date ${d}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; // local calendar date
};

export const isEthiopianLeapYear = (year: number) => ((year % 4) + 4) % 4 === 3;

/** Gregorian ('YYYY-MM-DD' or local Date) → Ethiopian date. */
export function toEthiopian(date: Date | string): EthiopianDate {
  const [y, m, d] = gregorianParts(date);
  const jdn = Math.floor(Date.UTC(y, m - 1, d) / DAY_MS) + UNIX_EPOCH_JDN;
  const r = (jdn - ETH_EPOCH) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  return {
    year: 4 * Math.floor((jdn - ETH_EPOCH) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: (n % 30) + 1,
  };
}

/** Ethiopian date → Gregorian 'YYYY-MM-DD'. Throws on invalid dates. */
export function fromEthiopian(year: number, month: number, day: number): string {
  const maxDay = month === 13 ? (isEthiopianLeapYear(year) ? 6 : 5) : 30;
  if (month < 1 || month > 13 || day < 1 || day > maxDay) throw new Error(`Invalid Ethiopian date ${year}-${month}-${day}`);
  const jdn = ETH_EPOCH + 365 + 365 * (year - 1) + Math.floor(year / 4) + 30 * month + day - 31;
  return new Date((jdn - UNIX_EPOCH_JDN) * DAY_MS).toISOString().slice(0, 10);
}

/** 'Meskerem 1, 2019' / 'መስከረም 1, 2019' (same text as SQL app.to_ethiopian). */
export function formatEthiopian(date: Date | string, lang: 'en' | 'am' = 'en'): string {
  const e = toEthiopian(date);
  return `${ETHIOPIAN_MONTHS[lang][e.month - 1]} ${e.day}, ${e.year}`;
}

export const ethiopianFiscalYear = (date: Date | string) => {
  const e = toEthiopian(date);
  return e.year + (e.month >= 11 ? 1 : 0);
};

/** Format a stored Gregorian date per the user's profile preference. */
export const formatDateFor = (date: Date | string, pref: ProfileLocale) =>
  pref.calendar === 'ethiopian'
    ? formatEthiopian(date, pref.locale)
    : typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
