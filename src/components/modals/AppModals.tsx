import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../store/useUIStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useEditorStore } from '../../store/useEditorStore';
import CopyPasteSettingsModal from './CopyPasteSettingsModal';
import PanoramaModal from './PanoramaModal';
import HdrModal from './HdrModal';
import NegativeConversionModal from './NegativeConversionModal';
import DenoiseModal from './DenoiseModal';
import CreateFolderModal from './CreateFolderModal';
import RenameFolderModal from './RenameFolderModal';
import RenameFileModal from './RenameFileModal';
import ConfirmModal from './ConfirmModal';
import ImportSettingsModal from './ImportSettingsModal';
import CullingModal from './CullingModal';
import CollageModal from './CollageModal';
import { AppSettings } from '../ui/AppProperties';
import { CopyPasteSettings } from '../../utils/adjustments';

export interface AppModalsProps {
  handleImageSelect: (path: string) => void;
  handleSavePanorama: () => Promise<string>;
  handleStartPanorama: (paths: string[]) => void;
  handleSaveHdr: () => Promise<string>;
  handleStartHdr: (paths: string[]) => void;
  refreshImageList: () => Promise<void>;
  handleApplyDenoise: (intensity: number, method: 'ai' | 'bm3d') => Promise<void>;
  handleBatchDenoise: (intensity: number, method: 'ai' | 'bm3d', paths: string[]) => Promise<string[]>;
  handleSaveDenoisedImage: () => Promise<string>;
  handleCreateFolder: (folderName: string) => Promise<void>;
  handleRenameFolder: (newName: string) => Promise<void>;
  handleSaveRename: (nameTemplate: string) => Promise<void>;
  handleStartImport: (settings: any) => Promise<void>;
  handleSetColorLabel: (color: string | null, paths?: string[]) => Promise<void>;
  handleRate: (rating: number, paths?: string[]) => void;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleSaveCollage: (base64Data: string, firstPath: string) => Promise<string>;
}

