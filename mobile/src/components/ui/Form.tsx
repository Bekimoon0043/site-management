// Form scroll-to-error plumbing. A <FormScreen> provides the context; fields with a
// `name` register their wrapper view so `form.focusFirstError(errors)` can scroll there.
import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { HostInstance, ScrollViewInstance } from 'react-native';
import { haptic } from './haptics';

export type Errors = Record<string, string | undefined | null>;

interface FormCtx {
  register: (name: string, v: HostInstance | null) => void;
  focusFirstError: (errors: Errors) => void;
}

const Ctx = createContext<FormCtx | null>(null);

export function useFormContext() { return useContext(Ctx); }

/** Callback ref for a field wrapper. No-op outside a FormScreen. */
export function useFieldRef(name: string | undefined) {
  const ctx = useContext(Ctx);
  return useCallback((v: HostInstance | null) => { if (name && ctx) ctx.register(name, v); }, [ctx, name]);
}

export function useFormController(scroll: React.RefObject<ScrollViewInstance | null>, content: React.RefObject<HostInstance | null>): FormCtx {
  const fields = useRef(new Map<string, HostInstance>());
  const register = useCallback((name: string, v: HostInstance | null) => {
    if (v) fields.current.set(name, v); else fields.current.delete(name);
  }, []);
  const focusFirstError = useCallback((errors: Errors) => {
    haptic('reject');
    const keys = Object.keys(errors).filter((k) => errors[k]);
    const node = content.current;
    if (!keys.length || !node || !scroll.current) return;
    let best = Number.POSITIVE_INFINITY;
    let pending = 0;
    const done = () => {
      if (--pending === 0 && Number.isFinite(best)) scroll.current?.scrollTo({ y: Math.max(best - 24, 0), animated: true });
    };
    for (const k of keys) {
      const v = fields.current.get(k);
      if (!v) continue;
      pending++;
      try {
        v.measureLayout(node, (_x, y) => { best = Math.min(best, y); done(); }, done);
      } catch { done(); }
    }
    if (!pending) scroll.current.scrollTo({ y: 0, animated: true });
  }, [content, scroll]);
  return useMemo(() => ({ register, focusFirstError }), [register, focusFirstError]);
}

export function FormProvider({ value, children }: { value: FormCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
