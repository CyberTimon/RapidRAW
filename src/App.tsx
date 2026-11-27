import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCloudStore } from './store/useCloudStore';
import { ToastContainer, toast, Slide } from 'react-toastify';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, MeasuringStrategy } from '@dnd-kit/core';
import clsx from 'clsx';

import TitleBar from './window/TitleBar';
import FolderTree from './components/panel/right/FolderTree';
import SettingsPanel from './components/panel/SettingsPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import GlobalTooltip from './components/ui/GlobalTooltip';
import AppModals from './components/modals/AppModals';

import SidePanelArea from './components/panel/SidePanelArea';
import { PANEL_ICONS } from './components/panel/PanelSwitcher';
import DockedFilmstrip from './components/panel/DockedFilmstrip';
import { ToolTileOverlay } from './components/ui/ToolTile';
import { getDropPlacement, layoutCollisionDetection, type LayoutDropData } from './utils/layoutDrop';
import Controls from './components/panel/right/ControlsPanel';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
import AdjustmentSliderResetProvider from './components/adjustments/AdjustmentSliderResetProvider';
import LookSliderKeyframes from './components/video/inspector/LookSliderKeyframes';
import MasksPanel from './components/panel/right/MasksPanel';
import AIPanel from './components/panel/right/AIPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import TetheringPanel from './components/panel/right/TetheringPanel';
import ProjectPanel from './components/video/ProjectPanel';
import InspectorPanel from './components/video/inspector/InspectorPanel';
import EffectsPanel from './components/video/EffectsPanel';
import CaptionsPanel from './components/video/CaptionsPanel';
import MixerPanel from './components/video/MixerPanel';
import LookPanelFrame from './components/video/LookPanelFrame';
import {
  TimelineDragOverlay,
  draggedPaths,
  dropEffectOnTimeline,
  dropMediaOnTimeline,
} from './components/video/timeline/drop';
import type { VideoDragData } from './components/video/EffectsPanel';
import {
  BIN_DRAG,
  FileDropTarget,
  ProjectThumbnails,
  dropOnProject,
  projectCloseGuard,
} from './store/videoIntegration';

import EditorView from './components/views/EditorView';
import LibraryView from './components/views/LibraryView';

import { ContextMenuProvider } from './context/ContextMenuContext';
import { useSettingsStore } from './store/useSettingsStore';
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  MAX_TIMELINE_SHARE,
  defaultTimelineHeight,
  getReopenedPanelWidth,
  usableActivePanel,
  useUIStore,
} from './store/useUIStore';
import { useLibraryStore } from './store/useLibraryStore';
import { canvasToolState, useEditorStore } from './store/useEditorStore';
import { JobKind, useProcessStore } from './store/useProcessStore';
import { useShallow } from 'zustand/react/shallow';

import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useTauriListeners } from './hooks/useTauriListeners';
import { transferFiles, useFileOperations } from './hooks/useFileOperations';
import { useAppContextMenus } from './hooks/useAppContextMenus';
import { useSortedLibrary } from './hooks/useSortedLibrary';
import { useImagePreloader } from './hooks/useImagePreloader';
import { useAppNavigation } from './hooks/useAppNavigation';
import { useExternalEditSession } from './hooks/useExternalEditSession';
import ExternalEditBar from './components/panel/ExternalEditBar';
import { Status } from './types/export';

import { useEditorActions } from './hooks/useEditorActions';
import { useLibraryActions } from './hooks/useLibraryActions';
import { useProductivityActions } from './hooks/useProductivityActions';

import { useAppInitialization } from './hooks/useAppInitialization';
import { useAndroidBackHandler } from './hooks/useAndroidBackHandler';
import './i18n';

import { Invokes } from './types/invokes';
import { ImageFile } from './types/library';
import { LibraryViewMode, Theme, ThumbnailSize, ThumbnailAspectRatio } from './types/settings';
import { Panel, PanelRegion } from './types/ui';

