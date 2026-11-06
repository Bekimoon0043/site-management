// Offline-first sync (FR-OF-01..06).
//   push: outbox ops are sent FIFO as supabase.rpc(name, { p }) — each carries
//         an op_id so retries are idempotent on the server.
//   pull: every SYNC_TABLES table is fetched incrementally by updated_at
//         (cursor per table, 2-minute overlap) and upserted locally.
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { SYNC_TABLES, type RpcMap, type RpcName } from './contract';
import {
  bump, clearSyncedPending, getDb, kvGet, kvSet, rollbackPending, upsertServerRows, type Row,
} from './db';
import { supabase } from './supabase';
import { applyOptimistic } from './optimistic';
import { SYNC_TABLES_FIELD, type RpcMapField } from './contract-field';
import { FIELD_RPCS, applyOptimisticField, recordRpcConflict } from './optimistic-field';
import { PC_RPCS, applyOptimisticPC, type RpcMapPC } from './optimistic-pc';
import { pcPullTables, skipMissingTable } from './tables-pc';
import { canSeePrices } from './pc';
import { myRole } from './me';
import { processUploads } from './photos';
import { ensureDeviceRegistered } from './device';
import { PRICE_TABLES_FLOWS, SYNC_TABLES_FLOWS } from './contract-flows';
import { FLOW_RPCS, applyOptimisticFlows, type RpcMapFlowsApp } from './optimistic-flows';
import { SL_RPCS, applyOptimisticSchedule, type RpcMapSL } from './optimistic-schedule';
import { pullScheduleTables, refreshScheduleViews } from './sync-schedule';
import { SYNC_TABLES_SITE, type RpcMapSite } from './contract-site';
import { SITE_RPCS, applyOptimisticSite } from './optimistic-site';
import { currentProjectId } from './me';

export type OutboxStatus = 'pending' | 'synced' | 'failed';
export interface OutboxEntry {
  id: string; seq: number; op_id: string; rpc: RpcName; payload: string; entity_type: string | null;
  entity_id: string | null; label: string | null; status: OutboxStatus; error: string | null;
  attempts: number; created_at: string; updated_at: string;
}

export interface SyncState { running: boolean; lastSyncAt: string | null; lastError: string | null; online: boolean }
let state: SyncState = { running: false, lastSyncAt: null, lastError: null, online: true };
const stateListeners = new Set<(s: SyncState) => void>();
export const getSyncState = () => state;
export function onSyncState(l: (s: SyncState) => void) {
  stateListeners.add(l);
  return () => { stateListeners.delete(l); };
}
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  stateListeners.forEach((l) => l(state));
}

export const uuid = () => Crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Core + feature RPC maps (field & quality: contract-field.ts). */
/** Flow RPCs (contract-flows.ts) replace the older save_mr / mr_action / post_grn / acknowledge_miv shapes. */
type AllRpcMap = Omit<RpcMap & RpcMapField & RpcMapPC & RpcMapSL & RpcMapSite, keyof RpcMapFlowsApp> & RpcMapFlowsApp;
type AllRpcName = keyof AllRpcMap;
type Payload<N extends AllRpcName> = Omit<AllRpcMap[N], 'op_id'>;

