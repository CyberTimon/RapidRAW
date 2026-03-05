import debounce from 'lodash.debounce';
import { useMemo } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useDebouncedSetHistory() {
  const { history } = useAppState();
  const { setState: setHistoryAdjustments } = history;

  const debouncedSetHistory = useMemo(
    () => debounce((newAdjustments) => setHistoryAdjustments(newAdjustments), 300),
    [setHistoryAdjustments],
  );

  return debouncedSetHistory;
}
