// Web photo / document upload: EXIF date + GPS (read before re-encoding drops them), downscale + JPEG compression,
// SHA-256 fingerprint (tamper evidence), upload to <project>/<entity_type>/<id>.<ext> and the attachments row.
import { check, supabase } from './supabase';
import type { AttachmentKindAll, AttachmentRow, AttachmentTag, UpdateAttachmentPayload } from './contract-photos';
import { MAX_FILE_BYTES } from './contract-photos';
import { invalidate } from './hooks';

export interface UploadTarget {
  projectId: string; entityType: string; entityId: string; kind?: AttachmentKindAll; tag?: AttachmentTag | null;
  caption?: string | null; blockId?: string | null; levelId?: string | null;
}
export interface ExifInfo { takenAt: string | null; lat: number | null; lng: number | null }

const MAX_DIM = 2048;
const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
export const isImageFile = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

/** Minimal JPEG EXIF reader: DateTimeOriginal (or DateTime) and GPS position. */
export function readExif(buf: ArrayBuffer): ExifInfo {
  const out: ExifInfo = { takenAt: null, lat: null, lng: null };
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return out;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) { parseTiff(v, off + 10, out); break; }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + size;
    }
  } catch { /* unreadable EXIF is not an error */ }
  return out;
}

function parseTiff(v: DataView, t: number, out: ExifInfo) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const entries = (ifd: number) => {
    const n = u16(t + ifd);
    const res = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const e = t + ifd + 2 + i * 12;
      const type = u16(e + 2), count = u32(e + 4);
      const bytes = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 } as Record<number, number>)[type] ?? 1;
      res.set(u16(e), { type, count, at: bytes * count <= 4 ? e + 8 : t + u32(e + 8) });
    }
    return res;
  };
  const ascii = (x?: { count: number; at: number }) => {
    if (!x) return null;
    let s = '';
    for (let i = 0; i < x.count; i++) { const c = v.getUint8(x.at + i); if (!c) break; s += String.fromCharCode(c); }
    return s;
  };
  const rational3 = (x?: { at: number }) => {
    if (!x) return null;
    const r = (k: number) => { const d = u32(x.at + k * 8 + 4); return d ? u32(x.at + k * 8) / d : 0; };
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  const ifd0 = entries(u32(t + 4));
  let dt = ascii(ifd0.get(0x0132));
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr) dt = ascii(entries(u32(exifPtr.at)).get(0x9003)) ?? dt;
  const m = dt?.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  // Camera clocks have no zone: site cameras run on Addis Ababa time (UTC+3).
  if (m && m[1] !== '0000') out.takenAt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`).toISOString();
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const g = entries(u32(gpsPtr.at));
    const lat = rational3(g.get(2)), lng = rational3(g.get(4));
    if (lat != null && lng != null && (lat !== 0 || lng !== 0)) {
      out.lat = ascii(g.get(1)) === 'S' ? -lat : lat;
      out.lng = ascii(g.get(3)) === 'W' ? -lng : lng;
    }
  }
}

/** Downscale to MAX_DIM and re-encode as JPEG (keeps the original when smaller or not decodable, e.g. HEIC). */
export async function compressImage(file: File): Promise<{ blob: Blob; mime: string; ext: string }> {
  const ext0 = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (blob && (blob.size < file.size || k < 1 || !/^image\/jpe?g$/.test(file.type))) return { blob, mime: 'image/jpeg', ext: 'jpg' };
  } catch { /* fall through: upload as is */ }
  return { blob: file, mime: file.type || 'application/octet-stream', ext: ext0 };
}

async function sha256Hex(blob: Blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reject files the server or the viewer cannot handle; returns a reason or null. */
export function fileProblem(f: File): string | null {
  if (!isImageFile(f) && !isPdf(f)) return `${f.name}: only photos (JPG, PNG, WebP, HEIC) and PDF files`;
  if (f.size > MAX_FILE_BYTES * (isImageFile(f) ? 3 : 1)) return `${f.name}: file is too large (max ${Math.round(MAX_FILE_BYTES / 1048576)} MB)`;
  return null;
}

/** Upload one file and create its attachments row. */
export async function uploadFile(f: File, target: UploadTarget): Promise<string> {
  const bad = fileProblem(f);
  if (bad) throw new Error(bad);
  const id = crypto.randomUUID();
  const exif: ExifInfo = isImageFile(f) && /jpe?g$/i.test(f.type || f.name) ? readExif(await f.arrayBuffer()) : { takenAt: null, lat: null, lng: null };
  const { blob, mime, ext } = isImageFile(f) ? await compressImage(f) : { blob: f as Blob, mime: 'application/pdf', ext: 'pdf' };
  if (blob.size > MAX_FILE_BYTES) throw new Error(`${f.name}: still larger than ${Math.round(MAX_FILE_BYTES / 1048576)} MB after compression`);
  const path = `${target.projectId}/${target.entityType}/${id}.${ext}`;
  const up = await supabase.storage.from('attachments').upload(path, blob, { contentType: mime, upsert: false });
  if (up.error) throw new Error(`${f.name}: ${up.error.message}`);
  check(await supabase.from('attachments').insert({
    id, project_id: target.projectId, entity_type: target.entityType, entity_id: target.entityId,
    kind: target.kind ?? (isPdf(f) ? 'document' : 'photo'), storage_path: path, mime_type: mime,
    latitude: exif.lat, longitude: exif.lng, captured_at: exif.takenAt ?? new Date(f.lastModified || Date.now()).toISOString(),
    sha256: await sha256Hex(blob), source: 'upload', caption: target.caption || null, tag: target.tag || null,
    block_id: target.blockId || null, level_id: target.levelId || null, file_name: f.name.slice(0, 200), size_bytes: blob.size,
    created_by: (await supabase.auth.getUser()).data.user?.id,
  }));
  return id;
}

/** Upload several files one after another; reports progress and collects per-file errors instead of stopping. */
export async function uploadFiles(files: File[], target: UploadTarget, onProgress?: (done: number, total: number) => void) {
  const errors: string[] = [];
  let ok = 0;
  for (let i = 0; i < files.length; i++) {
    try { await uploadFile(files[i], target); ok++; } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    onProgress?.(i + 1, files.length);
  }
  invalidate('attachments', 'site-photos');
  return { ok, errors };
}

export async function updateAttachment(p: UpdateAttachmentPayload) {
  const { error } = await supabase.rpc('update_attachment', { p });
  if (error) throw new Error(error.message);
  invalidate('attachments', 'site-photos');
}

export async function setAttachmentClientVisibility(id: string, visible: boolean) {
  const { error } = await supabase.rpc('set_attachment_client_visibility', { p: { id, visible } });
  if (error) throw new Error(error.message);
  invalidate('attachments', 'site-photos', 'client-photos');
}

export type AttachmentWithUrl = AttachmentRow & { url: string | null };

/** Signed URLs (1 h) for a page of attachments. */
export async function withUrls(rows: AttachmentRow[]): Promise<AttachmentWithUrl[]> {
  if (!rows.length) return [];
  const { data } = await supabase.storage.from('attachments').createSignedUrls(rows.map((r) => r.storage_path), 3600);
  const urls = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
  return rows.map((r) => ({ ...r, url: urls.get(r.storage_path) ?? null }));
}

/** Fetch the private file before downloading: the HTML download attribute is ignored for cross-origin signed URLs. */
export async function downloadAttachment(a: AttachmentWithUrl): Promise<void> {
  if (!a.url) throw new Error('The file URL is unavailable or has expired; close the viewer and try again');
  const res = await fetch(a.url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = a.file_name || a.storage_path.split('/').pop() || 'attachment';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const isImage = (a: { mime_type: string | null }) => (a.mime_type ?? '').startsWith('image/');
