import { invoke } from '@tauri-apps/api/core';
import { HdrModalState } from '../../App';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useRefreshImageList } from './useRefreshImageList';

export function useHandleSaveHdr() {
  const { hdrModalState, setHdrModalState } = useAppState();
  const refreshImageList = useRefreshImageList();

  const handleSaveHdr = async (): Promise<string> => {
    if (hdrModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for HDR not found.';
      setHdrModalState((prev: HdrModalState) => ({ ...prev, error: err }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SaveHdr, {
        firstPathStr: hdrModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save HDR image:', err);
      setHdrModalState((prev: HdrModalState) => ({ ...prev, error: String(err) }));
      throw err;
    }
  };

  return handleSaveHdr;
}
