import debounce from 'lodash.debounce';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { COPYABLE_ADJUSTMENT_KEYS, type Adjustments } from '../utils/adjustments';
import { globalImageCache } from '../utils/ImageLRUCache';
import { queueAdjustmentSync } from './persistence';
import {
  captureAdjustmentSnapshots,
  replayAdjustmentSnapshots,
  type AdjustmentSnapshots,
} from './adjustmentBatchHistory';
import { discardUndoableAction, recordUndoableAction } from './actionHistory';

interface PendingSync {
  actionId: number;
  after: Adjustments;
  before: Adjustments;
  beforeTargets: Promise<AdjustmentSnapshots>;
  changes: Partial<Adjustments>;
  sourcePath: string;
  targetPaths: string[];
  write?: Promise<unknown>;
}

let pending: PendingSync | null = null;

function sameTargets(left: string[], right: string[]) {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function afterSnapshots(sync: PendingSync, targets: AdjustmentSnapshots) {
  return Object.fromEntries(
    Object.entries(targets).map(([path, adjustments]) => [path, { ...adjustments, ...sync.changes }]),
  ) as AdjustmentSnapshots;
}

function cancelPendingSync(sync: PendingSync) {
  if (pending !== sync) return;
  pending = null;
  flushAfterGesture.cancel();
}

function flushPendingSync() {
  const sync = pending;
  pending = null;
  if (!sync || Object.keys(sync.changes).length === 0) return;

  sync.targetPaths.forEach((path) => globalImageCache.delete(path));
  sync.write = sync.beforeTargets
    .then(() => queueAdjustmentSync(sync.targetPaths, sync.changes))
    .catch((error) => {
      discardUndoableAction(sync.actionId);
      console.error('Failed to auto-sync adjustments to selection:', error);
    });
}

const flushAfterGesture = debounce(flushPendingSync, 100);

export function scheduleSelectedAdjustmentSync(sourcePath: string, previous: Adjustments, next: Adjustments) {
  const settings = useSettingsStore.getState().appSettings?.copyPasteSettings;
  if (!settings?.autoSync) return false;

  const targetPaths = useLibraryStore.getState().multiSelectedPaths.filter((path) => path !== sourcePath);
  if (targetPaths.length === 0) return false;

  const changes = Object.fromEntries(
    // Live sync follows the edited controls; the manual paste filter must not
    // silently suppress edits (the Exposure slider uses the brightness key).
    COPYABLE_ADJUSTMENT_KEYS
      .filter(
        (key) => JSON.stringify(previous[key as keyof Adjustments]) !== JSON.stringify(next[key as keyof Adjustments]),
      )
      .map((key) => [key, structuredClone(next[key as keyof Adjustments])]),
  ) as Partial<Adjustments>;
  if (Object.keys(changes).length === 0) return false;

  if (pending && (pending.sourcePath !== sourcePath || !sameTargets(pending.targetPaths, targetPaths))) {
    flushAfterGesture.cancel();
    flushPendingSync();
  }

  if (pending) {
    pending.after = structuredClone(next);
    pending.changes = { ...pending.changes, ...changes };
  } else {
    const sync: PendingSync = {
      actionId: 0,
      sourcePath,
      targetPaths,
      before: structuredClone(previous),
      after: structuredClone(next),
      beforeTargets: captureAdjustmentSnapshots(targetPaths),
      changes,
    };
    void sync.beforeTargets.catch(() => undefined);
    sync.actionId = recordUndoableAction({
      label: 'Adjust selected photos',
      undo: async () => {
        cancelPendingSync(sync);
        await sync.write;
        const targets = await sync.beforeTargets;
        await replayAdjustmentSnapshots(
          { [sourcePath]: sync.before, ...targets },
          { [sourcePath]: sync.after, ...afterSnapshots(sync, targets) },
        );
      },
      redo: async () => {
        const targets = await sync.beforeTargets;
        await replayAdjustmentSnapshots(
          { [sourcePath]: sync.after, ...afterSnapshots(sync, targets) },
          { [sourcePath]: sync.before, ...targets },
        );
      },
    });
    pending = sync;
  }
  flushAfterGesture();
  return true;
}