import ImageProcessingManager from './components/managers/ImageProcessingManager';
import ImageLoaderManager from './components/managers/ImageLoaderManager';
import { isImmichAlbumId } from './utils/immichApi';
import { guardWindowClose, watchWindowClose } from './utils/windowClose';
import { useImmichEvents } from './hooks/useImmichEvents';

const DND_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };
const LAYOUT_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };
const FOLDER_TREE_STYLE = { width: '100%', height: '100%' };

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

const pointerOf = (event: Event | null) => {
  const source = event as (Partial<PointerEvent> & { touches?: TouchList }) | null;
  const x = source?.clientX ?? source?.touches?.[0]?.clientX;
  const y = source?.clientY ?? source?.touches?.[0]?.clientY;
  return x === undefined || y === undefined ? null : { x, y };
};

type Point = { x: number; y: number };

type Grab = Point & { fx: number; fy: number };

const grabOf = (e: { activatorEvent: Event | null; active: { rect: { current: { initial: DOMRect | null } } } }) => {
  const start = pointerOf(e.activatorEvent);
  const rect = e.active.rect.current.initial;
  if (!start) return null;
  const share = (offset: number, length: number) => (length > 0 ? Math.min(1, Math.max(0, offset / length)) : 0.5);
  return {
    ...start,
    fx: rect ? share(start.x - rect.left, rect.width) : 0.5,
    fy: rect ? share(start.y - rect.top, rect.height) : 0.5,
  };
};

let lastPointer: Point | null = null;

const trackPointer = (event: PointerEvent) => {
  lastPointer = { x: event.clientX, y: event.clientY };
};

const dropPoint = (e: { activatorEvent: Event | null; delta: Point }): Point => {
  if (lastPointer) return lastPointer;
  const start = pointerOf(e.activatorEvent) ?? { x: 0, y: 0 };
  return { x: start.x + e.delta.x, y: start.y + e.delta.y };
};

function CursorChip({ grab, children }: { grab: Grab | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const fx = grab?.fx ?? 0.5;
    const fy = grab?.fy ?? 0.5;
    const place = (x: number, y: number) => {
      node.style.transform = `translate3d(${x - fx * node.offsetWidth}px, ${y - fy * node.offsetHeight}px, 0)`;
    };
    place(lastPointer?.x ?? grab?.x ?? -9999, lastPointer?.y ?? grab?.y ?? -9999);
    const follow = (event: PointerEvent) => place(event.clientX, event.clientY);
    window.addEventListener('pointermove', follow, true);
    return () => window.removeEventListener('pointermove', follow, true);
  }, [grab]);
  return createPortal(
    <div ref={ref} className="fixed left-0 top-0 z-[999] pointer-events-none">
      {children}
    </div>,
    document.body,
  );
}

function DragChip({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: 'easeOut' }}
      style={{ transformOrigin: 'center' }}
    >
      {children}
    </motion.div>
  );
}

function ImageDragOverlayNode({ activeItem }: { activeItem: { path: string; paths: string[] } }) {
  const url = useProcessStore.getState().thumbnails[activeItem.path];
  const count = activeItem.paths.length;

  return (
    <DragChip>
      <div className="relative w-18 h-18">
        {count > 1 && (
          <div className="absolute inset-0 translate-x-1 -translate-y-1 rounded-lg bg-surface ring-1 ring-border-color/60 shadow-lg" />
        )}
        <div className="absolute inset-0 rounded-lg shadow-xl ring-2 ring-accent bg-surface overflow-hidden">
          {url && <img src={url} className="w-full h-full object-cover" />}
        </div>
        {count > 1 && (
          <div className="absolute -top-2 -right-2 min-w-5 h-5 px-1.5 flex items-center justify-center bg-accent text-button-text text-[11px] font-semibold rounded-full shadow-md">
            {count}
          </div>
        )}
      </div>
    </DragChip>
  );
}

