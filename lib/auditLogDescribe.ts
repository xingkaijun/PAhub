import type { AuditEntry } from '../types';

export const asCount = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

// detail 拼成与本地 statusHistory 完全一致的字符串，
// TRANSITION_FILTERS 的正则筛选因此对服务端数据直接生效
export const describeAuditEntry = (entry: AuditEntry): string => {
    if (entry.action === 'BUILDER_REPLY') {
        const replies = asCount(entry.detail.replies);
        const round = entry.detail.round ? ` (Round ${String(entry.detail.round)})` : '';
        const status = String(entry.detail.status || '').trim();
        // "Waiting Reply -> Reviewing" stays in the arrow form; "unchanged (X)" reads as "status unchanged (X)"
        const statusText = status ? ` · status ${status}` : '';
        return `Builder replies imported: ${replies} ${replies === 1 ? 'reply' : 'replies'}${round}${statusText}`;
    }
    if (entry.action === 'STATUS') {
        const parts = [`Status: ${entry.detail.from ?? '?'} -> ${entry.detail.to ?? '?'}`];
        if (entry.detail.round) parts.push(`Round: ${entry.detail.round.from} -> ${entry.detail.round.to}`);
        return parts.join(' | ');
    }
    const from = (entry.detail.from || {}) as Record<string, unknown>;
    const to = (entry.detail.to || {}) as Record<string, unknown>;
    return `Comments: ${asCount(from.total)}/${asCount(from.open)} -> ${asCount(to.total)}/${asCount(to.open)}`;
};

