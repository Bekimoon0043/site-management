// Current user / project, readable outside React (sync, optimistic writes).
import type { AppRole, Profile } from './contract';

let profile: Profile | null = null;
let projectId: string | null = null;

export const me = () => profile;
export const myId = () => profile?.id ?? '';
export const myRole = (): AppRole | null => profile?.role ?? null;
export const setMe = (p: Profile | null) => { profile = p; };

export const currentProjectId = () => projectId;
export const setCurrentProjectId = (id: string | null) => { projectId = id; };
