import { useAppState } from '../../context/ContextProviders';
import { useHandleMultiselectClick } from './useHandleMultiSelectClick';

export function useHandleLibraryImageSingleClick() {
  const { libraryActivePath, setMultiSelectedPaths, setLibraryActivePath } = useAppState();
  const handleMultiSelectClick = useHandleMultiselectClick();

  const handleLibraryImageSingleClick = (path: string, event: any) => {
    handleMultiSelectClick(path, event, {
      shiftAnchor: libraryActivePath,
      updateLibraryActivePath: true,
      onSimpleClick: (p: any) => {
        setMultiSelectedPaths([p]);
        setLibraryActivePath(p);
      },
    });
  };

  return handleLibraryImageSingleClick;
}
