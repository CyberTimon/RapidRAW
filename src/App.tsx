import { useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ToastContainer, Slide } from 'react-toastify';
import clsx from 'clsx';
import TitleBar from './window/TitleBar';
import CommunityPage from './components/panel/CommunityPage';
import MainLibrary from './components/panel/MainLibrary';
import FolderTree from './components/panel/FolderTree';
import Editor from './components/panel/Editor';
import Controls from './components/panel/right/ControlsPanel';
import { useThumbnails } from './hooks/useThumbnails';
import RightPanelSwitcher from './components/panel/right/RightPanelSwitcher';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import AIPanel from './components/panel/right/AIPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import LibraryExportPanel from './components/panel/right/LibraryExportPanel';
import MasksPanel from './components/panel/right/MasksPanel';
import BottomBar from './components/panel/BottomBar';
import CreateFolderModal from './components/modals/CreateFolderModal';
import RenameFolderModal from './components/modals/RenameFolderModal';
import ConfirmModal from './components/modals/ConfirmModal';
import ImportSettingsModal from './components/modals/ImportSettingsModal';
import RenameFileModal from './components/modals/RenameFileModal';
import PanoramaModal from './components/modals/PanoramaModal';
import NegativeConversionModal from './components/modals/NegativeConversionModal';
import DenoiseModal from './components/modals/DenoiseModal';
import CollageModal from './components/modals/CollageModal';
import CopyPasteSettingsModal from './components/modals/CopyPasteSettingsModal';
import CullingModal from './components/modals/CullingModal';
import Resizer from './components/ui/Resizer';
import { CopyPasteSettings } from './utils/adjustments';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import GlobalTooltip from './components/ui/GlobalTooltip';
import {
  ImageFile,
  Panel,
  UiVisibility,
  Orientation,
  CullingSuggestions,
  AppSettings,
} from './components/ui/AppProperties';
import HdrModal from './components/modals/HdrModal';
import { ContextProviders, useAppState } from './context/ContextProviders';
import { useSortedImageList } from './hooks/useSortedImageList';
import { useHandlers } from './hooks/useHandlers';
import { useGlobalEffects } from './hooks/useGlobalEffects';

export interface CollapsibleSectionsState {
  basic: boolean;
  color: boolean;
  curves: boolean;
  details: boolean;
  effects: boolean;
}

export interface ConfirmModalState {
  confirmText?: string;
  confirmVariant?: string;
  isOpen: boolean;
  message?: string;
  onConfirm?(): void;
  title?: string;
}

export interface MultiSelectOptions {
  onSimpleClick(p: any): void;
  updateLibraryActivePath: boolean;
  shiftAnchor: string | null;
}

export interface CollageModalState {
  isOpen: boolean;
  sourceImages: ImageFile[];
}

export interface PanoramaModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

export interface HdrModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

export interface DenoiseModalState {
  isOpen: boolean;
  isProcessing: boolean;
  previewBase64: string | null;
  originalBase64?: string | null;
  error: string | null;
  targetPath: string | null;
  progressMessage: string | null;
}

export interface NegativeConversionModalState {
  isOpen: boolean;
  targetPath: string | null;
}

export interface CullingModalState {
  isOpen: boolean;
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
  pathsToCull: Array<string>;
}

export interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

