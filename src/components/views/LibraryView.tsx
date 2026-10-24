import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';

import CommunityPage from '../panel/CommunityPage';
import MainLibrary from '../panel/MainLibrary';
import BottomBar from '../panel/BottomBar';

import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useEditorStore } from '../../store/useEditorStore';
import { selectAiModelDownloadStatus, selectAiTaggingJob, useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';

import { ImageFile, LibraryViewMode, ThumbnailAspectRatio, ThumbnailSize } from '../ui/AppProperties';
import { GroupBadgeInfo, GroupId } from '../../utils/imageGrouping';
import { getImageFlag } from '../../utils/imageFlags';

interface LibraryViewProps {
  sortedImageList: ImageFile[];
  groupBadgeInfo: Map<GroupId, GroupBadgeInfo> | null;
  thumbnailSize: ThumbnailSize;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  libraryViewMode: LibraryViewMode;
  isAndroid: boolean;
  layoutMode: 'compact' | 'wide' | 'full';
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
  handleNavigateToFolder: (path: string) => void;
  handleImportClick: (path: string) => void;
  handleLibraryRefresh: () => Promise<void>;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleResetAdjustments: () => void;
  requestThumbnails: any;
}

export default function LibraryView({
  sortedImageList,
  groupBadgeInfo,
  thumbnailSize,
  thumbnailAspectRatio,
  libraryViewMode,
  isAndroid,
  layoutMode,
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
  handleNavigateToFolder,
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
    rootPaths,
    currentFolderPath,
    libraryActivePath,
    multiSelectedPaths,
    imageList,
    imageRatings,
    isViewLoading,
    isTreeLoading,
  } = useLibraryStore(
    useShallow((state) => ({
      rootPaths: state.rootPaths,
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

  const { aiModelDownloadStatus, aiTaggingJob, importState, isCopied, isPasted } = useProcessStore(
    useShallow((state) => ({
      aiModelDownloadStatus: selectAiModelDownloadStatus(state),
      aiTaggingJob: selectAiTaggingJob(state),
      importState: state.importState,
      isCopied: state.isCopied,
      isPasted: state.isPasted,
    })),
  );

  const handleMainLibraryImportClick = useCallback(
    () => handleImportClick(currentFolderPath as string),
    [handleImportClick, currentFolderPath],
  );
  const handleNavigateToCommunity = useCallback(() => setUI({ activeView: 'community' }), [setUI]);

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
            aiTaggingJob={aiTaggingJob}
            appSettings={appSettings}
            currentFolderPath={currentFolderPath}
            groupBadgeInfo={groupBadgeInfo}
            imageList={sortedImageList}
            imageRatings={imageRatings}
            importState={importState}
            isLoading={isViewLoading}
            isTreeLoading={isTreeLoading}
            isAndroid={isAndroid}
            libraryViewMode={libraryViewMode}
            multiSelectedPaths={multiSelectedPaths}
            onClearSelection={handleClearSelection}
            onContextMenu={handleThumbnailContextMenu}
            onNavigateToFolder={handleNavigateToFolder}
            onContinueSession={handleContinueSession}
            onEmptyAreaContextMenu={handleMainLibraryContextMenu}
            onGoHome={handleGoHome}
            onImageClick={handleLibraryImageSingleClick}
            onImageDoubleClick={handleImageSelect}
            onImportClick={handleMainLibraryImportClick}
            onLibraryRefresh={handleLibraryRefresh}
            onOpenFolder={handleOpenFolder}
            onSettingsChange={handleSettingsChange}
            onThumbnailAspectRatioChange={setThumbnailAspectRatio}
            onThumbnailSizeChange={setThumbnailSize}
            onRequestThumbnails={requestThumbnails}
            rootPaths={rootPaths}
            setLibraryViewMode={setLibraryViewMode}
            theme={theme}
            thumbnailAspectRatio={thumbnailAspectRatio}
            thumbnailSize={thumbnailSize}
            onNavigateToCommunity={handleNavigateToCommunity}
          />
        )}
        {rootPaths && rootPaths.length > 0 && (
          <BottomBar
            isCopied={isCopied}
            isCopyDisabled={multiSelectedPaths.length === 0}
            isExportDisabled={multiSelectedPaths.length === 0}
            isLibraryView={true}
            layoutMode={layoutMode}
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
            flag={getImageFlag(imageList, libraryActivePath)}
            thumbnailAspectRatio={thumbnailAspectRatio}
            totalImages={imageList.length}
          />
        )}
      </div>
    </div>
  );
}
