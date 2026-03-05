import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { useExecuteDelete } from './useExecuteDelete';

export function useHandleDeleteSelected() {
  const { multiSelectedPaths, imageList, setConfirmModalState } = useAppState();
  const executeDelete = useExecuteDelete();

  const handleDeleteSelected = useCallback(() => {
    const pathsToDelete = multiSelectedPaths;
    if (pathsToDelete.length === 0) {
      return;
    }

    const isSingle = pathsToDelete.length === 1;

    const selectionHasVirtualCopies =
      isSingle &&
      !pathsToDelete[0].includes('?vc=') &&
      imageList.some((image) => image.path.startsWith(`${pathsToDelete[0]}?vc=`));

    let modalTitle = 'Confirm Delete';
    let modalMessage = '';
    let confirmText = 'Delete';

    if (selectionHasVirtualCopies) {
      modalTitle = 'Delete Image and All Virtual Copies?';
      modalMessage = `Are you sure you want to permanently delete this image and all of its virtual copies? This action cannot be undone.`;
      confirmText = 'Delete All';
    } else if (isSingle) {
      modalMessage = `Are you sure you want to permanently delete this image? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
      confirmText = 'Delete Selected Only';
    } else {
      modalMessage = `Are you sure you want to permanently delete these ${pathsToDelete.length} images? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
      confirmText = 'Delete Selected Only';
    }

    setConfirmModalState({
      confirmText,
      confirmVariant: 'destructive',
      isOpen: true,
      message: modalMessage,
      onConfirm: () => executeDelete(pathsToDelete, { includeAssociated: false }),
      title: modalTitle,
    });
  }, [multiSelectedPaths, executeDelete, imageList]);

  return handleDeleteSelected;
}
