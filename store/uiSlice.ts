import { sessionApi } from '../services/api/sessionApi';
import type { UiSlice, SliceCreator } from './types';
export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  viewMode: 'list',
  setViewMode: (mode) => set({ viewMode: mode }),
  filterQuery: '',
  setFilterQuery: (query) => set({ filterQuery: query }),
  // isEditMode is a mirror of the server's administrator session, never a client-side password check.
  isEditMode: false,
  refreshSession: async () => {
    try {
      const status = await sessionApi.status();
      get().applySession(status.admin);
    } catch {
      // Offline: the server cannot vouch for the session, so treat the visitor as a reviewer.
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
      get().startEditingPresence();
    } else {
      get().stopEditingPresence();
      set({ isEditMode: false });
    }
  },
  clearError: () => set({ error: null })
});
