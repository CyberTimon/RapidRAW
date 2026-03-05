import { invoke } from '@tauri-apps/api/core';
import { PanoramaModalState } from '../../App';
import { Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useRefreshImageList } from './useRefreshImageList';

export function useHandleSavePanorama() {
  const { panoramaModalState, setPanoramaModalState } = useAppState();
  const refreshImageList = useRefreshImageList();

  const handleSavePanorama = async (): Promise<string> => {
    if (panoramaModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      setPanoramaModalState((prev: PanoramaModalState) => ({ ...prev, error: err }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: panoramaModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      setPanoramaModalState((prev: PanoramaModalState) => ({ ...prev, error: String(err) }));
      throw err;
    }
  };

  return handleSavePanorama;
}
