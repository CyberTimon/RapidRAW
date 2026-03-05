import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleToggleFullScreen() {
  const { isFullScreen, setIsFullScreen, selectedImage } = useAppState();

  const handleToggleFullScreen = useCallback(() => {
    if (isFullScreen) {
      setIsFullScreen(false);
    } else {
      if (!selectedImage) {
        return;
      }
      setIsFullScreen(true);
    }
  }, [isFullScreen, selectedImage]);

  return handleToggleFullScreen;
}