export default function AppModals(props: AppModalsProps) {
  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    isCreateFolderModalOpen,
    isRenameFolderModalOpen,
    isRenameFileModalOpen,
    isImportModalOpen,
    isCopyPasteSettingsModalOpen,
    folderActionTarget,
    renameTargetPaths,
    importSourcePaths,
    confirmModalState,
    panoramaModalState,
    hdrModalState,
    negativeModalState,
    denoiseModalState,
    cullingModalState,
    collageModalState,
    setUI,
  } = useUIStore(
    useShallow((state) => ({
      isCreateFolderModalOpen: state.isCreateFolderModalOpen,
      isRenameFolderModalOpen: state.isRenameFolderModalOpen,
      isRenameFileModalOpen: state.isRenameFileModalOpen,
      isImportModalOpen: state.isImportModalOpen,
      isCopyPasteSettingsModalOpen: state.isCopyPasteSettingsModalOpen,
      folderActionTarget: state.folderActionTarget,
      renameTargetPaths: state.renameTargetPaths,
      importSourcePaths: state.importSourcePaths,
      confirmModalState: state.confirmModalState,
      panoramaModalState: state.panoramaModalState,
      hdrModalState: state.hdrModalState,
      negativeModalState: state.negativeModalState,
      denoiseModalState: state.denoiseModalState,
      cullingModalState: state.cullingModalState,
      collageModalState: state.collageModalState,
      setUI: state.setUI,
    })),
  );

  const { thumbnails, aiModelDownloadStatus } = useProcessStore(
    useShallow((state) => ({
      thumbnails: state.thumbnails,
      aiModelDownloadStatus: state.aiModelDownloadStatus,
    })),
  );

  const { selectedImage, finalPreviewUrl } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      finalPreviewUrl: state.finalPreviewUrl,
    })),
  );

  const closeConfirmModal = () => {
    setUI((state) => ({ confirmModalState: { ...state.confirmModalState, isOpen: false } }));
  };

  return (
    <>
      <CopyPasteSettingsModal
        isOpen={isCopyPasteSettingsModalOpen}
        onClose={() => setUI({ isCopyPasteSettingsModalOpen: false })}
        settings={appSettings?.copyPasteSettings as CopyPasteSettings}
        onSave={(newSettings) =>
          handleSettingsChange({ ...appSettings, copyPasteSettings: newSettings } as AppSettings)
        }
      />
      <PanoramaModal
        error={panoramaModalState.error}
        finalImageBase64={panoramaModalState.finalImageBase64}
        imageCount={panoramaModalState.stitchingSourcePaths.length}
        isOpen={panoramaModalState.isOpen}
        isProcessing={panoramaModalState.isProcessing}
        loadingImageUrl={
          panoramaModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                panoramaModalState.stitchingSourcePaths[Math.floor(panoramaModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setUI({
            panoramaModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              error: null,
              stitchingSourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSavePanorama}
        onStitch={() => props.handleStartPanorama(panoramaModalState.stitchingSourcePaths)}
        progressMessage={panoramaModalState.progressMessage}
      />
      <HdrModal
        error={hdrModalState.error}
        finalImageBase64={hdrModalState.finalImageBase64}
        imageCount={hdrModalState.stitchingSourcePaths.length}
        isOpen={hdrModalState.isOpen}
        isProcessing={hdrModalState.isProcessing}
        loadingImageUrl={
          hdrModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                hdrModalState.stitchingSourcePaths[Math.floor(hdrModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setUI({
            hdrModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              error: null,
              stitchingSourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSaveHdr}
        onMerge={() => props.handleStartHdr(hdrModalState.stitchingSourcePaths)}
        progressMessage={hdrModalState.progressMessage}
      />
      <NegativeConversionModal
        isOpen={negativeModalState.isOpen}
        onClose={() => setUI((state) => ({ negativeModalState: { ...state.negativeModalState, isOpen: false } }))}
        targetPaths={negativeModalState.targetPaths}
        onSave={(savedPaths) => {
          props.refreshImageList().then(() => {
            if (selectedImage && negativeModalState.targetPaths.includes(selectedImage.path) && savedPaths.length > 0) {
              props.handleImageSelect(savedPaths[0]);
            }
          });
        }}
      />
      <DenoiseModal
        isOpen={denoiseModalState.isOpen}
        onClose={() => setUI((state) => ({ denoiseModalState: { ...state.denoiseModalState, isOpen: false } }))}
        onDenoise={props.handleApplyDenoise}
        onBatchDenoise={props.handleBatchDenoise}
        onSave={props.handleSaveDenoisedImage}
        onOpenFile={props.handleImageSelect}
        previewBase64={denoiseModalState.previewBase64}
        originalBase64={denoiseModalState.originalBase64 || null}
        isProcessing={denoiseModalState.isProcessing}
        error={denoiseModalState.error}
        progressMessage={denoiseModalState.progressMessage}
        aiModelDownloadStatus={aiModelDownloadStatus}
        isRaw={denoiseModalState.isRaw}
        targetPaths={denoiseModalState.targetPaths}
        loadingImageUrl={
          denoiseModalState.targetPaths.length > 0
            ? thumbnails[denoiseModalState.targetPaths[0]] ||
              (selectedImage?.path === denoiseModalState.targetPaths[0] ? finalPreviewUrl : null)
            : null
        }
      />
      <CreateFolderModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setUI({ isCreateFolderModalOpen: false })}
        onSave={props.handleCreateFolder}
      />
      <RenameFolderModal
        currentName={folderActionTarget ? folderActionTarget.split(/[\\/]/).pop() : ''}
        isOpen={isRenameFolderModalOpen}
        onClose={() => setUI({ isRenameFolderModalOpen: false })}
        onSave={props.handleRenameFolder}
      />
      <RenameFileModal
        filesToRename={renameTargetPaths}
        isOpen={isRenameFileModalOpen}
        onClose={() => setUI({ isRenameFileModalOpen: false })}
        onSave={props.handleSaveRename}
      />
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <ImportSettingsModal
        fileCount={importSourcePaths.length}
        isOpen={isImportModalOpen}
        onClose={() => setUI({ isImportModalOpen: false })}
        onSave={props.handleStartImport}
      />
      <CullingModal
        isOpen={cullingModalState.isOpen}
        onClose={() =>
          setUI({
            cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
          })
        }
        progress={cullingModalState.progress}
        suggestions={cullingModalState.suggestions}
        error={cullingModalState.error}
        imagePaths={cullingModalState.pathsToCull}
        thumbnails={thumbnails}
        onApply={(action, paths) => {
          if (action === 'reject') {
            props.handleSetColorLabel('red', paths);
          } else if (action === 'rate_zero') {
            props.handleRate(1, paths);
          } else if (action === 'delete') {
            props.executeDelete(paths, { includeAssociated: false });
          }
          setUI({
            cullingModalState: { isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] },
          });
        }}
        onError={(err) => {
          setUI((state) => ({ cullingModalState: { ...state.cullingModalState, error: err, progress: null } }));
        }}
      />
      <CollageModal
        isOpen={collageModalState.isOpen}
        onClose={() => setUI({ collageModalState: { isOpen: false, sourceImages: [] } })}
        onSave={props.handleSaveCollage}
        sourceImages={collageModalState.sourceImages}
        thumbnails={thumbnails}
      />
    </>
  );
}
