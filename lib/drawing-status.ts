import { nextRoundLabel } from './rounds.ts';
import { calculateDeadline, reviewCycleDays } from './deadline.ts';

export type ReviewStatus = 'Pending' | 'Reviewing' | 'Waiting Reply' | 'Approved';
export interface ReviewCycleConfig { roundACycle?: number; otherRoundsCycle?: number; holidays?: string[] }

// Shared optimistic calculation; the server supplies the authoritative previous state and time.
export function transitionReviewState(
  previous: { status: string; currentRound: string; reviewDeadline?: string | null },
  status: ReviewStatus,
  conf: ReviewCycleConfig,
  at = new Date(),
) {
  let currentRound = previous.currentRound || 'A';
  let reviewDeadline = previous.reviewDeadline || null;
  if (status !== previous.status) {
    if (status === 'Reviewing') {
      if (previous.status === 'Waiting Reply') currentRound = nextRoundLabel(currentRound);
      const days = reviewCycleDays(currentRound, conf);
      reviewDeadline = calculateDeadline(at, days, conf.holidays || []).toISOString();
    } else if (previous.status === 'Reviewing') reviewDeadline = null;
  }
  return { status, currentRound, reviewDeadline };
}
