import { type PointerEvent as ReactPointerEvent, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClerkProvider } from '@clerk/react';
import { ToastContainer, toast, Slide } from 'react-toastify';
import clsx from 'clsx';

import TitleBar from './window/TitleBar';
import FolderTree from './components/panel/FolderTree';
import ExportPanel from './components/panel/right/ExportPanel';
import Resizer from './components/ui/Resizer';
import GlobalTooltip from './components/ui/GlobalTooltip';
import AppModals from './components/modals/AppModals';

import EditorView from './components/views/EditorView';
import LibraryView from './components/views/LibraryView';

import { ContextMenuProvider } from './context/ContextMenuContext';
import { useSettingsStore } from './store/useSettingsStore';
import { useUIStore } from './store/useUIStore';
import { useLibraryStore } from './store/useLibraryStore';
import { useEditorStore } from './store/useEditorStore';
import { useProcessStore } from './store/useProcessStore';
import { useShallow } from 'zustand/react/shallow';

import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTauriListeners } from './hooks/useTauriListeners';
import { useFileOperations } from './hooks/useFileOperations';
import { useAppContextMenus } from './hooks/useAppContextMenus';
import { useSortedLibrary } from './hooks/useSortedLibrary';
import { useAppNavigation } from './hooks/useAppNavigation';

import { useEditorActions } from './hooks/useEditorActions';
import { useLibraryActions } from './hooks/useLibraryActions';
import { useProductivityActions } from './hooks/useProductivityActions';

import { useAppInitialization } from './hooks/useAppInitialization';
import './i18n';

