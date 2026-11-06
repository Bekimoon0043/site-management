// Full-screen viewer for photos / PDFs: previous / next (← →), caption, type, tag, location, who and when,
// GPS, download, and edit / delete for the uploader (delete within 24 h) or a coordinator / manager / admin.
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, MapPin, Pencil, Trash2, TriangleAlert, X } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { dateTime } from '../../lib/format';
import { downloadAttachment, isImage, setAttachmentClientVisibility, updateAttachment, type AttachmentWithUrl } from '../../lib/photos';
import { ATTACHMENT_KIND_LABELS, ATTACHMENT_TAG_LABELS, ENTITY_LABELS, type AttachmentTag } from '../../lib/contract-photos';
import { confirm, toast } from '../ui';
import './photos.css';

const MGMT = ['coordinator', 'manager', 'admin'];

export function PhotoViewer({ items, index, onIndex, onClose, person, place, recordLink }: {
  items: AttachmentWithUrl[]; index: number; onIndex: (i: number) => void; onClose: () => void;
  person?: (id: string) => string; place?: (a: AttachmentWithUrl) => string; recordLink?: (a: AttachmentWithUrl) => string | null;
}) {
  const auth = useAuth();
  const ref = useRef<HTMLDialogElement>(null);
  const a = items[index];
  const [edit, setEdit] = useState<{ caption: string; tag: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const me = auth.profile?.id;
  const mgmt = MGMT.includes(auth.profile?.role ?? '');
  const canEdit = !!a && (mgmt || a.created_by === me);
  const canDelete = !!a && (mgmt || (a.created_by === me && Date.now() - new Date(a.created_at).getTime() < 24 * 3600_000));

  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    d?.addEventListener('cancel', onCancel);
    return () => { d?.removeEventListener('cancel', onCancel); if (d?.open) d.close(); if (opener && document.contains(opener)) opener.focus(); };
  }, [onClose]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, items.length, onIndex]);
  useEffect(() => { setEdit(null); }, [index]);
  if (!a) return null;

  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try { await updateAttachment({ id: a.id, caption: edit.caption, tag: edit.tag as AttachmentTag | '' }); toast.success('Saved'); setEdit(null); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await confirm({ title: 'Delete this file?', body: 'It is hidden everywhere; the audit log keeps who deleted it.', confirm: 'Delete', danger: true }))) return;
    setBusy(true);
    try { await updateAttachment({ id: a.id, delete: true }); toast.success('Deleted'); onClose(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const download = async () => {
    setBusy(true);
    try { await downloadAttachment(a); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const publish = async (visible: boolean) => {
    setBusy(true);
    try { await setAttachmentClientVisibility(a.id, visible); toast.success(visible ? 'Approved for the client portal' : 'Removed from the client portal'); onClose(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const loc = place?.(a);
  const link = recordLink?.(a);

  return (
    <dialog ref={ref} className="photo-viewer" aria-label="Photo viewer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pv-stage">
        {a.url && isImage(a) ? <img src={a.url} alt={a.caption ?? ATTACHMENT_KIND_LABELS[a.kind] ?? 'Photo'} />
          : <div className="pv-doc"><FileText size={56} aria-hidden /><div>{a.file_name ?? 'Document'}</div>
              {a.url && <a className="link-btn primary" href={a.url} target="_blank" rel="noreferrer"><ExternalLink size={14} aria-hidden />Open</a>}</div>}
        {index > 0 && <button className="pv-nav prev" aria-label="Previous" onClick={() => onIndex(index - 1)}><ChevronLeft size={28} /></button>}
        {index < items.length - 1 && <button className="pv-nav next" aria-label="Next" onClick={() => onIndex(index + 1)}><ChevronRight size={28} /></button>}
        <button className="pv-close" aria-label="Close" onClick={onClose}><X size={22} /></button>
      </div>
      <aside className="pv-side">
        <div className="small-text muted">{index + 1} of {items.length}</div>
        {edit ? (
          <div className="stack">
            <label className="field"><span className="label">Caption</span>
              <textarea rows={3} maxLength={500} value={edit.caption} onChange={(e) => setEdit({ ...edit, caption: e.target.value })} data-autofocus /></label>
            <label className="field"><span className="label">Tag</span>
              <select value={edit.tag} onChange={(e) => setEdit({ ...edit, tag: e.target.value })}>
                <option value="">None</option>
                {Object.entries(ATTACHMENT_TAG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></label>
            <div className="row"><button className="primary" disabled={busy} onClick={() => void save()}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
          </div>
        ) : (
          <>
            <div className="pv-caption">{a.caption || <span className="muted">No caption</span>}</div>
            <dl className="kv small-text">
              <dt>Type</dt><dd>{ATTACHMENT_KIND_LABELS[a.kind] ?? a.kind}{a.tag ? ` · ${ATTACHMENT_TAG_LABELS[a.tag]}` : ''}</dd>
              <dt>On</dt><dd>{ENTITY_LABELS[a.entity_type] ?? a.entity_type}{link && <> · <a href={link}>open</a></>}</dd>
              {loc && <><dt>Location</dt><dd>{loc}</dd></>}
              {a.captured_at && <><dt>Taken</dt><dd>{dateTime(a.captured_at)}</dd></>}
              <dt>Added</dt><dd>{dateTime(a.created_at)}{person ? ` · ${person(a.created_by)}` : ''}</dd>
              <dt>Client portal</dt><dd>{a.client_visible ? `Published${a.client_approved_at ? ` · ${dateTime(a.client_approved_at)}` : ''}` : 'Not published'}</dd>
              {a.file_name && <><dt>File</dt><dd className="pv-file">{a.file_name}</dd></>}
            </dl>
            {a.latitude != null && a.longitude != null && (
              <a className="small-text" href={`https://www.google.com/maps?q=${a.latitude},${a.longitude}`} target="_blank" rel="noreferrer">
                <MapPin size={12} aria-hidden /> {a.latitude.toFixed(5)}, {a.longitude.toFixed(5)}</a>
            )}
            {a.outside_site && <div className="small-text warn-text"><TriangleAlert size={12} aria-hidden /> Taken outside the site area</div>}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {a.url && <button disabled={busy} onClick={() => void download()}><Download size={14} aria-hidden />Download</button>}
              {canEdit && <button onClick={() => setEdit({ caption: a.caption ?? '', tag: a.tag ?? '' })}><Pencil size={14} aria-hidden />Edit</button>}
              {mgmt && isImage(a) && <button disabled={busy} onClick={() => void publish(!a.client_visible)}>{a.client_visible ? 'Remove from client' : 'Approve for client'}</button>}
              {canDelete && <button className="danger" disabled={busy} onClick={() => void del()}><Trash2 size={14} aria-hidden />Delete</button>}
            </div>
          </>
        )}
      </aside>
    </dialog>
  );
}
