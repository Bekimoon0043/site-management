// Language root: loads the persisted language / calendar, adopts the server profile's
// choice on first sign-in, and switches Text to Ethiopic sizing for Amharic.
import React, { useEffect, useMemo } from 'react';
import { useApp } from '../lib/app';
import { hasLocalLocale, loadLocalePrefs, setLocalePrefs, useLocale } from '../lib/i18n';
import { ScriptContext } from './ui';

export function LocaleRoot({ children }: { children: React.ReactNode }) {
  const { ready, profile } = useApp();
  if (ready) loadLocalePrefs();
  const { locale } = useLocale();
  const p = profile as (typeof profile & { locale?: 'en' | 'am'; calendar?: 'gregorian' | 'ethiopian' }) | null;
  useEffect(() => {
    if (!ready || !p || hasLocalLocale()) return;
    if (p.locale || p.calendar) setLocalePrefs({ locale: p.locale === 'am' ? 'am' : 'en', calendar: p.calendar === 'ethiopian' ? 'ethiopian' : 'gregorian' });
  }, [ready, p?.locale, p?.calendar]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo(() => ({ ethiopic: locale === 'am' }), [locale]);
  return <ScriptContext.Provider value={value}>{children}</ScriptContext.Provider>;
}
