import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSyncProgressStore } from '../store/useSyncProgressStore';
import { Invokes } from '../components/ui/AppProperties';
import type { Adjustments } from '../utils/adjustments';

let metadataSaveQueue: Promise<unknown> = Promise.resolve();
let adjustmentSyncQueue: Promise<unknown> = Promise.resolve();
let photoMutationQueue: Promise<void> = Promise.resolve();
let photoMutationActive = false;

export function queueMetadataSave(path: string, adjustments: Adjustments) {
  const operation = metadataSaveQueue
    .catch(() => undefined)
    .then(() => invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments }));
  metadataSaveQueue = operation;
  return operation;
}

export function queueAdjustmentSync(paths: string[], adjustments: Partial<Adjustments>) {
  if (!paths.length) return Promise.resolve();
  const syncJobId = crypto.randomUUID();
  const progress = useSyncProgressStore.getState();
  progress.enqueue(syncJobId, paths.length);
  const operation = adjustmentSyncQueue
    .catch(() => undefined)
    .then(async () => {
      progress.start(syncJobId);
      let unlisten: (() => void) | undefined;
      try {
        unlisten = await listen<{ jobId: string; completed: number }>('adjustment-sync-progress', ({ payload }) => {
          if (payload.jobId === syncJobId) progress.advance(syncJobId, payload.completed);
        });
        await invoke(Invokes.ApplyAdjustmentsToPaths, { paths, adjustments, syncJobId });
        progress.finish(syncJobId);
      } catch (error) {
        progress.finish(syncJobId, true);
        throw error;
      } finally {
        unlisten?.();
      }
    });
  adjustmentSyncQueue = operation;
  return operation;
}

export function queuePhotoMutation<T>(mutation: () => Promise<T>) {
  let operation: Promise<T>;
  if (photoMutationActive) {
    operation = photoMutationQueue.then(mutation);
  } else {
    photoMutationActive = true;
    try {
      operation = Promise.resolve(mutation());
    } catch (error) {
      operation = Promise.reject(error);
    }
  }
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  photoMutationQueue = settled;
  void settled.then(() => {
    if (photoMutationQueue === settled) photoMutationActive = false;
  });
  return operation;
}
