// Photo capture, compression, evidence metadata and background upload (FR-OF-05).
// Photos and their captions / tags / hashes are queued locally first; upload happens during sync, optionally on Wi-Fi only.
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { File, Paths, Directory } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { bump, getDb, kvGet } from './db';
import { supabase } from './supabase';
import { myId } from './me';
import type { AttachmentTag } from './contract-photos';

export type AttachmentKind = 'photo' | 'delivery_note' | 'signature' | 'document';
export interface UploadEntry {
  id: string; project_id: string; entity_type: string; entity_id: string; kind: AttachmentKind;
  local_uri: string; mime: string | null; lat: number | null; lng: number | null;
  status: 'pending' | 'uploaded' | 'failed'; error: string | null; created_at: string;
  source?: 'camera' | 'gallery' | null; captured_at?: string | null;
  caption?: string | null; tag?: AttachmentTag | null; file_name?: string | null; size_bytes?: number | null; sha256?: string | null;
}

let metadataReady = false;
function metadataDb() {
  const d = getDb();
  if (!metadataReady) {
    d.execSync(`CREATE TABLE IF NOT EXISTS photo_metadata (
      upload_id TEXT PRIMARY KEY, caption TEXT, tag TEXT, file_name TEXT, size_bytes INTEGER, sha256 TEXT,
      FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE);
    CREATE TRIGGER IF NOT EXISTS photo_metadata_cascade AFTER DELETE ON uploads BEGIN
      DELETE FROM photo_metadata WHERE upload_id = OLD.id;
    END`);
    metadataReady = true;
  }
  return d;
}

export const wifiOnly = () => kvGet('wifi-only-photos') === '1';

async function geotag(): Promise<{ lat: number | null; lng: number | null }> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm.granted) {
      const req = await Location.requestForegroundPermissionsAsync();
      if (!req.granted) return { lat: null, lng: null };
    }
    const last = await Location.getLastKnownPositionAsync();
    const pos = last ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return { lat: null, lng: null };
  }
}

type Target = {
  projectId: string; entityType: string; entityId: string; kind?: AttachmentKind;
  caption?: string | null; tag?: AttachmentTag | null;
};
type Exif = Record<string, unknown> | null | undefined;