import {
  Invokes,
  ImageFile,
  LibraryViewMode,
  Panel,
  Theme,
  Orientation,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from './components/ui/AppProperties';

import ImageProcessingManager from './components/managers/ImageProcessingManager';
import ImageLoaderManager from './components/managers/ImageLoaderManager';

const CLERK_PUBLISHABLE_KEY = 'pk_test_YnJpZWYtc2Vhc25haWwtMTIuY2xlcmsuYWNjb3VudHMuZGV2JA'; // local dev key

const RIGHT_PANEL_ORDER = [
  Panel.Metadata,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
  Panel.Export,
];

const insertChildrenIntoTree = (node: any, targetPath: string, newChildren: any[]): any => {
  if (!node) return null;

  if (node.path === targetPath) {
    const mergedChildren = newChildren.map((newChild: any) => {
      const existingChild = node.children?.find((c: any) => c.path === newChild.path);
      if (existingChild && existingChild.children && existingChild.children.length > 0) {
        return { ...newChild, children: existingChild.children };
      }
      return newChild;
    });
    return { ...node, children: mergedChildren };
  }

  if (node.children && node.children.length > 0) {
    return {
      ...node,
      children: node.children.map((child: any) => insertChildrenIntoTree(child, targetPath, newChildren)),
    };
  }

  return node;
};

function App() {
  const COMPACT_EDITOR_MAX_WIDTH = 900;

  const { appSettings, theme, osPlatform, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      osPlatform: state.osPlatform,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    isFullScreen,
    isWindowFullScreen,
    isInstantTransition,
    isLayoutReady,
    uiVisibility,
    isLibraryExportPanelVisible,
    leftPanelWidth,
    rightPanelWidth,
    compactEditorPanelHeightOverride,
    activeRightPanel,
    setUI,
    setRightPanel,
  } = useUIStore(
    useShallow((state) => ({
      isFullScreen: state.isFullScreen,
      isWindowFullScreen: state.isWindowFullScreen,
      isInstantTransition: state.isInstantTransition,
      isLayoutReady: state.isLayoutReady,
      uiVisibility: state.uiVisibility,
      isLibraryExportPanelVisible: state.isLibraryExportPanelVisible,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelWidth: state.rightPanelWidth,
      compactEditorPanelHeightOverride: state.compactEditorPanelHeightOverride,
      activeRightPanel: state.activeRightPanel,
      setUI: state.setUI,
      setRightPanel: state.setRightPanel,
    })),
  );

  const { rootPaths, currentFolderPath, expandedFolders, multiSelectedPaths, setLibrary } = useLibraryStore(
    useShallow((state) => ({
      rootPaths: state.rootPaths,
      currentFolderPath: state.currentFolderPath,
      expandedFolders: state.expandedFolders,
      multiSelectedPaths: state.multiSelectedPaths,
      setLibrary: state.setLibrary,
    })),
  );

  const { selectedImage, activeMaskContainerId, activeAiPatchContainerId, hasRenderedFirstFrame, setEditor } =
    useEditorStore(
      useShallow((state) => ({
        selectedImage: state.selectedImage,
        activeMaskContainerId: state.activeMaskContainerId,
        activeAiPatchContainerId: state.activeAiPatchContainerId,
        hasRenderedFirstFrame: state.hasRenderedFirstFrame,
        setEditor: state.setEditor,
      })),
    );

  const { exportState, setExportState } = useProcessStore(
    useShallow((state) => ({
      exportState: state.exportState,
      setExportState: state.setExportState,
    })),
  );

  const defaultThumbnailSize = osPlatform === 'android' ? ThumbnailSize.Small : ThumbnailSize.Medium;
  const defaultLibraryViewMode = osPlatform === 'android' ? LibraryViewMode.Recursive : LibraryViewMode.Flat;

  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  const prevAdjustmentsRef = useRef<any>(null);

  const [viewportSize, setViewportSize] = useState<ImageDimensions>(() => {
    if (typeof window === 'undefined') {
      return { width: 0, height: 0 };
    }

    return {
      width: Math.round(window.visualViewport?.width ?? window.innerWidth),
      height: Math.round(window.visualViewport?.height ?? window.innerHeight),
    };
  });

  const isBackendReadyRef = useRef(true);
  const previewJobIdRef = useRef<number>(0);
  const latestRenderedJobIdRef = useRef<number>(0);
  const currentResRef = useRef<number>(1280);
  const cachedEditStateRef = useRef<any | null>(null);

  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(defaultLibraryViewMode);
  const [isResizing, setIsResizing] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState(defaultThumbnailSize);
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState(ThumbnailAspectRatio.Cover);

  const { requestThumbnails, clearThumbnailQueue, markGenerated } = useThumbnails();

  const transformWrapperRef = useRef<any>(null);
  const preloadedDataRef = useRef<{
    trees?: Promise<any>;
    images?: Promise<ImageFile[]>;
    rootPaths?: string[];
    currentPath?: string;
  }>({});

  useAppInitialization({
    preloadedDataRef,
    thumbnailSize,
    setThumbnailSize,
    thumbnailAspectRatio,
    setThumbnailAspectRatio,
    libraryViewMode,
    setLibraryViewMode,
  });

  const isAndroid = osPlatform === 'android';
  const isPortraitViewport = viewportSize.width > 0 && viewportSize.height > viewportSize.width;
  const isCompactPortrait =
    viewportSize.width > 0 && viewportSize.width <= COMPACT_EDITOR_MAX_WIDTH && isPortraitViewport;

  const compactEditorPanelMinHeight = 220;
  const compactEditorPanelMaxHeight =
    viewportSize.height > 0
      ? Math.max(compactEditorPanelMinHeight, Math.min(Math.round(viewportSize.height * 0.85), 850))
      : 520;

  const getDynamicCompactPanelHeight = () => {
    const { originalSize, adjustments } = useEditorStore.getState();
    const halfScreenHeight = viewportSize.height > 0 ? Math.round(viewportSize.height * 0.5) : 340;

    if (!selectedImage || originalSize.width === 0 || originalSize.height === 0 || viewportSize.width === 0) {
      return halfScreenHeight;
    }
    let effectiveRatio = originalSize.width / originalSize.height;
    const orientationSteps = adjustments?.orientationSteps || 0;
    if (orientationSteps % 2 !== 0) {
      effectiveRatio = originalSize.height / originalSize.width;
    }
    if (adjustments?.aspectRatio && adjustments.aspectRatio > 0) {
      effectiveRatio = adjustments.aspectRatio;
    }
    const desiredImageHeight = viewportSize.width / effectiveRatio;
    const topUiEstimation = !appSettings?.decorations && !isWindowFullScreen ? 110 : 60;
    const totalDesiredTopHeight = desiredImageHeight + topUiEstimation;
    const calculatedBottomHeight = Math.round(viewportSize.height - totalDesiredTopHeight);
    return Math.max(halfScreenHeight, calculatedBottomHeight);
  };

  const compactEditorPanelDefaultHeight = getDynamicCompactPanelHeight();
  const compactEditorPanelHeight = Math.max(
    compactEditorPanelMinHeight,
    Math.min(compactEditorPanelHeightOverride ?? compactEditorPanelDefaultHeight, compactEditorPanelMaxHeight),
  );
  const compactEditorPanelCollapsedHeight = 96;

  const { handleCopyAdjustments, handlePasteAdjustments, handleResetAdjustments, handleZoomChange } =
    useEditorActions();

  const navigationRefs = {
    transformWrapperRef,
    preloadedDataRef,
    cachedEditStateRef,
    selectedImagePathRef,
    isBackendReadyRef,
    latestRenderedJobIdRef,
    previewJobIdRef,
    currentResRef,
    prevAdjustmentsRef,
  };

  const {
    handleGoHome,
    handleBackToLibrary,
    handleImageSelect,
    handleSelectSubfolder,
    handleSelectAlbum,
    handleOpenFolder,
    handleContinueSession,
  } = useAppNavigation({
    clearThumbnailQueue,
    refs: navigationRefs,
  });

  const {
    handleRate,
    handleClearSelection,
    handleLibraryImageSingleClick,
    handleImageClick,
    handleSetColorLabel,
    refreshAllFolderTrees,
    handleTogglePinFolder,
    handleCreateAlbumItem,
    handleRenameAlbumItem,
  } = useLibraryActions(handleImageSelect);

  const sortedImageList = useSortedLibrary();

  const handleLibraryRefresh = useCallback(async () => {
    if (currentFolderPath) {
      if (currentFolderPath.startsWith('Album: ')) {
        const { activeAlbumId, albumTree } = useLibraryStore.getState();
        if (activeAlbumId) {
          const findObj = (nodes: any[]): any => {
            for (const n of nodes) {
              if (n.id === activeAlbumId) return n;
              if (n.type === 'group') {
                const f = findObj(n.children);
                if (f) return f;
              }
            }
            return null;
          };
          const album = findObj(albumTree);
          if (album) await handleSelectAlbum(album.id, album.name, album.images);
        }
      } else {
        await handleSelectSubfolder(currentFolderPath, false);
      }
    }
  }, [currentFolderPath, handleSelectSubfolder, handleSelectAlbum]);

  const {
    executeDelete,
    handleDeleteSelected,
    handleCreateFolder,
    handleRenameFolder,
    handleSaveRename,
    handleRenameFiles,
    handleStartImport,
    handleImportClick,
    handlePasteFiles,
  } = useFileOperations(
    handleLibraryRefresh,
    refreshAllFolderTrees,
    handleImageSelect,
    handleBackToLibrary,
    sortedImageList,
  );

  const {
    handleStartPanorama,
    handleSavePanorama,
    handleStartHdr,
    handleSaveHdr,
    handleApplyDenoise,
    handleBatchDenoise,
    handleSaveDenoisedImage,
    handleSaveCollage,
  } = useProductivityActions(handleLibraryRefresh);

  const {
    handleEditorContextMenu,
    handleThumbnailContextMenu,
    handleFolderTreeContextMenu,
    handleAlbumTreeContextMenu,
    handleMainLibraryContextMenu,
  } = useAppContextMenus({
    handleImageSelect,
    handleBackToLibrary,
    handleLibraryRefresh,
    handleRenameFiles,
    handleImportClick,
    refreshAllFolderTrees,
    refreshImageList: handleLibraryRefresh,
    executeDelete,
    handleTogglePinFolder,
  });

  useTauriListeners({
    refreshAllFolderTrees,
    handleSelectSubfolder,
    refreshImageList: handleLibraryRefresh,
    markGenerated,
  });

  const handleToggleFullScreen = useCallback(() => {
    const { zoom, selectedImage } = useEditorStore.getState();
    const currentlyZoomed = zoom > 1.01;
    setUI({ isInstantTransition: currentlyZoomed });

    if (isFullScreen) {
      setUI({ isFullScreen: false });
    } else {
      if (!selectedImage) return;
      setUI({ isFullScreen: true });
    }

    if (currentlyZoomed) {
      setTimeout(() => setUI({ isInstantTransition: false }), 100);
    }
  }, [isFullScreen, setUI]);

  useKeyboardShortcuts({
    sortedImageList,
    handleBackToLibrary,
    handleDeleteSelected,
    handleImageSelect,
    handlePasteFiles,
    handleToggleFullScreen,
    handleZoomChange,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateViewportSize = () => {
      const nextViewportSize = {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
      };

      setViewportSize((prev) =>
        prev.width === nextViewportSize.width && prev.height === nextViewportSize.height ? prev : nextViewportSize,
      );
    };

    updateViewportSize();

    window.addEventListener('resize', updateViewportSize);
    window.addEventListener('orientationchange', updateViewportSize);
    window.visualViewport?.addEventListener('resize', updateViewportSize);

    return () => {
      window.removeEventListener('resize', updateViewportSize);
      window.removeEventListener('orientationchange', updateViewportSize);
      window.visualViewport?.removeEventListener('resize', updateViewportSize);
    };
  }, []);

  useEffect(() => {
    const handleGlobalContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  const isLightTheme = useMemo(() => [Theme.Light, Theme.Snow, Theme.Arctic].includes(theme as Theme), [theme]);

  useEffect(() => {
    if (
      (activeRightPanel !== Panel.Masks || !activeMaskContainerId) &&
      (activeRightPanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setEditor({ isMaskControlHovered: false });
    }
  }, [activeRightPanel, activeMaskContainerId, activeAiPatchContainerId, setEditor]);

  useEffect(() => {
    const unlisten = listen('ai-connector-status-update', (event: any) => {
      setEditor({ isAIConnectorConnected: event.payload.connected });
    });
    invoke(Invokes.CheckAIConnectorStatus);
    const interval = setInterval(() => invoke(Invokes.CheckAIConnectorStatus), 10000);
    return () => {
      clearInterval(interval);
      unlisten.then((f) => f());
    };
  }, [setEditor]);

  const createResizeHandler = (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const pointerId = e.pointerId;
    const target = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;

    const previousTouchAction = document.documentElement.style.touchAction;
    const previousUserSelect = document.documentElement.style.userSelect;

    target.setPointerCapture?.(pointerId);
    document.documentElement.style.touchAction = 'none';
    document.documentElement.style.userSelect = 'none';

    const doDrag = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();

      if (stateKey === 'left') {
        setUI({ leftPanelWidth: Math.round(Math.max(200, Math.min(startSize + (moveEvent.clientX - startX), 500))) });
      } else if (stateKey === 'right') {
        setUI({ rightPanelWidth: Math.round(Math.max(280, Math.min(startSize - (moveEvent.clientX - startX), 600))) });
      } else if (stateKey === 'bottom') {
        setUI({
          bottomPanelHeight: Math.round(Math.max(100, Math.min(startSize - (moveEvent.clientY - startY), 400))),
        });
      } else if (stateKey === 'compact') {
        setUI({
          compactEditorPanelHeightOverride: Math.round(
            Math.max(
              compactEditorPanelMinHeight,
              Math.min(startSize - (moveEvent.clientY - startY), compactEditorPanelMaxHeight),
            ),
          ),
        });
      }
    };

    const stopDrag = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);

      document.documentElement.style.cursor = '';
      document.documentElement.style.touchAction = previousTouchAction;
      document.documentElement.style.userSelect = previousUserSelect;

      window.removeEventListener('pointermove', doDrag);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      setIsResizing(false);
    };
    document.documentElement.style.cursor =
      stateKey === 'bottom' || stateKey === 'compact' ? 'row-resize' : 'col-resize';

    window.addEventListener('pointermove', doDrag, { passive: false });
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const checkFullscreen = async () => {
      setUI({ isWindowFullScreen: await appWindow.isFullscreen() });
    };
    checkFullscreen();
    const unlistenPromise = appWindow.onResized(checkFullscreen);
    return () => {
      unlistenPromise.then((unlisten: any) => unlisten());
    };
  }, [setUI]);

  const handleRightPanelSelect = useCallback(
    (panelId: Panel) => {
      setRightPanel(panelId, RIGHT_PANEL_ORDER);
      setEditor({ activeMaskId: null, activeAiSubMaskId: null, isWbPickerActive: false });
    },
    [setRightPanel, setEditor],
  );

  const handleToggleFolder = useCallback(
    async (path: string) => {
      const isExpanding = !expandedFolders.has(path);
      setLibrary((state) => {
        const newSet = new Set(state.expandedFolders);
        if (isExpanding) {
          newSet.add(path);
        } else {
          newSet.delete(path);
        }
        return { expandedFolders: newSet };
      });
      if (!isExpanding) return;
      try {
        const showCounts = appSettings?.enableFolderImageCounts ?? false;
        const newChildren: any[] = await invoke(Invokes.GetFolderChildren, {
          path,
          showImageCounts: showCounts,
        });
        setLibrary((state) => ({
          folderTrees: state.folderTrees.map((t: any) => insertChildrenIntoTree(t, path, newChildren)),
        }));
        setLibrary((state) => ({
          pinnedFolderTrees: state.pinnedFolderTrees.map((tree) => insertChildrenIntoTree(tree, path, newChildren)),
        }));
      } catch (err) {
        toast.error(`Failed to load folder: ${err}`);
      }
    },
    [expandedFolders, appSettings?.enableFolderImageCounts, setLibrary],
  );

  const hasRoots = rootPaths && rootPaths.length > 0;

  const renderFolderTree = () => {
    if (!hasRoots) return null;

    return (
      <div
        className={clsx(
          'flex h-full overflow-hidden shrink-0',
          !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
        )}
        style={{
          maxWidth: isFullScreen ? '0px' : '1000px',
          opacity: isFullScreen ? 0 : 1,
        }}
      >
        <FolderTree
          isResizing={isResizing}
          isVisible={uiVisibility.folderTree}
          onContextMenu={handleFolderTreeContextMenu}
          onAlbumContextMenu={handleAlbumTreeContextMenu}
          onSelectAlbum={handleSelectAlbum}
          onFolderSelect={(path) => handleSelectSubfolder(path, false)}
          onToggleFolder={handleToggleFolder}
          onOpenFolder={handleOpenFolder}
          setIsVisible={(value: boolean) =>
            setUI((state) => ({ uiVisibility: { ...state.uiVisibility, folderTree: value } }))
          }
          style={{ width: uiVisibility.folderTree ? `${leftPanelWidth}px` : '32px' }}
          isInstantTransition={isInstantTransition}
        />
        <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('left', leftPanelWidth)} />
      </div>
    );
  };

  const shouldHideFolderTree = isAndroid;
  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;
  const useMacWindowShell = osPlatform === 'macos' && !appSettings?.decorations && !isWindowFullScreen && !isFullScreen;

  return (
    <>
      <ImageProcessingManager
        transformWrapperRef={transformWrapperRef}
        prevAdjustmentsRef={prevAdjustmentsRef}
        previewJobIdRef={previewJobIdRef}
        latestRenderedJobIdRef={latestRenderedJobIdRef}
        currentResRef={currentResRef}
      />
      <ImageLoaderManager cachedEditStateRef={cachedEditStateRef} />
      <div
        className={clsx(
          'flex flex-col h-screen font-sans text-text-primary overflow-hidden select-none',
          useMacWindowShell && 'macos-window-shell',
          isWgpuActive ? 'bg-transparent' : 'bg-bg-primary',
        )}
      >
        <div
          className={clsx(
            'shrink-0 overflow-hidden z-50',
            !isInstantTransition && 'transition-all duration-300 ease-in-out',
            isFullScreen ? 'max-h-0 opacity-0 pointer-events-none' : 'max-h-[60px] opacity-100',
          )}
        >
          {appSettings?.decorations || (!isWindowFullScreen && <TitleBar />)}
        </div>
        <div
          className={clsx(
            'flex-1 flex flex-col min-h-0',
            isLayoutReady && hasRoots && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            [hasRoots && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2')],
          )}
        >
          <div className="flex flex-row grow h-full min-h-0">
            {!shouldHideFolderTree && renderFolderTree()}
            <div className="flex-1 flex flex-col min-w-0">
              {selectedImage ? (
                <EditorView
                  transformWrapperRef={transformWrapperRef}
                  isResizing={isResizing}
                  isCompactPortrait={isCompactPortrait}
                  isAndroid={isAndroid}
                  compactEditorPanelHeight={compactEditorPanelHeight}
                  compactEditorPanelCollapsedHeight={compactEditorPanelCollapsedHeight}
                  thumbnailAspectRatio={thumbnailAspectRatio}
                  sortedImageList={sortedImageList}
                  createResizeHandler={createResizeHandler}
                  handleBackToLibrary={handleBackToLibrary}
                  handleEditorContextMenu={handleEditorContextMenu}
                  handleThumbnailContextMenu={handleThumbnailContextMenu}
                  handleImageClick={handleImageClick}
                  handleClearSelection={handleClearSelection}
                  handleCopyAdjustments={handleCopyAdjustments}
                  handlePasteAdjustments={handlePasteAdjustments}
                  handleRate={handleRate}
                  handleZoomChange={handleZoomChange}
                  handleRightPanelSelect={handleRightPanelSelect}
                  requestThumbnails={requestThumbnails}
                />
              ) : (
                <LibraryView
                  sortedImageList={sortedImageList}
                  thumbnailSize={thumbnailSize}
                  thumbnailAspectRatio={thumbnailAspectRatio}
                  libraryViewMode={libraryViewMode}
                  isAndroid={isAndroid}
                  setThumbnailSize={setThumbnailSize}
                  setThumbnailAspectRatio={setThumbnailAspectRatio}
                  setLibraryViewMode={setLibraryViewMode}
                  handleClearSelection={handleClearSelection}
                  handleLibraryImageSingleClick={handleLibraryImageSingleClick}
                  handleImageSelect={handleImageSelect}
                  handleRate={handleRate}
                  handleThumbnailContextMenu={handleThumbnailContextMenu}
                  handleMainLibraryContextMenu={handleMainLibraryContextMenu}
                  handleContinueSession={handleContinueSession}
                  handleGoHome={handleGoHome}
                  handleOpenFolder={handleOpenFolder}
                  handleImportClick={handleImportClick}
                  handleLibraryRefresh={handleLibraryRefresh}
                  handleCopyAdjustments={handleCopyAdjustments}
                  handlePasteAdjustments={handlePasteAdjustments}
                  handleResetAdjustments={handleResetAdjustments}
                  requestThumbnails={requestThumbnails}
                />
              )}
            </div>
            {!selectedImage && isLibraryExportPanelVisible && (
              <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('right', rightPanelWidth)} />
            )}
            <div
              className={clsx(
                'shrink-0 overflow-hidden',
                !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
              )}
              style={{ width: isLibraryExportPanelVisible && !isFullScreen ? `${rightPanelWidth}px` : '0px' }}
            >
              <ExportPanel
                exportState={exportState}
                multiSelectedPaths={multiSelectedPaths}
                selectedImage={null}
                setExportState={setExportState}
                appSettings={appSettings}
                onSettingsChange={handleSettingsChange}
                rootPaths={rootPaths}
                isVisible={isLibraryExportPanelVisible}
                onClose={() => setUI({ isLibraryExportPanelVisible: false })}
              />
            </div>
          </div>
        </div>
        <AppModals
          handleImageSelect={handleImageSelect}
          handleSavePanorama={handleSavePanorama}
          handleStartPanorama={handleStartPanorama}
          handleSaveHdr={handleSaveHdr}
          handleStartHdr={handleStartHdr}
          refreshImageList={handleLibraryRefresh}
          handleApplyDenoise={handleApplyDenoise}
          handleBatchDenoise={handleBatchDenoise}
          handleSaveDenoisedImage={handleSaveDenoisedImage}
          handleCreateFolder={handleCreateFolder}
          handleRenameFolder={handleRenameFolder}
          handleSaveRename={handleSaveRename}
          handleStartImport={handleStartImport}
          handleSetColorLabel={handleSetColorLabel}
          handleRate={handleRate}
          executeDelete={executeDelete}
          handleSaveCollage={handleSaveCollage}
          handleCreateAlbumItem={handleCreateAlbumItem}
          handleRenameAlbumItem={handleRenameAlbumItem}
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
              'bg-surface! text-text-primary! border! border-border-color! shadow-2xl! max-w-[420px]!',
            )
          }
        />
      </div>
    </>
  );
}

const AppWrapper = () => (
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} routerPush={(to) => {}} routerReplace={(to) => {}}>
    <ContextMenuProvider>
      <App />
      <GlobalTooltip />
    </ContextMenuProvider>
  </ClerkProvider>
);

export default AppWrapper;
