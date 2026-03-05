import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useDebouncedSetHistory } from './useDebouncedSetHistory';

export function useUndo() {
  const { history } = useAppState();

  const { undo: undoAdjustments, canUndo } = history;
  const debouncedSetHistory = useDebouncedSetHistory();

  const undo = useCallback(() => {
    if (canUndo) {
      undoAdjustments();
      debouncedSetHistory.cancel();
    }
  }, [canUndo, undoAdjustments, debouncedSetHistory]);

  return undo;
}
