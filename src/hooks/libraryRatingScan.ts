import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useLibraryStore } from '../store/useLibraryStore';
import { applyRatingBatch, type RatingBatch } from '../utils/ratingUpdates';

let activeLoad = '';
let unsubscribe: UnlistenFn | undefined;
const overrides = new Set<string>();
export function beginLibraryLoad() {
  activeLoad = crypto.randomUUID();
  unsubscribe?.();
  unsubscribe = undefined;
  overrides.clear();
  useLibraryStore.getState().setLibrary({ ratingProgress: null });
  void invoke('cancel_rating_scan').catch(console.error);
  return activeLoad;
}
export function isCurrentLibraryLoad(id: string) {
  return activeLoad === id;
}
export function protectManualRatings(paths: string[]) {
  paths.forEach((path) => overrides.add(path));
}
export async function startLibraryRatingScan(id: string, paths: string[]) {
  if (!isCurrentLibraryLoad(id)) return;
  useLibraryStore
    .getState()
    .setLibrary({ ratingProgress: { scanId: id, checked: 0, total: paths.length, failed: 0, done: false } });
  let stop: UnlistenFn | undefined;
  try {
    stop = await listen<RatingBatch>('library-rating-batch', ({ payload }) => {
      if (!isCurrentLibraryLoad(id)) return;
      useLibraryStore
        .getState()
        .setLibrary(
          (state) =>
            applyRatingBatch(state.ratingProgress?.scanId, state.imageList, state.imageRatings, payload, overrides) ??
            {},
        );
    });
    if (!isCurrentLibraryLoad(id)) {
      stop();
      return;
    }
    unsubscribe = stop;
    await invoke('scan_library_ratings', { scanId: id, paths });
  } catch (error) {
    console.error('Rating scan failed', error);
    if (isCurrentLibraryLoad(id))
      useLibraryStore.getState().setLibrary((state) => ({
        ratingProgress: {
          scanId: id,
          checked: state.ratingProgress?.checked ?? 0,
          total: paths.length,
          failed: paths.length - (state.ratingProgress?.checked ?? 0) + (state.ratingProgress?.failed ?? 0),
          done: true,
        },
        imageList: state.imageList.map((image) =>
          image.rating_state === 'pending' ? { ...image, rating_state: 'failed' } : image,
        ),
      }));
  } finally {
    // Keep the current listener until navigation: the final event may arrive after the command reply.
    if (!isCurrentLibraryLoad(id)) stop?.();
  }
}
