import { apiClient, type ApiClient } from './apiClient';

export interface SessionStatus {
  admin: boolean; requiresPassword: boolean; expiresAt?: number;
  mode?: 'legacy' | 'kjx';
  user?: { id: string; username: string; name: string; title: string | null; disciplines: string[]; role: 'admin' | 'manager' | 'reviewer' | 'viewer' } | null;
  permissions?: string[];
  auth?: { loginUrl: string; logoutUrl: string; passwordUrl: string; myAppsUrl: string } | null;
}

// The server is the only authority on the administrator session; the client just mirrors it.
// The httpOnly cookie travels with same-origin requests, so no credential is stored in JS.
export function createSessionApi(client: ApiClient) {
  return {
    status: (signal?: AbortSignal) => client.json<SessionStatus>('session', { cache: 'no-store', signal }),
    login: (password: string) => client.json<SessionStatus>('session', { method: 'POST', json: { password } }),
    logout: () => client.json<SessionStatus>('session', { method: 'DELETE' }),
  };
}

export const sessionApi = createSessionApi(apiClient);
