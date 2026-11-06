// Document numbers created in this browser (FR-OF-06): <PROJECT>-<TYPE>-<DEVICE>-<SEQ>.
// The device prefix comes from register_device (idempotent; auth.tsx registers on sign-in) and is
// cached per browser. The sequence is max(local counter, highest number already on the server) + 1,
// so clearing localStorage or using the same device id in two tabs never re-issues a number.
import { DEVICE_ID, supabase } from './supabase';
import { docNumber, type DocType } from './contract';
import { procurementDocNumber } from './contract-procurement';

const PREFIX_KEY = `sc.devicePrefix.${DEVICE_ID}`;
let pending: Promise<string> | null = null;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

/** This browser's registered device prefix (e.g. "D007"). */
export function devicePrefix(): Promise<string> {
  const cached = read(PREFIX_KEY);
  if (cached) return Promise.resolve(cached);
  pending ??= (async () => {
    const { data, error } = await supabase.rpc('register_device', { p: { device_id: DEVICE_ID, name: 'Web console' } });
    if (error) throw new Error(error.message);
    const prefix = String((data as { prefix?: string } | null)?.prefix ?? '');
    if (!prefix) throw new Error('Could not register this browser for document numbers');
    write(PREFIX_KEY, prefix);
    return prefix;
  })().finally(() => { pending = null; });
  return pending;
}

/** 'PR' = purchase request (material_requests.request_type 'purchase'; contract-flows flowDocNumber). */
export type NumberType = DocType | 'PR';

/** Table holding each document type's `number` column (server high-water mark). */
const TABLES: Partial<Record<NumberType, string>> = {
  MR: 'material_requests', PR: 'material_requests', GRN: 'grns', MIV: 'mivs', MRN: 'mrns', ADJ: 'adjustments', CNT: 'stock_counts', TRF: 'transfers',
  RFQ: 'rfqs', QT: 'quotations', PO: 'purchase_orders',
};

/** Reserves `count` consecutive numbers for this device. */
export async function nextDocNumbers(projectCode: string, type: NumberType, count = 1): Promise<string[]> {
  if (!projectCode) throw new Error('Select a project first');
  const prefix = await devicePrefix();
  const stem = `${projectCode}-${type}-${prefix}-`;
  const key = `sc.docseq.${stem}`;
  let seq = Number(read(key)) || 0;
  const table = TABLES[type];
  if (table) {
    const { data, error } = await supabase.from(table).select('number').like('number', `${stem}%`).order('number', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const last = (data as { number: string }[] | null)?.[0]?.number;
    if (last) seq = Math.max(seq, Number(last.slice(stem.length)) || 0);
  }
  const fmt = type === 'RFQ' || type === 'QT' || type === 'PO'
    ? (n: number) => procurementDocNumber(projectCode, type, prefix, n)
    : (n: number) => docNumber(projectCode, type as DocType, prefix, n); // 'PR' → <PROJ>-PR-<DEV>-<SEQ> (same format)
  const out = Array.from({ length: count }, (_, i) => fmt(seq + i + 1));
  write(key, String(seq + count));
  return out;
}

export const nextDocNumber = async (projectCode: string, type: NumberType) => (await nextDocNumbers(projectCode, type, 1))[0];
