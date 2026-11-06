import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { DEVICE_ID, check, supabase } from './supabase';
import { setCalendarPref } from './calendar';
import { can, type Action, type AppRole, type Profile, type Project, type ProjectSettings } from './contract';

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  projects: Project[];
  project: Project | null;
  projectId: string | null;
  setProjectId: (id: string) => void;
  settings: ProjectSettings | null;
  priceRoles: AppRole[];
  companyName: string;
  /** data: URL of the company logo for printed forms (app_settings.company_logo). */
  companyLogo: string | null;
  canSeePrices: boolean;
  can: (action: Action) => boolean;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
const PROJECT_KEY = 'site-console-project';

function storedProject(): string | null {
  try { return localStorage.getItem(PROJECT_KEY); } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectIdState] = useState<string | null>(storedProject());
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [priceRoles, setPriceRoles] = useState<AppRole[]>([]);
  const [companyName, setCompanyName] = useState('Company');
  const [companyLogo, setCompanyLogo] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    if (!session) {
      setProfile(null);
      setProjects([]);
      return;
    }
    try {
      const prof = check(await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()) as Profile | null;
      await setCalendarPref(prof as { locale?: string; calendar?: string } | null);
      setProfile(prof);
      const projs = check(await supabase.from('projects').select('*').order('code')) as Project[];
      setProjects(projs);
      const app = check(await supabase.from('app_settings').select('*').eq('id', 1).maybeSingle()) as
        { price_roles: AppRole[]; company_name: string; company_logo?: string | null } | null;
      setPriceRoles(app?.price_roles ?? []);
      setCompanyName(app?.company_name ?? 'Company');
      setCompanyLogo(app?.company_logo ?? null);
      setProjectIdState((cur) => (cur && projs.some((p) => p.id === cur) ? cur : projs[0]?.id ?? null));
      // Register this browser so any document numbers it creates are unique (FR-OF-06).
      await supabase.rpc('register_device', { p: { device_id: DEVICE_ID, name: 'Web console' } });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!projectId) { setSettings(null); return; }
    try { localStorage.setItem(PROJECT_KEY, projectId); } catch { /* ignore */ }
    supabase.from('project_settings').select('*').eq('project_id', projectId).maybeSingle()
      .then(({ data }) => setSettings((data as ProjectSettings | null) ?? null));
  }, [projectId]);

  const value = useMemo<AuthState>(() => {
    const role = profile?.role ?? null;
    return {
      session, profile, loading, projects,
      project: projects.find((p) => p.id === projectId) ?? null,
      projectId,
      setProjectId: setProjectIdState,
      settings, priceRoles, companyName, companyLogo,
      canSeePrices: !!role && priceRoles.includes(role),
      // app_settings.price_roles (Settings page) is authoritative for prices, as on the server (app.can_see_prices)
      can: (a: Action) => (a === 'prices.view' ? !!role && priceRoles.includes(role) : can(role, a)),
      reload: load,
      signOut: async () => { await supabase.auth.signOut(); },
    };
  }, [session, profile, loading, projects, projectId, settings, priceRoles, companyName, companyLogo, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Current project id; pages are only rendered when one is selected. */
export function useProjectId(): string {
  const { projectId } = useAuth();
  return projectId ?? '';
}
