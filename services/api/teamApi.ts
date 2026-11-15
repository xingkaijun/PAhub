import { createApiClient } from './apiClient';
export type DirectoryPerson = { id: string; name: string; username: string; title: string | null; disciplines: string[]; role: string };
export type DirectoryResult = { ok: true; users: DirectoryPerson[] } | { ok: false; fallback: true };
export const teamDirectory = (discipline = '', signal?: AbortSignal, projectId?: string) => createApiClient().json<DirectoryResult>('team/directory?' + new URLSearchParams({ discipline, ...(projectId ? {projectId} : {}) }), { signal });