/** Queue a write, apply it to the local DB immediately, then try to sync. */
export function enqueue<N extends AllRpcName>(
  rpc: N, payload: Payload<N>, info: { entityType: string; entityId: string; label: string },
): string {
  const d = getDb();
  const opId = uuid();
  const full = { ...payload, op_id: opId } as AllRpcMap[N] & { op_id: string };
  const seqRow = d.getFirstSync<{ s: number | null }>('SELECT MAX(seq) AS s FROM outbox');
  const t = nowIso();
  d.withTransactionSync(() => {
    d.runSync(
      `INSERT INTO outbox (id, seq, op_id, rpc, payload, entity_type, entity_id, label, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [uuid(), (seqRow?.s ?? 0) + 1, opId, rpc, JSON.stringify(full), info.entityType, info.entityId, info.label, t, t],
    );
    if (FLOW_RPCS.has(rpc as string)) applyOptimisticFlows(rpc as keyof RpcMapFlowsApp, full as never, opId);
    else if (FIELD_RPCS.has(rpc as string)) applyOptimisticField(rpc as keyof RpcMapField, full as never, opId);
    else if (PC_RPCS.has(rpc as string)) applyOptimisticPC(rpc as keyof RpcMapPC, full as never, opId);
    else if (SL_RPCS.has(rpc as string)) applyOptimisticSchedule(rpc as keyof RpcMapSL, full as never, opId);
    else if (SITE_RPCS.has(rpc as string)) applyOptimisticSite(rpc as keyof RpcMapSite, full as never, opId);
    else applyOptimistic(rpc as RpcName, full as never, opId);
  });
  bump();
  void syncNow();
  return opId;
}

export function outbox(status?: OutboxStatus): OutboxEntry[] {
  return status
    ? getDb().getAllSync<OutboxEntry>('SELECT * FROM outbox WHERE status = ? ORDER BY seq DESC', [status])
    : getDb().getAllSync<OutboxEntry>('SELECT * FROM outbox ORDER BY seq DESC LIMIT 300');
}

/** Sync status of the latest op touching an entity (FR-OF-04). */
export function entitySyncStatus(entityId: string): { status: OutboxStatus; error: string | null } | null {
  return getDb().getFirstSync<{ status: OutboxStatus; error: string | null }>(
    `SELECT status, error FROM outbox WHERE entity_id = ? ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, seq DESC LIMIT 1`,
    [entityId]) ?? null;
}

export function retryOp(id: string) {
  getDb().runSync(`UPDATE outbox SET status = 'pending', error = NULL, updated_at = ? WHERE id = ?`, [nowIso(), id]);
  bump();
  void syncNow();
}

export function discardOp(id: string) {
  const e = getDb().getFirstSync<OutboxEntry>('SELECT * FROM outbox WHERE id = ?', [id]);
  if (!e) return;
  getDb().runSync('DELETE FROM outbox WHERE id = ?', [id]);
  rollbackPending(e.op_id);
  bump();
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

function isNetworkError(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  // Postgres exceptions always carry a SQLSTATE code; fetch failures and gateway
  // errors don't. Expired/invalid JWTs (PGRST3xx) are also transient.
  return !err.code || err.code.startsWith('PGRST3');
}

async function push(): Promise<void> {
  const d = getDb();
  const pending = d.getAllSync<OutboxEntry>(`SELECT * FROM outbox WHERE status = 'pending' ORDER BY seq`);
  for (const e of pending) {
    const { data, error } = await supabase.rpc(e.rpc, { p: JSON.parse(e.payload) });
    const t = nowIso();
    // Business conflicts returned as data (e.g. save_site_diary { ok:false, conflict:'exists' }).
    const conflict = !error ? recordRpcConflict(e.rpc, e.entity_id, data) : null;
    if (conflict) {
      d.runSync(`UPDATE outbox SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`, [conflict, t, e.id]);
      continue;
    }
    if (!error) {
      d.runSync(`UPDATE outbox SET status = 'synced', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?`, [t, e.id]);
      continue;
    }
    if (isNetworkError(error)) {
      d.runSync('UPDATE outbox SET attempts = attempts + 1, updated_at = ? WHERE id = ?', [t, e.id]);
      throw new Error('Network unavailable');
    }
    // Business rule rejected by the server: keep it visible for the user to fix or discard.
    d.runSync(`UPDATE outbox SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      [error.message, t, e.id]);
  }
  // keep a week of history
  d.runSync(`DELETE FROM outbox WHERE status = 'synced' AND updated_at < ?`,
    [new Date(Date.now() - 7 * 86400e3).toISOString()]);
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

const PAGE = 1000;
const OVERLAP_MS = 2 * 60 * 1000;

async function pullTable(name: string): Promise<void> {
  const cursorKey = `cursor:${name}`;
  const cursor = kvGet(cursorKey);
  const since = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString() : '1970-01-01T00:00:00Z';
  let maxSeen = cursor;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.from(name).select('*')
      .gt('updated_at', since).order('updated_at', { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${name}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    if (rows.length) {
      upsertServerRows(name, rows);
      const last = rows[rows.length - 1].updated_at as string;
      if (!maxSeen || last > maxSeen) maxSeen = last;
    }
    if (rows.length < PAGE) break;
  }
  if (maxSeen) kvSet(cursorKey, maxSeen);
}

/** One-time full re-pull of tables that gained columns (kv flag per migration). */
const REPULL: { flag: string; tables: string[] }[] = [
  { flag: 'migr:mr-flows-v1', tables: ['material_requests', 'mr_lines'] },   // 20261030000002_mr_flows.sql
];
function applyRepullFlags() {
  for (const m of REPULL) {
    if (kvGet(m.flag)) continue;
    for (const t of m.tables) kvSet(`cursor:${t}`, null);
    kvSet(m.flag, new Date().toISOString());
  }
}

async function pull(): Promise<void> {
  applyRepullFlags();
  for (const t of SYNC_TABLES) await pullTable(t.name);
  for (const t of SYNC_TABLES_FIELD) await pullTable(t.name);
  // procurement + site control; price tables only for price roles (tables-pc.ts)
  for (const t of pcPullTables(canSeePrices(myRole()))) await pullTable(t.name).catch(skipMissingTable);
  // material procurement flows; price-restricted tables only for price roles
  for (const t of [...SYNC_TABLES_FLOWS, ...(canSeePrices(myRole()) ? PRICE_TABLES_FLOWS : [])]) await pullTable(t.name).catch(skipMissingTable);
  // schedule progress (no money) + look-ahead (current + next plan)
  await pullScheduleTables();
  // site operations: HSE + plant (absent before 20261105000030 → skipped)
  for (const t of SYNC_TABLES_SITE) await pullTable(t.name).catch(skipMissingTable);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

let inflight: Promise<void> | null = null;
let rerun = false;

export function syncNow(): Promise<void> {
  if (inflight) { rerun = true; return inflight; }
  inflight = (async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    const net = await NetInfo.fetch();
    const online = net.isConnected !== false && net.isInternetReachable !== false;
    setState({ online });
    if (!online) return;
    setState({ running: true });
    try {
      await ensureDeviceRegistered();
      await push();
      await pull();
      clearSyncedPending();
      const t = nowIso();
      kvSet('last-sync', t);
      setState({ lastSyncAt: t, lastError: null });
      bump();
      await refreshScheduleViews(currentProjectId());
      bump();
      await processUploads(net.type === 'wifi');
    } catch (e) {
      setState({ lastError: e instanceof Error ? e.message : String(e) });
    } finally {
      setState({ running: false });
    }
  })().finally(() => {
    inflight = null;
    if (rerun) { rerun = false; void syncNow(); }
  });
  return inflight;
}

let started = false;
export function startAutoSync() {
  if (started) return;
  started = true;
  setState({ lastSyncAt: kvGet('last-sync') });
  NetInfo.addEventListener((s) => {
    const online = s.isConnected !== false && s.isInternetReachable !== false;
    if (online && !state.online) void syncNow();
    setState({ online });
  });
  setInterval(() => { void syncNow(); }, 3 * 60 * 1000);
  void syncNow();
}

export function resetSyncCursors() {
  getDb().runSync(`DELETE FROM kv WHERE k LIKE 'cursor:%'`);
}
