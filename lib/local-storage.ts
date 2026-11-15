import type {StateStorage} from 'zustand/middleware';
let warning: string | null = null;
const listeners = new Set<() => void>();
export function reportStorageError(error: unknown) {
  warning = 'Local recovery unavailable (storage full or disabled). Keep this page open and Save Now. ' + (error instanceof Error ? error.message : String(error));
  // Never mutate the store from its persistence write: doing so recurses.
  for (const listener of listeners) listener();
}
export const recoveryStorage: StateStorage = {
  getItem(name) { try { return localStorage.getItem(name); } catch (error) { reportStorageError(error); return null; } },
  setItem(name, value) { try { localStorage.setItem(name, value); } catch (error) { reportStorageError(error); } },
  removeItem(name) { try { localStorage.removeItem(name); } catch (error) { reportStorageError(error); } },
};
export const storageWarningSnapshot=()=>warning;
export const subscribeStorageWarning=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
