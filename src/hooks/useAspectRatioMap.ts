import { useCallback, useEffect, useRef, useState } from 'react';

const RATIO_UPDATE_DELAY_MS = 150;

export function useAspectRatioMap() {
  const ratioMapRef = useRef<Record<string, number>>({});
  const [ratioMapVersion, setRatioMapVersion] = useState(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onAspectRatioLoaded = useCallback((path: string, ratio: number) => {
    if (Math.abs((ratioMapRef.current[path] || 0) - ratio) <= 0.01) return;
    ratioMapRef.current[path] = ratio;
    if (!timeoutRef.current) {
      timeoutRef.current = setTimeout(() => {
        setRatioMapVersion((v) => v + 1);
        timeoutRef.current = null;
      }, RATIO_UPDATE_DELAY_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return { ratioMapRef, ratioMapVersion, onAspectRatioLoaded };
}