function App() {
  const [activeImageDragItem, setActiveImageDragItem] = useState<{ path: string; paths: string[] } | null>(null);
  const [activeVideoDrag, setActiveVideoDrag] = useState<
    (Pick<VideoDragData, 'label' | 'icon'> & { tile: boolean }) | null
  >(null);
  const [dragGrab, setDragGrab] = useState<Grab | null>(null);

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
    leftPanelWidth,
    rightPanelWidth,
    compactEditorPanelHeightOverride,
    activePanel,
    activeLayoutDragItem,
    isSettingsOpen,
    setUI,
    setPanel,
    setLayoutDragItem,
    dropPanel,
    dockFilmstripToBottom,
  } = useUIStore(
    useShallow((state) => ({
      activeView: state.activeView,
      isFullScreen: state.isFullScreen,
      isWindowFullScreen: state.isWindowFullScreen,
      isInstantTransition: state.isInstantTransition,
      isLayoutReady: state.isLayoutReady,
      uiVisibility: state.uiVisibility,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelWidth: state.rightPanelWidth,
      compactEditorPanelHeightOverride: state.compactEditorPanelHeightOverride,
      activePanel: usableActivePanel(state),
      activeLayoutDragItem: state.activeLayoutDragItem,
      isSettingsOpen: state.isSettingsOpen,
      setUI: state.setUI,
      setPanel: state.setPanel,
      setLayoutDragItem: state.setLayoutDragItem,
      dropPanel: state.dropPanel,
      dockFilmstripToBottom: state.dockFilmstripToBottom,
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

  const { selectedImage, activeMaskContainerId, activeAiPatchContainerId, wgpuPhase, setEditor } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      activeMaskContainerId: state.activeMaskContainerId,
      activeAiPatchContainerId: state.activeAiPatchContainerId,
      wgpuPhase: state.wgpuPhase,
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
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState(ThumbnailAspectRatio.Contain);

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
  const COMPACT_EDITOR_MAX_WIDTH = 900;
  const ANDROID_COMPACT_MAX_WIDTH = 600;
  const ANDROID_FULL_MIN_WIDTH = 1000;

  const isPortraitViewport = viewportSize.width > 0 && viewportSize.height > viewportSize.width;

  type LayoutMode = 'compact' | 'wide' | 'full';
  const layoutMode: LayoutMode = isAndroid
    ? viewportSize.width >= ANDROID_FULL_MIN_WIDTH
      ? 'full'
      : isPortraitViewport && viewportSize.width < ANDROID_COMPACT_MAX_WIDTH
        ? 'compact'
        : 'wide'
    : isPortraitViewport && viewportSize.width > 0 && viewportSize.width <= COMPACT_EDITOR_MAX_WIDTH
      ? 'compact'
      : 'full';

  const useCompactPanels = layoutMode === 'compact';
  const useWidePanels = layoutMode === 'wide';
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
  const timelineMaxHeight = Math.round(viewportSize.height * MAX_TIMELINE_SHARE);

  const { handleCopyAdjustments, handlePasteAdjustments, handleResetAdjustments, handleZoomChange } =
    useEditorActions();

  const navigationRefs = useMemo(
    () => ({
      transformWrapperRef,
      preloadedDataRef,
      cachedEditStateRef,
      selectedImagePathRef,
      isBackendReadyRef,
      latestRenderedJobIdRef,
      previewJobIdRef,
      currentResRef,
      prevAdjustmentsRef,
    }),
    [],
  );

  const {
    handleGoHome,
    handleBackToLibrary,
    handleImageSelect,
    handleSelectSubfolder,
    handleSelectAlbum,
    handleOpenFolder,
    handleOpenContainingFolder,
    handleNavBack,
    handleNavForward,
    handleContinueSession,
  } = useAppNavigation({
    clearThumbnailQueue,
    refs: navigationRefs,
  });

  const {
    externalEditSession,
    isFinishing: isExternalEditFinishing,
    finishExternalEdit,
  } = useExternalEditSession(handleImageSelect, handleOpenContainingFolder);

  const {
    handleRate,
    handleClearSelection,
    handleLibraryImageSingleClick,
    handleImageClick,
    handleSetFlag,
    refreshAllFolderTrees,
    handleTogglePinFolder,
    handleCreateAlbumItem,
    handleRenameAlbumItem,
  } = useLibraryActions(handleImageSelect);

  useEffect(() => {
    const { setImageSelectHandler } = useUIStore.getState();
    setImageSelectHandler(handleImageSelect);
    return () => setImageSelectHandler(null);
  }, [handleImageSelect]);

  const { displayList: sortedImageList, badges: groupBadgeInfo } = useSortedLibrary();
  useImagePreloader(sortedImageList);

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
          else if (isImmichAlbumId(activeAlbumId))
            await handleSelectAlbum(activeAlbumId, currentFolderPath.slice('Album: '.length), [], true);
        }
      } else {
        await handleSelectSubfolder(currentFolderPath, false, undefined, false, true);
      }
    }
  }, [currentFolderPath, handleSelectSubfolder, handleSelectAlbum]);

  useEffect(() => {
    const { setLibraryRefreshHandler } = useUIStore.getState();
    setLibraryRefreshHandler(handleLibraryRefresh);
    return () => setLibraryRefreshHandler(null);
  }, [handleLibraryRefresh]);

  const {
    executeDelete,
    handleDeleteSelected,
    handleDeleteRejected,
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

  const { handleMergeSettingsChange, handleSaveCollage, handleSaveMerge, handleStartMerge } =
    useProductivityActions(handleLibraryRefresh);

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
    handleDeleteRejected,
    handleTogglePinFolder,
  });

  useImmichEvents(handleLibraryRefresh);

  useTauriListeners({
    refreshAllFolderTrees,
    handleSelectSubfolder,
    refreshImageList: handleLibraryRefresh,
    markGenerated,
    prevAdjustmentsRef,
  });

  useAndroidBackHandler();

  useKeyboardShortcuts({
    sortedImageList,
    handleBackToLibrary,
    handleDeleteSelected,
    handleDeleteRejected,
    handleGoHome,
    handleImageSelect,
    handlePasteFiles,
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
    setEditor({
      ...canvasToolState(),
      isStraightenActive: false,
      isGuidedPerspectiveActive: false,
      activeMaskId: null,
      activeAiSubMaskId: null,
    });
  }, [activePanel, activeView, setEditor]);

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
      } else if (stateKey === 'timeline') {
        const newHeight = startSize - (moveEvent.clientY - startY);
        setUI(
          newHeight < 100
            ? { timelineCollapsed: true }
            : { timelineHeight: Math.round(Math.min(newHeight, timelineMaxHeight)), timelineCollapsed: false },
        );
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

    document.documentElement.style.cursor = ['bottom', 'timeline', 'compact'].includes(stateKey)
      ? 'row-resize'
      : 'col-resize';

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
    } else if (stateKey === 'timeline') {
      setUI({ timelineHeight: defaultTimelineHeight(), timelineCollapsed: false });
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

  useEffect(() => {
    const unguard = guardWindowClose(projectCloseGuard);
    const unlisten = watchWindowClose();
    return () => {
      unguard();
      void unlisten.then((stop) => stop());
    };
  }, []);

  const handlePanelSelect = useCallback(
    (panelId: Panel) => {
      setPanel(panelId);
    },
    [setPanel],
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

  const handleTreeSelectAlbum = useCallback(
    (id: string, name: string, images: string[], skipHistory?: boolean) =>
      handleSelectAlbum(id, name, images, false, skipHistory),
    [handleSelectAlbum],
  );

  const handleTreeFolderSelect = useCallback(
    (path: string, skipHistory?: boolean) => handleSelectSubfolder(path, false, undefined, true, false, skipHistory),
    [handleSelectSubfolder],
  );

  const handleNavigateToFolder = useCallback(
    (path: string) => handleSelectSubfolder(path, false, undefined, true),
    [handleSelectSubfolder],
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
              onSelectAlbum={handleTreeSelectAlbum}
              onFolderSelect={handleTreeFolderSelect}
              onToggleFolder={handleToggleFolder}
              onOpenFolder={handleOpenFolder}
              onNavBack={handleNavBack}
              onNavForward={handleNavForward}
              style={FOLDER_TREE_STYLE}
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
          return (
            <LookPanelFrame>
              <AdjustmentSliderResetProvider>
                <LookSliderKeyframes>
                  <Controls />
                </LookSliderKeyframes>
              </AdjustmentSliderResetProvider>
            </LookPanelFrame>
          );
        case Panel.Metadata:
          return <MetadataPanel />;
        case Panel.Crop:
          return (
            <LookPanelFrame needs="clip">
              <AdjustmentSliderResetProvider>
                <CropPanel />
              </AdjustmentSliderResetProvider>
            </LookPanelFrame>
          );
        case Panel.Masks:
          return (
            <LookPanelFrame>
              <MasksPanel />
            </LookPanelFrame>
          );
        case Panel.Ai:
          return (
            <LookPanelFrame needs="media">
              <AIPanel />
            </LookPanelFrame>
          );
        case Panel.Presets:
          return (
            <LookPanelFrame browsable>
              <PresetsPanel onNavigateToCommunity={() => setUI({ activeView: 'community' })} />
            </LookPanelFrame>
          );
        case Panel.Tethering:
          return <TetheringPanel onLibraryRefresh={handleLibraryRefresh} onImageSelect={handleImageSelect} />;
        case Panel.MediaPool:
          return <ProjectPanel />;
        case Panel.Inspector:
          return <InspectorPanel />;
        case Panel.Effects:
          return <EffectsPanel />;
        case Panel.Captions:
          return <CaptionsPanel />;
        case Panel.Mixer:
          return <MixerPanel />;
        case Panel.Filmstrip:
          return (
            <DockedFilmstrip
              imageList={sortedImageList}
              groupBadgeInfo={groupBadgeInfo}
              onClearSelection={handleClearSelection}
              onContextMenu={handleThumbnailContextMenu}
              onEmptyAreaContextMenu={handleMainLibraryContextMenu}
              onImageSelect={handleImageClick}
              onRequestThumbnails={requestThumbnails}
              thumbnailAspectRatio={thumbnailAspectRatio}
            />
          );
        default:
          return null;
      }
    },
    [
      isResizing,
      handleFolderTreeContextMenu,
      handleAlbumTreeContextMenu,
      handleTreeSelectAlbum,
      handleTreeFolderSelect,
      handleToggleFolder,
      handleOpenFolder,
      handleNavBack,
      handleNavForward,
      setUI,
      isInstantTransition,
      exportState,
      multiSelectedPaths,
      selectedImage,
      setExportState,
      appSettings,
      handleSettingsChange,
      rootPaths,
      sortedImageList,
      handleClearSelection,
      handleThumbnailContextMenu,
      handleMainLibraryContextMenu,
      handleImageClick,
      requestThumbnails,
      thumbnailAspectRatio,
      groupBadgeInfo,
      handleBackToLibrary,
    ],
  );

  const hasRoots = rootPaths && rootPaths.length > 0;
  const hasMainContent = hasRoots || (activeView === 'editor' && !!selectedImage);

  const shouldHideFolderTree = useCompactPanels || useWidePanels;
  const isWgpuActive =
    activeView === 'editor' && appSettings?.useWgpuRenderer !== false && !!selectedImage && wgpuPhase === 'live';
  const useMacWindowShell = osPlatform === 'macos' && !appSettings?.decorations && !isWindowFullScreen && !isFullScreen;

  const layoutSensors = useSensors(useSensor(PointerSensor, LAYOUT_SENSOR_OPTIONS));
  const isDndDragging = useRef(false);
  useEffect(() => {
    const keepDragEscape = (event: KeyboardEvent) => {
      if (event.code === 'Escape' && isDndDragging.current) event.stopPropagation();
    };
    document.addEventListener('keydown', keepDragEscape);
    return () => document.removeEventListener('keydown', keepDragEscape);
  }, []);
  const handleDragStart = (e: any) => {
    isDndDragging.current = true;
    lastPointer = null;
    window.addEventListener('pointermove', trackPointer, true);
    setDragGrab(grabOf(e));
    if (e.active.data.current?.type === 'layout-tab') {
      setLayoutDragItem(e.active.data.current.panel as Panel);
    } else if (String(e.active.data.current?.type).startsWith('video-') || e.active.data.current?.type === BIN_DRAG) {
      const { label, icon, type } = e.active.data.current as
        VideoDragData | { type: typeof BIN_DRAG; label: string; icon: VideoDragData['icon'] };
      setActiveVideoDrag({ label, icon, tile: type !== BIN_DRAG });
    } else if (e.active.data.current?.type === 'library-image') {
      const { path, paths } = e.active.data.current;
      setActiveImageDragItem({ path, paths: draggedPaths(path, paths) });
    }
  };

  const openHiddenSide = (region: PanelRegion) => {
    if (region.startsWith('left') && !uiVisibility.leftPanel) {
      setUI((state) => ({
        uiVisibility: { ...state.uiVisibility, leftPanel: true },
        leftPanelWidth: getReopenedPanelWidth(state.leftPanelWidth),
      }));
    } else if (region.startsWith('right') && !uiVisibility.rightPanel) {
      setUI((state) => ({
        uiVisibility: { ...state.uiVisibility, rightPanel: true },
        rightPanelWidth: getReopenedPanelWidth(state.rightPanelWidth),
      }));
    }
  };

  const resetDragState = () => {
    isDndDragging.current = false;
    window.removeEventListener('pointermove', trackPointer, true);
    setLayoutDragItem(null);
    setActiveImageDragItem(null);
    setActiveVideoDrag(null);
  };

  const handleDragEnd = (e: any) => {
    resetDragState();
    const { active, over } = e;

    if (active.data.current?.type === 'layout-tab' && over) {
      const panel = active.data.current.panel as Panel;
      const dropData = over.data.current;
      if (dropData?.type === 'layout-region' || dropData?.type === 'layout-split') {
        const target = dropData as LayoutDropData;
        dropPanel(panel, {
          region: target.region,
          split: target.type === 'layout-split',
          placement: getDropPlacement(target.side, over.rect, active.rect.current.translated),
        });
      } else if (dropData?.type === 'layout-bottom' && panel === Panel.Filmstrip) {
        dockFilmstripToBottom();
      }
    }

    if (appSettings?.hideCollapsedPanels && active.data.current?.type === 'layout-tab' && over?.data.current?.region) {
      openHiddenSide(over.data.current.region as PanelRegion);
    }

    const isPoolTile = String(active.id).startsWith('media-pool-');

    if (String(active.data.current?.type).startsWith('video-') && over?.data.current?.type === 'video-timeline') {
      const point = dropPoint(e);
      dropEffectOnTimeline(active.data.current as VideoDragData, point.x, point.y);
    }

    if (!isPoolTile && active.data.current?.type === 'library-image' && over?.data.current?.type === 'folder') {
      const targetFolder = over.data.current.path;
      const sourcePaths = activeImageDragItem?.paths || [active.data.current.path];

      transferFiles(JobKind.Move, sourcePaths, targetFolder)
        .then(() => {
          refreshAllFolderTrees();
          handleLibraryRefresh();
          useLibraryStore.getState().setLibrary({ multiSelectedPaths: [] });
        })
        .catch((err) => {
          toast.error(`Failed to move files: ${err}`);
        });
    }

    if (active.data.current?.type === 'library-image' && over?.data.current?.type === 'video-timeline') {
      const point = dropPoint(e);
      dropMediaOnTimeline(activeImageDragItem?.paths || [active.data.current.path], point.x, point.y);
    }

    if (!isPoolTile && active.data.current?.type === 'library-image' && over?.data.current?.type === 'album') {
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

    if (over?.data.current?.type === 'video-project') {
      dropOnProject(active, over.data.current.path);
    }
  };

  const ActiveOverlayIcon = activeLayoutDragItem ? PANEL_ICONS[activeLayoutDragItem] : null;
  const shouldHideCollapsedPanels = appSettings?.hideCollapsedPanels && !activeLayoutDragItem;
  const collapsedLeftWidth = shouldHideCollapsedPanels ? 0 : 48;
  const collapsedRightWidth = shouldHideCollapsedPanels ? 0 : useWidePanels ? 58 : 48;
  const effectiveLeftWidth = uiVisibility.leftPanel ? leftPanelWidth : collapsedLeftWidth;
  const effectiveRightWidth = uiVisibility.rightPanel ? rightPanelWidth : collapsedRightWidth;

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
            onDragCancel={resetDragState}
            collisionDetection={layoutCollisionDetection}
            measuring={DND_MEASURING}
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
                      layoutMode={layoutMode}
                      isAndroid={isAndroid}
                      compactEditorPanelHeight={compactEditorPanelHeight}
                      compactEditorPanelCollapsedHeight={compactEditorPanelCollapsedHeight}
                      timelineMaxHeight={timelineMaxHeight}
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
                    layoutMode={layoutMode}
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
                    handleNavigateToFolder={handleNavigateToFolder}
                    handleImportClick={handleImportClick}
                    handleLibraryRefresh={handleLibraryRefresh}
                    handleCopyAdjustments={handleCopyAdjustments}
                    handlePasteAdjustments={handlePasteAdjustments}
                    handleResetAdjustments={handleResetAdjustments}
                    requestThumbnails={requestThumbnails}
                  />
                </div>
                {isSettingsOpen && appSettings && hasMainContent && (
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
              {!useCompactPanels && hasMainContent && (
                <SidePanelArea
                  side="right"
                  width={effectiveRightWidth}
                  topRegion="rightTop"
                  bottomRegion="rightBottom"
                  renderPanel={renderAppPanel}
                  onWidthChange={createResizeHandler('right', effectiveRightWidth)}
                  onWidthReset={createResizeResetHandler('right')}
                  isResizing={isResizing}
                  showAdditionalTabs={useWidePanels}
                />
              )}
            </div>
            <DragOverlay dropAnimation={null}>
              {activeLayoutDragItem && ActiveOverlayIcon ? (
                <div className="w-10 h-10 bg-surface shadow-2xl rounded-md flex items-center justify-center text-text-primary ring-1 ring-border-color">
                  <ActiveOverlayIcon size={20} />
                </div>
              ) : null}
            </DragOverlay>
            {(activeImageDragItem || activeVideoDrag) && (
              <CursorChip grab={dragGrab}>
                <TimelineDragOverlay>
                  {activeImageDragItem ? <ImageDragOverlayNode activeItem={activeImageDragItem} /> : null}
                  {activeVideoDrag?.tile ? (
                    <ToolTileOverlay icon={activeVideoDrag.icon} label={activeVideoDrag.label} />
                  ) : activeVideoDrag ? (
                    <DragChip>
                      <div className="flex items-center gap-2 pl-2.5 pr-3.5 h-8 rounded-full bg-surface/95 backdrop-blur-sm shadow-xl ring-1 ring-border-color/60 text-text-primary text-[13px] font-medium whitespace-nowrap">
                        <activeVideoDrag.icon size={15} className="text-accent" />
                        {activeVideoDrag.label}
                      </div>
                    </DragChip>
                  ) : null}
                </TimelineDragOverlay>
              </CursorChip>
            )}
            <FileDropTarget />
          </DndContext>
        </div>
        <ProjectThumbnails onRequestThumbnails={requestThumbnails} />
        <AppModals
          handleImageSelect={handleImageSelect}
          handleMergeSettingsChange={handleMergeSettingsChange}
          handleSaveMerge={handleSaveMerge}
          handleStartMerge={handleStartMerge}
          handleCreateFolder={handleCreateFolder}
          handleRenameFolder={handleRenameFolder}
          handleSaveRename={handleSaveRename}
          handleStartImport={handleStartImport}
          handleSetFlag={handleSetFlag}
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
              'bg-surface! text-text-primary! border! border-border-color! shadow-2xl! w-[380px]! max-w-[calc(100vw-2rem)]!',
            )
          }
        />
      </div>
    </>
  );
}

const AppWrapper = () => {
  useEffect(() => {
    useCloudStore.getState().initAuth();
  }, []);

  return (
    <ContextMenuProvider>
      <App />
      <GlobalTooltip />
    </ContextMenuProvider>
  );
};

export default AppWrapper;
