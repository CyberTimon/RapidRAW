import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useDebouncedSetHistory } from './useDebouncedSetHistory';

export function useRedo() {
  const { history } = useAppState();

  const { redo: redoAdjustments, canRedo } = history;
  const debouncedSetHistory = useDebouncedSetHistory();

  const redo = useCallback(() => {
    if (canRedo) {
      redoAdjustments();
      debouncedSetHistory.cancel();
    }
  }, [canRedo, redoAdjustments, debouncedSetHistory]);

  return redo;
}
