// Encrypted local store (FR-OF-02). Every synced table lives in one generic
// `rows` table keyed by (tbl, pk) with indexed project_id / parent columns,
// which keeps lookups fast without a per-table schema to migrate.
import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { SYNC_TABLES } from './contract';
import { PC_PARENT_COLUMN, PC_TABLES } from './tables-pc';
import { SL_PARENT_COLUMN, SL_TABLES } from './tables-schedule';
import { PRICE_TABLES_FLOWS, SYNC_TABLES_FLOWS } from './contract-flows';

const KEY_NAME = 'local-db-key';

// Column used as `parent` for fast child lookups.
export const PARENT_COLUMN: Record<string, string> = {
  levels: 'block_id',
  material_specs: 'material_id',
  spec_conversions: 'material_spec_id',
  element_activities: 'element_id',
  element_takeoffs: 'element_id',
  mr_lines: 'mr_id',
  mr_line_elements: 'mr_line_id',
  mr_events: 'mr_id',
  grn_lines: 'grn_id',
  miv_lines: 'miv_id',
  mrn_lines: 'mrn_id',
  transfer_lines: 'transfer_id',
  stock_count_lines: 'count_id',
  adjustment_lines: 'adjustment_id',
  stock_ledger: 'material_spec_id',
  progress_updates: 'element_id',
  attachments: 'entity_id',
  notifications: 'user_id',
  project_members: 'user_id',
  // field & quality (contract-field.ts)
  diary_labour: 'diary_id', diary_equipment: 'diary_id', diary_delays: 'diary_id', diary_visitors: 'diary_id',
  diary_instructions: 'diary_id', diary_elements: 'diary_id', diary_addenda: 'diary_id',
  checklist_template_items: 'template_id', inspections: 'element_id', inspection_items: 'inspection_id',
  snags: 'element_id', snag_events: 'snag_id', pour_elements: 'pour_id', pour_trucks: 'pour_id', pour_batches: 'pour_id',
  pour_issues: 'pour_id', cube_sets: 'pour_id', cube_results: 'cube_set_id', bbs_schedules: 'element_id', bbs_lines: 'bbs_id',
  // procurement + site control (tables-pc.ts)
  ...PC_PARENT_COLUMN,
  // schedule progress + look-ahead (tables-schedule.ts)
  ...SL_PARENT_COLUMN,
  // material procurement flows (contract-flows.ts)
  mr_approvals: 'mr_id', delivery_notices: 'po_id',
  // site operations (contract-site.ts)
  plant_logs: 'plant_id',
};

const PK: Record<string, string[]> = Object.fromEntries([...SYNC_TABLES, ...PC_TABLES, ...SL_TABLES, ...SYNC_TABLES_FLOWS, ...PRICE_TABLES_FLOWS].map((t) => [t.name, t.pk]));

export const pkOf = (tbl: string, row: Record<string, unknown>) =>
  (PK[tbl] ?? ['id']).map((k) => String(row[k])).join('|');

let db: SQLite.SQLiteDatabase | null = null;

async function dbKey(): Promise<string> {
  let key = await SecureStore.getItemAsync(KEY_NAME);
  if (!key) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(KEY_NAME, key);
  }
  return key;
}

