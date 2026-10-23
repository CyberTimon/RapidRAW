import { create } from 'zustand';

import { useEditorStore } from './useEditorStore';
import { AnalysisRegion, DEFAULT_ANALYSIS_REGION } from '../utils/adjustments';

export { DEFAULT_ANALYSIS_REGION } from '../utils/adjustments';
export type { AnalysisRegion } from '../utils/adjustments';

export const getAnalysisRegion = () =>
  useEditorStore.getState().adjustments.negativeAnalysisRegion ?? DEFAULT_ANALYSIS_REGION;

const saveRegion = (region: AnalysisRegion) => {
  const editor = useEditorStore.getState();
  const adjustments = { ...editor.adjustments, negativeAnalysisRegion: region };
  editor.setEditor({
    adjustments,
    ...(editor.showOriginal ? { showOriginal: false, previewOverride: null } : {}),
  });
  editor.pushHistory(adjustments);
};

interface Point {
  x: number;
  y: number;
}
type Handle = 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se';
interface AnalysisState {
  draft: AnalysisRegion | null;
  editing: boolean;
  gesture: { start: Point; region: AnalysisRegion; handle: Handle; imagePath: string | null } | null;
  setEditing(editing: boolean): void;
  finishEditing(applyDraft: boolean): void;
  begin(point: Point, handle: Handle): void;
  move(point: Point): void;
  commit(): void;
  cancel(): void;
  reset(): void;
  closeWorkspace(): void;
}
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Only overlay visibility and unfinished gestures are transient. The applied region belongs to image adjustments.
export const useNegativeAnalysisStore = create<AnalysisState>((set, get) => ({
  draft: null,
  editing: false,
  gesture: null,
  setEditing: (editing) => set({ editing, draft: null, gesture: null }),
  finishEditing: (applyDraft) => {
    if (applyDraft) get().commit();
    get().setEditing(false);
  },
  begin: (start, handle) =>
    set({
      gesture: {
        start,
        handle,
        region: getAnalysisRegion(),
        imagePath: useEditorStore.getState().selectedImage?.path ?? null,
      },
      draft: handle === 'draw' ? { x: start.x, y: start.y, width: 0, height: 0 } : getAnalysisRegion(),
    }),
  move: (point) => {
    const gesture = get().gesture;
    if (!gesture || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const { start, region: r, handle } = gesture;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    if (handle === 'draw') {
      const end = { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) };
      set({
        draft: {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        },
      });
      return;
    }
    if (handle === 'move') {
      set({ draft: { ...r, x: clamp(r.x + dx, 0, 1 - r.width), y: clamp(r.y + dy, 0, 1 - r.height) } });
      return;
    }
    const left = handle.includes('w') ? clamp(r.x + dx, 0, r.x + r.width - 0.01) : r.x;
    const top = handle.includes('n') ? clamp(r.y + dy, 0, r.y + r.height - 0.01) : r.y;
    const right = handle.includes('e') ? clamp(r.x + r.width + dx, r.x + 0.01, 1) : r.x + r.width;
    const bottom = handle.includes('s') ? clamp(r.y + r.height + dy, r.y + 0.01, 1) : r.y + r.height;
    set({ draft: { x: left, y: top, width: right - left, height: bottom - top } });
  },
  commit: () => {
    const { draft, gesture } = get();
    set({ draft: null, gesture: null });
    if (
      draft &&
      gesture &&
      gesture.imagePath === (useEditorStore.getState().selectedImage?.path ?? null) &&
      gesture.region === getAnalysisRegion() &&
      (gesture.handle !== 'draw' || (draft.width >= 0.01 && draft.height >= 0.01))
    ) {
      saveRegion(draft);
    }
  },
  cancel: () => set({ draft: null, gesture: null }),
  reset: () => {
    set({ draft: null, gesture: null });
    saveRegion({ ...DEFAULT_ANALYSIS_REGION });
  },
  closeWorkspace: () => set({ editing: false, draft: null, gesture: null }),
}));

// Switching sources must never carry an unfinished rectangle onto another image.
useEditorStore.subscribe((state, previous) => {
  if (state.selectedImage?.path !== previous.selectedImage?.path) {
    useNegativeAnalysisStore.getState().cancel();
  }
});
