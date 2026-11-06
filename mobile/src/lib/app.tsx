import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { Profile, Project } from './contract';
import { dataVersion, get, kvGet, kvSet, openDb, subscribe, wipeLocalData } from './db';
import { hasStoredSession, isConfigured, loadDeviceId, supabase } from './supabase';
import { setCurrentProjectId, setMe } from './me';
import { getSyncState, onSyncState, startAutoSync, syncNow, type SyncState } from './sync';
import { ensureDeviceRegistered } from './device';
import { projects as allProjects } from './queries';

const LOCK_AFTER_MS = 5 * 60 * 1000; // session timeout (NFR-04)

interface AppCtx {
  ready: boolean;
  configured: boolean;
  userId: string | null;
  profile: Profile | null;
  project: Project | null;
  locked: boolean;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  selectProject: (id: string) => void;
  unlock: () => Promise<boolean>;
  setBiometric: (on: boolean) => Promise<boolean>;
  biometric: boolean;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside AppProvider');
  return c;
}

/** Re-renders when local data changes. */
export function useDataVersion(): number {
  return useSyncExternalStore(subscribe, dataVersion);
}

/** Run a synchronous local query and re-run it whenever data changes. */
export function useData<T>(fn: () => T, deps: React.DependencyList = []): T {
  const v = useDataVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(fn, [v, ...deps]);
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(onSyncState, getSyncState);
}

/** Current project + profile; only valid under the signed-in layout. */
export function useSession(): { profile: Profile; project: Project } {
  const { profile, project } = useApp();
  if (!profile || !project) throw new Error('No active session/project');
  return { profile, project };
}

async function registerPushToken(userId: string) {
  try {
    const perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await supabase.from('push_tokens').upsert({ token: token.data, user_id: userId, platform: 'android' });
  } catch {
    // Expo Go / no EAS project id: push not available, in-app notifications still work.
  }
}

async function loadProfile(userId: string): Promise<Profile | null> {
  const local = get<Profile>('profiles', userId);
  if (local) return local;
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  return (data as Profile | null) ?? null;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [biometric, setBio] = useState(false);
  const bgAt = useRef<number | null>(null);
  const v = useDataVersion();

  const activate = useCallback(async (uid: string) => {
    if (kvGet('user-id') && kvGet('user-id') !== uid) wipeLocalData();
    kvSet('user-id', uid);
    setUserId(uid);
    const p = await loadProfile(uid);
    setMe(p);
    setProfile(p);
    const pid = kvGet('project-id');
    setCurrentProjectId(pid);
    setProjectId(pid);
    startAutoSync();
    void ensureDeviceRegistered();
    void registerPushToken(uid);
  }, []);

  useEffect(() => {
    (async () => {
      await openDb();
      await loadDeviceId();
      const bio = kvGet('biometric') === '1';
      setBio(bio);
      if (isConfigured) {
        const { data } = await supabase.auth.getSession();
        // Offline with an expired token: keep working from local data; the
        // stored refresh token is used once connectivity returns.
        const uid = data.session?.user.id ?? ((await hasStoredSession()) ? kvGet('user-id') : null);
        if (uid) {
          if (bio) setLocked(true);
          await activate(uid);
        }
      }
      setReady(true);
    })();
  }, [activate]);

  // Keep profile fresh after sync (role or name changes, deactivation).
  useEffect(() => {
    if (!userId) return;
    const p = get<Profile>('profiles', userId);
    if (p && JSON.stringify(p) !== JSON.stringify(profile)) {
      setMe(p);
      setProfile(p);
    }
    if (!projectId) {
      const ps = allProjects();
      if (ps.length === 1) {
        kvSet('project-id', ps[0].id);
        setCurrentProjectId(ps[0].id);
        setProjectId(ps[0].id);
      }
    }
  }, [v, userId, profile, projectId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') {
        bgAt.current = Date.now();
      } else if (s === 'active') {
        if (biometric && userId && bgAt.current && Date.now() - bgAt.current > LOCK_AFTER_MS) setLocked(true);
        bgAt.current = null;
        if (userId) void syncNow();
      }
    });
    return () => sub.remove();
  }, [biometric, userId]);

  const signIn = useCallback(async (identifier: string, password: string) => {
    const id = identifier.trim();
    const res = id.includes('@')
      ? await supabase.auth.signInWithPassword({ email: id.toLowerCase(), password })
      : await supabase.auth.signInWithPassword({ phone: id.replace(/[\s-]/g, ''), password });
    if (res.error) throw new Error(res.error.message);
    const p = await loadProfile(res.data.user.id);
    if (p && !p.is_active) {
      await supabase.auth.signOut();
      throw new Error('This account has been deactivated');
    }
    await activate(res.data.user.id);
  }, [activate]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
    setProfile(null);
    setUserId(null);
    setLocked(false);
  }, []);

  const selectProject = useCallback((id: string) => {
    kvSet('project-id', id);
    setCurrentProjectId(id);
    setProjectId(id);
  }, []);

  const unlock = useCallback(async () => {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Site Materials' });
    if (r.success) setLocked(false);
    return r.success;
  }, []);

  const setBiometric = useCallback(async (on: boolean) => {
    if (on) {
      const has = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!has || !enrolled) return false;
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to enable biometric unlock' });
      if (!r.success) return false;
    }
    kvSet('biometric', on ? '1' : '0');
    setBio(on);
    return true;
  }, []);

  const project = useMemo(() => (projectId ? get<Project>('projects', projectId) : null), [projectId, v]);

  const value: AppCtx = {
    ready, configured: isConfigured, userId, profile, project, locked,
    signIn, signOut, selectProject, unlock, setBiometric, biometric,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
