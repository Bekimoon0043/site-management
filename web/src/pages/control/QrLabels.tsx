import { useMemo, useState } from 'react';
import { Printer, QrCode as QrIcon, X } from 'lucide-react';
import { useAuth, useProjectId } from '../../lib/auth';
import { useAsync, useLookups, type Lookups } from '../../lib/hooks';
import { fetchAll, supabase } from '../../lib/supabase';
import { canControl, type QrEntityType, type QrLabel } from '../../lib/contract-control';
import { rpcRead, rpcx, uuid } from '../../lib/fieldx';
import { dateTime, humanize } from '../../lib/format';
import { useUrlFilters } from '../../lib/url';
import { QrCode } from '../../components/control/QrCode';
import { Banner, DataTable, ErrorBanner, FilterBar, FilterSelect, FilterToggle, Page, SearchInput, Tabs, toast, useBusy } from '../../components/ui';
import '../../components/field/field.css';

type Source = 'store' | 'element' | 'spec' | 'labels';
interface Target { entity_type: QrEntityType; entity_id: string; title: string; sub: string; search: string; group: string }
interface SheetItem { id: string | null; code: string; title: string; sub: string }

function targets(src: Exclude<Source, 'labels'>, L: Lookups): Target[] {
  if (src === 'store') return L.stores.map((s) => ({ entity_type: 'store', entity_id: s.id, title: s.name, sub: `${humanize(s.store_type)} store`, search: s.name, group: s.store_type }));
  if (src === 'element') return L.elements.map((e) => ({ entity_type: 'element', entity_id: e.id, title: e.code, sub: [L.block(e.block_id) && `Block ${L.block(e.block_id)}`, L.level(e.level_id) && `Level ${L.level(e.level_id)}`, e.element_type].filter(Boolean).join(' · '),
    search: `${e.code} ${e.element_type}`, group: e.block_id ?? '' }));
  return L.specs.filter((s) => s.is_active).map((s) => ({ entity_type: 'spec', entity_id: s.id, title: s.label, sub: `${s.category} · ${s.uom}`, search: `${s.label} ${s.category}`, group: s.category }));
}

