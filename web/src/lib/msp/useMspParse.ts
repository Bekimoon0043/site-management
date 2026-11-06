// Runs the schedule parser in a Web Worker (main-thread fallback when Workers are unavailable).
import { useEffect, useState } from 'react';
import type { ScheduleParseOptions } from './parse';
import type { QualityReport } from './quality';
import type { MspParseProgress, ParsedSchedule } from './types';
import type { MspWorkerRequest, MspWorkerResponse } from './worker';

export interface MspParseOutput { result: ParsedSchedule; quality: QualityReport; ms: number }

let seq = 0;

/** Parses `file` off the main thread. Rejects with a user-readable message. `signal` terminates the worker. */
export function parseScheduleFile(
  file: Blob, name: string, options: ScheduleParseOptions = {},
  onProgress?: (p: MspParseProgress) => void, signal?: AbortSignal,
): Promise<MspParseOutput> {
  if (typeof Worker === 'undefined') return parseOnMainThread(file, name, options);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const id = ++seq;
    const done = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
    const abort = () => { done(); reject(new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort);
    worker.onmessage = (e: MessageEvent<MspWorkerResponse>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') onProgress?.(m.progress);
      else if (m.type === 'done') { done(); resolve({ result: m.result, quality: m.quality, ms: m.ms }); }
      else { done(); reject(new Error(m.error)); }
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || 'Schedule parser failed')); };
    worker.postMessage({ id, file, name, options } satisfies MspWorkerRequest);
  });
}

async function parseOnMainThread(file: Blob, name: string, options: ScheduleParseOptions): Promise<MspParseOutput> {
  const t0 = performance.now();
  const [{ parseScheduleBuffer, sha256Hex }, { qualityReport }] = await Promise.all([import('./parse'), import('./quality')]);
  const buf = await file.arrayBuffer();
  const result = parseScheduleBuffer(buf, name, options);
  result.file_sha256 = await sha256Hex(buf);
  return { result, quality: qualityReport(result), ms: Math.round(performance.now() - t0) };
}

export type MspParseState =
  | { status: 'idle' }
  | { status: 'parsing'; progress: MspParseProgress | null }
  | ({ status: 'done' } & MspParseOutput)
  | { status: 'error'; error: string };

/**
 * `const s = useMspParse(file, { boqField: 'BoQ Code' })` — re-parses when the file or options change.
 * Pass `null` to reset. Options are compared by value.
 */
export function useMspParse(file: File | null, options: ScheduleParseOptions = {}): MspParseState {
  const optKey = JSON.stringify(options);
  // State is tagged with the (file, options) it belongs to; anything else renders as 'parsing'.
  const [tagged, setTagged] = useState<{ file: File; optKey: string; state: MspParseState } | null>(null);
  useEffect(() => {
    if (!file) return;
    const ac = new AbortController();
    const set = (state: MspParseState) => { if (!ac.signal.aborted) setTagged({ file, optKey, state }); };
    parseScheduleFile(file, file.name, JSON.parse(optKey) as ScheduleParseOptions,
      (progress) => set({ status: 'parsing', progress }), ac.signal)
      .then((out) => set({ status: 'done', ...out }))
      .catch((e: Error) => { if (e.name !== 'AbortError') set({ status: 'error', error: e.message }); });
    return () => ac.abort();
  }, [file, optKey]);
  if (!file) return { status: 'idle' };
  if (!tagged || tagged.file !== file || tagged.optKey !== optKey) return { status: 'parsing', progress: null };
  return tagged.state;
}
