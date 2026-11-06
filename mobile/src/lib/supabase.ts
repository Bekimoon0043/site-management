import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const isConfigured = SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20;

// SecureStore values are limited to ~2 KB, so the session is stored in chunks.
const CHUNK = 1800;
const safeKey = (k: string) => k.replace(/[^A-Za-z0-9._-]/g, '_');

const chunkedSecureStore: SupportedStorage = {
  async getItem(key) {
    const k = safeKey(key);
    const n = Number(await SecureStore.getItemAsync(`${k}.n`));
    if (!n) return SecureStore.getItemAsync(k);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push((await SecureStore.getItemAsync(`${k}.${i}`)) ?? '');
    return parts.join('');
  },
  async setItem(key, value) {
    const k = safeKey(key);
    const n = Math.ceil(value.length / CHUNK);
    for (let i = 0; i < n; i++) await SecureStore.setItemAsync(`${k}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    await SecureStore.setItemAsync(`${k}.n`, String(n));
  },
  async removeItem(key) {
    const k = safeKey(key);
    const n = Number(await SecureStore.getItemAsync(`${k}.n`));
    for (let i = 0; i < n; i++) await SecureStore.deleteItemAsync(`${k}.${i}`);
    await SecureStore.deleteItemAsync(`${k}.n`);
    await SecureStore.deleteItemAsync(k);
  },
};

// Persistent per-install device id, sent as x-device-id for the audit trail (FR-AU-01).
let deviceId: string | null = null;
export async function loadDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  let id = await SecureStore.getItemAsync('device-id');
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync('device-id', id);
  }
  deviceId = id;
  return id;
}
export const getDeviceId = () => deviceId ?? '';

/** True when a session (possibly with an expired access token) is stored on the
 *  device. Lets the app start offline even if the token cannot be refreshed yet. */
export async function hasStoredSession(): Promise<boolean> {
  if (!isConfigured) return false;
  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  return !!(await chunkedSecureStore.getItem(`sb-${ref}-auth-token`));
}

export const supabase = createClient(
  isConfigured ? SUPABASE_URL : 'http://localhost:54321',
  isConfigured ? SUPABASE_ANON_KEY : 'anon-key-not-configured',
  {
    auth: { storage: chunkedSecureStore, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (deviceId) headers.set('x-device-id', deviceId);
        return fetch(input, { ...init, headers });
      },
    },
  },
);
