// /photos — every photo and document of the project in one place: filter by date, record type, block / level,
// tag and who added it; full-screen viewer with download and a link to the record; bulk upload of general site photos
// (several files, drag & drop, block / level / tag / caption for the whole batch).
import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { useAuth, useProjectId } from '../lib/auth';
import { useAsync, useLookups } from '../lib/hooks';
import { check, supabase } from '../lib/supabase';
import { date, dateTime } from '../lib/format';
import { ATTACHMENT_KIND_LABELS, ATTACHMENT_TAG_LABELS, ENTITY_LABELS, type AttachmentRow, type AttachmentTag } from '../lib/contract-photos';
import { isImage, uploadFiles, withUrls, type AttachmentWithUrl } from '../lib/photos';
import { Card, Empty, ErrorBanner, Field, Loading, Page, toast } from '../components/ui';
import { PhotoDrop } from '../components/photos/PhotoDrop';
import { PhotoViewer } from '../components/photos/PhotoViewer';
import '../components/photos/photos.css';

const PAGE = 60;

/** Where the record behind an attachment opens in the console. */
export function recordLink(a: Pick<AttachmentRow, 'entity_type' | 'entity_id'>): string | null {
  const id = a.entity_id;
  switch (a.entity_type) {
    case 'material_request': return `/requests/${id}`;
    case 'site_diary': return `/diary/${id}`;
    case 'inspection': return `/quality/inspections/${id}`;
    case 'snag': return '/quality#snags';
    case 'pour': return `/concrete/pours/${id}`;
    case 'bbs': return '/rebar#schedules';
    case 'gate_pass': return `/gate/${id}`;
    case 'sc_certificate': return `/payments/certificates/${id}`;
    case 'payroll': return `/payments/payroll/${id}`;
    case 'client_ipc': return `/billing/ipc/${id}`;
    case 'variation': return '/billing#variations';
    case 'purchase_order': return `/procurement/po/${id}`;
    case 'rfq': return `/procurement/rfq/${id}`;
    case 'grn': return '/store#grn';
    case 'miv': return '/store#miv';
    case 'mrn': return '/store#mrn';
    case 'adjustment': return '/store#adjustments';
    case 'stock_count': return '/store#counts';
    case 'lookahead_item': return '/lookahead';
    case 'task_progress': case 'schedule_task': return '/schedule';
    case 'element': case 'progress_update': return '/progress#elements';
    case 'document': case 'submittal': case 'rfi': return '/office';
    case 'plant_log': return '/plant';
    case 'hse_incident': case 'work_permit': case 'toolbox_talk': return '/safety';
    case 'supplier_invoice': return '/payments/invoices';
    default: return null;
  }
}

interface Filters { from: string; to: string; type: string; block: string; level: string; who: string; tag: string; files: '' | 'photos' | 'docs'; text: string }