export async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  const d = SQLite.openDatabaseSync('site.db');
  // SQLCipher (enabled via the expo-sqlite config plugin in a dev/production build).
  const key = await dbKey();
  d.execSync(`PRAGMA key = '${key}';`);
  d.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rows (
      tbl TEXT NOT NULL, pk TEXT NOT NULL, project_id TEXT, parent TEXT, updated_at TEXT,
      deleted INTEGER NOT NULL DEFAULT 0, pending TEXT, orig TEXT, json TEXT NOT NULL,
      PRIMARY KEY (tbl, pk));
    CREATE INDEX IF NOT EXISTS rows_tbl_project ON rows (tbl, project_id);
    CREATE INDEX IF NOT EXISTS rows_tbl_parent ON rows (tbl, parent);
    CREATE INDEX IF NOT EXISTS rows_pending ON rows (pending);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, op_id TEXT NOT NULL, rpc TEXT NOT NULL, payload TEXT NOT NULL,
      entity_type TEXT, entity_id TEXT, label TEXT, status TEXT NOT NULL, error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS outbox_status ON outbox (status, seq);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      kind TEXT NOT NULL, local_uri TEXT NOT NULL, mime TEXT, lat REAL, lng REAL,
      status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
  `);
  // Added later (photos from the gallery keep their own date; camera vs gallery is evidence). SQLite has no ADD COLUMN IF NOT EXISTS.
  for (const col of ['source TEXT', 'captured_at TEXT']) {
    try { d.execSync(`ALTER TABLE uploads ADD COLUMN ${col}`); } catch { /* already there */ }
  }
  db = d;
  return d;
}

export function getDb(): SQLite.SQLiteDatabase {
  if (!db) throw new Error('Local database not opened');
  return db;
}

// ---------------------------------------------------------------------------
// Change notification: screens re-query when the data version bumps.
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
export const dataVersion = () => version;
export function subscribe(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function bump() {
  version++;
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------------------
// kv
// ---------------------------------------------------------------------------

export function kvGet(k: string): string | null {
  const r = getDb().getFirstSync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]);
  return r?.v ?? null;
}
export function kvSet(k: string, v: string | null) {
  if (v === null) getDb().runSync('DELETE FROM kv WHERE k = ?', [k]);
  else getDb().runSync('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [k, v]);
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;
interface RawRow { json: string; pending: string | null }

function meta(tbl: string, row: Row) {
  const parentCol = PARENT_COLUMN[tbl];
  return {
    pk: pkOf(tbl, row),
    project_id: (tbl === 'projects' ? row.id : row.project_id) as string | null ?? null,
    parent: parentCol ? ((row[parentCol] as string | null) ?? null) : null,
    updated_at: (row.updated_at as string | null) ?? null,
    deleted: row.deleted_at ? 1 : 0,
  };
}

/** Upsert rows coming from the server. Rows with a still-unsynced optimistic
 *  version are kept, but their server copy is remembered for rollback. */
export function upsertServerRows(tbl: string, rows: Row[]) {
  const d = getDb();
  d.withTransactionSync(() => {
    for (const row of rows) {
      const m = meta(tbl, row);
      d.runSync(
        `INSERT INTO rows (tbl, pk, project_id, parent, updated_at, deleted, pending, orig, json)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT (tbl, pk) DO UPDATE SET
           orig = CASE WHEN rows.pending IN (SELECT op_id FROM outbox WHERE status IN ('pending','failed')) THEN excluded.json ELSE NULL END,
           json = CASE WHEN rows.pending IN (SELECT op_id FROM outbox WHERE status IN ('pending','failed')) THEN rows.json ELSE excluded.json END,
           project_id = excluded.project_id, parent = excluded.parent, updated_at = excluded.updated_at,
           deleted = CASE WHEN rows.pending IN (SELECT op_id FROM outbox WHERE status IN ('pending','failed')) THEN rows.deleted ELSE excluded.deleted END,
           pending = CASE WHEN rows.pending IN (SELECT op_id FROM outbox WHERE status IN ('pending','failed')) THEN rows.pending ELSE NULL END`,
        [tbl, m.pk, m.project_id, m.parent, m.updated_at, m.deleted, JSON.stringify(row)],
      );
    }
  });
}

/** Write an optimistic row on behalf of an outbox op. */
export function putPending(tbl: string, row: Row, opId: string, pk?: string) {
  const d = getDb();
  const m = meta(tbl, row);
  const key = pk ?? m.pk;
  const existing = d.getFirstSync<{ json: string; pending: string | null; orig: string | null }>(
    'SELECT json, pending, orig FROM rows WHERE tbl = ? AND pk = ?', [tbl, key]);
  const orig = existing ? (existing.pending ? existing.orig : existing.json) : null;
  d.runSync(
    `INSERT INTO rows (tbl, pk, project_id, parent, updated_at, deleted, pending, orig, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tbl, pk) DO UPDATE SET project_id = excluded.project_id, parent = excluded.parent,
       updated_at = excluded.updated_at, deleted = excluded.deleted, pending = excluded.pending,
       orig = excluded.orig, json = excluded.json`,
    [tbl, key, m.project_id, m.parent, m.updated_at, m.deleted, opId, orig, JSON.stringify(row)],
  );
}

/** Drop optimistic rows of an op: restore server copies, delete pure local rows. */
export function rollbackPending(opId: string) {
  const d = getDb();
  d.withTransactionSync(() => {
    const rs = d.getAllSync<{ tbl: string; pk: string; orig: string | null }>(
      'SELECT tbl, pk, orig FROM rows WHERE pending = ?', [opId]);
    for (const r of rs) {
      if (r.orig) {
        const row = JSON.parse(r.orig) as Row;
        const m = meta(r.tbl, row);
        d.runSync('UPDATE rows SET json = ?, orig = NULL, pending = NULL, deleted = ? WHERE tbl = ? AND pk = ?',
          [r.orig, m.deleted, r.tbl, r.pk]);
      } else {
        d.runSync('DELETE FROM rows WHERE tbl = ? AND pk = ?', [r.tbl, r.pk]);
      }
    }
  });
}

/** After a successful push + pull, optimistic rows of synced ops are obsolete. */
export function clearSyncedPending() {
  const d = getDb();
  // Rows whose pk the server echoed back were already replaced on pull; the rest
  // (e.g. locally keyed stock-ledger rows) are removed.
  d.runSync(`DELETE FROM rows WHERE pending IN (SELECT op_id FROM outbox WHERE status = 'synced') AND orig IS NULL
             AND pk LIKE 'local:%'`);
  d.runSync(`UPDATE rows SET pending = NULL, orig = NULL WHERE pending IN (SELECT op_id FROM outbox WHERE status = 'synced')`);
}

export interface Opts { project?: string | null; parent?: string | null; includeDeleted?: boolean }

export function list<T>(tbl: string, opts: Opts = {}): (T & { _pending?: string })[] {
  const where = ['tbl = ?'];
  const args: (string | number)[] = [tbl];
  if (opts.project) { where.push('project_id = ?'); args.push(opts.project); }
  if (opts.parent) { where.push('parent = ?'); args.push(opts.parent); }
  if (!opts.includeDeleted) where.push('deleted = 0');
  const rs = getDb().getAllSync<RawRow>(`SELECT json, pending FROM rows WHERE ${where.join(' AND ')}`, args);
  return rs.map((r) => {
    const o = JSON.parse(r.json) as T & { _pending?: string };
    if (r.pending) o._pending = r.pending;
    return o;
  });
}

export function get<T>(tbl: string, pk: string | null | undefined): (T & { _pending?: string }) | null {
  if (!pk) return null;
  const r = getDb().getFirstSync<RawRow>('SELECT json, pending FROM rows WHERE tbl = ? AND pk = ?', [tbl, pk]);
  if (!r) return null;
  const o = JSON.parse(r.json) as T & { _pending?: string };
  if (r.pending) o._pending = r.pending;
  return o;
}

/** Clears data when a different user signs in. Device prefix and document
 *  counters are kept so offline numbers never repeat on this device. */
export function wipeLocalData() {
  getDb().execSync(`DELETE FROM rows; DELETE FROM outbox; DELETE FROM uploads;
    DELETE FROM kv WHERE k NOT LIKE 'seq:%' AND k <> 'device-prefix';`);
  bump();
}
