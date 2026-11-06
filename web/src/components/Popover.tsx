import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Non-modal anchored popover (menus, filter popovers, project switcher, notifications).
 * Closes on outside click, Esc (focus returns to the trigger) and on `close()` from children.
 *
 *   <Popover align="right" trigger={(p) => <button {...p}>Export</button>}>
 *     {(close) => <Menu items={[{ label: 'Excel', onClick: () => { exportX(); close(); } }]} />}
 *   </Popover>
 */
export function Popover({ trigger, children, align = 'left', className, open: openProp, onOpenChange }: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': true; ref: React.Ref<HTMLButtonElement> }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => { setOpenState(o); onOpenChange?.(o); };
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="popover-anchor" ref={wrap}>
      {trigger({ onClick: () => setOpen(!open), 'aria-expanded': open, 'aria-haspopup': true, ref: btn })}
      {open && <div className={`popover ${align}${className ? ` ${className}` : ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export interface MenuItem { label: ReactNode; onClick: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean; hint?: ReactNode }

/** Vertical menu for use inside a Popover. Use `null` entries as separators. */
export function Menu({ items }: { items: (MenuItem | null)[] }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) => it === null ? <div key={i} className="menu-sep" role="separator" /> : (
        <button key={i} role="menuitem" className={`menu-item${it.danger ? ' danger' : ''}`} disabled={it.disabled} onClick={it.onClick}>
          {it.icon}<span className="grow">{it.label}</span>{it.hint && <span className="muted small-text">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}
