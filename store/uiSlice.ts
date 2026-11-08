import type { UiSlice, SliceCreator } from './types';
export const createUiSlice: SliceCreator<UiSlice> = (set, get) => ({
  viewMode: 'list',
  setViewMode: (mode) => set({ viewMode: mode }),
  filterQuery: '',
  setFilterQuery: (query) => set({ filterQuery: query }),
  isEditMode: false,
  toggleEditMode: (password) => {
    const state = get();
    if (!state.isEditMode) {
      const expected = import.meta.env.VITE_EDIT_PASSWORD;
      if (expected?.trim() && password !== expected)
        return false;
      set({ isEditMode: true });
      get().startEditingPresence();
    }
    else {
      get().stopEditingPresence();
      set({ isEditMode: false });
    }
    return true;
  },
  clearError: () => set({ error: null })
});
