import { useCallback, useEffect, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isAutoHydration } from '../auto/editSafety';
import { registerCropCommitListener } from '../crop/commit';
import { useLibraryStore } from '../store/useLibraryStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { COPYABLE_ADJUSTMENT_KEYS, type Adjustments } from '../utils/adjustments';
import { globalImageCache } from '../utils/ImageLRUCache';
import { Invokes } from '../components/ui/AppProperties';
import { debouncedSave } from './useEditorActions';

let adjustmentSyncQueue: Promise<unknown> = Promise.resolve();

function queueAdjustmentSync(paths: string[], adjustments: Partial<Adjustments>) {
  const operation = adjustmentSyncQueue
    .catch(() => undefined)
    .then(() => invoke(Invokes.ApplyAdjustmentsToPaths, { paths, adjustments }));
  adjustmentSyncQueue = operation;
  return operation;
}

// Rendering and crop acceptance share one baseline, so navigation can flush an
// accepted crop without waiting for the next render or Auto Sync running twice.
export function useAdjustmentPersistence(previousRef: RefObject<{ path: string; adjustments: Adjustments } | null>) {
  const persist = useCallback(
    (path: string, saved: Adjustments, fallback?: Adjustments) => {
      const previous = previousRef.current?.path === path ? previousRef.current.adjustments : fallback;
      if (!previous) {
        previousRef.current = { path, adjustments: saved };
        return;
      }
      if (JSON.stringify(previous) === JSON.stringify(saved) || isAutoHydration(saved)) return;
      debouncedSave(path, saved);
      const settings = useSettingsStore.getState().appSettings?.copyPasteSettings;
      const otherPaths = useLibraryStore.getState().multiSelectedPaths.filter((p) => p !== path);
      if (settings?.autoSync && otherPaths.length) {
        const included = settings.includedAdjustments || COPYABLE_ADJUSTMENT_KEYS;
        const delta = Object.fromEntries(
          Object.entries(saved).filter(
            ([key, value]) =>
              included.includes(key) && JSON.stringify(value) !== JSON.stringify(previous[key as keyof Adjustments]),
          ),
        );
        if (Object.keys(delta).length) {
          otherPaths.forEach((p) => globalImageCache.delete(p));
          void queueAdjustmentSync(otherPaths, delta).catch((error) => {
            console.error('Failed to apply adjustments to multi-selection:', error);
          });
        }
      }
      previousRef.current = { path, adjustments: saved };
    },
    [previousRef],
  );
  useEffect(() => registerCropCommitListener(persist), [persist]);
  return persist;
}
