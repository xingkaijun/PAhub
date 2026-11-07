import type { ReviewTrackerEntry } from '../types';

export type PcfIndexEntry = {
  approval: string;
  totalComments: number;
  openComments: number;
  currentRound: number;
  rev: number;
};

export function effectiveAprDone(entry: ReviewTrackerEntry | undefined, approval: string | undefined): boolean {
  // Legacy tracker rows predate the source column. Any explicit legacy value was a user
  // decision, so it must remain authoritative after upgrading to PCF-derived defaults.
  if (isManualApr(entry)) return Boolean(entry!.done);
  return approval === 'Approved' || approval === 'Approved with comments';
}

export function isManualApr(entry: ReviewTrackerEntry | undefined): boolean {
  return Boolean(entry && (entry.source == null || entry.source === 'manual'));
}

// Remove APR overrides for the next round; never persist PCF defaults as manual false.
export function clearedTracker(entry: Record<string, ReviewTrackerEntry>): Record<string, ReviewTrackerEntry> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== '__approved__')
    .map(([key]) => [key, { done: false }]));
}

export function sentStatus(entry: ReviewTrackerEntry | undefined, approval: string | undefined): 'Approved' | 'Waiting Reply' {
  return effectiveAprDone(entry, approval) ? 'Approved' : 'Waiting Reply';
}

export function pcfApprovalVisible(approval: string | undefined): boolean {
  return Boolean(approval && approval !== 'Not submitted');
}

export function pcfApprovalTone(approval: string | undefined): string {
  if (approval === 'Approved') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (approval === 'Approved with comments') return 'border-cyan-200 bg-cyan-50 text-cyan-700';
  if (approval === 'Rejected') return 'border-red-200 bg-red-50 text-red-700';
  if (approval === 'Under review') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-500';
}

export function normalizePcfIndex(rows: any[]): Record<string, PcfIndexEntry> {
  if (!Array.isArray(rows)) return {};
  return Object.fromEntries(rows.filter(row => row && row.drawing_id).map(row => [String(row.drawing_id), {
    approval: String(row.approval || 'Not submitted'),
    totalComments: Number(row.total_comments) || 0,
    openComments: Number(row.open_comments) || 0,
    currentRound: Number(row.current_round) || 1,
    rev: Number(row.rev) || 0,
  }]));
}
