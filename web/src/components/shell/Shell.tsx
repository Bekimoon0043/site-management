import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown, HardHat, Keyboard, LogOut, Menu as MenuIcon, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { ROLE_LABELS } from '../../lib/contract';
import { setPref, usePrefs, type Theme } from '../../lib/prefs';
import { useNavCounts } from '../../lib/approvals';
import { GROUPS, NAV, navFor } from '../../nav';
import { Popover } from '../Popover';
import { Modal, ConfirmHost } from '../Dialog';
import { Toaster } from '../toast';
import { Notifications } from './Notifications';

const CommandPalette = lazy(() => import('./CommandPalette').then((m) => ({ default: m.CommandPalette })));

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
}

/** App chrome: 48px top bar, collapsible grouped sidebar with badges, palette, toasts, confirm host, global shortcuts. */
export function Shell({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const prefs = usePrefs();
  const nav = useNavigate();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const counts = useNavCounts(auth.projectId, auth.can, auth.profile?.role);
  const items = navFor(auth.profile?.role, auth.can);
  const gPressed = useRef(0);

  useEffect(() => { setMenuOpen(false); }, [loc.pathname]);

  // Global shortcuts. Never single letters while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || document.querySelector('dialog[open]')) return;
      if (e.key === '/') {
        const s = document.querySelector<HTMLInputElement>('[data-page-search]');
        if (s) { e.preventDefault(); s.focus(); }
        return;
      }
      if (e.key === '?') { setHelp(true); return; }
      const now = Date.now();
      if (e.key === 'g') { gPressed.current = now; return; }
      if (now - gPressed.current < 1200) {
        gPressed.current = 0;
        const k = e.key.toLowerCase();
        if (k === 'p') { setProjOpen(true); return; }
        const target = items.find((n) => n.key === k);
        if (target) { e.preventDefault(); nav(target.to); }
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [items, nav]);

  const name = auth.profile?.full_name || auth.profile?.email || '';
  const countFor = (k?: string) => (k && counts.data ? (counts.data as unknown as Record<string, number>)[k] ?? 0 : 0);

  return (
    <div className={`shell${prefs.sidebarCollapsed ? ' collapsed' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="topbar no-print">
        <button className="icon-btn menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" aria-expanded={menuOpen}><MenuIcon size={18} /></button>
        <Link to="/" className="brand" title={auth.companyName}>
          <span className="brand-mark" aria-hidden><HardHat size={16} /></span>
          <span className="brand-name">{auth.companyName}</span>
        </Link>
        <span className="topbar-sep" aria-hidden />
        <ProjectSwitcher open={projOpen} onOpenChange={setProjOpen} />
        <button className="search-trigger" onClick={() => setPalette(true)} aria-label="Search or jump to (Ctrl K)">
          <Search size={15} aria-hidden /><span className="label">Search or jump to…</span><span className="kbd">Ctrl K</span>
        </button>
        <div className="spacer" />
        <Notifications />
        <UserMenu name={name} onShortcuts={() => setHelp(true)} />
      </header>

      <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />
      <nav className="sidebar no-print" aria-label="Main">
        <div className="sidebar-scroll">
          {GROUPS.map((g) => {
            const list = items.filter((n) => n.group === g);
            if (!list.length) return null;
            return (
              <div className="nav-group" key={g}>
                <div className="nav-group-label">{g}</div>
                {list.map((n) => {
                  const c = countFor(n.count);
                  const I = n.icon;
                  return (
                    // exact match when another item lives under this path (e.g. /schedule vs /schedule/import)
                    <NavLink key={n.to} to={n.to} end={n.to === '/' || items.some((o) => o.to.startsWith(`${n.to}/`))} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                      title={prefs.sidebarCollapsed ? `${n.label}${c ? ` (${c})` : ''}` : undefined}
                      onMouseEnter={() => void n.load()} onFocus={() => void n.load()}>
                      <I size={16} aria-hidden />
                      <span className="label">{n.label}</span>
                      {c > 0 && <span className={`nav-count${n.count === 'store' ? ' hot' : ''}`} aria-label={`${c} waiting`}>{c > 99 ? '99+' : c}</span>}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="sidebar-foot">
          <button className="icon-btn collapse-toggle" onClick={() => setPref('sidebarCollapsed', !prefs.sidebarCollapsed)}
            aria-label={prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={prefs.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {prefs.sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button className="icon-btn" onClick={() => setPref('theme', nextTheme(prefs.theme))} aria-label={`Theme: ${prefs.theme}`} title={`Theme: ${prefs.theme}`}>
            <ThemeIcon t={prefs.theme} />
          </button>
          <button className="icon-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Keyboard size={16} /></button>
        </div>
      </nav>

      <main className="content" id="main">{children}</main>

      {palette && <Suspense fallback={null}><CommandPalette onClose={() => setPalette(false)} onSwitchProject={() => setProjOpen(true)} onShortcuts={() => setHelp(true)} /></Suspense>}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      <Toaster />
      <ConfirmHost />
    </div>
  );
}

const nextTheme = (t: Theme): Theme => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system');
function ThemeIcon({ t }: { t: Theme }) {
  return t === 'dark' ? <Moon size={16} /> : t === 'light' ? <Sun size={16} /> : <Monitor size={16} />;
}

function ProjectSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  let recent: string[] = [];
  try { recent = JSON.parse(localStorage.getItem('sc.recentProjects') ?? '[]') as string[]; } catch { /* ignore */ }
  const pick = (id: string) => {
    auth.setProjectId(id);
    try { localStorage.setItem('sc.recentProjects', JSON.stringify([id, ...recent.filter((x) => x !== id)].slice(0, 4))); } catch { /* ignore */ }
    onOpenChange(false);
    setQ('');
  };
  const term = q.toLowerCase();
  const list = auth.projects.filter((p) => !term || p.code.toLowerCase().includes(term) || p.name.toLowerCase().includes(term));
  const rec = !term ? recent.map((id) => auth.projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p && p.id !== auth.projectId).slice(0, 3) : [];
  const row = (p: (typeof auth.projects)[number]) => (
    <button key={p.id} className={`menu-item${p.id === auth.projectId ? ' active' : ''}`} onClick={() => pick(p.id)}>
      <span className="code strong">{p.code}</span><span className="grow muted">{p.name}</span>{p.id === auth.projectId && <Check size={14} />}
    </button>
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange} trigger={(p) => (
      <button className="project-btn" {...p} aria-label="Switch project (G P)" title="Switch project (G P)">
        {auth.project ? <><span className="code">{auth.project.code}</span><span className="name">{auth.project.name}</span></> : <span className="muted">No project</span>}
        <ChevronsUpDown size={14} aria-hidden />
      </button>
    )}>
      {() => (
        <div style={{ width: 320 }}>
          <div className="popover-search"><input autoFocus placeholder="Find project…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) pick(list[0].id); }} aria-label="Find project" /></div>
          <div className="menu popover-scroll">
            {rec.length > 0 && <><div className="menu-label">Recent</div>{rec.map(row)}<div className="menu-sep" /></>}
            <div className="menu-label">All projects</div>
            {list.map(row)}
            {!list.length && <div className="muted small-text" style={{ padding: 8 }}>No project matches.</div>}
            {auth.can('mr.approve') && <><div className="menu-sep" /><button className="menu-item" onClick={() => { onOpenChange(false); nav('/setup'); }}>Manage projects…</button></>}
          </div>
        </div>
      )}
    </Popover>
  );
}

function UserMenu({ name, onShortcuts }: { name: string; onShortcuts: () => void }) {
  const auth = useAuth();
  const prefs = usePrefs();
  const themes: { t: Theme; label: string }[] = [{ t: 'system', label: 'System' }, { t: 'light', label: 'Light' }, { t: 'dark', label: 'Dark' }];
  return (
    <Popover align="right" trigger={(p) => <button className="avatar-btn" aria-label="Account menu" {...p}><span className="avatar">{initials(name)}</span></button>}>
      {(close) => (
        <div style={{ width: 260 }}>
          <div className="menu-head">
            <div className="strong truncate">{name}</div>
            <div className="muted small-text">{auth.profile ? ROLE_LABELS[auth.profile.role] : ''}</div>
          </div>
          <div className="menu">
            <div className="menu-label">Theme</div>
            {themes.map((x) => (
              <button key={x.t} className="menu-item" onClick={() => setPref('theme', x.t)}>
                <ThemeIcon t={x.t} /><span className="grow">{x.label}</span>{prefs.theme === x.t && <Check size={14} />}
              </button>
            ))}
            <div className="menu-label">Density</div>
            {(['compact', 'default', 'comfortable'] as const).map((d) => (
              <button key={d} className="menu-item" onClick={() => setPref('density', d)}>
                <span className="grow" style={{ textTransform: 'capitalize' }}>{d}</span>{prefs.density === d && <Check size={14} />}
              </button>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { close(); onShortcuts(); }}><Keyboard size={16} /><span className="grow">Keyboard shortcuts</span><kbd>?</kbd></button>
            <button className="menu-item" onClick={() => { close(); void auth.signOut(); }}><LogOut size={16} /><span className="grow">Sign out</span></button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function K({ k }: { k: string[] }) {
  return <dt>{k.map((x) => <kbd key={x}>{x}</kbd>)}</dt>;
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const goKeys = NAV.filter((n) => n.key);
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="kbd-list">
        <K k={['Ctrl', 'K']} /><dd>Command palette — jump to pages, records and actions</dd>
        <K k={['/']} /><dd>Focus the page search</dd>
        {goKeys.map((n) => <span key={n.to} style={{ display: 'contents' }}><K k={['G', n.key!.toUpperCase()]} /><dd>Go to {n.label}</dd></span>)}
        <K k={['G', 'P']} /><dd>Switch project</dd>
        <K k={['↑', '↓']} /><dd>Move between table rows (also J / K)</dd>
        <K k={['Enter']} /><dd>Open the focused row</dd>
        <K k={['Space']} /><dd>Select the focused row (also X)</dd>
        <K k={['A']} /><dd>Approvals inbox: approve</dd>
        <K k={['R']} /><dd>Approvals inbox: return / reject (asks for a comment)</dd>
        <K k={['Esc']} /><dd>Close a panel or dialog</dd>
      </dl>
    </Modal>
  );
}
