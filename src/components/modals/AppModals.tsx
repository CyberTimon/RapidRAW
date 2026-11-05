import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useProcessStore } from '../../store/useProcessStore';
import CopyPasteSettingsModal from './CopyPasteSettingsModal';
import PanoramaModal from './PanoramaModal';
import HdrModal from './HdrModal';
import FocusStackModal from './FocusStackModal';
import CreateFolderModal from './CreateFolderModal';
import RenameFolderModal from './RenameFolderModal';
import RenameFileModal from './RenameFileModal';
import ConfirmModal from './ConfirmModal';
import ImportSettingsModal from './ImportSettingsModal';
import CullingModal from './CullingModal';
import CollageModal from './CollageModal';
import { AppSettings, Invokes, ImageFlag, AlbumItem, Album, AlbumGroup } from '../ui/AppProperties';
import { CopyPasteSettings } from '../../utils/adjustments';

export interface AppModalsProps {
  handleImageSelect: (path: string) => void;
  handleSavePanorama: () => Promise<string>;
  handleStartPanorama: (paths: string[]) => void;
  handleSaveHdr: () => Promise<string>;
  handleStartHdr: (paths: string[]) => void;
  handleStartFocusStack: (paths: string[]) => void;
  handleSaveFocusStack: () => Promise<string>;
  handleCreateFolder: (folderName: string) => Promise<void>;
  handleRenameFolder: (newName: string) => Promise<void>;
  handleSaveRename: (nameTemplate: string) => Promise<void>;
  handleStartImport: (settings: any) => Promise<void>;
  handleSetFlag: (flag: ImageFlag | null, paths?: string[]) => void;
  handleRate: (rating: number, paths?: string[]) => void;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleSaveCollage: (base64Data: string, firstPath: string) => Promise<string>;
  handleCreateAlbumItem: (name: string, type: 'album' | 'group') => Promise<void>;
  handleRenameAlbumItem: (newName: string) => Promise<void>;
}

