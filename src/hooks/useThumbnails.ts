import { useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProcessStore } from '../store/useProcessStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';
import { touchThumbnails, setVisibleThumbnails } from '../utils/thumbnailCache';

export function useThumbnails() {
  const pending = useRef(new Map<string, number>());
  const attempts = useRef(new Map<string, number>());
  const lastActivity = useRef(0);
  const requestThumbnails = useCallback((paths: string[]) => {
    lastActivity.current = Date.now();
    touchThumbnails(paths);
    const cached = useProcessStore.getState().thumbnails;
    const missing = paths.filter(
      (path) =>
        !cached[path] &&
        ((attempts.current.get(path) ?? 0) < 3 ||
          useLibraryStore.getState().imageList.some((image) => image.path === path && image.is_cloud_placeholder)) &&
        Date.now() - (pending.current.get(path) ?? 0) > 5000,
    );
    if (!missing.length) return;
    for (const path of missing) {
      pending.current.set(path, Date.now());
      attempts.current.set(path, (attempts.current.get(path) ?? 0) + 1);
    }
    void invoke('update_thumbnail_queue', { paths: missing }).catch((error) => {
      missing.forEach((path) => pending.current.delete(path));
      console.error('Thumbnail request failed', error);
    });
  }, []);
  const markGenerated = useCallback((path: string) => {
    pending.current.delete(path);
    attempts.current.delete(path);
  }, []);
  const clearThumbnailQueue = useCallback(() => {
    pending.current.clear();
    attempts.current.clear();
    setVisibleThumbnails([]);
    void invoke('update_thumbnail_queue', { paths: [] }).catch(console.error);
  }, []);

  useEffect(() => {
    let folder: string | null = null;
    let cursor = 0;
    let paused: boolean | undefined;
    const syncPaused = () => {
      const next = useUIStore.getState().activeView !== 'library' || Date.now() - lastActivity.current < 1500;
      if (paused !== next) {
        paused = next;
        void invoke('pause_thumbnail_background', { paused: next }).catch(console.error);
      }
      return next;
    };
    const activity = () => {
      lastActivity.current = Date.now();
      syncPaused();
    };
    document.addEventListener('wheel', activity, { passive: true });
    document.addEventListener('pointerdown', activity, { passive: true });
    const unsubscribe = useUIStore.subscribe(syncPaused);
    const timer = setInterval(() => {
      const state = useLibraryStore.getState();
      if (folder !== state.currentFolderPath) {
        folder = state.currentFolderPath;
        cursor = 0;
      }
      if (syncPaused() || state.isViewLoading || state.isDiscovering) return;
      const paths = state.imageList.slice(cursor, cursor + 4).map((image) => image.path);
      cursor += paths.length;
      if (paths.length) void invoke('update_thumbnail_queue', { paths, background: true }).catch(console.error);
      for (const [path, time] of pending.current) if (Date.now() - time > 30_000) pending.current.delete(path);
    }, 1500);
    return () => {
      clearInterval(timer);
      unsubscribe();
      document.removeEventListener('wheel', activity);
      document.removeEventListener('pointerdown', activity);
    };
  }, []);
  return { requestThumbnails, clearThumbnailQueue, markGenerated };
}
