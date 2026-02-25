import { useState, useMemo, useCallback } from 'react';

export const useHistoryState = (initialState: any) => {
  const [history, setHistory] = useState([initialState]);
  const [index, setIndex] = useState(0);
  const state = useMemo(() => history[index], [history, index]);

  const setState = useCallback(
    (newState: any) => {
      const resolvedState = typeof newState === 'function' ? newState(history[index]) : newState;
      if (JSON.stringify(resolvedState) === JSON.stringify(history[index])) {
        return;
      }
      const newHistory = history.slice(0, index + 1);
      newHistory.push(resolvedState);
      setHistory(newHistory);
      setIndex(newHistory.length - 1);
    },
    [history, index],
  );

  const undo = useCallback(() => {
    if (index > 0) {
      setIndex(index - 1);
    }
  }, [index]);

  const redo = useCallback(() => {
    if (index < history.length - 1) {
      setIndex(index + 1);
    }
  }, [index, history.length]);

  const resetHistory = useCallback((newInitialState: any) => {
    setHistory([newInitialState]);
    setIndex(0);
  }, []);

  const goToIndex = useCallback((newIndex: number) => {
    if (newIndex >= 0 && newIndex < history.length) {
      setIndex(newIndex);
    }
  }, [history.length]);

  const canUndo = index > 0;
  const canRedo = index < history.length - 1;

  return { state, setState, undo, redo, canUndo, canRedo, resetHistory, history, historyIndex: index, goToIndex };
};
