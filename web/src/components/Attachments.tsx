// Photos, delivery notes, scans and signatures attached to a record: tiles, full-screen viewer, and (canAdd)
// upload of several photos / PDFs with drag & drop. Rows deleted with update_attachment are hidden.
import { useState } from 'react';
import { FileText, MapPin } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useAsync, useLookups } from '../lib/hooks';
import { check, supabase } from '../lib/supabase';
import { dateTime } from '../lib/format';
import { ATTACHMENT_KIND_LABELS, ATTACHMENT_TAG_LABELS, type AttachmentKindAll, type AttachmentRow, type AttachmentTag } from '../lib/contract-photos';
import { isImage, uploadFiles, withUrls, type AttachmentWithUrl } from '../lib/photos';
import { ErrorBanner, Skeleton } from './Page';
import { toast } from './toast';
import { PhotoDrop } from './photos/PhotoDrop';
import { PhotoViewer } from './photos/PhotoViewer';
import './photos/photos.css';

export function Attachments({ entityType, entityId, canAdd = false, kinds, tags, groupByTag = false, projectId, emptyText = 'No attachments.', addLabel }: {
  entityType: string; entityId: string;
  /** Show the upload area (the database still checks who may attach to this kind of record). */
  canAdd?: boolean;
  /** Document types offered when adding (first = default). */
  kinds?: AttachmentKindAll[];
  /** Tags offered when adding, e.g. ['before', 'after'] for snags. */
  tags?: AttachmentTag[];
  /** Group tiles by tag (Before / After / …). */
  groupByTag?: boolean;
  /** Defaults to the selected project. */
  projectId?: string;
  emptyText?: string;
  addLabel?: string;
}) {
  const auth = useAuth();
  const pid = projectId ?? auth.projectId ?? '';
  const lk = useLookups(pid);
  const [open, setOpen] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const q = useAsync(async () => {
    const rows = (check(await supabase.from('attachments').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at')) as AttachmentRow[])
      .filter((r) => !r.deleted_at);
    return withUrls(rows);
  }, [entityType, entityId], { key: 'attachments', staleTime: 30 * 60_000 });

  const add = async (files: File[], choice: { kind?: AttachmentKindAll; tag?: AttachmentTag | null }) => {
    setProgress({ done: 0, total: files.length });
    const r = await uploadFiles(files, { projectId: pid, entityType, entityId, kind: choice.kind, tag: choice.tag }, (done, total) => setProgress({ done, total }));
    setProgress(null);
    if (r.ok) toast.success(`${r.ok} file${r.ok > 1 ? 's' : ''} added`);
    if (r.errors.length) toast.error(r.errors.slice(0, 3).join(' · '));
    q.reload();
  };

  if (q.error) return <ErrorBanner error={q.error} onRetry={q.reload} />;
  const rows = q.data;
  const drop = canAdd && pid ? (
    <PhotoDrop onFiles={add} kinds={kinds} tags={tags} busy={!!progress} progress={progress} label={addLabel} />
  ) : null;
  if (!rows) return <div className="attachments"><Skeleton height={120} /><Skeleton height={120} /></div>;

  const tile = (a: AttachmentWithUrl) => (
    <button key={a.id} type="button" className="photo-tile" onClick={() => setOpen(rows.indexOf(a))}
      aria-label={`${a.caption ?? ATTACHMENT_KIND_LABELS[a.kind] ?? 'Attachment'}, ${dateTime(a.created_at)}`}>
      <div className="thumb">{a.url && isImage(a) ? <img src={a.url} alt="" loading="lazy" /> : <FileText size={28} aria-hidden />}</div>
      {a.tag && <span className={`tagchip ${a.tag}`}>{ATTACHMENT_TAG_LABELS[a.tag]}</span>}
      <div className="meta">
        <span className="small-text strong">{a.caption || ATTACHMENT_KIND_LABELS[a.kind] || a.kind}</span>
        <span className="xs-text muted">{dateTime(a.captured_at ?? a.created_at)}</span>
        {a.latitude !== null && a.longitude !== null && <span className="xs-text muted"><MapPin size={10} aria-hidden /> geotagged</span>}
      </div>
    </button>
  );
  const groups: [string, AttachmentWithUrl[]][] = groupByTag
    ? [...(tags ?? []).map((t) => [ATTACHMENT_TAG_LABELS[t], rows.filter((r) => r.tag === t)] as [string, AttachmentWithUrl[]]),
       ['Other', rows.filter((r) => !r.tag || !(tags ?? []).includes(r.tag))]]
    : [['', rows]];

  return (
    <div className="stack" style={{ gap: 8 }}>
      {drop}
      {!rows.length ? <div className="muted small-text">{emptyText}</div> : groups.filter(([, g]) => g.length || groupByTag).map(([label, g]) => (
        <div key={label || 'all'} className="photo-group">
          {label && <h4>{label} <span className="muted">({g.length})</span></h4>}
          {g.length ? <div className="photo-tiles">{g.map(tile)}</div> : <div className="muted small-text">None yet.</div>}
        </div>
      ))}
      {open !== null && rows[open] && (
        <PhotoViewer items={rows} index={open} onIndex={setOpen} onClose={() => { setOpen(null); q.reload(); }}
          person={(id) => lk.data?.person(id) ?? ''}
          place={(a) => [lk.data?.block(a.block_id), lk.data?.level(a.level_id)].filter(Boolean).join(' / ')} />
      )}
    </div>
  );
}
