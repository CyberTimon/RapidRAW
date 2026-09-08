import { invoke } from '@tauri-apps/api/core';
import { useLibraryStore } from '../store/useLibraryStore';

let generation = 0;
let running = false;
const pending = new Set<string>();
const attempted = new Set<string>();
export function resetLibraryExifQueue() {
  generation += 1;
  pending.clear();
  attempted.clear();
}
export function requestLibraryExif(paths: string[]) {
  const images = new Map(useLibraryStore.getState().imageList.map((image) => [image.path, image]));
  for (const path of paths) {
    if (images.has(path) && !images.get(path)?.exif && !attempted.has(path)) pending.add(path);
  }
  void drain();
}
async function drain() {
  if (running) return;
  running = true;
  try {
    while (pending.size) {
      const token = generation;
      const paths = Array.from(pending).slice(0, 16);
      for (const path of paths) {
        pending.delete(path);
        attempted.add(path);
      }
      try {
        const metadata = await invoke<Record<string, Record<string, string>>>('read_exif_for_paths', { paths });
        if (token === generation)
          useLibraryStore.getState().setLibrary((state) => ({
            imageList: state.imageList.map((image) =>
              metadata[image.path] ? { ...image, exif: metadata[image.path] } : image,
            ),
          }));
      } catch (error) {
        console.error('Could not load visible image metadata', error);
      }
    }
  } finally {
    running = false;
  }
}
