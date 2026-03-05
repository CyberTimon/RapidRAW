import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useAppState } from '../../context/ContextProviders';
import { useSetAdjustments } from './useSetAdjustments';

interface LutData {
  size: number;
}

export function useHandleLutSelect() {
  const { setError } = useAppState();
  const setAdjustments = useSetAdjustments();

  const handleLutSelect = useCallback(
    async (path: string) => {
      try {
        const result: LutData = await invoke('load_and_parse_lut', { path });
        const name = path.split(/[\\/]/).pop() || 'LUT';
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          sectionVisibility: {
            ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
            effects: true,
          },
        }));
      } catch (err) {
        console.error('Failed to load or parse LUT:', err);
        setError(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments],
  );

  return handleLutSelect;
}
