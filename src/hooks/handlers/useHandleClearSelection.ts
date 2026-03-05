import { useAppState } from '../../context/ContextProviders';

export function useHandleClearSelection() {
  const { selectedImage, setMultiSelectedPaths, setLibraryActivePath } = useAppState();

  const handleClearSelection = () => {
    if (selectedImage) {
      setMultiSelectedPaths([selectedImage.path]);
    } else {
      setMultiSelectedPaths([]);
      setLibraryActivePath(null);
    }
  };

  return handleClearSelection;
}