export function Photos() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const [f, setF] = useState<Filters>({ from: '', to: '', type: '', block: '', level: '', who: '', tag: '', files: '', text: '' });
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);
  const [batch, setBatch] = useState<{ block: string; level: string; caption: string }>({ block: '', level: '', caption: '' });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const q = useAsync(async () => {
    let s = supabase.from('attachments').select('*').eq('project_id', projectId).is('deleted_at', null).order('created_at', { ascending: false }).limit(limit + 1);
    if (f.from) s = s.gte('created_at', `${f.from}T00:00:00+03:00`);
    if (f.to) s = s.lte('created_at', `${f.to}T23:59:59+03:00`);
    if (f.type) s = s.eq('entity_type', f.type);
    if (f.block) s = s.eq('block_id', f.block);
    if (f.level) s = s.eq('level_id', f.level);
    if (f.who) s = s.eq('created_by', f.who);
    if (f.tag) s = s.eq('tag', f.tag);
    if (f.files === 'photos') s = s.like('mime_type', 'image/%');
    if (f.files === 'docs') s = s.not('mime_type', 'like', 'image/%');
    if (f.text.trim()) {
      const pattern = `%${f.text.trim().replace(/["\\]/g, '\\$&')}%`;
      s = s.or(`caption.ilike."${pattern}",file_name.ilike."${pattern}"`);
    }
    const rows = (check(await s) as AttachmentRow[]).filter((r) => !r.deleted_at);
    return { more: rows.length > limit, rows: await withUrls(rows.slice(0, limit)) };
  }, [projectId, f.from, f.to, f.type, f.block, f.level, f.who, f.tag, f.files, f.text, limit], { key: 'site-photos', enabled: !!projectId });

  const shown = useMemo(() => {
    const t = f.text.trim().toLowerCase();
    return (q.data?.rows ?? []).filter((a) => !t || (a.caption ?? '').toLowerCase().includes(t) || (a.file_name ?? '').toLowerCase().includes(t));
  }, [q.data, f.text]);
  const byDay = useMemo(() => {
    const m = new Map<string, AttachmentWithUrl[]>();
    for (const a of shown) { const d = date(a.created_at); m.set(d, [...(m.get(d) ?? []), a]); }
    return [...m.entries()];
  }, [shown]);

  const set = (patch: Partial<Filters>) => { setF({ ...f, ...patch }); setLimit(PAGE); };
  const levels = (lk.data?.levels ?? []).filter((l) => !f.block || l.block_id === f.block);
  const batchLevels = (lk.data?.levels ?? []).filter((l) => !batch.block || l.block_id === batch.block);
  const place = (a: AttachmentRow) => [lk.data?.block(a.block_id), lk.data?.level(a.level_id)].filter(Boolean).join(' / ');

  const upload = async (files: File[], choice: { tag?: AttachmentTag | null }) => {
    setProgress({ done: 0, total: files.length });
    const r = await uploadFiles(files, { projectId, entityType: 'site', entityId: projectId, tag: choice.tag ?? null, caption: batch.caption || null,
      blockId: batch.block || null, levelId: batch.level || null }, (done, total) => setProgress({ done, total }));
    setProgress(null);
    if (r.ok) toast.success(`${r.ok} photo${r.ok > 1 ? 's' : ''} added`);
    if (r.errors.length) toast.error(r.errors.slice(0, 3).join(' · '));
    q.reload();
  };

  return (
    <Page title="Site photos" subtitle={`Photos and documents from every record of ${auth.project?.name ?? 'the project'} — newest first`}>
      <div className="stack">
        <Card title="Add site photos" sub="General progress, condition and handover photos. Several at once; the date and GPS are taken from the photo when it has them.">
          <PhotoDrop onFiles={upload} tags={['progress', 'before', 'after', 'issue', 'handover', 'other']} busy={!!progress} progress={progress}
            extra={<>
              <select aria-label="Block" value={batch.block} onChange={(e) => setBatch({ ...batch, block: e.target.value, level: '' })}>
                <option value="">Block…</option>{(lk.data?.blocks ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
              <select aria-label="Level" value={batch.level} onChange={(e) => setBatch({ ...batch, level: e.target.value })}>
                <option value="">Level…</option>{batchLevels.map((l) => <option key={l.id} value={l.id}>{lk.data?.block(l.block_id)} {l.code}</option>)}
              </select>
              <input aria-label="Caption" placeholder="Caption for these photos" value={batch.caption} maxLength={500}
                onChange={(e) => setBatch({ ...batch, caption: e.target.value })} style={{ minWidth: 200 }} />
            </>} />
        </Card>

        <Card>
          <div className="form-grid">
            <Field label="From"><input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></Field>
            <Field label="To"><input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></Field>
            <Field label="Record">
              <select value={f.type} onChange={(e) => set({ type: e.target.value })}>
                <option value="">All records</option>
                {Object.entries(ENTITY_LABELS).sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Block">
              <select value={f.block} onChange={(e) => set({ block: e.target.value, level: '' })}>
                <option value="">All blocks</option>{(lk.data?.blocks ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
              </select>
            </Field>
            <Field label="Level">
              <select value={f.level} onChange={(e) => set({ level: e.target.value })}>
                <option value="">All levels</option>{levels.map((l) => <option key={l.id} value={l.id}>{lk.data?.block(l.block_id)} {l.code}</option>)}
              </select>
            </Field>
            <Field label="Added by">
              <select value={f.who} onChange={(e) => set({ who: e.target.value })}>
                <option value="">Anyone</option>{(lk.data?.profiles ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
              </select>
            </Field>
            <Field label="Tag">
              <select value={f.tag} onChange={(e) => set({ tag: e.target.value })}>
                <option value="">Any</option>{Object.entries(ATTACHMENT_TAG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="Files">
              <select value={f.files} onChange={(e) => set({ files: e.target.value as Filters['files'] })}>
                <option value="">Photos and documents</option><option value="photos">Photos only</option><option value="docs">Documents (PDF) only</option>
              </select>
            </Field>
            <Field label="Search caption / file name"><input value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
          </div>
        </Card>

        <ErrorBanner error={q.error} onRetry={q.reload} />
        {!q.data ? <Loading lines={6} /> : !shown.length ? (
          <Empty title="No photos match">Photos taken on the phone app, attached in the console or added above show up here.</Empty>
        ) : (
          <div>
            {byDay.map(([day, list]) => (
              <section key={day}>
                <h3 className="gallery-day">{day} · {list.length}</h3>
                <div className="gallery-grid">
                  {list.map((a) => (
                    <button key={a.id} type="button" className="photo-tile" onClick={() => setOpen(shown.indexOf(a))}
                      aria-label={`${a.caption ?? ENTITY_LABELS[a.entity_type] ?? 'Photo'}, ${dateTime(a.created_at)}`}>
                      <div className="thumb">{a.url && isImage(a) ? <img src={a.url} alt="" loading="lazy" /> : <FileText size={32} aria-hidden />}</div>
                      {a.tag && <span className={`tagchip ${a.tag}`}>{ATTACHMENT_TAG_LABELS[a.tag]}</span>}
                      {a.client_visible && <span className="client-published-chip">Client</span>}
                      <div className="meta">
                        <span className="small-text strong">{a.caption || ENTITY_LABELS[a.entity_type] || a.entity_type}</span>
                        <span className="xs-text muted">{[ATTACHMENT_KIND_LABELS[a.kind], place(a)].filter(Boolean).join(' · ')}</span>
                        <span className="xs-text muted">{dateTime(a.created_at)} · {lk.data?.person(a.created_by)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {q.data.more && <div className="row mt-3"><button onClick={() => setLimit(limit + PAGE)}>Show more</button></div>}
          </div>
        )}
      </div>
      {open !== null && shown[open] && (
        <PhotoViewer items={shown} index={open} onIndex={setOpen} onClose={() => { setOpen(null); q.reload(); }}
          person={(id) => lk.data?.person(id) ?? ''} place={place} recordLink={recordLink} />
      )}
    </Page>
  );
}
