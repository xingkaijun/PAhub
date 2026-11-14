import { sessionApi } from '../services/api/sessionApi';
import type { UiSlice, SliceCreator } from './types';
export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  session: null,
  can: capability => get().session?.mode === 'kjx' ? Boolean(get().session?.permissions?.includes(capability)) : get().isEditMode,
  viewMode: 'list',
  setViewMode: (mode) => set({ viewMode: mode }),
  filterQuery: '',
  setFilterQuery: (query) => set({ filterQuery: query }),
  // isEditMode is a mirror of the server's administrator session, never a client-side password check.
  isEditMode: false,
  refreshSession: async () => {
    try {
      const status = await sessionApi.status();
      set({ session: status });
      get().applySession(status.mode === 'kjx' ? Boolean(status.permissions?.includes('drawing.update')) : status.admin);
    } catch {
      // Offline: the server cannot vouch for the session, so clear cached kjx capabilities.
      if (get().session?.mode === 'kjx') set({ session: { ...get().session!, admin: false, permissions: [] } });
      get().applySession(false);
    }
  },
  loginAdmin: async (password) => {
    try {
      const status = await sessionApi.login(password);
      get().applySession(status.admin);
      return status.admin;
    } catch {
      get().applySession(false);
      return false;
    }
  },
  logoutAdmin: async () => {
    try { await sessionApi.logout(); } catch { /* the local mirror is cleared regardless */ }
    get().applySession(false);
  },
  applySession: (admin) => {
    const state = get();
    if (admin === state.isEditMode) return;
    if (admin) {
      set({ isEditMode: true });
      if (get().session?.mode !== 'kjx' || get().session?.admin) get().startEditingPresence();
    } else {
      get().stopEditingPresence();
      set({ isEditMode: false });
    }
  },
  clearError: () => set({ error: null })
});
