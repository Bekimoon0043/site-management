// Web Worker: parses an MSPDI / Excel schedule off the main thread. DOMParser does not exist in workers,
// so XML goes through @xmldom/xmldom. Create with:
//   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
import { DOMParser } from '@xmldom/xmldom';
import { parseScheduleBuffer, sha256Hex, type ScheduleParseOptions } from './parse';
import { qualityReport } from './quality';
import type { MspParseProgress, ParsedSchedule } from './types';
import type { QualityReport } from './quality';

export type MspWorkerRequest = { id: number; file: Blob | ArrayBuffer; name: string; options?: ScheduleParseOptions };
export type MspWorkerResponse =
  | { id: number; type: 'progress'; progress: MspParseProgress }
  | { id: number; type: 'done'; result: ParsedSchedule; quality: QualityReport; ms: number }
  | { id: number; type: 'error'; error: string };

// Typed minimally: the app tsconfig uses lib.dom, which lacks DedicatedWorkerGlobalScope.
const ctx = self as unknown as { postMessage(m: MspWorkerResponse): void; onmessage: ((e: MessageEvent<MspWorkerRequest>) => void) | null };

ctx.onmessage = async (e: MessageEvent<MspWorkerRequest>) => {
  const { id, file, name, options } = e.data;
  const post = (m: MspWorkerResponse) => ctx.postMessage(m);
  const t0 = performance.now();
  try {
    post({ id, type: 'progress', progress: { stage: 'reading' } });
    const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
    const result = parseScheduleBuffer(buf, name, options, {
      DOMParser: DOMParser as unknown as NonNullable<Parameters<typeof parseScheduleBuffer>[3]>['DOMParser'],
      onProgress: (progress) => post({ id, type: 'progress', progress }),
    });
    result.file_sha256 = await sha256Hex(buf);
    post({ id, type: 'progress', progress: { stage: 'checking' } });
    post({ id, type: 'done', result, quality: qualityReport(result), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
