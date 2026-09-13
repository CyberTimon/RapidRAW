import { useCallback, useEffect, useRef } from 'react';
import type { ImageFile } from '../components/ui/AppProperties';
import { useProcessStore } from '../store/useProcessStore';
import { setVisibleThumbnails } from '../utils/thumbnailCache';
import { queueThumbnails } from './thumbnailRequests';

export function useCullingPrefetch(
  images: ImageFile[],
  selected: string[],
  activePath: string | null,
  request?: (paths: string[]) => void,
) {
  const visible = useRef<string[]>([]);
  useEffect(() => {
    setVisibleThumbnails([...visible.current, ...selected.slice(-6)]);
  }, [selected]);
  useEffect(() => () => setVisibleThumbnails([]), []);
  useEffect(() => {
    const index = images.findIndex((item) => item.path === activePath);
    if (index < 0) return;
    const neighbors = images
      .slice(Math.max(0, index - 2), index + 3)
      .filter((item) => item.path !== activePath && !useProcessStore.getState().mediumThumbnails[item.path])
      .map((item) => item.path);
    if (neighbors.length) void queueThumbnails(neighbors, true, true).catch(console.error);
  }, [images, activePath]);
  return useCallback(
    ({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) => {
      const paths = images.slice(startIndex, stopIndex + 1).map((item) => item.path);
      visible.current = paths;
      setVisibleThumbnails([...paths, ...selected.slice(-6)]);
      request?.(paths);
      const adjacent = images
        .slice(Math.max(0, startIndex - 2), stopIndex + 3)
        .filter((item) => !paths.includes(item.path) && !useProcessStore.getState().thumbnails[item.path])
        .map((item) => item.path);
      if (adjacent.length) void queueThumbnails(adjacent, false, true).catch(console.error);
    },
    [images, selected, request],
  );
}
