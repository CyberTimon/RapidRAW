import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_OPTIONS, type AutoOptions, type AutoProgress } from './types';
interface AutoState {
  enabled: boolean;
  open: boolean;
  options: AutoOptions;
  lastBatchId: string | null;
  progress: AutoProgress | null;
  pending: boolean;
  setAuto: (value: Partial<AutoState>) => void;
}
export const useAutoStore = create<AutoState>()(
  persist(
    (set) => ({
      enabled: false,
      open: false,
      options: DEFAULT_OPTIONS,
      lastBatchId: null,
      progress: null,
      pending: false,
      setAuto: (value) => set(value),
    }),
    {
      name: 'rapidraw-scene-auto-v1',
      version: 1,
      partialize: ({ enabled, options, lastBatchId }) => ({ enabled, options, lastBatchId }),
    },
  ),
);
