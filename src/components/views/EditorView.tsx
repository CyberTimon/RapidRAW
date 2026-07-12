import { type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';

import Editor from '../panel/Editor';
import BottomBar from '../panel/BottomBar';
import RightPanelSwitcher from '../panel/right/RightPanelSwitcher';
import Resizer from '../ui/Resizer';
import Controls from '../panel/right/ControlsPanel';
import MetadataPanel from '../panel/right/MetadataPanel';
import CropPanel from '../panel/right/CropPanel';
import MasksPanel from '../panel/right/MasksPanel';
import AIPanel from '../panel/right/AIPanel';
import PresetsPanel from '../panel/right/PresetsPanel';
import ExportPanel from '../panel/right/ExportPanel';

import { useEditorStore } from '../../store/useEditorStore';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';

import { ImageFile, Orientation, Panel, ThumbnailAspectRatio } from '../ui/AppProperties';

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

interface EditorViewProps {
  transformWrapperRef: RefObject<any>;
  isResizing: boolean;
  isCompactPortrait: boolean;
  isAndroid: boolean;
  compactEditorPanelHeight: number;
  compactEditorPanelCollapsedHeight: number;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  sortedImageList: ImageFile[];
  createResizeHandler: (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => void;
  handleBackToLibrary: () => void;
  handleEditorContextMenu: (...args: any) => void;
  handleThumbnailContextMenu: (...args: any) => void;
  handleImageClick: (...args: any) => void;
  handleClearSelection: () => void;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleRate: (...args: any) => void;
  handleZoomChange: (zoom: number) => void;
  handleRightPanelSelect: (panelId: Panel) => void;
  requestThumbnails: any;
}

export default function EditorView({
  transformWrapperRef,
  isResizing,
  isCompactPortrait,
  isAndroid,
  compactEditorPanelHeight,
  compactEditorPanelCollapsedHeight,
  thumbnailAspectRatio,
  sortedImageList,
  createResizeHandler,
  handleBackToLibrary,
  handleEditorContextMenu,
  handleThumbnailContextMenu,
  handleImageClick,
  handleClearSelection,
  handleCopyAdjustments,
  handlePasteAdjustments,
  handleRate,
  handleZoomChange,
  handleRightPanelSelect,
  requestThumbnails,
}: EditorViewProps) {
  const { selectedImage } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
    })),
  );

  const {
    isFullScreen,
    isInstantTransition,
    uiVisibility,
    bottomPanelHeight,
    rightPanelWidth,
    activeRightPanel,
    renderedRightPanel,
    slideDirection,
    setUI,
  } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isInstantTransition: state.isInstantTransition,
      uiVisibility: state.uiVisibility,
      bottomPanelHeight: state.bottomPanelHeight,
      rightPanelWidth: state.rightPanelWidth,
      activeRightPanel: state.activeRightPanel,
      renderedRightPanel: state.renderedRightPanel,
      slideDirection: state.slideDirection,
      setUI: state.setUI,
    })),
  );

  const { multiSelectedPaths, imageRatings, isViewLoading, rootPaths } = useLibraryStore(
    useShallow((state) => ({
      multiSelectedPaths: state.multiSelectedPaths,
      imageRatings: state.imageRatings,
      isViewLoading: state.isViewLoading,
      rootPaths: state.rootPaths,
    })),
  );

  const { exportState, isCopied, isPasted, setExportState } = useProcessStore(
    useShallow((state) => ({
      exportState: state.exportState,
      isCopied: state.isCopied,
      isPasted: state.isPasted,
      setExportState: state.setExportState,
    })),
  );

  const { appSettings, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const editorNode = (
    <Editor
      onBackToLibrary={handleBackToLibrary}
      onContextMenu={handleEditorContextMenu}
      transformWrapperRef={transformWrapperRef}
    />
  );

  const editorBottomBarComponent = (
    <BottomBar
      filmstripHeight={bottomPanelHeight}
      imageList={sortedImageList}
      imageRatings={imageRatings}
      isCopied={isCopied}
      isCopyDisabled={!selectedImage}
      isFilmstripVisible={uiVisibility.filmstrip}
      isLoading={isViewLoading}
      isPasted={isPasted}
      isPasteDisabled={useEditorStore.getState().copiedAdjustments === null}
      isRatingDisabled={!selectedImage}
      isResizing={isResizing}
      multiSelectedPaths={multiSelectedPaths}
      onClearSelection={handleClearSelection}
      onContextMenu={handleThumbnailContextMenu}
      onCopy={handleCopyAdjustments}
      onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
      onImageSelect={handleImageClick}
      onPaste={() => handlePasteAdjustments()}
      onRate={handleRate}
      onRequestThumbnails={requestThumbnails}
      onZoomChange={handleZoomChange}
      rating={imageRatings[selectedImage?.path || ''] || 0}
      selectedImage={selectedImage}
      setIsFilmstripVisible={(value: boolean) =>
        setUI((state) => ({ uiVisibility: { ...state.uiVisibility, filmstrip: value } }))
      }
      showFilmstrip={!isCompactPortrait}
      showZoomControls={!isAndroid}
      thumbnailAspectRatio={thumbnailAspectRatio}
      totalImages={sortedImageList.length}
    />
  );

  const editorBottomBarNode = (
    <div
      className={clsx(
        'flex flex-col w-full overflow-hidden shrink-0',
        !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
      )}
      style={{
        maxHeight: isFullScreen ? '0px' : '500px',
        opacity: isFullScreen ? 0 : 1,
      }}
    >
      {!isCompactPortrait && (
        <Resizer direction={Orientation.Horizontal} onMouseDown={createResizeHandler('bottom', bottomPanelHeight)} />
      )}
      {editorBottomBarComponent}
    </div>
  );

  const editorRightPanelContent = (
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
          {renderedRightPanel === Panel.Adjustments && <Controls />}
          {renderedRightPanel === Panel.Metadata && <MetadataPanel />}
          {renderedRightPanel === Panel.Crop && <CropPanel />}
          {renderedRightPanel === Panel.Masks && <MasksPanel />}
          {renderedRightPanel === Panel.Presets && (
            <PresetsPanel
              onNavigateToCommunity={() => {
                handleBackToLibrary();
                setUI({ activeView: 'community' });
              }}
            />
          )}
          {renderedRightPanel === Panel.Export && (
            <ExportPanel
              exportState={exportState}
              multiSelectedPaths={multiSelectedPaths}
              selectedImage={selectedImage}
              setExportState={setExportState}
              appSettings={appSettings}
              onSettingsChange={handleSettingsChange}
              rootPaths={rootPaths}
            />
          )}
          {renderedRightPanel === Panel.Ai && <AIPanel />}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={clsx('flex grow h-full min-h-0', isCompactPortrait ? 'flex-col gap-2' : 'flex-row')}>
      <div className={clsx('flex-1 flex flex-col min-w-0', isCompactPortrait && 'min-h-0')}>
        {editorNode}
        {!isCompactPortrait && editorBottomBarNode}
      </div>
      <div
        className={clsx(
          'flex overflow-hidden shrink-0',
          isCompactPortrait ? 'flex-col bg-bg-secondary rounded-lg' : 'h-full bg-transparent',
          !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
        )}
        style={
          isCompactPortrait
            ? {
                height: isFullScreen
                  ? '0px'
                  : `${activeRightPanel ? compactEditorPanelHeight : compactEditorPanelCollapsedHeight}px`,
                opacity: isFullScreen ? 0 : 1,
              }
            : {
                maxWidth: isFullScreen ? '0px' : '1000px',
                opacity: isFullScreen ? 0 : 1,
              }
        }
      >
        {isCompactPortrait ? (
          <>
            {activeRightPanel && !isFullScreen && (
              <Resizer
                direction={Orientation.Horizontal}
                onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
              />
            )}
            <div className="min-h-0 flex-1 overflow-hidden">{editorRightPanelContent}</div>
            <div className="shrink-0 border-t border-surface">
              <RightPanelSwitcher
                activePanel={activeRightPanel}
                onPanelSelect={handleRightPanelSelect}
                isInstantTransition={isInstantTransition}
                layout="horizontal"
              />
            </div>
            <div className="shrink-0 border-t border-surface">{editorBottomBarComponent}</div>
          </>
        ) : (
          <>
            <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('right', rightPanelWidth)} />
            <div className="flex bg-bg-secondary rounded-lg h-full">
              <div
                className={clsx(
                  'h-full overflow-hidden',
                  !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
                )}
                style={{ width: activeRightPanel ? `${rightPanelWidth}px` : '0px' }}
              >
                <div style={{ width: `${rightPanelWidth}px` }} className="h-full">
                  {editorRightPanelContent}
                </div>
              </div>
              <div
                className={clsx(
                  'h-full border-l transition-colors',
                  activeRightPanel ? 'border-surface' : 'border-transparent',
                )}
              >
                <RightPanelSwitcher
                  activePanel={activeRightPanel}
                  onPanelSelect={handleRightPanelSelect}
                  isInstantTransition={isInstantTransition}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
