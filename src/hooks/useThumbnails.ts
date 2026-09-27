import { useRef, useCallback, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import debounce from 'lodash.debounce';
import { useLibraryStore } from '../store/useLibraryStore';
import { useProcessStore } from '../store/useProcessStore';

const physicalSource = (path: string) => path.split('?vc=')[0];
const belongsToSource = (path: string, source: string) => path === source || path.startsWith(`${source}?vc=`);

export function useThumbnails() {
  const generatedRef = useRef<Set<string>>(new Set());
  const pendingQueueRef = useRef<Set<string>>(new Set());
  const expectedSourceRevisionsRef = useRef<Map<string, string | null>>(new Map());

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

  const shouldAcceptGenerated = useCallback((path: string, sourceRevision?: string | null) => {
    const source = physicalSource(path);
    if (!expectedSourceRevisionsRef.current.has(source)) return true;
    const expected = expectedSourceRevisionsRef.current.get(source);
    return !!expected && sourceRevision === expected;
  }, []);

  const needsSourceThumbnailRefresh = useCallback((path: string, sourceRevision: string) => {
    const source = physicalSource(path);
    if (
      expectedSourceRevisionsRef.current.has(source) &&
      expectedSourceRevisionsRef.current.get(source) !== sourceRevision
    ) {
      return true;
    }
    const process = useProcessStore.getState();
    return [...Object.keys(process.thumbnails), ...Object.keys(process.mediumThumbnails)].some(
      (candidate) =>
        belongsToSource(candidate, source) && process.thumbnailSourceRevisions[candidate] !== sourceRevision,
    );
  }, []);

  const retryStaleGenerated = useCallback(
    (path: string) => {
      if (!expectedSourceRevisionsRef.current.get(physicalSource(path))) return;
      generatedRef.current.delete(path);
      pendingQueueRef.current.delete(path);
      requestThumbnails([path]);
    },
    [requestThumbnails],
  );

  const invalidateSourceThumbnails = useCallback(
    (path: string, sourceRevision: string | null) => {
      const source = physicalSource(path);
      if (
        expectedSourceRevisionsRef.current.has(source) &&
        expectedSourceRevisionsRef.current.get(source) === sourceRevision
      ) {
        return;
      }
      expectedSourceRevisionsRef.current.set(source, sourceRevision);
      if (expectedSourceRevisionsRef.current.size > 256) {
        expectedSourceRevisionsRef.current.delete(expectedSourceRevisionsRef.current.keys().next().value!);
      }

      const process = useProcessStore.getState();
      const visiblePaths = new Set([path, ...useLibraryStore.getState().imageList.map((image) => image.path)]);
      const paths = new Set([
        path,
        ...Object.keys(process.thumbnails),
        ...Object.keys(process.mediumThumbnails),
        ...Object.keys(process.thumbnailSourceRevisions),
        ...visiblePaths,
      ]);
      const affected = [...paths].filter((candidate) => belongsToSource(candidate, source));
      process.setProcess((state) => {
        const thumbnails = { ...state.thumbnails };
        const mediumThumbnails = { ...state.mediumThumbnails };
        const thumbnailSourceRevisions = { ...state.thumbnailSourceRevisions };
        for (const candidate of affected) {
          delete thumbnails[candidate];
          delete mediumThumbnails[candidate];
          delete thumbnailSourceRevisions[candidate];
        }
        return { thumbnails, mediumThumbnails, thumbnailSourceRevisions };
      });
      for (const candidate of affected) {
        generatedRef.current.delete(candidate);
        pendingQueueRef.current.delete(candidate);
      }
      if (sourceRevision) requestThumbnails(affected.filter((candidate) => visiblePaths.has(candidate)));
    },
    [requestThumbnails],
  );

  const clearThumbnailQueue = useCallback(() => {
    generatedRef.current.clear();
    pendingQueueRef.current.clear();
    flushQueueToBackend.cancel();
    invoke('update_thumbnail_queue', { paths: [] }).catch(console.error);
  }, [flushQueueToBackend]);

  useEffect(() => {
    return () => flushQueueToBackend.cancel();
  }, [flushQueueToBackend]);

  return {
    requestThumbnails,
    clearThumbnailQueue,
    markGenerated,
    invalidateSourceThumbnails,
    shouldAcceptGenerated,
    needsSourceThumbnailRefresh,
    retryStaleGenerated,
  };
}
