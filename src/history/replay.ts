import type { Adjustments } from '../utils/adjustments';

const replayedAdjustments = new WeakSet<object>();

export function markHistoryReplay(adjustments: Adjustments) {
  replayedAdjustments.add(adjustments);
  return adjustments;
}

export function isHistoryReplay(adjustments: Adjustments) {
  return replayedAdjustments.has(adjustments);
}
