import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ImageFile, Invokes, LibraryDisplayMode } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useUIStore } from '../store/useUIStore';

const PRELOAD_DELAY_MS = 300;

function neighbours(list: ImageFile[], path: string): string[] {
  const index = list.findIndex((image) => image.path === path);
  if (index === -1 || list.length < 2) return [];
  const next = list[(index + 1) % list.length].path;
  const previous = list[(index - 1 + list.length) % list.length].path;
  return [...new Set([next, previous])].filter((p) => p !== path);
}

export function useAdjacentImagePreload(sortedImageList: ImageFile[]) {
  const inEditor = useUIStore((s) => s.activeView === 'editor');
  const inCulling = useSettingsStore((s) => s.appSettings?.libraryDisplayMode === LibraryDisplayMode.Cull);
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const isReady = useEditorStore((s) => s.selectedImage?.isReady ?? false);
  const listRef = useRef(sortedImageList);

  useEffect(() => {
    listRef.current = sortedImageList;
  }, [sortedImageList]);

  useEffect(() => {
    if (!(inEditor || inCulling) || !selectedPath || !isReady) return;
    const timer = setTimeout(() => {
      const paths = neighbours(listRef.current, selectedPath);
      if (paths.length > 0) {
        invoke(Invokes.PreloadImages, { paths }).catch((err) => console.warn('Preloading images failed:', err));
      }
    }, PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [inEditor, inCulling, selectedPath, isReady]);
}
