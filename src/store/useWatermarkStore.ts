import { create } from 'zustand';
import { DEFAULT_WATERMARK, ExportLayout, WatermarkState } from '../utils/watermark';

interface WatermarkStore {
  watermark: WatermarkState;
  exportLayout: ExportLayout | null;
  setWatermark(patch: Partial<WatermarkState>): void;
  setExportLayout(layout: ExportLayout | null): void;
}

export const useWatermarkStore = create<WatermarkStore>((set, get) => ({
  watermark: DEFAULT_WATERMARK,
  exportLayout: null,
  setWatermark: (patch) => set((state) => ({ watermark: { ...state.watermark, ...patch } })),
  setExportLayout: (layout) => {
    if (JSON.stringify(get().exportLayout) !== JSON.stringify(layout)) set({ exportLayout: layout });
  },
}));
