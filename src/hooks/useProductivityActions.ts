import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'react-toastify';
import { MergeModalState, useUIStore } from '../store/useUIStore';
import { Invokes } from '../types/invokes';
import { MergePreview, MergeSettings } from '../types/library';

export function useProductivityActions(refreshImageList: () => Promise<void>) {
  const setUI = useUIStore((state) => state.setUI);
  const mergeRequest = useRef(0);

  const updateMerge = useCallback(
    (patch: Partial<MergeModalState>) => {
      setUI((state) => ({ mergeModalState: { ...state.mergeModalState, ...patch } }));
    },
    [setUI],
  );

  const handleStartMerge = useCallback(async () => {
    const request = ++mergeRequest.current;
    const { kind, settings, sourcePaths } = useUIStore.getState().mergeModalState;
    updateMerge({ error: null, isProcessing: true, isUpdatingPreview: false, preview: null, progressMessage: null });
    try {
      const preview: MergePreview = await invoke(Invokes.StartMerge, { kind, paths: sourcePaths, settings });
      if (request !== mergeRequest.current || !useUIStore.getState().mergeModalState.isOpen) return;
      updateMerge({ isProcessing: false, preview, progressMessage: null });
    } catch (err) {
      if (request !== mergeRequest.current || !useUIStore.getState().mergeModalState.isOpen) return;
      updateMerge({ error: String(err), isProcessing: false, progressMessage: null });
    }
  }, [updateMerge]);

  const handleMergeSettingsChange = useCallback(
    async (settings: MergeSettings) => {
      const request = ++mergeRequest.current;
      const previousSettings = useUIStore.getState().mergeModalState.settings;
      updateMerge({ isUpdatingPreview: true, settings });
      try {
        const preview: MergePreview = await invoke(Invokes.UpdateMergePreview, { settings });
        if (request !== mergeRequest.current) return;
        updateMerge({ isUpdatingPreview: false, preview });
      } catch (err) {
        if (request !== mergeRequest.current) return;
        console.error('Failed to update the merge preview:', err);
        toast.error(String(err));
        updateMerge({ isUpdatingPreview: false, settings: previousSettings });
      }
    },
    [updateMerge],
  );

  const handleSaveMerge = useCallback(async (): Promise<string> => {
    const { settings } = useUIStore.getState().mergeModalState;
    try {
      const savedPath: string = await invoke(Invokes.SaveMerge, { settings });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save the merged image:', err);
      updateMerge({ error: String(err) });
      throw err;
    }
  }, [refreshImageList, updateMerge]);

  const handleSaveCollage = useCallback(
    async (base64Data: string, firstPath: string): Promise<string> => {
      try {
        const savedPath: string = await invoke(Invokes.SaveCollage, { base64Data, firstPathStr: firstPath });
        await refreshImageList();
        return savedPath;
      } catch (err) {
        console.error('Failed to save collage:', err);
        throw err;
      }
    },
    [refreshImageList],
  );

  return {
    handleMergeSettingsChange,
    handleSaveCollage,
    handleSaveMerge,
    handleStartMerge,
  };
}