function App() {
  const {
    selectedImage,
    appSettings,
    rootPath,
    activeView,
    setActiveView,
    isWindowFullScreen,
    isLayoutReady,
    currentFolderPath,
    folderTree,
    imageList,
    imageRatings,
    sortCriteria,
    filterCriteria,
    supportedTypes,
    multiSelectedPaths,
    setMultiSelectedPaths,
    libraryActivePath,
    setLibraryActivePath,
    libraryActiveAdjustments,
    setShowOriginal,
    adjustments,
    isTreeLoading,
    isViewLoading,
    setIsWaveformVisible,
    uiVisibility,
    setUiVisibility,
    setIsSliderDragging,
    isFullScreen,
    isAnimatingTheme,
    theme,
    activeRightPanel,
    slideDirection,
    activeMaskContainerId,
    setActiveMaskContainerId,
    activeMaskId,
    setActiveMaskId,
    activeAiPatchContainerId,
    setActiveAiPatchContainerId,
    activeAiSubMaskId,
    setActiveAiSubMaskId,
    zoom,
    displaySize,
    baseRenderSize,
    originalSize,
    setInitialFitScale,
    renderedRightPanel,
    isLibraryExportPanelVisible,
    setIsLibraryExportPanelVisible,
    libraryViewMode,
    leftPanelWidth,
    setLeftPanelWidth,
    rightPanelWidth,
    setRightPanelWidth,
    bottomPanelHeight,
    setBottomPanelHeight,
    isResizing,
    thumbnailSize,
    setThumbnailSize,
    thumbnailAspectRatio,
    setThumbnailAspectRatio,
    copiedAdjustments,
    isStraightenActive,
    setIsStraightenActive,
    copiedFilePaths,
    setCopiedFilePaths,
    aiModelDownloadStatus,
    isCopied,
    isPasted,
    isIndexing,
    indexingProgress,
    searchCriteria,
    setIsCreateFolderModalOpen,
    setIsRenameFolderModalOpen,
    setIsRenameFileModalOpen,
    setIsImportModalOpen,
    setIsCopyPasteSettingsModalOpen,
    importSourcePaths,
    folderActionTarget,
    confirmModalState,
    setPanoramaModalState,
    setHdrModalState,
    negativeModalState,
    setNegativeModalState,
    setDenoiseModalState,
    setCullingModalState,
    setCollageModalState,
    customEscapeHandler,
    libraryScrollTop,
    thumbnails,
    setThumbnails,
    history,
    importState,
    isLightTheme,
    isAnyModalOpen,
  } = useAppState();

  const { sortedImageList } = useSortedImageList();

  const { canUndo, canRedo, goToIndex: goToAdjustmentsHistoryIndex } = history;

  const {
    handleBackToLibrary,
    handleImageSelect,
    executeDelete,
    handleDeleteSelected,
    refreshImageList,
    handleDisplaySizeChange,
    setAdjustments,
    handleStraighten,
    toggleWbPicker,
    handleWbPicked,
    undo,
    redo,
    updateSubMask,
    handleGenerativeReplace,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
    createResizeHandler,
    handleLutSelect,
    handleRightPanelSelect,
    handleSettingsChange,
    handleToggleWaveform,
    handleActiveTreeSectionChange,
    handleSelectSubfolder,
    handleLibraryRefresh,
    handleToggleFolder,
    handleToggleFullScreen,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleAutoAdjustments,
    handleRate,
    handleSetColorLabel,
    handleTagsChanged,
    closeConfirmModal,
    handlePasteFiles,
    handleZoomChange,
    handleUserTransform,
    handleSavePanorama,
    handleSaveHdr,
    handleApplyDenoise,
    handleSaveDenoisedImage,
    handleSaveCollage,
    handleOpenFolder,
    handleContinueSession,
    handleGoHome,
    handleLibraryImageSingleClick,
    handleImageClick,
    handleClearSelection,
    handleSaveRename,
    handleStartImport,
    handleResetAdjustments,
    handleEditorContextMenu,
    handleThumbnailContextMenu,
    handleCreateFolder,
    handleRenameFolder,
    handleFolderTreeContextMenu,
    handleMainLibraryContextMenu,
  } = useHandlers();

  useGlobalEffects();

  const { loading: isThumbnailsLoading } = useThumbnails(imageList, setThumbnails);

  useKeyboardShortcuts({
    isModalOpen: isAnyModalOpen,
    activeAiPatchContainerId,
    activeAiSubMaskId,
    activeMaskContainerId,
    activeMaskId,
    activeRightPanel,
    canRedo,
    canUndo,
    copiedFilePaths,
    customEscapeHandler,
    handleBackToLibrary,
    handleCopyAdjustments,
    handleDeleteAiPatch,
    handleDeleteMaskContainer,
    handleDeleteSelected,
    handleImageSelect,
    handlePasteAdjustments,
    handlePasteFiles,
    handleRate,
    handleRightPanelSelect,
    handleSetColorLabel,
    handleToggleFullScreen,
    handleZoomChange,
    isFullScreen,
    isStraightenActive,
    isViewLoading,
    libraryActivePath,
    multiSelectedPaths,
    redo,
    selectedImage,
    setActiveAiSubMaskId,
    setActiveMaskContainerId,
    setActiveMaskId,
    setCopiedFilePaths,
    setIsStraightenActive,
    setIsWaveformVisible,
    setLibraryActivePath,
    setMultiSelectedPaths,
    setShowOriginal,
    sortedImageList,
    undo,
    zoom,
    displaySize,
    baseRenderSize,
    originalSize,
  });

  const memoizedFolderTree = useMemo(
    () =>
      rootPath && (
        <div
          className={clsx(
            'flex h-full overflow-hidden flex-shrink-0',
            !isResizing && 'transition-all duration-300 ease-in-out',
          )}
          style={{
            maxWidth: isFullScreen ? '0px' : '1000px',
            opacity: isFullScreen ? 0 : 1,
          }}
        >
          <FolderTree
            onContextMenu={handleFolderTreeContextMenu}
            onFolderSelect={(path) => handleSelectSubfolder(path, false)}
            onToggleFolder={handleToggleFolder}
            setIsVisible={(value: boolean) => setUiVisibility((prev: UiVisibility) => ({ ...prev, folderTree: value }))}
            onActiveSectionChange={handleActiveTreeSectionChange}
          />
          <Resizer
            direction={Orientation.Vertical}
            onMouseDown={createResizeHandler(setLeftPanelWidth, leftPanelWidth)}
          />
        </div>
      ),
    [rootPath, isResizing, handleSelectSubfolder, leftPanelWidth, folderTree, isFullScreen],
  );

  const memoizedLibraryView = useMemo(
    () => (
      <div className="flex flex-row flex-grow h-full min-h-0">
        <div className="flex-1 flex flex-col min-w-0 gap-2">
          {activeView === 'community' ? (
            <CommunityPage onBackToLibrary={() => setActiveView('library')} />
          ) : (
            <MainLibrary
              onClearSelection={handleClearSelection}
              onContextMenu={handleThumbnailContextMenu}
              onContinueSession={handleContinueSession}
              onEmptyAreaContextMenu={handleMainLibraryContextMenu}
              onGoHome={handleGoHome}
              onImageClick={handleLibraryImageSingleClick}
              onImageDoubleClick={handleImageSelect}
              onLibraryRefresh={handleLibraryRefresh}
              onOpenFolder={handleOpenFolder}
              onSettingsChange={handleSettingsChange}
              onThumbnailAspectRatioChange={setThumbnailAspectRatio}
              onThumbnailSizeChange={setThumbnailSize}
              onNavigateToCommunity={() => setActiveView('community')}
            />
          )}
          {rootPath && (
            <BottomBar
              isCopied={isCopied}
              isCopyDisabled={multiSelectedPaths.length !== 1}
              isExportDisabled={multiSelectedPaths.length === 0}
              isLibraryView={true}
              isPasted={isPasted}
              isPasteDisabled={copiedAdjustments === null || multiSelectedPaths.length === 0}
              isRatingDisabled={multiSelectedPaths.length === 0}
              isResetDisabled={multiSelectedPaths.length === 0}
              multiSelectedPaths={multiSelectedPaths}
              onCopy={handleCopyAdjustments}
              onExportClick={() => setIsLibraryExportPanelVisible((prev) => !prev)}
              onOpenCopyPasteSettings={() => setIsCopyPasteSettingsModalOpen(true)}
              onPaste={() => handlePasteAdjustments()}
              onRate={handleRate}
              onReset={() => handleResetAdjustments()}
              rating={libraryActiveAdjustments.rating || 0}
              thumbnailAspectRatio={thumbnailAspectRatio}
              totalImages={imageList.length}
            />
          )}
        </div>
      </div>
    ),
    [
      activeView,
      sortedImageList,
      currentFolderPath,
      libraryActivePath,
      aiModelDownloadStatus,
      appSettings,
      filterCriteria,
      imageRatings,
      importState,
      indexingProgress,
      isIndexing,
      isThumbnailsLoading,
      isViewLoading,
      isTreeLoading,
      libraryScrollTop,
      libraryViewMode,
      multiSelectedPaths,
      rootPath,
      searchCriteria,
      sortCriteria,
      theme,
      thumbnailAspectRatio,
      thumbnails,
      thumbnailSize,
      isCopied,
      isPasted,
      copiedAdjustments,
      libraryActiveAdjustments,
      supportedTypes,
      copiedFilePaths,
    ],
  );

  const renderMainView = () => {
    const panelVariants: any = {
      animate: (direction: number) => ({
        opacity: 1,
        y: 0,
        transition: { duration: direction === 0 ? 0 : 0.2, ease: 'circOut' },
      }),
      exit: (direction: number) => ({
        opacity: direction === 0 ? 1 : 0.2,
        y: direction === 0 ? 0 : direction > 0 ? -20 : 20,
        transition: { duration: direction === 0 ? 0 : 0.1, ease: 'circIn' },
      }),
      initial: (direction: number) => ({
        opacity: direction === 0 ? 1 : 0.2,
        y: direction === 0 ? 0 : direction > 0 ? 20 : -20,
      }),
    };

    if (selectedImage) {
      return (
        <div className="flex flex-row flex-grow h-full min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            <Editor
              onBackToLibrary={handleBackToLibrary}
              onCloseWaveform={() => setIsWaveformVisible(false)}
              onContextMenu={handleEditorContextMenu}
              onGenerateAiMask={handleGenerateAiMask}
              onQuickErase={handleQuickErase}
              onRedo={redo}
              onSelectAiSubMask={setActiveAiSubMaskId}
              onSelectMask={setActiveMaskId}
              onStraighten={handleStraighten}
              onToggleFullScreen={handleToggleFullScreen}
              onToggleWaveform={handleToggleWaveform}
              onUndo={undo}
              onZoomed={handleUserTransform}
              onWbPicked={handleWbPicked}
              setAdjustments={setAdjustments}
              setShowOriginal={setShowOriginal}
              updateSubMask={updateSubMask}
              onDisplaySizeChange={handleDisplaySizeChange}
              onInitialFitScale={setInitialFitScale}
              goToAdjustmentsHistoryIndex={goToAdjustmentsHistoryIndex}
            />
            <div
              className={clsx(
                'flex flex-col w-full overflow-hidden flex-shrink-0',
                !isResizing && 'transition-all duration-300 ease-in-out',
              )}
              style={{
                maxHeight: isFullScreen ? '0px' : '500px',
                opacity: isFullScreen ? 0 : 1,
              }}
            >
              <Resizer
                direction={Orientation.Horizontal}
                onMouseDown={createResizeHandler(setBottomPanelHeight, bottomPanelHeight)}
              />
              <BottomBar
                filmstripHeight={bottomPanelHeight}
                imageList={sortedImageList}
                imageRatings={imageRatings}
                isCopied={isCopied}
                isCopyDisabled={!selectedImage}
                isFilmstripVisible={uiVisibility.filmstrip}
                isLoading={isViewLoading}
                isPasted={isPasted}
                isPasteDisabled={copiedAdjustments === null}
                isRatingDisabled={!selectedImage}
                isResizing={isResizing}
                multiSelectedPaths={multiSelectedPaths}
                displaySize={displaySize}
                originalSize={originalSize}
                baseRenderSize={baseRenderSize}
                onClearSelection={handleClearSelection}
                onContextMenu={handleThumbnailContextMenu}
                onCopy={handleCopyAdjustments}
                onOpenCopyPasteSettings={() => setIsCopyPasteSettingsModalOpen(true)}
                onImageSelect={handleImageClick}
                onPaste={() => handlePasteAdjustments()}
                onRate={handleRate}
                onZoomChange={handleZoomChange}
                rating={adjustments.rating || 0}
                selectedImage={selectedImage}
                setIsFilmstripVisible={(value: boolean) =>
                  setUiVisibility((prev: UiVisibility) => ({ ...prev, filmstrip: value }))
                }
                thumbnailAspectRatio={thumbnailAspectRatio}
                thumbnails={thumbnails}
                zoom={zoom}
                totalImages={sortedImageList.length}
              />
            </div>
          </div>

          <div
            className={clsx(
              'flex h-full overflow-hidden flex-shrink-0',
              !isResizing && 'transition-all duration-300 ease-in-out',
            )}
            style={{
              maxWidth: isFullScreen ? '0px' : '1000px',
              opacity: isFullScreen ? 0 : 1,
            }}
          >
            <Resizer
              onMouseDown={createResizeHandler(setRightPanelWidth, rightPanelWidth)}
              direction={Orientation.Vertical}
            />
            <div className="flex bg-bg-secondary rounded-lg h-full">
              <div
                className={clsx('h-full overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
                style={{ width: activeRightPanel ? `${rightPanelWidth}px` : '0px' }}
              >
                <div style={{ width: `${rightPanelWidth}px` }} className="h-full">
                  <AnimatePresence mode="wait" custom={slideDirection}>
                    {activeRightPanel && (
                      <motion.div
                        animate="animate"
                        className="h-full w-full"
                        custom={slideDirection}
                        exit="exit"
                        initial="initial"
                        key={renderedRightPanel}
                        variants={panelVariants}
                      >
                        {renderedRightPanel === Panel.Adjustments && (
                          <Controls
                            handleAutoAdjustments={handleAutoAdjustments}
                            handleLutSelect={handleLutSelect}
                            toggleWbPicker={toggleWbPicker}
                            onDragStateChange={setIsSliderDragging}
                          />
                        )}
                        {renderedRightPanel === Panel.Metadata && (
                          <MetadataPanel
                            tags={imageList.find((img) => img.path === selectedImage.path)?.tags || []}
                            onRate={handleRate}
                            onSetColorLabel={handleSetColorLabel}
                            onTagsChanged={handleTagsChanged}
                          />
                        )}
                        {renderedRightPanel === Panel.Crop && <CropPanel />}
                        {renderedRightPanel === Panel.Masks && (
                          <MasksPanel
                            onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                            onGenerateAiSkyMask={handleGenerateAiSkyMask}
                            onSelectContainer={setActiveMaskContainerId}
                            onSelectMask={setActiveMaskId}
                            onDragStateChange={setIsSliderDragging}
                          />
                        )}
                        {renderedRightPanel === Panel.Presets && (
                          <PresetsPanel
                            onNavigateToCommunity={() => {
                              handleBackToLibrary();
                              setActiveView('community');
                            }}
                          />
                        )}
                        {renderedRightPanel === Panel.Export && <ExportPanel onSettingsChange={handleSettingsChange} />}
                        {renderedRightPanel === Panel.Ai && (
                          <AIPanel
                            onDeletePatch={handleDeleteAiPatch}
                            onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                            onGenerativeReplace={handleGenerativeReplace}
                            onSelectPatchContainer={setActiveAiPatchContainerId}
                            onSelectSubMask={setActiveAiSubMaskId}
                            onTogglePatchVisibility={handleToggleAiPatchVisibility}
                          />
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              <div
                className={clsx(
                  'h-full border-l transition-colors',
                  activeRightPanel ? 'border-surface' : 'border-transparent',
                )}
              >
                <RightPanelSwitcher activePanel={activeRightPanel} onPanelSelect={handleRightPanelSelect} />
              </div>
            </div>
          </div>
        </div>
      );
    }
    return memoizedLibraryView;
  };

  const renderContent = () => {
    return renderMainView();
  };

  return (
    <div
      className={clsx(
        'flex flex-col h-screen bg-bg-primary font-sans text-text-primary overflow-hidden select-none',
        (appSettings?.adaptiveEditorTheme || isAnimatingTheme) && 'enable-color-transitions',
      )}
    >
      <div
        className={clsx(
          'flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out z-50',
          isFullScreen ? 'max-h-0 opacity-0 pointer-events-none' : 'max-h-[60px] opacity-100',
        )}
      >
        {appSettings?.decorations || (!isWindowFullScreen && <TitleBar />)}
      </div>
      <div
        className={clsx(
          'flex-1 flex flex-col min-h-0',
          isLayoutReady && rootPath && 'transition-all duration-300 ease-in-out',
          [
            rootPath && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2'),
            !appSettings?.decorations && !isWindowFullScreen && !isFullScreen && (rootPath ? 'pt-12' : 'pt-10'),
          ],
        )}
      >
        <div className="flex flex-row flex-grow h-full min-h-0">
          {memoizedFolderTree}
          <div className="flex-1 flex flex-col min-w-0">{renderContent()}</div>
          {!selectedImage && isLibraryExportPanelVisible && (
            <Resizer
              direction={Orientation.Vertical}
              onMouseDown={createResizeHandler(setRightPanelWidth, rightPanelWidth)}
            />
          )}
          <div
            className={clsx('flex-shrink-0 overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
            style={{ width: isLibraryExportPanelVisible && !isFullScreen ? `${rightPanelWidth}px` : '0px' }}
          >
            <LibraryExportPanel
              onClose={() => setIsLibraryExportPanelVisible(false)}
              onSettingsChange={handleSettingsChange}
            />
          </div>
        </div>
      </div>
      <CopyPasteSettingsModal
        onClose={() => setIsCopyPasteSettingsModalOpen(false)}
        settings={appSettings?.copyPasteSettings as CopyPasteSettings}
        onSave={(newSettings) =>
          handleSettingsChange({ ...appSettings, copyPasteSettings: newSettings } as AppSettings)
        }
      />
      <PanoramaModal
        onClose={() =>
          setPanoramaModalState({
            isOpen: false,
            progressMessage: '',
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: [],
          })
        }
        onOpenFile={(path: string) => {
          handleImageSelect(path);
        }}
        onSave={handleSavePanorama}
      />
      <HdrModal
        onClose={() =>
          setHdrModalState({
            isOpen: false,
            progressMessage: '',
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: [],
          })
        }
        onOpenFile={(path: string) => {
          handleImageSelect(path);
        }}
        onSave={handleSaveHdr}
      />
      <NegativeConversionModal
        onClose={() => setNegativeModalState((prev) => ({ ...prev, isOpen: false }))}
        onSave={(savedPath) => {
          refreshImageList().then(() => {
            if (selectedImage?.path === negativeModalState.targetPath) {
              handleImageSelect(savedPath);
            }
          });
        }}
      />
      <DenoiseModal
        onClose={() => setDenoiseModalState((prev) => ({ ...prev, isOpen: false }))}
        onDenoise={handleApplyDenoise}
        onSave={handleSaveDenoisedImage}
        onOpenFile={handleImageSelect}
      />
      <CreateFolderModal onClose={() => setIsCreateFolderModalOpen(false)} onSave={handleCreateFolder} />
      <RenameFolderModal
        currentName={folderActionTarget ? folderActionTarget.split(/[\\/]/).pop() : ''}
        onClose={() => setIsRenameFolderModalOpen(false)}
        onSave={handleRenameFolder}
      />
      <RenameFileModal onClose={() => setIsRenameFileModalOpen(false)} onSave={handleSaveRename} />
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <ImportSettingsModal
        fileCount={importSourcePaths.length}
        onClose={() => setIsImportModalOpen(false)}
        onSave={handleStartImport}
      />
      <CullingModal
        onClose={() =>
          setCullingModalState({ isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] })
        }
        onApply={(action, paths) => {
          if (action === 'reject') {
            handleSetColorLabel('red', paths);
          } else if (action === 'rate_zero') {
            handleRate(1, paths);
          } else if (action === 'delete') {
            executeDelete(paths, { includeAssociated: false });
          }
          setCullingModalState({ isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] });
        }}
        onError={(err) => {
          setCullingModalState((prev) => ({ ...prev, error: err, progress: null }));
        }}
      />
      <CollageModal
        onClose={() => setCollageModalState({ isOpen: false, sourceImages: [] })}
        onSave={handleSaveCollage}
      />
      <ToastContainer
        position="bottom-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable={false}
        pauseOnHover
        theme={isLightTheme ? 'light' : 'dark'}
        transition={Slide}
        toastClassName={() =>
          clsx(
            'relative flex min-h-16 p-4 rounded-lg justify-between overflow-hidden cursor-pointer mb-4',
            '!bg-surface !text-text-primary !border !border-border-color !shadow-2xl !max-w-[420px]',
          )
        }
      />
    </div>
  );
}

const AppWrapper = () => (
  <ContextProviders>
    <App />
    <GlobalTooltip />
  </ContextProviders>
);

export default AppWrapper;
