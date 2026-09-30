import { useEffect, useRef, type RefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { Invokes, type ImageFile } from '../components/ui/AppProperties';

// Let the opened photo's first renders run before background decoding starts.
const PREFETCH_DELAY_MS = 400;

const sourceOf = (path: string) => path.split('?vc=')[0];

// Each request cancels the running decode, so only send a changed list.
function requestPrefetch(lastRequest: RefObject<string>, paths: string[]) {
  const key = paths.join('\n');
  if (key === lastRequest.current) return;
  lastRequest.current = key;
  invoke(Invokes.PrefetchImages, { paths }).catch((error) =>
    console.warn('Could not prefetch neighbouring photos:', error),
  );
}

/**
 * Decodes the photos on either side of the one open in the editor, favouring
 * the direction of travel, so stepping through a folder skips the RAW decode.
 */
export function useNeighborPrefetch(sortedImageList: ImageFile[]) {
  const selectedPath = useEditorStore((state) => state.selectedImage?.path ?? null);
  const isReady = useEditorStore((state) => !!state.selectedImage?.isReady);
  const isEditor = useUIStore((state) => state.activeView === 'editor');
  const lastIndexRef = useRef<number | null>(null);
  const movingBackRef = useRef(false);
  const lastRequestRef = useRef('');

  useEffect(() => {
    if (!isEditor || !selectedPath) {
      lastIndexRef.current = null;
      requestPrefetch(lastRequestRef, []);
      return;
    }
    if (!isReady) return;

    const count = sortedImageList.length;
    const index = sortedImageList.findIndex((image) => image.path === selectedPath);
    if (index === -1 || count < 2) return;
    const lastIndex = lastIndexRef.current;
    if (lastIndex !== null && lastIndex !== index) {
      movingBackRef.current = index === (lastIndex - 1 + count) % count;
    }
    lastIndexRef.current = index;

    const at = (offset: number) => sortedImageList[(index + offset + count) % count].path;
    const current = sourceOf(selectedPath);
    const candidates = movingBackRef.current ? [at(-1), at(1)] : [at(1), at(-1)];
    const paths = candidates.filter(
      (path, i) => sourceOf(path) !== current && candidates.findIndex((p) => sourceOf(p) === sourceOf(path)) === i,
    );

    const timer = setTimeout(() => requestPrefetch(lastRequestRef, paths), PREFETCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isEditor, selectedPath, isReady, sortedImageList]);
}