/** QR label sheets (A4, 3 × 8) for stores, elements and material specs — signed codes verifiable offline (E1). */
export function QrLabels() {
  const projectId = useProjectId();
  const auth = useAuth();
  const lk = useLookups(projectId);
  const canRegister = canControl(auth.profile?.role, 'qr.register');
  const labels = useAsync(() => fetchAll<QrLabel>((a, b) => supabase.from('qr_labels').select('*').eq('project_id', projectId).is('deleted_at', null).order('created_at', { ascending: false }).range(a, b)),
    [projectId], { key: 'qr-labels' });
  const [f, setF, { active, clear }] = useUrlFilters({ src: 'element', q: '', group: '', unprinted: '' });
  const src = (['store', 'element', 'spec', 'labels'].includes(f.src) ? f.src : 'element') as Source;
  const [sheet, setSheet] = useState<SheetItem[] | null>(null);
  const { busy, error, run } = useBusy();
  const L = lk.data;
  const existing = useMemo(() => new Map((labels.data ?? []).map((l) => [`${l.entity_type}:${l.entity_id}`, l])), [labels.data]);
  const list = useMemo(() => (L && src !== 'labels' ? targets(src, L) : []).filter((t) => (!f.q || t.search.toLowerCase().includes(f.q.toLowerCase())) && (!f.group || t.group === f.group)
    && (!f.unprinted || !existing.get(`${t.entity_type}:${t.entity_id}`)?.printed_at)), [L, src, f.q, f.group, f.unprinted, existing]);
  const groups = L && src !== 'labels' ? [...new Set(targets(src, L).map((t) => t.group).filter(Boolean))] : [];

  /** Register (or re-use) labels for the selection and open the print sheet. Users who can't register get unsaved signed previews (sign_qr). */
  const generate = (sel: Target[]) => run(async () => {
    if (canRegister) {
      const payload = sel.map((t) => ({ id: existing.get(`${t.entity_type}:${t.entity_id}`)?.id ?? uuid(), entity_type: t.entity_type, entity_id: t.entity_id, label: t.title }));
      const r = await rpcx('register_qr_labels', { project_id: projectId, labels: payload }) as { labels?: { id: string; code: string }[] };
      const codes = new Map((r.labels ?? []).map((x) => [x.id, x.code]));
      setSheet(payload.map((p, i) => ({ id: p.id, code: codes.get(p.id) ?? '', title: sel[i].title, sub: sel[i].sub })).filter((x) => x.code));
    } else {
      const out: SheetItem[] = [];
      for (const t of sel) {
        const r = await rpcRead<{ code: string }>('sign_qr', { project_id: projectId, entity_type: t.entity_type, entity_id: t.entity_id });
        out.push({ id: null, code: r.code, title: t.title, sub: t.sub });
      }
      setSheet(out);
    }
  });

  const reprint = (sel: QrLabel[]) => setSheet(sel.map((l) => ({ id: l.id, code: l.code, title: l.label ?? humanize(l.entity_type), sub: humanize(l.entity_type) })));

  const print = async () => {
    window.print();
    const ids = (sheet ?? []).map((s) => s.id).filter((x): x is string => !!x);
    if (ids.length && canRegister) {
      try { await rpcx('mark_qr_printed', { ids }); toast.success(`${ids.length} label${ids.length === 1 ? '' : 's'} marked printed`); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    }
  };

  if (sheet) {
    return (
      <Page title="QR label sheet" subtitle={`${sheet.length} label${sheet.length === 1 ? '' : 's'} · A4, 3 × 8 per page`}
        breadcrumbs={[{ label: 'QR labels', to: '/qr-labels' }, { label: 'Print sheet' }]}
        actions={<><button onClick={() => setSheet(null)}><X size={14} aria-hidden />Close</button><button className="primary" onClick={() => void print()}><Printer size={14} aria-hidden />Print labels</button></>}>
        {!canRegister && <Banner tone="info">Preview only — your role can't register labels, so these won't appear in the label register.</Banner>}
        <div className="qr-print">
          <div className="qr-sheet">
            {sheet.map((s, i) => (
              <div key={`${s.code}${i}`} className="qr-label">
                <QrCode code={s.code} size={98} label={`QR for ${s.title}`} />
                <div className="ql-text">
                  <span className="ql-title">{s.title}</span>
                  <span className="ql-sub">{s.sub}</span>
                  <span className="ql-sub">{auth.project?.code}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Page>
    );
  }

  return (
    <Page title="QR labels" subtitle="Print signed QR labels — scanning opens the bin card, element or store and proves the label is genuine, even offline">
      <Tabs label="Label source" value={src} onChange={(v) => { clear(); setF('src', v); }} tabs={[
        { key: 'element', label: 'Elements' }, { key: 'store', label: 'Stores' }, { key: 'spec', label: 'Materials (bins)' }, { key: 'labels', label: 'Printed labels', count: labels.data?.length },
      ]} />
      <ErrorBanner error={error ?? lk.error ?? labels.error} onRetry={labels.reload} />
      {src === 'labels' ? (
        <DataTable rows={labels.data ?? []} loading={!labels.data} exportName="qr-labels" selectable
          bulkActions={(sel, clr) => <button className="small primary" onClick={() => { reprint(sel); clr(); }}><Printer size={14} aria-hidden />Print {sel.length}</button>}
          empty={{ title: 'No labels yet', body: 'Choose elements, stores or materials and generate a sheet.' }}
          columns={[
            { key: 'label', label: 'Label', id: true },
            { key: 'entity_type', label: 'Type', value: (r) => humanize(r.entity_type) },
            { key: 'printed_at', label: 'Printed', value: (r) => r.printed_at, render: (r) => (r.printed_at ? `${dateTime(r.printed_at)} · ${L?.person(r.printed_by) ?? ''}` : <span className="warn-text">Not printed</span>) },
            { key: 'code', label: 'Code', hidden: true },
          ]} />
      ) : (
        <>
          <FilterBar active={active - (f.src !== 'element' ? 1 : 0)} onClear={() => { clear(); setF('src', src); }}>
            <SearchInput value={f.q} onChange={(v) => setF('q', v)} placeholder="Search" />
            {groups.length > 1 && <FilterSelect label={src === 'element' ? 'Block' : src === 'spec' ? 'Category' : 'Type'} value={f.group} onChange={(v) => setF('group', v)}
              options={groups.map((g) => ({ value: g, label: src === 'element' ? L?.block(g) ?? g : humanize(g) }))} />}
            <FilterToggle label="Not printed yet" checked={!!f.unprinted} onChange={(v) => setF('unprinted', v ? '1' : '')} />
          </FilterBar>
          <DataTable rows={list} rowKey={(r) => r.entity_id} loading={!L || !labels.data} selectable filtered={active > (f.src !== 'element' ? 1 : 0)} onClearFilters={() => { clear(); setF('src', src); }}
            bulkActions={(sel, clr) => <button className="small primary" disabled={busy} onClick={() => void generate(sel).then(clr)}>{busy ? <span className="spinner" /> : <QrIcon size={14} aria-hidden />}Generate {sel.length} label{sel.length === 1 ? '' : 's'}</button>}
            empty={{ title: 'Nothing to label', body: src === 'element' ? 'Import elements first.' : src === 'store' ? 'Add stores under Project setup.' : 'Add materials first.' }}
            columns={[
              { key: 'title', label: src === 'element' ? 'Element' : src === 'store' ? 'Store' : 'Material', id: true },
              { key: 'sub', label: 'Details' },
              { key: 'label', label: 'Label', value: (r) => (existing.get(`${r.entity_type}:${r.entity_id}`)?.printed_at ? 'Printed' : existing.has(`${r.entity_type}:${r.entity_id}`) ? 'Registered' : ''),
                render: (r) => { const l = existing.get(`${r.entity_type}:${r.entity_id}`); return !l ? <span className="muted-dash">—</span> : l.printed_at ? <span className="ok-text">Printed {dateTime(l.printed_at)}</span> : <span className="warn-text">Registered, not printed</span>; } },
            ]} />
          <p className="muted small-text">Select rows, then “Generate labels” — re-generating an existing label keeps its code.</p>
        </>
      )}
    </Page>
  );
}
