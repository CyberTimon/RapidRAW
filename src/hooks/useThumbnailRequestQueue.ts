import { useCallback, useEffect, useRef } from 'react';
import { useProcessStore } from '../store/useProcessStore';

const REQUEST_BATCH_DELAY_MS = 50;

export function useThumbnailRequestQueue(onRequestThumbnails?: (paths: string[]) => void) {
  const queueRef = useRef<Set<string>>(new Set());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearThumbnailRequests = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
    queueRef.current.clear();
  }, []);

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      queueRef.current.add(path);
      if (!timeoutRef.current) {
        timeoutRef.current = setTimeout(() => {
          const paths = Array.from(queueRef.current);
          if (paths.length > 0) {
            onRequestThumbnails(paths);
            queueRef.current.clear();
          }
          timeoutRef.current = null;
        }, REQUEST_BATCH_DELAY_MS);
      }
    },
    [onRequestThumbnails],
  );

  useEffect(() => clearThumbnailRequests, [clearThumbnailRequests]);

  return { queueThumbnailRequest, clearThumbnailRequests };
}
