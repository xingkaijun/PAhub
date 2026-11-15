// Normal saves follow a fixed cadence; retry backoff lives in save-control.ts.
export const AUTOSAVE_INTERVAL_MS = 15 * 60 * 1000;
export function startAutosave(save: () => void, next: (at: number) => void, now = Date.now, schedule: typeof setInterval = setInterval, cancel: typeof clearInterval = clearInterval) {
  let deadline = now() + AUTOSAVE_INTERVAL_MS;
  next(deadline);
  const timer = schedule(() => { deadline += AUTOSAVE_INTERVAL_MS; if (deadline <= now()) deadline = now() + AUTOSAVE_INTERVAL_MS; next(deadline); save(); }, AUTOSAVE_INTERVAL_MS);
  return () => { cancel(timer); next(0); };
}
