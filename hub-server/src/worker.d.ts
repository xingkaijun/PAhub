import type { D1Adapter } from './d1.ts';

// Boundary type only: esbuild resolves this alias to the unchanged Worker source.
// The old Worker uses non-strict TS; the hub is checked independently in strict mode.
declare const worker: {
  fetch(request: Request, env: {
    PAPC_DB: D1Adapter;
    API_TOKEN?: string;
    ADMIN_PASSWORD?: string;
    ADMIN_SQL?: (sql: string) => Record<string, unknown>[];
    ALLOW_CORS_ORIGIN?: string;
  }): Promise<Response>;
};
export default worker;
