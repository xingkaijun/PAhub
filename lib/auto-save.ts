export const AUTO_SAVE_DELAY_MS = 3000;

// Dependency injection keeps the debounce behavior testable without a browser clock.
export function createDebouncedSave(save: () => void, delay = AUTO_SAVE_DELAY_MS, schedule: (fn: () => void, ms: number) => any = setTimeout, cancel: (id: any) => void = clearTimeout) {
  let timer: any;
  return {
    changed() {
      if (timer !== undefined) cancel(timer);
      timer = schedule(() => { timer = undefined; save(); }, delay);
    },
    cancel() { if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}
