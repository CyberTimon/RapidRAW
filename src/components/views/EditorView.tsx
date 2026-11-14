import { type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useDroppable } from '@dnd-kit/core';

import Editor from '../panel/Editor';
import BottomBar from '../panel/BottomBar';
import Resizer from '../ui/Resizer';
import { MobilePanelSwitcher } from '../panel/PanelSwitcher';

import { useEditorStore } from '../../store/useEditorStore';
import { isFilmstripDocked, useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useProcessStore } from '../../store/useProcessStore';
import { getImageFlag } from '../../utils/imageFlags';

import { ImageFile } from '../../types/library';
import { Orientation, Panel } from '../../types/ui';
import { ThumbnailAspectRatio } from '../../types/settings';

interface EditorViewProps {
  transformWrapperRef: RefObject<any>;
  isResizing: boolean;
  layoutMode: 'compact' | 'wide' | 'full';
  isAndroid: boolean;
  compactEditorPanelHeight: number;
  compactEditorPanelCollapsedHeight: number;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  sortedImageList: ImageFile[];
  createResizeHandler: (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => void;
  createResizeResetHandler: (stateKey: string) => () => void;
  handleBackToLibrary: () => void;
  handleEditorContextMenu: (...args: any) => void;
  handleThumbnailContextMenu: (...args: any) => void;
  handleMainLibraryContextMenu?: (...args: any) => void;
  handleImageClick: (...args: any) => void;
  handleClearSelection: () => void;
  handleCopyAdjustments: () => void;
  handlePasteAdjustments: () => void;
  handleRate: (...args: any) => void;
  handleZoomChange: (zoom: number) => void;
  handlePanelSelect: (panelId: any) => void;
  requestThumbnails: any;
  renderAppPanel: (panelId: any) => React.ReactNode;
}

function FilmstripDropzone({ height }: { height: number }) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: 'layout-bottom', data: { type: 'layout-bottom' } });

  return (
    <motion.div
      ref={setNodeRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={clsx(
        'absolute inset-x-0 bottom-0 z-30 rounded-lg border-2 flex items-center justify-center transition-all duration-200 backdrop-blur-sm overflow-hidden',
        isOver
          ? 'scale-[0.98] border-transparent bg-accent/20 text-accent font-semibold'
          : 'border-dashed border-accent/40 bg-bg-secondary/60 text-text-secondary',
      )}
      style={{ height }}
    >
      <span className="text-xs uppercase tracking-wider pointer-events-none">
        {t('editor.switcher.tooltips.filmstrip')}
      </span>
    </motion.div>
  );
}

export default function EditorView({
  transformWrapperRef,
  isResizing,
  layoutMode,
  isAndroid,
  compactEditorPanelHeight,
  compactEditorPanelCollapsedHeight,
  thumbnailAspectRatio,
  sortedImageList,
  createResizeHandler,
  createResizeResetHandler,
  handleBackToLibrary,
  handleEditorContextMenu,
  handleThumbnailContextMenu,
  handleMainLibraryContextMenu,
  handleImageClick,
  handleClearSelection,
  handleCopyAdjustments,
  handlePasteAdjustments,
  handleRate,
  handleZoomChange,
  handlePanelSelect,
  requestThumbnails,
  renderAppPanel,
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
    activePanel,
    isFilmstripInSidePanel,
    isDraggingFilmstrip,
    setUI,
  } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isInstantTransition: state.isInstantTransition,
      uiVisibility: state.uiVisibility,
      bottomPanelHeight: state.bottomPanelHeight,
      activePanel: state.activePanel,
      isFilmstripInSidePanel: layoutMode === 'full' && isFilmstripDocked(state),
      isDraggingFilmstrip: state.activeLayoutDragItem === Panel.Filmstrip,
      setUI: state.setUI,
    })),
  );

  const { multiSelectedPaths, imageRatings, flag, isViewLoading } = useLibraryStore(
    useShallow((state) => ({
      multiSelectedPaths: state.multiSelectedPaths,
      imageRatings: state.imageRatings,
      flag: getImageFlag(state.imageList, selectedImage?.path),
      isViewLoading: state.isViewLoading,
    })),
  );

  const { isCopied, isPasted } = useProcessStore(
    useShallow((state) => ({
      isCopied: state.isCopied,
      isPasted: state.isPasted,
    })),
  );

  const editorNode = (
    <Editor
      onBackToLibrary={handleBackToLibrary}
      onContextMenu={handleEditorContextMenu}
      onImageSelect={handleImageClick}
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
      onEmptyAreaContextMenu={handleMainLibraryContextMenu}
      onCopy={handleCopyAdjustments}
      onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
      onImageSelect={handleImageClick}
      onPaste={() => handlePasteAdjustments()}
      onRate={handleRate}
      onRequestThumbnails={requestThumbnails}
      onZoomChange={handleZoomChange}
      rating={imageRatings[selectedImage?.path || ''] || 0}
      flag={flag}
      selectedImage={selectedImage ?? undefined}
      showFilmstrip={layoutMode !== 'compact'}
      layoutMode={layoutMode}
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
      {layoutMode !== 'compact' &&
        (isFilmstripInSidePanel ? (
          <div className="h-2 shrink-0" />
        ) : (
          <Resizer
            direction={Orientation.Horizontal}
            onMouseDown={createResizeHandler('bottom', bottomPanelHeight)}
            onDoubleClick={createResizeResetHandler('bottom')}
          />
        ))}
      {editorBottomBarComponent}
    </div>
  );

  const editorMobilePanelNode =
    layoutMode === 'compact' ? (
      <div
        className={clsx(
          'flex overflow-hidden shrink-0 flex-col bg-bg-secondary rounded-lg',
          !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
        )}
        style={{
          height: isFullScreen ? 0 : activePanel ? compactEditorPanelHeight : compactEditorPanelCollapsedHeight,
          opacity: isFullScreen ? 0 : 1,
        }}
      >
        {activePanel && !isFullScreen && (
          <Resizer
            direction={Orientation.Horizontal}
            onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
            onDoubleClick={createResizeResetHandler('compact')}
          />
        )}
        <div className="min-h-0 flex-1 overflow-hidden relative">
          <AnimatePresence mode="wait">
            {activePanel && (
              <motion.div
                key={activePanel}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 overflow-y-auto custom-scrollbar"
              >
                {renderAppPanel(activePanel)}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <MobilePanelSwitcher activePanel={activePanel} onPanelSelect={handlePanelSelect} />
        <div className="shrink-0 border-t border-surface">{editorBottomBarComponent}</div>
      </div>
    ) : null;

  return (
    <div className={clsx('flex grow h-full min-h-0', layoutMode === 'compact' ? 'flex-col gap-2' : 'flex-col')}>
      <div className={clsx('relative flex-1 flex flex-col min-w-0', layoutMode === 'compact' && 'min-h-0')}>
        {editorNode}
        <AnimatePresence>
          {isFilmstripInSidePanel && isDraggingFilmstrip && <FilmstripDropzone height={bottomPanelHeight} />}
        </AnimatePresence>
      </div>
      {layoutMode === 'compact' ? editorMobilePanelNode : editorBottomBarNode}
    </div>
  );
}
