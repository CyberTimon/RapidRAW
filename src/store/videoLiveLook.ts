import { animatedValues, lookValueAt } from '../utils/video/lookAnimation';
import { hasLook, locateItem, lookOf } from '../utils/video/model';
import { useEditorStore } from './useEditorStore';
import { editorLookTime, getVideo, syncedEditorLook, useVideoStore } from './useVideoStore';

const PLAYING_INTERVAL_MS = 80;
const NO_VALUES = new Map<string, number>();

let values = NO_VALUES;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRun = 0;
const listeners = new Set<() => void>();

export const shownLookValues = () => {
  const { project, editorItemId, playhead, session } = getVideo();
  const item = session?.kind === 'project' && project ? locateItem(project, editorItemId)?.item : null;
  if (!project || !item || !hasLook(item)) return NO_VALUES;
  const look = lookOf(project, item);
  if (!look) return NO_VALUES;
  const shown = animatedValues(look, editorLookTime(project, item, playhead));
  const synced = syncedEditorLook(item.id);
  const edited = useEditorStore.getState().adjustments;
  if (synced && synced !== edited) {
    shown.forEach((_, path) => {
      if (lookValueAt(edited, path) !== lookValueAt(synced, path)) shown.delete(path);
    });
  }
  return shown;
};

const differs = (next: Map<string, number>) =>
  next.size !== values.size || [...next].some(([path, value]) => values.get(path) !== value);

const update = () => {
  timer = null;
  lastRun = performance.now();
  const next = shownLookValues();
  if (!differs(next)) return;
  values = next;
  listeners.forEach((listener) => listener());
};

const schedule = () => {
  if (timer !== null || listeners.size === 0) return;
  const wait = getVideo().isPlaying ? Math.max(0, lastRun + PLAYING_INTERVAL_MS - performance.now()) : 0;
  timer = setTimeout(update, wait);
};

export const liveLookValue = (path: string) => values.get(path);

export const subscribeLiveLook = (listener: () => void) => {
  if (listeners.size === 0) values = shownLookValues();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

useVideoStore.subscribe((state, prev) => {
  if (
    state.playhead !== prev.playhead ||
    state.project !== prev.project ||
    state.editorItemId !== prev.editorItemId ||
    state.session !== prev.session
  ) {
    schedule();
  }
});

useEditorStore.subscribe((state, prev) => {
  if (state.adjustments !== prev.adjustments) schedule();
});
