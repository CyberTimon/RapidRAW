import { useBloc } from '@blac/react';
import { ModalBloc } from '../../blocs/app/ModalBloc';
import { ConfirmModal } from '../../primitives/Modal';
import { RenameFileModal } from './RenameFileModal';
import { CreateFolderModal } from './CreateFolderModal';
import { RenameFolderModal } from './RenameFolderModal';
import { RenamePresetModal } from './RenamePresetModal';
import { AddPresetModal } from './AddPresetModal';
import { ImportSettingsModal } from './ImportSettingsModal';
import { CopyPasteSettingsModal } from './CopyPasteSettingsModal';
import { DenoiseModal } from './DenoiseModal';
import { CullingModal } from './CullingModal';
import { CollageModal } from './CollageModal';
import { PanoramaModal } from './PanoramaModal';
import { ExportProgressModal } from './ExportProgressModal';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { AboutModal } from './AboutModal';

export function ModalRenderer() {
  const [state, modalBloc] = useBloc(ModalBloc);
  const confirmData = state.modalData['confirm'];

  return (
    <>
      {/* Confirm modal (special case - uses ConfirmModal primitive) */}
      <ConfirmModal
        isOpen={state.openModals.includes('confirm')}
        onClose={() => {
          confirmData?.onCancel?.();
          modalBloc.close('confirm');
        }}
        onConfirm={() => {
          confirmData?.onConfirm?.();
        }}
        title={confirmData?.title ?? ''}
        message={confirmData?.message ?? ''}
        confirmText={confirmData?.confirmText}
        cancelText={confirmData?.cancelText}
        confirmVariant={confirmData?.confirmVariant}
      />

      {/* File/Folder modals */}
      <RenameFileModal />
      <CreateFolderModal />
      <RenameFolderModal />

      {/* Preset modals */}
      <RenamePresetModal />
      <AddPresetModal />

      {/* Settings modals */}
      <ImportSettingsModal />
      <CopyPasteSettingsModal />

      {/* Processing modals */}
      <DenoiseModal />
      <CullingModal />
      <CollageModal />
      <PanoramaModal />

      {/* Utility modals */}
      <ExportProgressModal />
      <KeyboardShortcutsModal />
      <AboutModal />
    </>
  );
}
