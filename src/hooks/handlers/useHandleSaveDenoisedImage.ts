import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useRefreshImageList } from './useRefreshImageList';

export function useHandleSaveDenoisedImage() {
  const { denoiseModalState } = useAppState();
  const refreshImageList = useRefreshImageList();

  const handleSaveDenoisedImage = async (): Promise<string> => {
    if (!denoiseModalState.targetPath) throw new Error('No target path');
    const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
      originalPathStr: denoiseModalState.targetPath,
    });
    await refreshImageList();
    return savedPath;
  };

  return handleSaveDenoisedImage;
}
