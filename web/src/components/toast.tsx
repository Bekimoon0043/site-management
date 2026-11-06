import { useSyncExternalStore, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

/**
 * Tiny toast store. Bottom-right, max 3. Success/info auto-dismiss (4 s, 6 s with an action);
 * errors persist until dismissed. Use for async completions — not for validation errors.
 *
 *   toast.success('MR-0142 approved', { action: { label: 'Next', onClick } });
 *   toast.error(e.message);
 */
type Kind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: Kind; message: ReactNode; action?: { label: string; onClick: () => void } }

let toasts: Toast[] = [];
let seq = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

function dismiss(id: number) { toasts = toasts.filter((t) => t.id !== id); emit(); }

function push(kind: Kind, message: ReactNode, opts: { action?: Toast['action']; duration?: number } = {}) {
  const id = ++seq;
  toasts = [...toasts, { id, kind, message, action: opts.action }].slice(-3);
  emit();
  const ms = opts.duration ?? (kind === 'error' ? 0 : opts.action ? 6000 : 4000);
  if (ms) setTimeout(() => dismiss(id), ms);
  return id;
}

export const toast = {
  success: (m: ReactNode, o?: { action?: Toast['action']; duration?: number }) => push('success', m, o),
  error: (m: ReactNode, o?: { action?: Toast['action']; duration?: number }) => push('error', m, o),
  info: (m: ReactNode, o?: { action?: Toast['action']; duration?: number }) => push('info', m, o),
  dismiss,
};

/** Mount once in the shell. */
export function Toaster() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => toasts);
  return (
    <div className="toaster">
      {list.map((t) => {
        const I = t.kind === 'success' ? CircleCheck : t.kind === 'error' ? CircleAlert : Info;
        return (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <I size={18} aria-hidden />
            <div className="grow">{t.message}</div>
            {t.action && <button className="small" onClick={() => { t.action!.onClick(); dismiss(t.id); }}>{t.action.label}</button>}
            <button className="icon-btn sm" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
