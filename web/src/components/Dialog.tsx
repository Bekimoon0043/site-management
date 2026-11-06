import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ErrorBanner } from './Page';
import { Field } from './Form';

/**
 * Native <dialog> base: top layer, inert background, Esc, focus moved in and returned to the
 * invoking element on close. Backdrop click closes. Rendered = open (mount to show, unmount to hide).
 */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!d.open) d.showModal();
    const target = d.querySelector<HTMLElement>('[data-autofocus]')
      ?? d.querySelector<HTMLElement>('.modal-body textarea, .modal-body input:not([type=checkbox]):not([type=hidden]):not([disabled])');
    target?.focus();
    const onCancel = (e: Event) => { e.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  const onMouseDown = (e: React.MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) closeRef.current(); };
  return { ref, onMouseDown };
}

function Head({ title, subtitle, onClose }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-head">
      <div className="titles"><h2>{title}</h2>{subtitle && <div className="sub">{subtitle}</div>}</div>
      <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
    </div>
  );
}

/**
 * Centered modal — confirms, reasons, short forms (≤6 fields).
 * Footer convention: secondary left of primary; destructive uses `danger` + a verb.
 */
export function Modal({ title, subtitle, onClose, children, footer, wide, size }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; size?: 'sm' | 'md' | 'lg';
}) {
  const { ref, onMouseDown } = useDialog(onClose);
  const cls = wide || size === 'lg' ? 'wide' : size === 'md' ? 'md' : '';
  return (
    <dialog ref={ref} className={`modal ${cls}`} onMouseDown={onMouseDown} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="dialog-inner">
        <Head title={title} subtitle={subtitle} onClose={onClose} />
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * Right-side sheet for peeking a record or editing it without losing the list's scroll/filters.
 * Pair with `useUrlParam('peek')` so Back closes it. May open one confirm Modal on top.
 */
export function Drawer({ title, subtitle, onClose, children, footer, size = 'md' }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'md' | 'lg';
}) {
  const { ref, onMouseDown } = useDialog(onClose);
  return (
    <dialog ref={ref} className={`drawer ${size === 'lg' ? 'lg' : ''}`} onMouseDown={onMouseDown} aria-label={typeof title === 'string' ? title : undefined}>
      <div className="dialog-inner">
        <Head title={title} subtitle={subtitle} onClose={onClose} />
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </dialog>
  );
}

/** Modal asking for a (required) comment, used for reject/return/reverse actions. */
export function ReasonModal({ title, label = 'Reason', required = true, confirm = 'Confirm', danger, onSubmit, onClose, children }: {
  title: string; label?: string; required?: boolean; confirm?: string; danger?: boolean;
  onSubmit: (text: string) => Promise<void>; onClose: () => void; children?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onSubmit(text.trim()); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <button onClick={onClose}>Cancel</button>
        <button className={danger ? 'danger' : 'primary'} disabled={busy || (required && !text.trim())} onClick={() => void go()}>
          {busy && <span className="spinner" />}{busy ? 'Working…' : confirm}
        </button>
      </>
    }>
      <div className="stack tight">
        <ErrorBanner error={err} />
        {children}
        <Field label={label} required={required} wide>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} data-autofocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !(required && !text.trim())) void go(); }} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Imperative confirm():  if (!(await confirm({ title: 'Reject 3 requests?', danger: true }))) return;
// Requires <ConfirmHost/> once in the app shell.
// ---------------------------------------------------------------------------

interface ConfirmReq { title: string; body?: ReactNode; confirm?: string; danger?: boolean; resolve: (ok: boolean) => void }
let pending: ConfirmReq | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function confirm(opts: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => { pending?.resolve(false); pending = { ...opts, resolve }; emit(); });
}

export function ConfirmHost() {
  const req = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => pending);
  if (!req) return null;
  const done = (ok: boolean) => { req.resolve(ok); pending = null; emit(); };
  return (
    <Modal title={req.title} onClose={() => done(false)} footer={<>
      <button onClick={() => done(false)} data-autofocus={req.danger ? true : undefined}>Cancel</button>
      <button className={req.danger ? 'danger' : 'primary'} data-autofocus={req.danger ? undefined : true} onClick={() => done(true)}>{req.confirm ?? 'Confirm'}</button>
    </>}>
      {req.body ?? <p className="muted mb-0">Are you sure?</p>}
    </Modal>
  );
}
