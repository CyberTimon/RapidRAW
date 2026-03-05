import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../components/ui/AppProperties';
import { useRefreshImageList } from './useRefreshImageList';
import { useAppState } from '../../context/ContextProviders';

export function useHandleSaveCollage() {
  const { setError } = useAppState();
  const refreshImageList = useRefreshImageList();

  const handleSaveCollage = async (base64Data: string, firstPath: string): Promise<string> => {
    try {
      const savedPath: string = await invoke(Invokes.SaveCollage, {
        base64Data,
        firstPathStr: firstPath,
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save collage:', err);
      setError(`Failed to save collage: ${err}`);
      throw err;
    }
  };

  return handleSaveCollage;
}
