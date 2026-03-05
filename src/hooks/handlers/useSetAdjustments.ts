import { useCallback } from 'react';
import { Adjustments } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useDebouncedSetHistory } from './useDebouncedSetHistory';

export function useSetAdjustments() {
  const { setAdjustments: setLiveAdjustments } = useAppState();
  const debouncedSetHistory = useDebouncedSetHistory();

  const setAdjustments = useCallback(
    (value: any) => {
      setLiveAdjustments((prevAdjustments: Adjustments) => {
        const newAdjustments = typeof value === 'function' ? value(prevAdjustments) : value;
        debouncedSetHistory(newAdjustments);
        return newAdjustments;
      });
    },
    [debouncedSetHistory],
  );

  return setAdjustments;
}
