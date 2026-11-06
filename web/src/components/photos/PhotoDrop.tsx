// Add photos / PDFs: click to choose several files, or drag & drop; optional document type and tag pickers.
// Photos are downscaled + compressed and keep their EXIF date / GPS (lib/photos.ts).
import { useRef, useState, type ReactNode } from 'react';
import { ImagePlus } from 'lucide-react';
import { ACCEPT_FILES, ATTACHMENT_KIND_LABELS, ATTACHMENT_TAG_LABELS, type AttachmentKindAll, type AttachmentTag } from '../../lib/contract-photos';
import { fileProblem } from '../../lib/photos';
import { toast } from '../ui';
import './photos.css';

export interface DropChoice { kind?: AttachmentKindAll; tag?: AttachmentTag | null }

export function PhotoDrop({ onFiles, kinds, tags, label = 'Add photos or PDF', hint, extra, busy, progress, capture }: {
  /** Valid files with the chosen type / tag; resolves when handled. */
  onFiles: (files: File[], choice: DropChoice) => Promise<void> | void;
  kinds?: AttachmentKindAll[]; tags?: AttachmentTag[]; label?: string; hint?: ReactNode; extra?: ReactNode;
  busy?: boolean; progress?: { done: number; total: number } | null;
  /** Open the camera on phones / tablets. */
  capture?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [kind, setKind] = useState<AttachmentKindAll | ''>(kinds?.[0] ?? '');
  const [tag, setTag] = useState<AttachmentTag | ''>(tags?.[0] ?? '');
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])];
    if (!files.length) return;
    const bad = files.map(fileProblem).filter(Boolean) as string[];
    if (bad.length) toast.error(bad.slice(0, 3).join(' · ') + (bad.length > 3 ? ` (+${bad.length - 3} more)` : ''));
    const good = files.filter((f) => !fileProblem(f));
    if (good.length) void onFiles(good, { kind: kind || undefined, tag: tag || null });
  };
  return (
    <div className={`photo-drop${over ? ' over' : ''}`}
      onDragOver={(e) => { if (busy) return; e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!busy) take(e.dataTransfer.files); }}>
      <button type="button" className="primary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <span className="spinner" /> : <ImagePlus size={16} aria-hidden />}{label}
      </button>
      <input ref={input} type="file" multiple accept={ACCEPT_FILES} {...(capture ? { capture: 'environment' as const } : {})}
        onChange={(e) => { take(e.target.files); e.target.value = ''; }} aria-label={label} />
      {kinds && kinds.length > 1 && (
        <select aria-label="Document type" value={kind} onChange={(e) => setKind(e.target.value as AttachmentKindAll)}>
          {kinds.map((k) => <option key={k} value={k}>{ATTACHMENT_KIND_LABELS[k]}</option>)}
        </select>
      )}
      {tags && tags.length > 0 && (
        <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value as AttachmentTag)}>
          {tags.map((t) => <option key={t} value={t}>{ATTACHMENT_TAG_LABELS[t]}</option>)}
        </select>
      )}
      {extra}
      <span className="grow small-text muted">{hint ?? 'or drop files here · several at once · JPG, PNG, HEIC, PDF'}</span>
      {progress && progress.total > 0 && progress.done < progress.total && (
        <div className="photo-progress" role="progressbar" aria-valuenow={progress.done} aria-valuemax={progress.total}
          aria-label={`Uploading ${progress.done} of ${progress.total}`}>
          <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/** Pick files now, upload them after the record is saved (forms that create the record). */
export function PendingFiles({ files, onChange, label = 'Photos' }: { files: File[]; onChange: (f: File[]) => void; label?: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <PhotoDrop label={`Add ${label.toLowerCase()}`} capture={false} onFiles={(f) => onChange([...files, ...f])}
        hint={files.length ? `${files.length} file${files.length > 1 ? 's' : ''} will be attached when you save` : 'Optional · several at once · drop files here'} />
      {files.length > 0 && (
        <div className="row small-text" style={{ flexWrap: 'wrap', gap: 6 }}>
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="chip">{f.name}
              <button type="button" className="ghost small" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, k) => k !== i))}>×</button></span>
          ))}
        </div>
      )}
    </div>
  );
}
