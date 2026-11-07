import { createHub } from './app.ts';

const hub = await createHub();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000).unref();
    void hub.close().then(() => { clearTimeout(timeout); process.exit(0); });
  });
}
