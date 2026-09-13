import { globalImageCache } from '../utils/ImageLRUCache';
import type { Adjustments } from '../utils/adjustments';
import { recordUndoableAction } from './actionHistory';
import { queueMetadataSave } from './persistence';
import { markHistoryReplay } from './replay';

interface AdjustmentChange {
  after: Adjustments;
  afterIndex: number;
  apply(adjustments: Adjustments, index: number): void;
  before: Adjustments;
  beforeIndex: number;
  path: string;
}

export function recordAdjustmentChange(change: AdjustmentChange) {
  const replay = async (adjustments: Adjustments, index: number, rollback: Adjustments, rollbackIndex: number) => {
    const snapshot = structuredClone(adjustments);
    change.apply(markHistoryReplay(snapshot), index);
    globalImageCache.delete(change.path);
    try {
      await queueMetadataSave(change.path, snapshot);
    } catch (error) {
      change.apply(markHistoryReplay(structuredClone(rollback)), rollbackIndex);
      throw error;
    }
  };

  recordUndoableAction({
    label: 'Adjust photo',
    undo: () => replay(change.before, change.beforeIndex, change.after, change.afterIndex),
    redo: () => replay(change.after, change.afterIndex, change.before, change.beforeIndex),
  });
}
