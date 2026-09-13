import { useCallback, useEffect, type RefObject } from 'react';
import { isAutoHydration } from '../auto/editSafety';
import { registerCropCommitListener } from '../crop/commit';
import type { Adjustments } from '../utils/adjustments';
import { isHistoryReplay } from '../history/replay';
import { debouncedSave } from './useEditorActions';

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
      if (JSON.stringify(previous) === JSON.stringify(saved)) return;
      if (isAutoHydration(saved) || isHistoryReplay(saved)) {
        previousRef.current = { path, adjustments: saved };
        return;
      }
      debouncedSave(path, saved);
      previousRef.current = { path, adjustments: saved };
    },
    [previousRef],
  );
  useEffect(() => registerCropCommitListener(persist), [persist]);
  return persist;
}
