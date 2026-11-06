// QR labels (SM1 codes): offline verification with the per-project key from get_qr_key,
// kept in expo-secure-store (never in the SQLite store). Roles without key access
// (and phones that never fetched it) fall back to the online verify_qr RPC.
import * as SecureStore from 'expo-secure-store';
import type { AppRole } from './contract';
import { canControl, parseQr, verifyQr, type QrPayload } from './contract-control';
import { supabase } from './supabase';

const keys = new Map<string, string>();
const storeKey = (projectId: string) => `qr-key.${projectId}`;

async function loadKey(projectId: string): Promise<string | undefined> {
  if (keys.has(projectId)) return keys.get(projectId);
  try {
    const v = await SecureStore.getItemAsync(storeKey(projectId));
    if (v) keys.set(projectId, v);
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

/** Fetch the project key once (online) for roles allowed to verify at the gate / store. */
export async function ensureQrKey(projectId: string, role: AppRole | null | undefined): Promise<boolean> {
  if (await loadKey(projectId)) return true;
  if (!canControl(role, 'qr.key')) return false;
  try {
    const { data, error } = await supabase.rpc('get_qr_key', { p: { project_id: projectId } });
    const hex = (data as { key_hex?: string } | null)?.key_hex;
    if (error || !hex) return false;
    await SecureStore.setItemAsync(storeKey(projectId), hex);
    keys.set(projectId, hex);
    return true;
  } catch {
    return false;
  }
}

export const hasQrKey = (projectId: string) => keys.has(projectId);

export interface QrCheck { ok: boolean; payload: QrPayload | null; how: 'offline' | 'online' | null; reason?: string }

const withTimeout = <T,>(p: PromiseLike<T>, ms: number) =>
  Promise.race([Promise.resolve(p), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/** Verify a scanned code: offline with the cached key, else online. */
export async function checkQr(code: string): Promise<QrCheck> {
  const q = parseQr(code);
  if (!q) return { ok: false, payload: null, how: null, reason: 'Not a Site Materials QR code' };
  const key = await loadKey(q.project_id);
  if (key) {
    const r = verifyQr(code, () => key);
    return r?.valid ? { ok: true, payload: r, how: 'offline' } : { ok: false, payload: r, how: 'offline', reason: 'Signature does not match: label may be forged or from another system' };
  }
  try {
    const { data, error } = await withTimeout(supabase.rpc('verify_qr', { p: { code } }), 8000);
    if (error) throw new Error(error.message);
    const d = data as { valid?: boolean; member?: boolean; project_id: string; entity_type?: string; entity_id?: string };
    if (!d?.valid) return { ok: false, payload: null, how: 'online', reason: 'Signature does not match' };
    if (d.member === false) return { ok: false, payload: null, how: 'online', reason: 'This label belongs to a project you are not a member of' };
    return { ok: true, how: 'online', payload: { valid: true, project_id: d.project_id, entity_type: d.entity_type ?? q.entity_type, entity_id: d.entity_id ?? q.entity_id } };
  } catch {
    return { ok: false, payload: null, how: null, reason: 'Cannot verify offline on this phone. Connect once so the gate key can be downloaded.' };
  }
}
