import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ImageFile, Invokes, Progress } from '../components/ui/AppProperties';

const THUMBNAIL_REQUEST_BATCH_SIZE = 16;

export function useThumbnails(
  imageList: Array<ImageFile>,
  thumbnails: Record<string, string>,
  setThumbnails: any,
  requestedPaths: Array<string> = [],
) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>({ completed: 0, total: 0 });
  const processedImageListKey = useRef<string | null>(null);
  const thumbnailsRef = useRef<Record<string, string>>(thumbnails);

  useEffect(() => {
    thumbnailsRef.current = thumbnails;
  }, [thumbnails]);

  useEffect(() => {
    if (!imageList || imageList.length === 0) {
      processedImageListKey.current = null;
      setThumbnails({});
      setLoading(false);
      setProgress({ completed: 0, total: 0 });
      return;
    }

    const imagePaths = imageList.map((img: ImageFile) => img.path);
    const effectiveRequestedPaths =
      requestedPaths.length > 0 ? requestedPaths.filter((path) => imagePaths.includes(path)) : imagePaths.slice(0, 48);

    setThumbnails((prevThumbnails: Record<string, string>) => {
      const newPathSet = new Set(imagePaths);
      const nextThumbnails = { ...prevThumbnails };
      let hasChanges = false;

      Object.keys(nextThumbnails).forEach((path) => {
        if (!newPathSet.has(path)) {
          delete nextThumbnails[path];
          hasChanges = true;
        }
      });

      return hasChanges || Object.keys(nextThumbnails).length !== imagePaths.length 
        ? nextThumbnails 
        : prevThumbnails;
    });

    invoke('cancel_thumbnail_generation').catch(() => {});

    const pathsToRequest = effectiveRequestedPaths.filter((path) => !thumbnailsRef.current[path]);
    const newKey = JSON.stringify(pathsToRequest);

    if (newKey === processedImageListKey.current) {
      return;
    }

    processedImageListKey.current = newKey;

    if (pathsToRequest.length === 0) {
      setLoading(false);
      setProgress({ completed: 0, total: 0 });
      return;
    }

    let unlistenComplete: any;
    let isCancelled = false;
    let nextBatchStartIndex = 0;

    const setupListenersAndInvoke = async () => {
      setLoading(true);
      setProgress({ completed: 0, total: pathsToRequest.length });

      unlistenComplete = await listen('thumbnail-generation-complete', () => {
        if (isCancelled) {
          return;
        }
        const completed = Math.min(nextBatchStartIndex, pathsToRequest.length);
        setProgress({ completed, total: pathsToRequest.length });
        if (completed >= pathsToRequest.length) {
          setLoading(false);
          return;
        }
        invokeNextBatch();
      });

      const invokeNextBatch = async () => {
        if (isCancelled) {
          return;
        }
        const batchPaths = pathsToRequest.slice(
          nextBatchStartIndex,
          nextBatchStartIndex + THUMBNAIL_REQUEST_BATCH_SIZE,
        );
        if (batchPaths.length === 0) {
          setLoading(false);
          return;
        }
        nextBatchStartIndex += batchPaths.length;

        try {
          await invoke(Invokes.GenerateThumbnailsProgressive, { paths: batchPaths });
        } catch (error) {
          console.error('Failed to invoke thumbnail generation:', error);
          setLoading(false);
        }
      };

      try {
        await invokeNextBatch();
      } catch (error) {
        console.error('Failed to invoke thumbnail generation:', error);
        setLoading(false);
      }
    };

    setupListenersAndInvoke();

    return () => {
      isCancelled = true;
      invoke('cancel_thumbnail_generation').catch(() => {});
      if (unlistenComplete) {
        unlistenComplete();
      }
    };
  }, [imageList, requestedPaths, setThumbnails]);

  return { loading, progress };
}
