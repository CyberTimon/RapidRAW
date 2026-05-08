import { type PointerEvent as ReactPointerEvent, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { ClerkProvider } from '@clerk/react';
import { ToastContainer, toast, Slide } from 'react-toastify';
import clsx from 'clsx';

import TitleBar from './window/TitleBar';
import SettingsPanel from './components/panel/SettingsPanel';
import FolderTree from './components/panel/FolderTree';
import LibraryExportPanel from './components/panel/right/LibraryExportPanel';
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

import { THEMES, DEFAULT_THEME_ID, ThemeProps } from './utils/themes';
import { COPYABLE_ADJUSTMENT_KEYS } from './utils/adjustments';
import {
  FilterCriteria,
  Invokes,
  ImageFile,
  LibraryViewMode,
  Panel,
  RawStatus,
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

  const {
    appSettings,
    theme,
    supportedTypes,
    osPlatform,
    setAppSettings,
    setTheme,
    setSupportedTypes,
    initPlatform,
    handleSettingsChange,
  } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      supportedTypes: state.supportedTypes,
      osPlatform: state.osPlatform,
      setAppSettings: state.setAppSettings,
      setTheme: state.setTheme,
      setSupportedTypes: state.setSupportedTypes,
      initPlatform: state.initPlatform,
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
    isSettingsOpen,
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
      isSettingsOpen: state.isSettingsOpen,
      setUI: state.setUI,
      setRightPanel: state.setRightPanel,
    })),
  );

  const {
    rootPath,
    currentFolderPath,
    expandedFolders,
    multiSelectedPaths,
    sortCriteria,
    filterCriteria,
    setLibrary,
    setFilterCriteria,
    setSortCriteria,
  } = useLibraryStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      currentFolderPath: state.currentFolderPath,
      expandedFolders: state.expandedFolders,
      multiSelectedPaths: state.multiSelectedPaths,
      sortCriteria: state.sortCriteria,
      filterCriteria: state.filterCriteria,
      setLibrary: state.setLibrary,
      setFilterCriteria: state.setFilterCriteria,
      setSortCriteria: state.setSortCriteria,
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

  const { exportState, isCopied, isPasted, setProcess, setExportState } = useProcessStore(
    useShallow((state) => ({
      exportState: state.exportState,
      isCopied: state.isCopied,
      isPasted: state.isPasted,
      setProcess: state.setProcess,
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
  const isInitialMount = useRef(true);
  const preloadedDataRef = useRef<{
    tree?: Promise<any>;
    images?: Promise<ImageFile[]>;
    rootPath?: string;
    currentPath?: string;
  }>({});

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
  } = useLibraryActions(handleImageSelect);

  const sortedImageList = useSortedLibrary();

  const handleLibraryRefresh = useCallback(async () => {
    if (currentFolderPath) {
      await handleSelectSubfolder(currentFolderPath, false);
    }
  }, [currentFolderPath, handleSelectSubfolder]);

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
    if (!isCopied) return;
    const timer = setTimeout(() => setProcess({ isCopied: false }), 1000);
    return () => clearTimeout(timer);
  }, [isCopied, setProcess]);

  useEffect(() => {
    if (!isPasted) return;
    const timer = setTimeout(() => setProcess({ isPasted: false }), 1000);
    return () => clearTimeout(timer);
  }, [isPasted, setProcess]);

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

  useEffect(() => {
    initPlatform();
  }, [initPlatform]);

  useEffect(() => {
    invoke(Invokes.LoadSettings)
      .then(async (settings: any) => {
        if (
          !settings.copyPasteSettings ||
          !settings.copyPasteSettings.includedAdjustments ||
          settings.copyPasteSettings.includedAdjustments.length === 0
        ) {
          settings.copyPasteSettings = { mode: 'merge', includedAdjustments: COPYABLE_ADJUSTMENT_KEYS };
        }
        setAppSettings(settings);
        if (settings?.sortCriteria) setSortCriteria(settings.sortCriteria);
        if (settings?.filterCriteria) {
          setFilterCriteria((prev: FilterCriteria) => ({
            ...prev,
            ...settings.filterCriteria,
            rawStatus: settings.filterCriteria.rawStatus || RawStatus.All,
            colors: settings.filterCriteria.colors || [],
          }));
        }
        if (settings?.theme) setTheme(settings.theme);
        if (settings?.uiVisibility)
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, ...settings.uiVisibility } }));
        if (settings?.isWaveformVisible !== undefined) setEditor({ isWaveformVisible: settings.isWaveformVisible });
        if (settings?.activeWaveformChannel) setEditor({ activeWaveformChannel: settings.activeWaveformChannel });
        if (typeof settings?.waveformHeight === 'number') setEditor({ waveformHeight: settings.waveformHeight });
        setLibraryViewMode(settings?.libraryViewMode ?? defaultLibraryViewMode);
        setThumbnailSize(settings?.thumbnailSize ?? defaultThumbnailSize);
        if (settings?.thumbnailAspectRatio) setThumbnailAspectRatio(settings.thumbnailAspectRatio);

        if (settings?.pinnedFolders && settings.pinnedFolders.length > 0) {
          try {
            const trees = await invoke(Invokes.GetPinnedFolderTrees, {
              paths: settings.pinnedFolders,
              expandedFolders: settings.lastFolderState?.expandedFolders || [],
              showImageCounts: settings.enableFolderImageCounts ?? false,
            });
            setLibrary({ pinnedFolderTrees: trees });
          } catch (err) {
            console.error('Failed to load pinned folder trees:', err);
          }
        }

        if (!isAndroid && settings.lastRootPath) {
          const root = settings.lastRootPath;
          const currentPath = settings.lastFolderState?.currentFolderPath || root;
          const command =
            settings.libraryViewMode === LibraryViewMode.Recursive
              ? Invokes.ListImagesRecursive
              : Invokes.ListImagesInDir;

          preloadedDataRef.current = {
            rootPath: root,
            currentPath: currentPath,
            tree: invoke(Invokes.GetFolderTree, {
              path: root,
              expandedFolders: settings.lastFolderState?.expandedFolders ?? [root],
              showImageCounts: settings.enableFolderImageCounts ?? false,
            }),
            images: invoke(command, { path: currentPath }),
          };
        }

        invoke('frontend_ready').catch((e) => console.error('Failed to notify backend of readiness:', e));
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
        setAppSettings({
          lastRootPath: null,
          theme: DEFAULT_THEME_ID as Theme,
          thumbnailSize: defaultThumbnailSize,
          libraryViewMode: defaultLibraryViewMode,
        });
      })
      .finally(() => {
        isInitialMount.current = false;
      });
  }, [
    isAndroid,
    setAppSettings,
    setTheme,
    setUI,
    defaultLibraryViewMode,
    defaultThumbnailSize,
    setSortCriteria,
    setFilterCriteria,
    setEditor,
    setLibrary,
  ]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (JSON.stringify(appSettings.uiVisibility) !== JSON.stringify(uiVisibility)) {
      handleSettingsChange({ ...appSettings, uiVisibility });
    }
  }, [uiVisibility, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (appSettings.thumbnailSize !== thumbnailSize) {
      handleSettingsChange({ ...appSettings, thumbnailSize });
    }
  }, [thumbnailSize, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (appSettings.thumbnailAspectRatio !== thumbnailAspectRatio) {
      handleSettingsChange({ ...appSettings, thumbnailAspectRatio });
    }
  }, [thumbnailAspectRatio, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (appSettings.libraryViewMode !== libraryViewMode) {
      handleSettingsChange({ ...appSettings, libraryViewMode });
    }
  }, [libraryViewMode, appSettings, handleSettingsChange]);

  useEffect(() => {
    invoke(Invokes.GetSupportedFileTypes)
      .then((types: any) => setSupportedTypes(types))
      .catch((err) => console.error('Failed to load supported file types:', err));
  }, [setSupportedTypes]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (JSON.stringify(appSettings.sortCriteria) !== JSON.stringify(sortCriteria)) {
      handleSettingsChange({ ...appSettings, sortCriteria });
    }
  }, [sortCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) return;
    if (JSON.stringify(appSettings.filterCriteria) !== JSON.stringify(filterCriteria)) {
      handleSettingsChange({ ...appSettings, filterCriteria });
    }
  }, [filterCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    const root = document.documentElement;
    const currentThemeId = theme || DEFAULT_THEME_ID;

    const baseTheme =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    if (!baseTheme) return;

    let finalCssVariables: any = { ...baseTheme.cssVariables };

    Object.entries(finalCssVariables).forEach(([key, value]) => {
      root.style.setProperty(key, value as string);
    });

    const fontFamily = appSettings?.fontFamily || 'poppins';
    const fontStack =
      fontFamily === 'system'
        ? '-apple-system, BlinkMacSystemFont, system-ui, sans-serif'
        : "'Poppins', system-ui, sans-serif";
    root.style.setProperty('--font-family', fontStack);
  }, [theme, appSettings?.fontFamily]);

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
        setLibrary((state) => ({ folderTree: insertChildrenIntoTree(state.folderTree, path, newChildren) }));
        setLibrary((state) => ({
          pinnedFolderTrees: state.pinnedFolderTrees.map((tree) => insertChildrenIntoTree(tree, path, newChildren)),
        }));
      } catch (err) {
        toast.error(`Failed to load folder: ${err}`);
      }
    },
    [expandedFolders, appSettings?.enableFolderImageCounts, setLibrary],
  );

  const renderFolderTree = () => {
    if (!rootPath) return null;

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
          onFolderSelect={(path) => handleSelectSubfolder(path, false)}
          onToggleFolder={handleToggleFolder}
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
            isLayoutReady && rootPath && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            [rootPath && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2')],
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
              <LibraryExportPanel
                exportState={exportState}
                imageList={sortedImageList}
                isVisible={isLibraryExportPanelVisible}
                multiSelectedPaths={multiSelectedPaths}
                onClose={() => setUI({ isLibraryExportPanelVisible: false })}
                setExportState={setExportState}
                appSettings={appSettings}
                onSettingsChange={handleSettingsChange}
                rootPath={rootPath}
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
        />
        {isSettingsOpen && appSettings && (
          <div
            className="fixed inset-0 z-60 flex flex-col bg-bg-primary overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
          >
            <div className="flex flex-1 min-h-0 flex-col px-4 py-6 sm:px-6 sm:py-8 md:py-10 lg:px-8">
              <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden">
                <SettingsPanel
                  appSettings={appSettings}
                  onBack={() => setUI({ isSettingsOpen: false })}
                  onLibraryRefresh={handleLibraryRefresh}
                  onSettingsChange={handleSettingsChange}
                  rootPath={rootPath}
                />
              </div>
            </div>
          </div>
        )}
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
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
    <ContextMenuProvider>
      <App />
      <GlobalTooltip />
    </ContextMenuProvider>
  </ClerkProvider>
);

export default AppWrapper;
