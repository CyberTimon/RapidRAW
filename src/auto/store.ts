import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_OPTIONS,
  type AutoAdjustmentFamilies,
  type AutoOptions,
  type Controls,
  type AutoProgress,
} from './types';
interface AutoState {
  open: boolean;
  options: AutoOptions;
  lastBatchId: string | null;
  progress: AutoProgress | null;
  canRetune: boolean;
  pending: boolean;
  setAuto: (value: Partial<AutoState>) => void;
}
type PersistedAutoState = Partial<AutoState> & {
  options?: Partial<AutoOptions> & {
    controls?: Partial<Controls>;
    adjustments?: Partial<AutoAdjustmentFamilies>;
  };
};

export function migrateAutoState(persisted: unknown) {
  const saved = persisted && typeof persisted === 'object' ? (persisted as PersistedAutoState) : {};
  return {
    lastBatchId: typeof saved.lastBatchId === 'string' ? saved.lastBatchId : null,
    options: {
      ...DEFAULT_OPTIONS,
      ...(saved.options || {}),
      controls: { ...DEFAULT_OPTIONS.controls, ...(saved.options?.controls || {}) },
      adjustments: { ...DEFAULT_OPTIONS.adjustments, ...(saved.options?.adjustments || {}) },
      groups: saved.options?.groups || {},
    },
  };
}

export const useAutoStore = create<AutoState>()(
  persist(
    (set) => ({
      open: false,
      options: DEFAULT_OPTIONS,
      lastBatchId: null,
      progress: null,
      canRetune: true,
      pending: false,
      setAuto: (value) => set(value),
    }),
    {
      name: 'rapidraw-scene-auto-v1',
      version: 2,
      migrate: migrateAutoState,
      partialize: ({ options, lastBatchId }) => ({ options, lastBatchId }),
    },
  ),
);
