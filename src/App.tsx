import { type PointerEvent as ReactPointerEvent, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClerkProvider } from '@clerk/react';
import { ToastContainer, toast, Slide } from 'react-toastify';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  Modifier,
  MeasuringStrategy,
  pointerWithin,
} from '@dnd-kit/core';
import clsx from 'clsx';

import TitleBar from './window/TitleBar';
import FolderTree from './components/panel/right/FolderTree';
import SettingsPanel from './components/panel/SettingsPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import GlobalTooltip from './components/ui/GlobalTooltip';
import AppModals from './components/modals/AppModals';

import SidePanelArea from './components/panel/SidePanelArea';
import { PANEL_ICONS } from './components/panel/PanelSwitcher';
import Controls from './components/panel/right/ControlsPanel';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
import MasksPanel from './components/panel/right/MasksPanel';
import AIPanel from './components/panel/right/AIPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import TetheringPanel from './components/panel/right/TetheringPanel';

import EditorView from './components/views/EditorView';
import LibraryView from './components/views/LibraryView';

import { ContextMenuProvider } from './context/ContextMenuContext';
import { useSettingsStore } from './store/useSettingsStore';
import { DEFAULT_BOTTOM_PANEL_HEIGHT, DEFAULT_PANEL_WIDTH, useUIStore } from './store/useUIStore';
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
import { useExternalEditSession } from './hooks/useExternalEditSession';
import ExternalEditBar from './components/ui/ExternalEditBar';
import { Status } from './components/ui/ExportImportProperties';

import { useEditorActions } from './hooks/useEditorActions';
import { useLibraryActions } from './hooks/useLibraryActions';
import { useProductivityActions } from './hooks/useProductivityActions';

import { useAppInitialization } from './hooks/useAppInitialization';
import { useAndroidBackHandler } from './hooks/useAndroidBackHandler';
import { useConvertedInputConfirmation } from './hooks/useConvertedInputConfirmation';
import { useExternalImageDrop } from './hooks/useExternalImageDrop';
import './i18n';

