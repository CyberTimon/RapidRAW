import { useShallow } from 'zustand/react/shallow';

import CommunityPage from '../panel/CommunityPage';
import MainLibrary from '../panel/MainLibrary';
import BottomBar from '../panel/BottomBar';

import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';

import { ImageFile, LibraryViewMode, ThumbnailAspectRatio, ThumbnailSize } from '../ui/AppProperties';

interface LibraryViewProps {
  sortedImageList: ImageFile[];
  thumbnailSize: ThumbnailSize;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  libraryViewMode: LibraryViewMode;
  isAndroid: boolean;
  setThumbnailSize: (size: ThumbnailSize) => void;
  setThumbnailAspectRatio: (ratio: ThumbnailAspectRatio) => void;
  setLibraryViewMode: (mode: LibraryViewMode) => void;
  handleClearSelection: () => void;
  handleLibraryImageSingleClick: (...args: any) => void;
  handleImageSelect: (...args: any) => void;
  handleRate: (...args: any) => void;
  handleThumbnailContextMenu: (...args: any) => void;
  handleMainLibraryContextMenu: (...args: any) => void;
  handleContinueSession: (...args: any) => void;
  handleGoHome: (...args: any) => void;
  handleOpenFolder: (...args: any) => void;
  handleImportClick: (path: string) => void;
  handleLibraryRefresh: () => Promise<void>;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleResetAdjustments: () => void;
  requestThumbnails: any;
}

export default function LibraryView({
  sortedImageList,
  thumbnailSize,
  thumbnailAspectRatio,
  libraryViewMode,
  isAndroid,
  setThumbnailSize,
  setThumbnailAspectRatio,
  setLibraryViewMode,
  handleClearSelection,
  handleLibraryImageSingleClick,
  handleImageSelect,
  handleRate,
  handleThumbnailContextMenu,
  handleMainLibraryContextMenu,
  handleContinueSession,
  handleGoHome,
  handleOpenFolder,
  handleImportClick,
  handleLibraryRefresh,
  handleCopyAdjustments,
  handlePasteAdjustments,
  handleResetAdjustments,
  requestThumbnails,
}: LibraryViewProps) {
  const { activeView, setUI } = useUIStore(
    useShallow((state) => ({
      activeView: state.activeView,
      setUI: state.setUI,
    })),
  );

  const {
    rootPath,
    currentFolderPath,
    libraryActivePath,
    multiSelectedPaths,
    imageList,
    imageRatings,
    isViewLoading,
    isTreeLoading,
  } = useLibraryStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      currentFolderPath: state.currentFolderPath,
      libraryActivePath: state.libraryActivePath,
      multiSelectedPaths: state.multiSelectedPaths,
      imageList: state.imageList,
      imageRatings: state.imageRatings,
      isViewLoading: state.isViewLoading,
      isTreeLoading: state.isTreeLoading,
    })),
  );

  const { appSettings, supportedTypes, theme, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      supportedTypes: state.supportedTypes,
      theme: state.theme,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const { aiModelDownloadStatus, importState, indexingProgress, isIndexing, thumbnailProgress, isCopied, isPasted } =
    useProcessStore(
      useShallow((state) => ({
        aiModelDownloadStatus: state.aiModelDownloadStatus,
        importState: state.importState,
        indexingProgress: state.indexingProgress,
        isIndexing: state.isIndexing,
        thumbnailProgress: state.thumbnailProgress,
        isCopied: state.isCopied,
        isPasted: state.isPasted,
      })),
    );

  return (
    <div className="flex flex-row grow h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 gap-2">
        {activeView === 'community' ? (
          <CommunityPage
            onBackToLibrary={() => setUI({ activeView: 'library' })}
            supportedTypes={supportedTypes}
            imageList={sortedImageList}
            currentFolderPath={currentFolderPath}
          />
        ) : (
          <MainLibrary
            activePath={libraryActivePath}
            aiModelDownloadStatus={aiModelDownloadStatus}
            appSettings={appSettings}
            currentFolderPath={currentFolderPath}
            imageList={sortedImageList}
            imageRatings={imageRatings}
            importState={importState}
            indexingProgress={indexingProgress}
            isIndexing={isIndexing}
            isLoading={isViewLoading}
            isTreeLoading={isTreeLoading}
            isAndroid={isAndroid}
            libraryViewMode={libraryViewMode}
            multiSelectedPaths={multiSelectedPaths}
            onClearSelection={handleClearSelection}
            onContextMenu={handleThumbnailContextMenu}
            onContinueSession={handleContinueSession}
            onEmptyAreaContextMenu={handleMainLibraryContextMenu}
            onGoHome={handleGoHome}
            onImageClick={handleLibraryImageSingleClick}
            onImageDoubleClick={handleImageSelect}
            onImportClick={() => handleImportClick(currentFolderPath as string)}
            onLibraryRefresh={handleLibraryRefresh}
            onOpenFolder={handleOpenFolder}
            onSettingsChange={handleSettingsChange}
            onThumbnailAspectRatioChange={setThumbnailAspectRatio}
            onThumbnailSizeChange={setThumbnailSize}
            onRequestThumbnails={requestThumbnails}
            rootPath={rootPath}
            setLibraryViewMode={setLibraryViewMode}
            theme={theme}
            thumbnailAspectRatio={thumbnailAspectRatio}
            thumbnailProgress={thumbnailProgress}
            thumbnailSize={thumbnailSize}
            onNavigateToCommunity={() => setUI({ activeView: 'community' })}
          />
        )}
        {rootPath && (
          <BottomBar
            isCopied={isCopied}
            isCopyDisabled={multiSelectedPaths.length !== 1}
            isExportDisabled={multiSelectedPaths.length === 0}
            isLibraryView={true}
            isPasted={isPasted}
            isPasteDisabled={useEditorStore.getState().copiedAdjustments === null || multiSelectedPaths.length === 0}
            isRatingDisabled={multiSelectedPaths.length === 0}
            isResetDisabled={multiSelectedPaths.length === 0}
            multiSelectedPaths={multiSelectedPaths}
            onCopy={handleCopyAdjustments}
            onExportClick={() =>
              setUI((state) => ({ isLibraryExportPanelVisible: !state.isLibraryExportPanelVisible }))
            }
            onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
            onPaste={() => handlePasteAdjustments()}
            onRate={handleRate}
            onReset={() => handleResetAdjustments()}
            rating={imageRatings[libraryActivePath || ''] || 0}
            thumbnailAspectRatio={thumbnailAspectRatio}
            totalImages={imageList.length}
          />
        )}
      </div>
    </div>
  );
}