/** Date taken and GPS from the picker's EXIF (Android: flat keys; iOS: {GPS: {...}}); camera clocks run on Addis time. */
function fromExif(exif: Exif): { takenAt: string | null; lat: number | null; lng: number | null } {
  const out = { takenAt: null as string | null, lat: null as number | null, lng: null as number | null };
  if (!exif) return out;
  const raw = String(exif.DateTimeOriginal ?? exif.DateTime ?? (exif['{Exif}'] as Record<string, unknown> | undefined)?.DateTimeOriginal ?? '');
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m && m[1] !== '0000') out.takenAt = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`).toISOString();
  const g = ((exif['{GPS}'] ?? exif.GPS) as Record<string, unknown> | undefined) ?? exif;
  const lat = Number(g.GPSLatitude ?? g.Latitude), lng = Number(g.GPSLongitude ?? g.Longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    out.lat = String(g.GPSLatitudeRef ?? g.LatitudeRef ?? 'N') === 'S' ? -Math.abs(lat) : lat;
    out.lng = String(g.GPSLongitudeRef ?? g.LongitudeRef ?? 'E') === 'W' ? -Math.abs(lng) : lng;
  }
  return out;
}

async function queueAsset(target: Target, asset: ImagePicker.ImagePickerAsset, source: 'camera' | 'library'): Promise<UploadEntry> {
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > 1280) {
    ctx.resize(asset.width >= asset.height ? { width: 1280 } : { height: 1280 });
  }
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ compress: 0.6, format: SaveFormat.JPEG });

  const dir = new Directory(Paths.document, 'photos');
  if (!dir.exists) dir.create({ intermediates: true });
  const id = Crypto.randomUUID();
  const dest = new File(dir, `${id}.jpg`);
  new File(saved.uri).copy(dest);
  // 320 px thumbnail for lists and strips (never decode the full image at thumbnail size).
  try {
    const tctx = ImageManipulator.manipulate(dest.uri);
    tctx.resize(asset.width >= asset.height ? { width: 320 } : { height: 320 });
    const timg = await tctx.renderAsync();
    const tsaved = await timg.saveAsync({ compress: 0.6, format: SaveFormat.JPEG });
    new File(tsaved.uri).copy(new File(dir, `${id}.t.jpg`));
  } catch {
    // thumbnail is an optimisation only
  }

  // Camera: where the phone is now. Gallery: only the position stored in the photo (an old photo was not taken here).
  const ex = fromExif(asset.exif as Exif);
  const { lat, lng } = source === 'camera' ? (ex.lat != null ? { lat: ex.lat, lng: ex.lng } : await geotag()) : { lat: ex.lat, lng: ex.lng };
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, await dest.bytes());
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const entry: UploadEntry = {
    id, project_id: target.projectId, entity_type: target.entityType, entity_id: target.entityId,
    kind: target.kind ?? 'photo', local_uri: dest.uri, mime: 'image/jpeg', lat, lng,
    status: 'pending', error: null, created_at: new Date().toISOString(),
    source: source === 'camera' ? 'camera' : 'gallery', captured_at: ex.takenAt ?? (source === 'camera' ? new Date().toISOString() : null),
    caption: target.caption?.trim() || null, tag: target.tag ?? (target.entityType === 'snag' ? 'before' : null),
    file_name: asset.fileName?.slice(0, 200) ?? null, size_bytes: dest.size ?? null, sha256,
  };
  const d = metadataDb();
  d.runSync(
    `INSERT INTO uploads (id, project_id, entity_type, entity_id, kind, local_uri, mime, lat, lng, status, created_at, source, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [entry.id, entry.project_id, entry.entity_type, entry.entity_id, entry.kind, entry.local_uri, entry.mime, lat, lng, entry.created_at,
     entry.source ?? null, entry.captured_at ?? null],
  );
  d.runSync(`INSERT INTO photo_metadata (upload_id, caption, tag, file_name, size_bytes, sha256) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, entry.caption ?? null, entry.tag ?? null, entry.file_name ?? null, entry.size_bytes ?? null, sha256]);
  return entry;
}

/** Take a photo, or pick several from the gallery; compress, keep in app storage and queue for upload. */
export async function capturePhotos(target: Target, source: 'camera' | 'library' = 'camera'): Promise<UploadEntry[]> {
  if ((target.caption?.trim().length ?? 0) > 500) throw new Error('Caption must be 500 characters or fewer');
  const perm = source === 'camera'
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error(source === 'camera' ? 'Camera permission is required to attach photos' : 'Photo library permission is required to pick photos');
  const res = source === 'camera'
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: true })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8, exif: true, allowsMultipleSelection: true, selectionLimit: 20 });
  if (res.canceled || !res.assets.length) return [];
  const out: UploadEntry[] = [];
  const errors: string[] = [];
  for (const [i, a] of res.assets.entries()) {
    try { out.push(await queueAsset(target, a, source)); }
    catch (e) { errors.push(`${a.fileName ?? `Photo ${i + 1}`}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  if (out.length) bump();
  if (errors.length) throw new Error(`${out.length ? `${out.length} photo${out.length > 1 ? 's' : ''} queued. ` : ''}${errors.slice(0, 3).join(' · ')}`);
  return out;
}

/** One photo (camera) — kept for screens that take a single picture. */
export async function capturePhoto(target: Target, source: 'camera' | 'library' = 'camera'): Promise<UploadEntry | null> {
  return (await capturePhotos(target, source))[0] ?? null;
}

