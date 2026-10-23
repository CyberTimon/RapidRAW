import { create } from 'zustand';

export interface AnalysisRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}
export const DEFAULT_ANALYSIS_REGION: AnalysisRegion = { x: 0.12, y: 0.12, width: 0.76, height: 0.76 };
type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';
interface AnalysisState {
  region: AnalysisRegion;
  draft: AnalysisRegion | null;
  editing: boolean;
  gesture: { start: Point; region: AnalysisRegion; handle: Handle } | null;
  setEditing(editing: boolean): void;
  begin(point: Point, handle: Handle): void;
  move(point: Point): void;
  commit(): void;
  cancel(): void;
  reset(): void;
  closeWorkspace(): void;
}
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// Deliberately separate from adjustments: never copied to a sidecar, history, or preset.
export const useNegativeAnalysisStore = create<AnalysisState>((set, get) => ({
  region: DEFAULT_ANALYSIS_REGION,
  draft: null,
  editing: false,
  gesture: null,
  setEditing: (editing) => set({ editing, draft: null, gesture: null }),
  begin: (start, handle) => set({ gesture: { start, handle, region: get().region }, draft: get().region }),
  move: (point) => {
    const gesture = get().gesture;
    if (!gesture || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const { start, region: r, handle } = gesture;
    const dx = point.x - start.x;
    const dy = point.y - start.y;
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
  commit: () => set((s) => ({ region: s.draft ?? s.region, draft: null, gesture: null })),
  cancel: () => set({ draft: null, gesture: null }),
  reset: () => set({ region: { ...DEFAULT_ANALYSIS_REGION }, draft: null, gesture: null }),
  closeWorkspace: () => set({ region: { ...DEFAULT_ANALYSIS_REGION }, editing: false, draft: null, gesture: null }),
}));

// Render/export payloads use the same source proportions. Persistent adjustments remain untouched.
export const withAnalysisRegion = <T extends object>(adjustments: T) => ({
  ...adjustments,
  negativeAnalysisRegion: useNegativeAnalysisStore.getState().region,
});
