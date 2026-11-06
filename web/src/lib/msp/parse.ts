// Format detection + dispatch, shared by the worker and the main-thread fallback.
import { parseExcelSchedule } from './parseExcel';
import { parseMspdi } from './parseMspdi';
import type { ExcelParseOptions, MspParseProgress, ParseOptions, ParsedSchedule } from './types';

/** Options that can cross postMessage (no functions / constructors). */
export type ScheduleParseOptions = Omit<ParseOptions, 'DOMParser' | 'onProgress'> & Omit<ExcelParseOptions, 'onProgress'>;

export const SCHEDULE_ACCEPT = '.xml,.xlsx,.xls,.csv';

export function detectScheduleFormat(name: string, head: Uint8Array): 'mspdi' | 'excel' | 'mpp' | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'mpp' || (head[0] === 0xd0 && head[1] === 0xcf && ext !== 'xls')) return 'mpp';
  if (ext === 'xml') return 'mspdi';
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return 'excel';
  const s = new TextDecoder().decode(head.slice(0, 512)).replace(/^﻿/, '').trimStart();
  if (s.startsWith('<')) return 'mspdi';
  if (head[0] === 0x50 && head[1] === 0x4b) return 'excel';
  return null;
}

export function parseScheduleBuffer(
  buf: ArrayBuffer, name: string, opts: ScheduleParseOptions = {},
  env: { DOMParser?: ParseOptions['DOMParser']; onProgress?: (p: MspParseProgress) => void } = {},
): ParsedSchedule {
  const bytes = new Uint8Array(buf);
  const fmt = detectScheduleFormat(name, bytes.slice(0, 512));
  if (fmt === 'mpp') throw new Error('.mpp files cannot be read in the browser. In MS Project use File › Save As › XML Format (*.xml), then upload the .xml.');
  if (fmt === 'mspdi') return parseMspdi(new TextDecoder('utf-8').decode(bytes), name, { ...opts, ...env });
  if (fmt === 'excel') return parseExcelSchedule(bytes, name, { ...opts, onProgress: env.onProgress });
  throw new Error('Unsupported file. Upload an MS Project XML (.xml) or the Excel template (.xlsx).');
}

/** SHA-256 hex of the file bytes (Web Crypto; available in workers, browsers on https/localhost, and Node). */
export async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // insecure context (plain http on the LAN): server then skips the duplicate-file check
  }
}
