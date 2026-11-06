import { useRef, useCallback, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';

export function useThumbnails() {
  const generatedRef = useRef<Set<string>>(new Set());
  const pendingQueueRef = useRef<Set<string>>(new Set());

  const flushQueueToBackend = useMemo(
    () =>
      debounce(
        () => {
          const pathsToSend = Array.from(pendingQueueRef.current);
          if (pathsToSend.length === 0) return;

          for (let i = pathsToSend.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pathsToSend[i], pathsToSend[j]] = [pathsToSend[j], pathsToSend[i]];
          }

          invoke('update_thumbnail_queue', { paths: pathsToSend }).catch((err) => {
            console.error('Failed to update thumbnail queue:', err);
          });

          pendingQueueRef.current.clear();
        },
        150,
        { maxWait: 300 },
      ),
    [],
  );

  const requestThumbnails = useCallback(
    (visiblePaths: string[]) => {
      let addedToQueue = false;

      visiblePaths.forEach((p) => {
        if (!generatedRef.current.has(p) && !pendingQueueRef.current.has(p)) {
          pendingQueueRef.current.add(p);
          addedToQueue = true;
        }
      });

      if (addedToQueue) {
        flushQueueToBackend();
      }
    },
    [flushQueueToBackend],
  );

  const markGenerated = useCallback((path: string) => {
    generatedRef.current.add(path);
    pendingQueueRef.current.delete(path);
  }, []);

  const clearThumbnailQueue = useCallback(() => {
    generatedRef.current.clear();
    pendingQueueRef.current.clear();
    flushQueueToBackend.cancel();
    invoke('update_thumbnail_queue', { paths: [] }).catch(console.error);
  }, [flushQueueToBackend]);

  useEffect(() => {
    return () => flushQueueToBackend.cancel();
  }, [flushQueueToBackend]);

  return { requestThumbnails, clearThumbnailQueue, markGenerated };
}
