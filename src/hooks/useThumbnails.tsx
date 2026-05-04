import { useRef, useCallback, useMemo, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import debounce from 'lodash.debounce';
import { SupportedTypes } from '../components/ui/AppProperties';

interface ThumbnailSet {
  Preview?: string; // Full generated thumbnail (best quality)
  Embedded?: string; // Full embedded preview
  Tiny?: string; // Tiny preview from 64KB
}

export function useThumbnails(appSettings?: any, supportedTypes?: SupportedTypes) {
  const generatedRef = useRef<Set<string>>(new Set());
  const pendingQueueRef = useRef<Set<string>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<string, ThumbnailSet>>({});

  // Clear thumbnails when embedded preview setting changes (to refresh display)
  useEffect(() => {
    setThumbnails({});
  }, [appSettings?.useEmbeddedJpegThumbnails]);

  // Get best available thumbnail for a path (Preview > Embedded > Tiny)
  const getThumbnailForPath = useCallback(
    (path: string): string | undefined => {
      const thumbnailSet = thumbnails[path];
      const shouldUseEmbedded = appSettings?.useEmbeddedJpegThumbnails ?? true;

      // If embedded previews disabled for RAW files, only use actual Preview
      if (!shouldUseEmbedded && supportedTypes) {
        const fileExtension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        if (supportedTypes.raw.some((t) => t.toLowerCase() === fileExtension)) {
          return thumbnailSet?.Preview;
        }
      }

      return thumbnailSet?.Preview || thumbnailSet?.Embedded || thumbnailSet?.Tiny;
    },
    [thumbnails, appSettings?.useEmbeddedJpegThumbnails, supportedTypes],
  );

  const flatThumbnails = useMemo(() => {
    const result: Record<string, string> = {};
    const shouldUseEmbedded = appSettings?.useEmbeddedJpegThumbnails ?? true;

    for (const [path, thumbnailSet] of Object.entries(thumbnails)) {
      // If embedded previews disabled for RAW files, only use actual Preview
      if (!shouldUseEmbedded && supportedTypes) {
        const fileExtension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const isRaw = supportedTypes.raw.some((t) => t.toLowerCase() === fileExtension);
        if (isRaw) {
          if (thumbnailSet?.Preview) result[path] = thumbnailSet.Preview;
          continue;
        }
      }

      const bestThumbnail = thumbnailSet?.Preview || thumbnailSet?.Embedded || thumbnailSet?.Tiny;
      if (bestThumbnail) result[path] = bestThumbnail;
    }
    return result;
  }, [thumbnails, appSettings?.useEmbeddedJpegThumbnails, supportedTypes]);

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
    setThumbnails({});
    invoke('update_thumbnail_queue', { paths: [] }).catch(console.error);
  }, [flushQueueToBackend]);

  // Set up event listeners for thumbnail generation
  useEffect(() => {
    let unlistenEmbedded: (() => void) | null = null;
    let unlistenThumbnail: (() => void) | null = null;

    (async () => {
      unlistenEmbedded = await listen('embedded-preview-generated', (event: any) => {
        const { path, data, type: previewType } = event.payload;
        if (data) {
          setThumbnails((prev) => {
            const current = prev[path];
            // If we already have a Preview, don't add anything
            if (current?.Preview) {
              return prev;
            }
            // Route to correct tier based on type
            if (previewType === 'tiny') {
              return {
                ...prev,
                [path]: { ...current, Tiny: data },
              };
            } else if (previewType === 'embedded') {
              // Embedded replaces Tiny
              return {
                ...prev,
                [path]: { Preview: current?.Preview, Embedded: data },
              };
            }
            return prev;
          });
        }
      });

      unlistenThumbnail = await listen('thumbnail-generated', (event: any) => {
        const { path, data } = event.payload;
        if (data) {
          // Full Preview - clear all lower tiers
          setThumbnails((prev) => ({
            ...prev,
            [path]: { Preview: data },
          }));
          markGenerated(path);
        }
      });
    })();

    return () => {
      unlistenEmbedded?.();
      unlistenThumbnail?.();
      flushQueueToBackend.cancel();
    };
  }, [markGenerated, flushQueueToBackend]);

  return {
    thumbnails: flatThumbnails,
    getThumbnailForPath,
    requestThumbnails,
    clearThumbnailQueue,
    markGenerated,
  };
}
