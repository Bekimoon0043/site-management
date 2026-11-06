// Device registration and collision-free offline document numbers (FR-OF-06).
import * as Device from 'expo-device';
import { docNumber, type DocType } from './contract';
import { getDb, kvGet, kvSet } from './db';
import { supabase, loadDeviceId } from './supabase';

export const devicePrefix = () => kvGet('device-prefix');

export async function ensureDeviceRegistered(): Promise<string | null> {
  const existing = devicePrefix();
  if (existing) return existing;
  const id = await loadDeviceId();
  const { data, error } = await supabase.rpc('register_device', {
    p: { device_id: id, name: `${Device.manufacturer ?? ''} ${Device.modelName ?? ''}`.trim() || 'Android device' },
  });
  if (error || !data) return null;
  const prefix = (data as { prefix: string }).prefix;
  kvSet('device-prefix', prefix);
  return prefix;
}

/** Next number for a document type. The counter is local; the device prefix keeps it unique. */
export function nextDocNumber(projectCode: string, type: DocType): string {
  const prefix = devicePrefix();
  if (!prefix) throw new Error('This device is not registered yet. Connect to the internet once to register it.');
  const d = getDb();
  const key = `seq:${projectCode}:${type}`;
  let n = 0;
  d.withTransactionSync(() => {
    n = Number(kvGet(key) ?? '0') + 1;
    kvSet(key, String(n));
  });
  return docNumber(projectCode, type, prefix, n);
}