export default function AppModals(props: AppModalsProps) {
  const { t } = useTranslation();
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
    isCreateAlbumModalOpen,
    isCreateAlbumGroupModalOpen,
    isRenameAlbumModalOpen,
    albumActionTarget,
    confirmModalState,
    panoramaModalState,
    hdrModalState,
    focusStackModalState,
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
      isCreateAlbumModalOpen: state.isCreateAlbumModalOpen,
      isCreateAlbumGroupModalOpen: state.isCreateAlbumGroupModalOpen,
      isRenameAlbumModalOpen: state.isRenameAlbumModalOpen,
      albumActionTarget: state.albumActionTarget,
      confirmModalState: state.confirmModalState,
      panoramaModalState: state.panoramaModalState,
      hdrModalState: state.hdrModalState,
      focusStackModalState: state.focusStackModalState,
      cullingModalState: state.cullingModalState,
      collageModalState: state.collageModalState,
      setUI: state.setUI,
    })),
  );

  const middlePath = (paths: string[]) => (paths.length > 0 ? paths[Math.floor(paths.length / 2)] : null);
  const panoramaLoadingPath = middlePath(panoramaModalState.stitchingSourcePaths);
  const hdrLoadingPath = middlePath(hdrModalState.stitchingSourcePaths);
  const focusStackLoadingPath = middlePath(focusStackModalState.sourcePaths);

  const { panoramaThumbnail, hdrThumbnail, focusStackThumbnail } = useProcessStore(
    useShallow((state) => ({
      panoramaThumbnail: panoramaLoadingPath ? state.thumbnails[panoramaLoadingPath] : undefined,
      hdrThumbnail: hdrLoadingPath ? state.thumbnails[hdrLoadingPath] : undefined,
      focusStackThumbnail: focusStackLoadingPath ? state.thumbnails[focusStackLoadingPath] : undefined,
    })),
  );

  const closeConfirmModal = () => {
    setUI((state) => ({ confirmModalState: { ...state.confirmModalState, isOpen: false } }));
  };

  const currentAlbumData = (() => {
    if (!albumActionTarget) return null;
    const { albumTree } = useLibraryStore.getState();
    const findNode = (nodes: AlbumItem[]): AlbumItem | null => {
      for (const n of nodes) {
        if (n.id === albumActionTarget) return n;
        if (n.type === 'group') {
          const res = findNode((n as AlbumGroup).children);
          if (res) return res;
        }
      }
      return null;
    };
    return findNode(albumTree);
  })();

  const currentAlbumName = currentAlbumData?.name || '';
  const isAlbumGroup = currentAlbumData?.type === 'group';

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
        loadingImageUrl={panoramaModalState.stitchingSourcePaths.length > 0 ? panoramaThumbnail || null : null}
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
        loadingImageUrl={hdrModalState.stitchingSourcePaths.length > 0 ? hdrThumbnail || null : null}
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
      <FocusStackModal
        error={focusStackModalState.error}
        finalImageBase64={focusStackModalState.finalImageBase64}
        imageCount={focusStackModalState.sourcePaths.length}
        isOpen={focusStackModalState.isOpen}
        isProcessing={focusStackModalState.isProcessing}
        loadingImageUrl={focusStackModalState.sourcePaths.length > 0 ? focusStackThumbnail || null : null}
        depthMapBase64={focusStackModalState.depthMapBase64}
        onClose={() =>
          setUI({
            focusStackModalState: {
              isOpen: false,
              isProcessing: false,
              progressMessage: '',
              finalImageBase64: null,
              depthMapBase64: null,
              error: null,
              sourcePaths: [],
            },
          })
        }
        onOpenFile={(path: string) => props.handleImageSelect(path)}
        onSave={props.handleSaveFocusStack}
        onMerge={() => props.handleStartFocusStack(focusStackModalState.sourcePaths)}
        progressMessage={focusStackModalState.progressMessage}
      />
      <CreateFolderModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setUI({ isCreateFolderModalOpen: false })}
        onSave={props.handleCreateFolder}
      />
      <RenameFolderModal
        currentName={folderActionTarget ? folderActionTarget.split(/[\\/]/).pop() || '' : ''}
        isOpen={isRenameFolderModalOpen}
        onClose={() => setUI({ isRenameFolderModalOpen: false })}
        onSave={props.handleRenameFolder}
      />
      <CreateFolderModal
        isOpen={isCreateAlbumModalOpen}
        onClose={() => setUI({ isCreateAlbumModalOpen: false })}
        onSave={(name) => props.handleCreateAlbumItem(name, 'album')}
        title={t('contextMenus.albums.newAlbum')}
        placeholder={t('modals.createAlbum.placeholder')}
        buttonText={t('modals.createFolder.create')}
      />
      <CreateFolderModal
        isOpen={isCreateAlbumGroupModalOpen}
        onClose={() => setUI({ isCreateAlbumGroupModalOpen: false })}
        onSave={(name) => props.handleCreateAlbumItem(name, 'group')}
        title={t('contextMenus.albums.newGroup')}
        placeholder={t('modals.createGroup.placeholder')}
        buttonText={t('modals.createFolder.create')}
      />
      <RenameFolderModal
        currentName={currentAlbumName}
        isOpen={isRenameAlbumModalOpen}
        onClose={() => setUI({ isRenameAlbumModalOpen: false })}
        onSave={props.handleRenameAlbumItem}
        title={isAlbumGroup ? t('contextMenus.albums.renameGroup') : t('contextMenus.albums.renameAlbum')}
        placeholder={isAlbumGroup ? t('modals.renameGroup.placeholder') : t('modals.renameAlbum.placeholder')}
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
        onApply={(action, paths) => {
          if (action === 'reject') {
            props.handleSetFlag(ImageFlag.Reject, paths);
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
      />
    </>
  );
}
