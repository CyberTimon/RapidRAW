import { useSyncExternalStore } from 'react';
import { getActionHistorySnapshot, subscribeActionHistory } from './actionHistory';

export function useActionHistory() {
  return useSyncExternalStore(subscribeActionHistory, getActionHistorySnapshot, getActionHistorySnapshot);
}
