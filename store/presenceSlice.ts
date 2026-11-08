import { appRepository } from '../services/data/AppRepository';
import type { PresenceSlice, SliceCreator } from './types';
export const createPresenceSlice: SliceCreator<PresenceSlice> = (set, get) => ({
  pcfPresence: {},
  refreshPcfPresence: async (projectId: string) => {
    if (import.meta.env.MODE !== 'hub')
      return;
    try {
      const token = import.meta.env.VITE_DATA_API_TOKEN?.trim();
      const response = await fetch('/api/pcf/' + encodeURIComponent(projectId) + '/presence', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!response.ok)
        throw Error('Presence: ' + response.status);
      const result = await response.json();
      if (get().activeProjectId === projectId)
        set({
          pcfPresence: Object.fromEntries(Object.entries(result.drawings).map(([id, people]) => [id, (people as unknown[]).length])),
        });
    }
    catch {
      if (get().activeProjectId === projectId)
        set({ pcfPresence: {} });
    }
  },
  adminPresence: { isOnline: false },
  _heartbeatTimer: null,
  startEditingPresence: () => {
    const old = get()._heartbeatTimer;
    if (old)
      clearInterval(old);
    set({ adminPresence: { isOnline: true, lastSeen: new Date().toISOString() } });
    const projectId = get().activeProjectId;
    if (!projectId)
      return;
    appRepository.sendHeartbeat(projectId).catch(() => { });
    const timer = setInterval(() => {
      const currentId = get().activeProjectId;
      if (currentId)
        appRepository.sendHeartbeat(currentId).catch(() => { });
    }, 30000);
    set({ _heartbeatTimer: timer });
  },
  stopEditingPresence: () => {
    const timer = get()._heartbeatTimer;
    if (timer)
      clearInterval(timer);
    set({ _heartbeatTimer: null, adminPresence: { isOnline: false } });
  },
  refreshAdminPresence: async (projectId) => {
    try {
      const lastSeen = await appRepository.getHeartbeat(projectId);
      if (get().activeProjectId !== projectId || get().isEditMode)
        return;
      set({ adminPresence: lastSeen ? { isOnline: Date.now() - new Date(lastSeen).getTime() < 60000, lastSeen } : { isOnline: false } });
    }
    catch { /* Presence is non-blocking. */ }
  }
});
