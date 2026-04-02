import { useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';

export function useThumbnails() {
  const requestedPathsRef = useRef<Set<string>>(new Set());
  const visiblePathsRef = useRef<Set<string>>(new Set());
  const processorRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requestThumbnails = useCallback((paths: string[]) => {
    visiblePathsRef.current = new Set(paths);

    if (!processorRef.current) {
      processorRef.current = setInterval(() => {
        const pathsToRequest = Array.from(visiblePathsRef.current).filter((p) => !requestedPathsRef.current.has(p));

        if (pathsToRequest.length > 0) {
          pathsToRequest.forEach((p) => requestedPathsRef.current.add(p));

          for (let i = pathsToRequest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pathsToRequest[i], pathsToRequest[j]] = [pathsToRequest[j], pathsToRequest[i]];
          }

          invoke(Invokes.GenerateThumbnailsProgressive, { paths: pathsToRequest }).catch((err) => {
            console.error('Failed to request thumbnails:', err);
          });
        } else {
          if (processorRef.current) {
            clearInterval(processorRef.current);
            processorRef.current = null;
          }
        }
      }, 150);
    }
  }, []);

  const clearThumbnailQueue = useCallback(() => {
    requestedPathsRef.current.clear();
    visiblePathsRef.current.clear();
    if (processorRef.current) {
      clearInterval(processorRef.current);
      processorRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (processorRef.current) clearInterval(processorRef.current);
    };
  }, []);

  return { requestThumbnails, clearThumbnailQueue };
}
