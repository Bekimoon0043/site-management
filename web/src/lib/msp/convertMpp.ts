// Client for the local .mpp → MS Project XML converter (tools/mpp-converter/server.py).
// Browsers can't read binary MS Project files, so the wizard posts them to the converter on the office PC and
// parses the returned MSPDI XML exactly like an uploaded .xml.
import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

/** Extensions that go through the converter (MPXJ's UniversalProjectReader). MSPDI .xml stays in the browser. */
export const CONVERTER_EXTS = ['mpp', 'mpt', 'mpx', 'xer', 'pp', 'pod', 'gan', 'sdef', 'fts', 'cdpx', 'mpd', 'pep', 'ppx'];
export const CONVERTER_ACCEPT = CONVERTER_EXTS.map((e) => `.${e}`).join(',');
export const CONVERTER_MAX_MB = 60;

export function needsConverter(name: string): boolean {
  return CONVERTER_EXTS.includes(name.toLowerCase().split('.').pop() ?? '');
}

/** VITE_MPP_CONVERTER_URL, or `<page protocol>//<page host>:8787`. */
export function converterUrl(): string {
  const env = (import.meta.env.VITE_MPP_CONVERTER_URL as string | undefined)?.trim();
  if (env) return env.replace(/\/+$/, '');
  return `${location.protocol}//${location.hostname}:8787`;
}

const FALLBACK = 'Start the converter on the office PC, or in MS Project use File → Save As → XML and upload the .xml.';

/** Converts a binary schedule to MSPDI XML. Returns a File named `<name>.xml`. Rejects with a user-readable message. */
export async function convertScheduleFile(file: File, signal?: AbortSignal): Promise<File> {
  if (file.size > CONVERTER_MAX_MB * 1024 * 1024) throw new Error(`${file.name} is larger than ${CONVERTER_MAX_MB} MB.`);
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Your session has expired — sign in again, then retry.');
  let res: Response;
  try {
    res = await fetch(`${converterUrl()}/convert`, {
      method: 'POST', body: file, signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new Error(`The MS Project converter is not reachable (${converterUrl()}). ${FALLBACK}`);
  }
  if (!res.ok) {
    const msg = await res.json().then((j: { error?: string }) => j.error).catch(() => undefined);
    if (res.status === 401) throw new Error('Your session has expired — sign in again, then retry.');
    if (res.status === 413) throw new Error(msg ?? `${file.name} is too large for the converter.`);
    if (res.status === 400) throw new Error(msg ?? `${file.name} could not be read as a schedule.`);
    throw new Error(`The converter failed (${res.status}${msg ? `: ${msg}` : ''}). ${FALLBACK}`);
  }
  const xml = await res.text();
  return new File([xml], `${file.name.replace(/\.[^.]+$/, '')}.xml`, { type: 'application/xml' });
}

export type ConverterStatus = 'checking' | 'online' | 'offline';

/** Pings GET /health once (short timeout). */
export function useConverterHealth(timeoutMs = 2500): ConverterStatus {
  const [s, setS] = useState<ConverterStatus>('checking');
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    fetch(`${converterUrl()}/health`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean } | null) => setS(j?.ok ? 'online' : 'offline'))
      .catch(() => setS('offline'))
      .finally(() => clearTimeout(t));
    return () => { clearTimeout(t); ac.abort(); };
  }, [timeoutMs]);
  return s;
}
