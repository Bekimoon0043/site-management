import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Clock, CornerDownLeft, FileText, Hash, Layers, Moon, Package, Search, Upload, Repeat, Keyboard, LogOut, Rows3, ShoppingCart } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useLookups } from '../../lib/hooks';
import { supabase } from '../../lib/supabase';
import { getRecent, setPref, usePrefs, pushRecent } from '../../lib/prefs';
import { navFor } from '../../nav';
import { canProcure } from '../../lib/contract-procurement';
import { canFlow } from '../../lib/contract-flows';

type Icon = ComponentType<{ size?: number }>;
interface Item { id: string; group: string; label: string; hint?: string; icon: Icon; run: () => void; keywords?: string }

const DOC_RE = /^(MR|PR|GRN|MIV|MRN|ADJ|TR|CNT|TRF|PO|RFQ)[-\s]?/i;

/**
 * Ctrl/⌘K palette: Go to (nav + tabs) · Actions · Records (MR/GRN/MIV numbers via 3 small
 * server lookups; elements & materials from cached lookups) · Recent (empty query).
 */
export function CommandPalette({ onClose, onSwitchProject, onShortcuts }: { onClose: () => void; onSwitchProject: () => void; onShortcuts: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const prefs = usePrefs();
  const lk = useLookups(auth.projectId ?? '');
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<Item[]>([]);

  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    d.showModal();
    inputRef.current?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    d.addEventListener('cancel', onCancel);
    return () => { d.removeEventListener('cancel', onCancel); if (d.open) d.close(); opener?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (to: string, recent?: { label: string; hint: string }) => {
    if (recent) pushRecent({ ...recent, to });
    onClose();
    nav(to);
  };

  // Server search for document numbers (debounced 200 ms).
  useEffect(() => {
    const term = q.trim();
    if (!auth.projectId || (term.length < 3 && !DOC_RE.test(term))) { setRemote([]); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const like = `%${term.replace(/[%_]/g, '')}%`;
      const proc = canProcure(auth.profile?.role, 'rfq.create');
      const none = Promise.resolve({ data: [] as { id: string; number: string }[] });
      const [mrs, grns, mivs, pos, rfqs] = await Promise.all([
        supabase.from('material_requests').select('id, number, status').eq('project_id', auth.projectId!).ilike('number', like).limit(5),
        supabase.from('grns').select('id, number').eq('project_id', auth.projectId!).ilike('number', like).limit(5),
        supabase.from('mivs').select('id, number').eq('project_id', auth.projectId!).ilike('number', like).limit(5),
        proc ? supabase.from('purchase_orders').select('id, number').eq('project_id', auth.projectId!).ilike('number', like).limit(5) : none,
        proc ? supabase.from('rfqs').select('id, number').eq('project_id', auth.projectId!).ilike('number', like).limit(5) : none,
      ]);
      if (!alive) return;
      const out: Item[] = [];
      for (const m of (mrs.data ?? []) as { id: string; number: string; status: string }[]) {
        const hint = /(^|-)PR-/.test(m.number) ? 'Purchase request' : 'Request';
        out.push({ id: `mr${m.id}`, group: 'Records', label: m.number, hint, icon: FileText, run: () => go(`/requests/${m.id}`, { label: m.number, hint }) });
      }
      for (const g of (grns.data ?? []) as { id: string; number: string }[]) {
        out.push({ id: `grn${g.id}`, group: 'Records', label: g.number, hint: 'Receipt (GRN)', icon: FileText, run: () => go(`/store?open=${g.id}#grn`, { label: g.number, hint: 'GRN' }) });
      }
      for (const m of (mivs.data ?? []) as { id: string; number: string }[]) {
        out.push({ id: `miv${m.id}`, group: 'Records', label: m.number, hint: 'Issue (MIV)', icon: FileText, run: () => go(`/store?open=${m.id}#miv`, { label: m.number, hint: 'MIV' }) });
      }
      for (const x of (pos.data ?? []) as { id: string; number: string }[]) {
        out.push({ id: `po${x.id}`, group: 'Records', label: x.number, hint: 'Purchase order', icon: ShoppingCart, run: () => go(`/procurement/po/${x.id}`, { label: x.number, hint: 'Purchase order' }) });
      }
      for (const x of (rfqs.data ?? []) as { id: string; number: string }[]) {
        out.push({ id: `rfq${x.id}`, group: 'Records', label: x.number, hint: 'RFQ', icon: FileText, run: () => go(`/procurement/rfq/${x.id}`, { label: x.number, hint: 'RFQ' }) });
      }
      setRemote(out);
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, auth.projectId]);

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    const match = (s: string) => !term || s.toLowerCase().includes(term);
    const out: Item[] = [];
    if (!term) {
      for (const r of getRecent()) out.push({ id: `rec${r.to}`, group: 'Recent', label: r.label, hint: r.hint, icon: Clock, run: () => go(r.to) });
    }
    for (const n of navFor(auth.profile?.role, auth.can)) {
      if (match(n.label)) out.push({ id: `nav${n.to}`, group: 'Go to', label: n.label, icon: n.icon as Icon, run: () => go(n.to), hint: n.key ? `G ${n.key.toUpperCase()}` : undefined });
      for (const t of n.tabs ?? []) {
        const label = `${n.label} › ${t.label}`;
        if (term && match(label)) out.push({ id: `tab${n.to}${t.hash}`, group: 'Go to', label, icon: ArrowRight, run: () => go(`${n.to}#${t.hash}`) });
      }
    }
    const actions: Item[] = [
      { id: 'a-proj', group: 'Actions', label: 'Switch project…', hint: 'G P', icon: Repeat, run: () => { onClose(); onSwitchProject(); } },
      ...(auth.can('master.edit') ? [
        { id: 'a-impel', group: 'Actions', label: 'Import elements, BoQ or take-offs', icon: Upload, run: () => go('/elements#import') },
        { id: 'a-impmat', group: 'Actions', label: 'Import materials', icon: Upload, run: () => go('/materials#import') },
      ] : []),
      ...(auth.projectId && ['office_engineer', 'coordinator', 'manager', 'admin'].includes(auth.profile?.role ?? '') ? [
        { id: 'a-impsched', group: 'Actions', label: 'Import MS Project schedule (XML / Excel)', icon: Upload, run: () => go('/schedule/import') },
        { id: 'a-verifytask', group: 'Actions', label: 'Verify task progress', icon: FileText, run: () => go('/approvals?type=task_progress') },
      ] : []),
      ...(auth.projectId ? [
        { id: 'a-sur', group: 'Actions', label: 'Site-use requests', icon: FileText, run: () => go('/requests') },
        { id: 'a-prl', group: 'Actions', label: 'Purchase requests', icon: ShoppingCart, run: () => go('/requests?type=purchase') },
        ...(canFlow(auth.profile?.role, 'pr.create') ? [{ id: 'a-pr', group: 'Actions', label: 'New purchase request', icon: ShoppingCart, run: () => go('/requests?type=purchase&new=pr') }] : []),
        ...(canFlow(auth.profile?.role, 'pr.accept') || canFlow(auth.profile?.role, 'rfq.fromPr') ? [{ id: 'a-prs', group: 'Actions', label: 'Purchase requests to accept / source', icon: ShoppingCart, run: () => go('/procurement#prs') }] : []),
        ...(canFlow(auth.profile?.role, 'delivery.acknowledge') || auth.profile?.role === 'security' ? [{ id: 'a-dn', group: 'Actions', label: 'Expected deliveries (delivery notices)', icon: Package, run: () => go('/deliveries') }] : []),
      ] : []),
      ...(auth.projectId && canProcure(auth.profile?.role, 'po.create') && auth.canSeePrices ? [
        { id: 'a-po', group: 'Actions', label: 'New purchase order', icon: ShoppingCart, run: () => go('/procurement/po/new') },
        { id: 'a-mkt', group: 'Actions', label: 'Log market price', icon: Package, run: () => go('/prices?log=1') },
      ] : []),
      ...(auth.projectId && canProcure(auth.profile?.role, 'rfq.create') ? [
        { id: 'a-rfq', group: 'Actions', label: 'New request for quotation (RFQ)', icon: FileText, run: () => go('/procurement?new=rfq#rfqs') },
        { id: 'a-src', group: 'Actions', label: 'Source approved requests', icon: ShoppingCart, run: () => go('/procurement#needs') },
      ] : []),
      { id: 'a-theme', group: 'Actions', label: prefs.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: Moon,
        run: () => { setPref('theme', prefs.theme === 'dark' ? 'light' : 'dark'); onClose(); } },
      { id: 'a-dens', group: 'Actions', label: prefs.density === 'compact' ? 'Default row density' : 'Compact row density', icon: Rows3,
        run: () => { setPref('density', prefs.density === 'compact' ? 'default' : 'compact'); onClose(); } },
      { id: 'a-keys', group: 'Actions', label: 'Keyboard shortcuts', hint: '?', icon: Keyboard, run: () => { onClose(); onShortcuts(); } },
      { id: 'a-out', group: 'Actions', label: 'Sign out', icon: LogOut, run: () => { onClose(); void auth.signOut(); } },
    ];
    out.push(...actions.filter((a) => match(a.label)));
    out.push(...remote);
    const L = lk.data;
    if (L && term.length >= 2) {
      let n = 0;
      for (const e of L.elements) {
        if (n >= 5) break;
        if (e.code.toLowerCase().includes(term)) {
          n++;
          const label = L.element(e.id);
          out.push({ id: `el${e.id}`, group: 'Records', label, hint: 'Element', icon: Layers, run: () => go(`/elements?peek=${e.id}`, { label, hint: 'Element' }) });
        }
      }
      n = 0;
      for (const s of L.specs) {
        if (n >= 5) break;
        if (s.label.toLowerCase().includes(term) || s.category.toLowerCase().includes(term)) {
          n++;
          out.push({ id: `sp${s.id}`, group: 'Records', label: s.label, hint: `Material · ${s.uom}`, icon: Package, run: () => go(`/store?q=${encodeURIComponent(s.label)}#balances`, { label: s.label, hint: 'Stock' }) });
        }
      }
    }
    // Group order (Recent first when empty, else Go to / Actions / Records)
    const order = !term ? ['Recent', 'Go to', 'Actions'] : DOC_RE.test(term) ? ['Records', 'Go to', 'Actions'] : ['Go to', 'Actions', 'Records'];
    return order.flatMap((g) => out.filter((i) => i.group === g));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, remote, lk.data, prefs.theme, prefs.density]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
  };

  let lastGroup = '';
  return (
    <dialog ref={ref} className="palette" aria-label="Command palette" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-input">
        <Search size={18} aria-hidden />
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search pages, actions, MR / GRN / MIV numbers, elements, materials…"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[active] ? `pi-${active}` : undefined} />
        <kbd>Esc</kbd>
      </div>
      <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
        {!items.length && <div className="palette-empty">No matches. Try a document number like <code>MR-</code> or an element code.</div>}
        {items.map((it, i) => {
          const head = it.group !== lastGroup ? <div className="palette-group" role="presentation">{it.group}</div> : null;
          lastGroup = it.group;
          const I = it.icon;
          return (
            <div key={it.id}>
              {head}
              <div id={`pi-${i}`} data-i={i} role="option" aria-selected={i === active} className="palette-item"
                onMouseMove={() => setActive(i)} onClick={() => it.run()}>
                <I size={16} /><span className="grow">{it.label}</span>{it.hint && <span className="hint">{it.hint}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="palette-foot"><span>↑↓ navigate</span><span><CornerDownLeft size={11} /> open</span><span>esc close</span><span className="grow" /><span><Hash size={11} /> type a number to search records</span></div>
    </dialog>
  );
}
