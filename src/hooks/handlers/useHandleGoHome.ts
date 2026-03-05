import { useAppState } from '../../context/ContextProviders';

export function useHandleGoHome() {
  const {
    setRootPath,
    setCurrentFolderPath,
    setImageList,
    setImageRatings,
    setFolderTree,
    setMultiSelectedPaths,
    setLibraryActivePath,
    setIsLibraryExportPanelVisible,
    setExpandedFolders,
  } = useAppState();

  const handleGoHome = () => {
    setRootPath(null);
    setCurrentFolderPath(null);
    setImageList([]);
    setImageRatings({});
    setFolderTree(null);
    setMultiSelectedPaths([]);
    setLibraryActivePath(null);
    setIsLibraryExportPanelVisible(false);
    setExpandedFolders(new Set());
  };

  return handleGoHome;
}
