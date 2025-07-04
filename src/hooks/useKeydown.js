import { useCallback, useEffect } from 'react';

export const useKeydown = (key, callback, enabled = true) => {
  const memoizedCallback = useCallback(callback, [callback]);

  useEffect(() => {
    if (!enabled) return;

    const handler = (e) => {
      if (e.key.toLowerCase() === key.toLowerCase()) {
        if (document.activeElement.tagName.toLowerCase() === 'input') return;
        e.preventDefault();
        memoizedCallback();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, memoizedCallback, enabled]);
};