const UPLOAD_METADATA = `u.*, m.caption, m.tag, m.file_name, m.size_bytes, m.sha256`;
const UPLOAD_JOIN = `FROM uploads u LEFT JOIN photo_metadata m ON m.upload_id = u.id`;

export function localPhotos(entityId: string): UploadEntry[] {
  return metadataDb().getAllSync<UploadEntry>(`SELECT ${UPLOAD_METADATA} ${UPLOAD_JOIN} WHERE u.entity_id = ? ORDER BY u.created_at`, [entityId]);
}

export function pendingUploads(): UploadEntry[] {
  return metadataDb().getAllSync<UploadEntry>(`SELECT ${UPLOAD_METADATA} ${UPLOAD_JOIN} WHERE u.status != 'uploaded' ORDER BY u.created_at`);
}

export async function processUploads(onWifi: boolean): Promise<void> {
  if (wifiOnly() && !onWifi) return;
  const d = metadataDb();
  for (const u of d.getAllSync<UploadEntry>(`SELECT ${UPLOAD_METADATA} ${UPLOAD_JOIN} WHERE u.status = 'pending' ORDER BY u.created_at`)) {
    try {
      const path = `${u.project_id}/${u.entity_type}/${u.id}.jpg`;
      const bytes = await new File(u.local_uri).bytes();
      const up = await supabase.storage.from('attachments').upload(path, bytes, { contentType: u.mime ?? 'image/jpeg', upsert: true });
      if (up.error && !/exists/i.test(up.error.message)) throw new Error(up.error.message);
      const ins = await supabase.from('attachments').upsert({
        id: u.id, project_id: u.project_id, entity_type: u.entity_type, entity_id: u.entity_id, kind: u.kind,
        storage_path: path, mime_type: u.mime, latitude: u.lat, longitude: u.lng, created_by: myId(),
        source: u.source ?? 'camera', captured_at: u.captured_at ?? u.created_at, caption: u.caption ?? null, tag: u.tag ?? null,
        file_name: u.file_name ?? null, size_bytes: u.size_bytes ?? bytes.byteLength, sha256: u.sha256 ?? null,
      }, { onConflict: 'id', ignoreDuplicates: true });
      if (ins.error) throw new Error(ins.error.message);
      d.runSync(`UPDATE uploads SET status = 'uploaded', error = NULL WHERE id = ?`, [u.id]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Network problems retry next sync; anything else is shown on the sync screen.
      const transient = /network|fetch|timeout/i.test(msg);
      d.runSync(`UPDATE uploads SET status = ?, error = ? WHERE id = ?`, [transient ? 'pending' : 'failed', msg, u.id]);
      if (transient) break;
    }
  }
  bump();
}

export function retryUpload(id: string) {
  getDb().runSync(`UPDATE uploads SET status = 'pending', error = NULL WHERE id = ?`, [id]);
  bump();
}

export async function signedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage.from('attachments').createSignedUrl(storagePath, 3600);
  return data?.signedUrl ?? null;
}

/** Local 320 px thumbnail of a captured photo, falling back to the full file. */
export function thumbUri(localUri: string): string {
  const t = localUri.replace(/\.jpg$/, '.t.jpg');
  try { return new File(t).exists ? t : localUri; } catch { return localUri; }
}

/** Remove a photo that has not been uploaded yet (viewer "Delete"). */
export function deleteLocalPhoto(id: string) {
  const d = metadataDb();
  const u = d.getFirstSync<UploadEntry>(`SELECT * FROM uploads WHERE id = ? AND status != 'uploaded'`, [id]);
  if (!u) return false;
  d.runSync('DELETE FROM photo_metadata WHERE upload_id = ?', [id]);
  d.runSync('DELETE FROM uploads WHERE id = ?', [id]);
  for (const uri of [u.local_uri, u.local_uri.replace(/\.jpg$/, '.t.jpg')]) {
    try { const f = new File(uri); if (f.exists) f.delete(); } catch { /* ignore */ }
  }
  bump();
  return true;
}