import {
  Invokes,
  ImageFile,
  LibraryViewMode,
  Panel,
  PanelRegion,
  Theme,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from './components/ui/AppProperties';

import ImageProcessingManager from './components/managers/ImageProcessingManager';
import ImageLoaderManager from './components/managers/ImageLoaderManager';

const CLERK_PUBLISHABLE_KEY = 'pk_test_YnJpZWYtc2Vhc25haWwtMTIuY2xlcmsuYWNjb3VudHMuZGV2JA'; // local dev key

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

const imageDragModifier: Modifier = ({ active, activatorEvent, activeNodeRect, transform }) => {
  if (active?.data?.current?.type === 'library-image' && activatorEvent && activeNodeRect) {
    const event = activatorEvent as any;
    const startX = event.clientX ?? event.touches?.[0]?.clientX ?? 0;
    const startY = event.clientY ?? event.touches?.[0]?.clientY ?? 0;

    if (startX === 0 && startY === 0) return transform;

    const offsetX = startX - activeNodeRect.left - 48;
    const offsetY = startY - activeNodeRect.top - 48;

    return {
      ...transform,
      x: transform.x + offsetX,
      y: transform.y + offsetY,
    };
  }
  return transform;
};

function ImageDragOverlayNode({ activeItem }: { activeItem: { path: string; paths: string[] } }) {
  const url = useProcessStore.getState().thumbnails[activeItem.path];
  const count = activeItem.paths.length;

  return (
    <div className="w-24 h-24 rounded-lg shadow-2xl border-2 border-accent relative bg-surface overflow-hidden flex items-center justify-center">
      {url && <img src={url} className="w-full h-full object-cover" />}
      {count > 1 && (
        <div className="absolute top-1 right-1 bg-accent text-button-text text-xs font-bold px-2 py-0.5 rounded-full shadow-md z-10">
          {count}
        </div>
      )}
    </div>
  );
}

function App() {
  const COMPACT_EDITOR_MAX_WIDTH = 900;
  const ANDROID_PHONE_MAX_WIDTH = 600;

  const [activeImageDragItem, setActiveImageDragItem] = useState<{ path: string; paths: string[] } | null>(null);

  const { appSettings, theme, osPlatform, handleSettingsChange } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      osPlatform: state.osPlatform,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    activeView,
    isFullScreen,
    isWindowFullScreen,
    isInstantTransition,
    isLayoutReady,
    uiVisibility,
    isLibraryExportPanelVisible,
    leftPanelWidth,
    rightPanelWidth,
    compactEditorPanelHeightOverride,
    activePanel,
    activeLayoutDragItem,
    isSettingsOpen,
    setUI,
    setPanel,
    setLayoutDragItem,
    movePanel,
  } = useUIStore(
    useShallow((state) => ({
      activeView: state.activeView,
      isFullScreen: state.isFullScreen,
      isWindowFullScreen: state.isWindowFullScreen,
      isInstantTransition: state.isInstantTransition,
      isLayoutReady: state.isLayoutReady,
      uiVisibility: state.uiVisibility,
      isLibraryExportPanelVisible: state.isLibraryExportPanelVisible,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelWidth: state.rightPanelWidth,
      compactEditorPanelHeightOverride: state.compactEditorPanelHeightOverride,
      activePanel: state.activePanel,
      activeLayoutDragItem: state.activeLayoutDragItem,
      isSettingsOpen: state.isSettingsOpen,
      setUI: state.setUI,
      setPanel: state.setPanel,
      setLayoutDragItem: state.setLayoutDragItem,
      movePanel: state.movePanel,
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
  const compactEditorMaxWidth = isAndroid ? ANDROID_PHONE_MAX_WIDTH : COMPACT_EDITOR_MAX_WIDTH;
  const isCompactPortrait = viewportSize.width > 0 && viewportSize.width <= compactEditorMaxWidth && isPortraitViewport;
  const useCompactAndroidPanels = isAndroid && isCompactPortrait;

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

  const { confirmConvertedInputs } = useConvertedInputConfirmation();
  const handleImageSelectWithConfirmation = useCallback(
    async (path: string, openInEditor: boolean = true) => {
      if (!(await confirmConvertedInputs([path]))) return false;
      await handleImageSelect(path, openInEditor);
      return true;
    },
    [confirmConvertedInputs, handleImageSelect],
  );

  useExternalImageDrop(handleImageSelectWithConfirmation);

  const {
    externalEditSession,
    isFinishing: isExternalEditFinishing,
    finishExternalEdit,
  } = useExternalEditSession(handleImageSelectWithConfirmation);

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
  } = useLibraryActions(handleImageSelectWithConfirmation);

  const { displayList: sortedImageList, badges: groupBadgeInfo } = useSortedLibrary();

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
          if (album) await handleSelectAlbum(album.id, album.name, album.images, true);
        }
      } else {
        await handleSelectSubfolder(currentFolderPath, false, undefined, false, true);
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
    handleImageSelectWithConfirmation,
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
    handleStartFocusStack,
    handleSaveFocusStack,
  } = useProductivityActions(handleLibraryRefresh);

  const {
    handleEditorContextMenu,
    handleThumbnailContextMenu,
    handleFolderTreeContextMenu,
    handleAlbumTreeContextMenu,
    handleMainLibraryContextMenu,
  } = useAppContextMenus({
    handleImageSelect: handleImageSelectWithConfirmation,
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

  useAndroidBackHandler();

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
    handleGoHome,
    handleImageSelect: handleImageSelectWithConfirmation,
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
      (activePanel !== Panel.Masks || !activeMaskContainerId) &&
      (activePanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setEditor({ isMaskControlHovered: false });
    }
  }, [activePanel, activeMaskContainerId, activeAiPatchContainerId, setEditor]);

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
        let w = startSize + (moveEvent.clientX - startX);
        if (w < 200) {
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, leftPanel: false } }));
        } else {
          w = Math.min(w, 600);
          setUI((state) => ({
            leftPanelWidth: Math.round(w),
            uiVisibility: { ...state.uiVisibility, leftPanel: true },
          }));
        }
      } else if (stateKey === 'right') {
        let w = startSize - (moveEvent.clientX - startX);
        if (w < 200) {
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, rightPanel: false } }));
        } else {
          w = Math.min(w, 600);
          setUI((state) => ({
            rightPanelWidth: Math.round(w),
            uiVisibility: { ...state.uiVisibility, rightPanel: true },
          }));
        }
      } else if (stateKey === 'bottom') {
        const newHeight = startSize - (moveEvent.clientY - startY);
        if (newHeight < 100) {
          setUI((state) => ({
            uiVisibility: { ...state.uiVisibility, filmstrip: false },
          }));
        } else {
          setUI((state) => ({
            bottomPanelHeight: Math.round(Math.min(newHeight, 400)),
            uiVisibility: { ...state.uiVisibility, filmstrip: true },
          }));
        }
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

  const createResizeResetHandler = (stateKey: string) => () => {
    if (stateKey === 'left') {
      setUI((state) => ({
        leftPanelWidth: DEFAULT_PANEL_WIDTH,
        uiVisibility: { ...state.uiVisibility, leftPanel: true },
      }));
    } else if (stateKey === 'right') {
      setUI((state) => ({
        rightPanelWidth: DEFAULT_PANEL_WIDTH,
        uiVisibility: { ...state.uiVisibility, rightPanel: true },
      }));
    } else if (stateKey === 'bottom') {
      setUI((state) => ({
        bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
        uiVisibility: { ...state.uiVisibility, filmstrip: true },
      }));
    } else if (stateKey === 'compact') {
      setUI({ compactEditorPanelHeightOverride: null });
    }
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

  const handlePanelSelect = useCallback(
    (panelId: Panel) => {
      setPanel(panelId);
      setEditor({ activeMaskId: null, activeAiSubMaskId: null, isWbPickerActive: false });
    },
    [setPanel, setEditor],
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

  const renderAppPanel = useCallback(
    (panelId: Panel) => {
      switch (panelId) {
        case Panel.FolderTree:
          return (
            <FolderTree
              isResizing={isResizing}
              onContextMenu={handleFolderTreeContextMenu}
              onAlbumContextMenu={handleAlbumTreeContextMenu}
              onSelectAlbum={handleSelectAlbum}
              onFolderSelect={(path) => handleSelectSubfolder(path, false)}
              onToggleFolder={handleToggleFolder}
              onOpenFolder={handleOpenFolder}
              style={{ width: '100%', height: '100%' }}
              isInstantTransition={isInstantTransition}
            />
          );
        case Panel.Export:
          return (
            <ExportPanel
              exportState={exportState}
              multiSelectedPaths={multiSelectedPaths}
              selectedImage={selectedImage}
              setExportState={setExportState}
              appSettings={appSettings}
              onSettingsChange={handleSettingsChange}
              rootPaths={rootPaths}
              isVisible={true}
              onClose={() => setUI({ isLibraryExportPanelVisible: false })}
            />
          );
        case Panel.Adjustments:
          return <Controls />;
        case Panel.Metadata:
          return <MetadataPanel />;
        case Panel.Crop:
          return <CropPanel />;
        case Panel.Masks:
          return <MasksPanel />;
        case Panel.Ai:
          return <AIPanel />;
        case Panel.Presets:
          return <PresetsPanel onNavigateToCommunity={() => setUI({ activeView: 'community' })} />;
        case Panel.Tethering:
          return (
            <TetheringPanel onLibraryRefresh={handleLibraryRefresh} onImageSelect={handleImageSelectWithConfirmation} />
          );
        default:
          return null;
      }
    },
    [
      isResizing,
      handleFolderTreeContextMenu,
      handleAlbumTreeContextMenu,
      handleSelectAlbum,
      handleSelectSubfolder,
      handleToggleFolder,
      handleOpenFolder,
      setUI,
      isInstantTransition,
      exportState,
      multiSelectedPaths,
      selectedImage,
      setExportState,
      appSettings,
      handleSettingsChange,
      rootPaths,
    ],
  );

  const hasRoots = rootPaths && rootPaths.length > 0;
  const hasMainContent = hasRoots || (activeView === 'editor' && !!selectedImage);

  const shouldHideFolderTree = useCompactAndroidPanels;
  const isWgpuActive =
    activeView === 'editor' &&
    appSettings?.useWgpuRenderer !== false &&
    selectedImage?.isReady &&
    hasRenderedFirstFrame;
  const useMacWindowShell = osPlatform === 'macos' && !appSettings?.decorations && !isWindowFullScreen && !isFullScreen;

  const layoutSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragStart = (e: any) => {
    if (e.active.data.current?.type === 'layout-tab') {
      setLayoutDragItem(e.active.data.current.panel as Panel);
    } else if (e.active.data.current?.type === 'library-image') {
      const path = e.active.data.current.path;
      const multiSelected = useLibraryStore.getState().multiSelectedPaths;
      const paths = multiSelected.includes(path) ? multiSelected : [path];
      setActiveImageDragItem({ path, paths });
    }
  };

  const handleDragEnd = (e: any) => {
    setLayoutDragItem(null);
    setActiveImageDragItem(null);
    const { active, over } = e;

    if (active.data.current?.type === 'layout-tab' && over?.data.current?.type === 'layout-region') {
      movePanel(active.data.current.panel as Panel, over.data.current.region as PanelRegion);
    }

    if (active.data.current?.type === 'library-image' && over?.data.current?.type === 'folder') {
      const targetFolder = over.data.current.path;
      const sourcePaths = activeImageDragItem?.paths || [active.data.current.path];

      invoke(Invokes.MoveFiles, { sourcePaths, destinationFolder: targetFolder })
        .then(() => {
          refreshAllFolderTrees();
          handleLibraryRefresh();
          useLibraryStore.getState().setLibrary({ multiSelectedPaths: [] });
        })
        .catch((err) => {
          toast.error(`Failed to move files: ${err}`);
        });
    }

    if (active.data.current?.type === 'library-image' && over?.data.current?.type === 'album') {
      const targetAlbumId = over.data.current.id;
      const sourcePaths = activeImageDragItem?.paths || [active.data.current.path];

      invoke(Invokes.AddToAlbum, { albumId: targetAlbumId, paths: sourcePaths })
        .then(() => invoke(Invokes.GetAlbums))
        .then((updatedTree: any) => {
          useLibraryStore.getState().setLibrary({ albumTree: updatedTree, multiSelectedPaths: [] });
          handleLibraryRefresh();
        })
        .catch((err) => {
          toast.error(`Failed to add to album: ${err}`);
        });
    }
  };

  const ActiveOverlayIcon = activeLayoutDragItem ? PANEL_ICONS[activeLayoutDragItem] : null;
  const effectiveLeftWidth = uiVisibility.leftPanel ? leftPanelWidth : 48;
  const effectiveRightWidth = uiVisibility.rightPanel ? rightPanelWidth : 48;

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
        {!isAndroid && (
          <div
            className={clsx(
              'shrink-0 overflow-hidden z-50',
              !isInstantTransition && 'transition-all duration-300 ease-in-out',
              isFullScreen ? 'max-h-0 opacity-0 pointer-events-none' : 'max-h-15 opacity-100',
            )}
          >
            {appSettings?.decorations || (!isWindowFullScreen && <TitleBar />)}
          </div>
        )}
        <div
          className={clsx(
            'flex-1 flex flex-col min-h-0',
            isLayoutReady && hasMainContent && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            [hasMainContent && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2')],
          )}
        >
          <DndContext
            sensors={layoutSensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            collisionDetection={pointerWithin}
            measuring={{
              droppable: {
                strategy: MeasuringStrategy.Always,
              },
            }}
          >
            <div className="flex flex-row grow h-full min-h-0">
              {!shouldHideFolderTree && hasMainContent && (
                <SidePanelArea
                  side="left"
                  width={effectiveLeftWidth}
                  topRegion="leftTop"
                  bottomRegion="leftBottom"
                  renderPanel={renderAppPanel}
                  onWidthChange={createResizeHandler('left', effectiveLeftWidth)}
                  onWidthReset={createResizeResetHandler('left')}
                  isResizing={isResizing}
                />
              )}
              <div className="relative flex-1 flex flex-col min-w-0">
                {selectedImage && externalEditSession && (
                  <ExternalEditBar
                    session={externalEditSession}
                    isFinishing={isExternalEditFinishing}
                    errorMessage={exportState.status === Status.Error ? exportState.errorMessage : ''}
                    onDone={finishExternalEdit}
                  />
                )}
                <div
                  className={clsx(
                    'flex-1 flex flex-col min-w-0 h-full',
                    activeView === 'editor' && selectedImage ? 'flex' : 'hidden',
                  )}
                >
                  {selectedImage && (
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
                      createResizeResetHandler={createResizeResetHandler}
                      handleBackToLibrary={handleBackToLibrary}
                      handleEditorContextMenu={handleEditorContextMenu}
                      handleThumbnailContextMenu={handleThumbnailContextMenu}
                      handleMainLibraryContextMenu={handleMainLibraryContextMenu}
                      handleImageClick={handleImageClick}
                      handleClearSelection={handleClearSelection}
                      handleCopyAdjustments={handleCopyAdjustments}
                      handlePasteAdjustments={handlePasteAdjustments}
                      handleRate={handleRate}
                      handleZoomChange={handleZoomChange}
                      handlePanelSelect={handlePanelSelect}
                      requestThumbnails={requestThumbnails}
                      renderAppPanel={renderAppPanel}
                    />
                  )}
                </div>
                <div
                  className={clsx(
                    'flex-1 flex flex-col min-w-0 h-full',
                    activeView === 'editor' && selectedImage ? 'hidden' : 'flex',
                  )}
                >
                  <LibraryView
                    sortedImageList={sortedImageList}
                    groupBadgeInfo={groupBadgeInfo}
                    thumbnailSize={thumbnailSize}
                    thumbnailAspectRatio={thumbnailAspectRatio}
                    libraryViewMode={libraryViewMode}
                    isAndroid={isAndroid}
                    setThumbnailSize={setThumbnailSize}
                    setThumbnailAspectRatio={setThumbnailAspectRatio}
                    setLibraryViewMode={setLibraryViewMode}
                    handleClearSelection={handleClearSelection}
                    handleLibraryImageSingleClick={handleLibraryImageSingleClick}
                    handleImageSelect={handleImageSelectWithConfirmation}
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
                </div>
                {isSettingsOpen && appSettings && hasRoots && (
                  <div className="absolute inset-0 z-50 flex bg-bg-secondary rounded-lg">
                    <div className="w-full h-full flex flex-col p-4 lg:p-8 overflow-y-auto custom-scrollbar">
                      <SettingsPanel
                        appSettings={appSettings}
                        onBack={() => setUI({ isSettingsOpen: false })}
                        onLibraryRefresh={handleLibraryRefresh}
                        onSettingsChange={handleSettingsChange}
                        rootPaths={rootPaths}
                      />
                    </div>
                  </div>
                )}
              </div>
              {!useCompactAndroidPanels && hasMainContent && (
                <SidePanelArea
                  side="right"
                  width={effectiveRightWidth}
                  topRegion="rightTop"
                  bottomRegion="rightBottom"
                  renderPanel={renderAppPanel}
                  onWidthChange={createResizeHandler('right', effectiveRightWidth)}
                  onWidthReset={createResizeResetHandler('right')}
                  isResizing={isResizing}
                />
              )}
            </div>
            <DragOverlay modifiers={activeImageDragItem ? [imageDragModifier] : undefined} dropAnimation={null}>
              {activeLayoutDragItem && ActiveOverlayIcon ? (
                <div className="w-10 h-10 bg-surface shadow-2xl rounded-md flex items-center justify-center text-text-primary ring-1 ring-border-color">
                  <ActiveOverlayIcon size={20} />
                </div>
              ) : null}
              {activeImageDragItem ? <ImageDragOverlayNode activeItem={activeImageDragItem} /> : null}
            </DragOverlay>
          </DndContext>
        </div>
        <AppModals
          handleImageSelect={handleImageSelectWithConfirmation}
          handleSavePanorama={handleSavePanorama}
          handleStartPanorama={handleStartPanorama}
          handleStartFocusStack={handleStartFocusStack}
          handleSaveFocusStack={handleSaveFocusStack}
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
