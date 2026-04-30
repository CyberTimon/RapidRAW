import { useRef, useCallback, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';

export function useThumbnails() {
  const generatedRef = useRef<Set<string>>(new Set());

  const sendQueueToBackend = useMemo(
    () =>
      debounce(
        (paths: string[]) => {
          invoke('update_thumbnail_queue', { paths }).catch((err) => {
            console.error('Failed to update thumbnail queue:', err);
          });
        },
        150,
        { maxWait: 300 },
      ),
    [],
  );

  const requestThumbnails = useCallback(
    (visiblePaths: string[]) => {
      const neededPaths = visiblePaths.filter((p) => !generatedRef.current.has(p));

      if (neededPaths.length > 0) {
        for (let i = neededPaths.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [neededPaths[i], neededPaths[j]] = [neededPaths[j], neededPaths[i]];
        }

        sendQueueToBackend(neededPaths);
      }
    },
    [sendQueueToBackend],
  );

  const markGenerated = useCallback((path: string) => {
    generatedRef.current.add(path);
  }, []);

  const clearThumbnailQueue = useCallback(() => {
    generatedRef.current.clear();
    sendQueueToBackend.cancel();
    invoke('update_thumbnail_queue', { paths: [] }).catch(console.error);
  }, [sendQueueToBackend]);

  useEffect(() => {
    return () => sendQueueToBackend.cancel();
  }, [sendQueueToBackend]);

  return { requestThumbnails, clearThumbnailQueue, markGenerated };
}
