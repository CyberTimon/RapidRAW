import { invoke } from '@tauri-apps/api/core';
import { Invokes, ImageFile } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleSelectSubfolder } from './useHandleSelectSubfolder';
import { useHandleSettingsChange } from './useHandleSettingsChange';
import { useHandleGoHome } from './useHandleGoHome';

export function useHandleContinueSession() {
  const { appSettings, setRootPath, setExpandedFolders, setIsTreeLoading, preloadedDataRef, setFolderTree, setError } =
    useAppState();

  const handleSelectSubfolder = useHandleSelectSubfolder();
  const handleSettingsChange = useHandleSettingsChange();
  const handleGoHome = useHandleGoHome();

  const handleContinueSession = () => {
    const restore = async () => {
      if (!appSettings?.lastRootPath) {
        return;
      }

      const root = appSettings.lastRootPath;
      const folderState = appSettings.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || root;

      setRootPath(root);

      if (folderState?.expandedFolders) {
        const newExpandedFolders = new Set(folderState.expandedFolders);
        newExpandedFolders.add(root);
        setExpandedFolders(newExpandedFolders);
      } else {
        setExpandedFolders(new Set([root]));
      }

      setIsTreeLoading(true);
      try {
        let treeData;
        if (preloadedDataRef.current.rootPath === root && preloadedDataRef.current.tree) {
          treeData = await preloadedDataRef.current.tree;
          console.log('Preload cache hit for folder tree.');
        } else {
          treeData = await invoke(Invokes.GetFolderTree, { path: root });
        }
        setFolderTree(treeData);
      } catch (err) {
        console.error('Failed to restore folder tree:', err);
      } finally {
        setIsTreeLoading(false);
      }

      let preloadedImages: ImageFile[] | undefined = undefined;
      if (preloadedDataRef.current.currentPath === pathToSelect && preloadedDataRef.current.images) {
        try {
          preloadedImages = await preloadedDataRef.current.images;
          console.log('Preload cache hit for image list.');
        } catch (e) {
          console.error('Failed to retrieve preloaded images', e);
        }
      }

      await handleSelectSubfolder(pathToSelect, false, preloadedImages);
    };
    restore().catch((err) => {
      console.error('Failed to restore session, folder might be missing:', err);
      setError('Failed to restore session. The last used folder may have been moved or deleted.');
      if (appSettings) {
        handleSettingsChange({ ...appSettings, lastRootPath: null, lastFolderState: null });
      }
      handleGoHome();
      setIsTreeLoading(false);
    });
  };

  return handleContinueSession;
}
