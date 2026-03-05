import { useAppState } from '../../context/ContextProviders';
import { useHandleImageSelect } from './useHandleImageSelect';
import { useHandleMultiselectClick } from './useHandleMultiSelectClick';

export function useHandleImageClick() {
  const { selectedImage, libraryActivePath } = useAppState();
  const handleMultiSelectClick = useHandleMultiselectClick();
  const handleImageSelect = useHandleImageSelect();

  const handleImageClick = (path: string, event: any) => {
    const inEditor = !!selectedImage;
    handleMultiSelectClick(path, event, {
      shiftAnchor: inEditor ? selectedImage.path : libraryActivePath,
      updateLibraryActivePath: !inEditor,
      onSimpleClick: handleImageSelect,
    });
  };

  return handleImageClick;
}
