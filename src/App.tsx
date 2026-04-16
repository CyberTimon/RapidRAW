import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { platform } from '@tauri-apps/plugin-os';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import debounce from 'lodash.debounce';
import { ImageLRUCache, ImageCacheEntry } from './utils/ImageLRUCache';
import { ClerkProvider } from '@clerk/react';
import { ToastContainer, toast, Slide } from 'react-toastify';
import clsx from 'clsx';
import {
  Aperture,
  Check,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Edit,
  FileEdit,
  Folder,
  FolderInput,
  FolderPlus,
  Images,
  LayoutTemplate,
  Redo,
  RefreshCw,
  RotateCcw,
  Star,
  Save,
  SquaresUnite,
  Palette,
  Tag,
  Trash2,
  Undo,
  X,
  Pin,
  PinOff,
  Users,
  Gauge,
  Grip,
  Film,
} from 'lucide-react';
import TitleBar from './window/TitleBar';
import CommunityPage from './components/panel/CommunityPage';
import MainLibrary, { ColumnWidths } from './components/panel/MainLibrary';
import FolderTree from './components/panel/FolderTree';
import Editor from './components/panel/Editor';
import Controls from './components/panel/right/ControlsPanel';
import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import RightPanelSwitcher from './components/panel/right/RightPanelSwitcher';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel, { type OverlayMode } from './components/panel/right/CropPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import AIPanel from './components/panel/right/AIPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import LibraryExportPanel from './components/panel/right/LibraryExportPanel';
import MasksPanel from './components/panel/right/MasksPanel';
import BottomBar from './components/panel/BottomBar';
import { ContextMenuProvider, useContextMenu } from './context/ContextMenuContext';
import TaggingSubMenu from './context/TaggingSubMenu';
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
import { useHistoryState } from './hooks/useHistoryState';
import Resizer from './components/ui/Resizer';
import {
  Adjustments,
  AiPatch,
  Color,
  COLOR_LABELS,
  Coord,
  COPYABLE_ADJUSTMENT_KEYS,
  INITIAL_ADJUSTMENTS,
  MaskContainer,
  normalizeLoadedAdjustments,
  PasteMode,
  CopyPasteSettings,
} from './utils/adjustments';
import { calculateCenteredCrop } from './utils/cropUtils';
import { generatePaletteFromImage } from './utils/palette';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import GlobalTooltip from './components/ui/GlobalTooltip';
import { THEMES, DEFAULT_THEME_ID, ThemeProps } from './utils/themes';
import { SubMask, ToolType } from './components/panel/right/Masks';
import { ExportState, IMPORT_TIMEOUT, ImportState, Status } from './components/ui/ExportImportProperties';
import {
  AppSettings,
  BrushSettings,
  FilterCriteria,
  Invokes,
  ImageFile,
  Option,
  OPTION_SEPARATOR,
  LibraryViewMode,
  Panel,
  Progress,
  RawStatus,
  SelectedImage,
  SortCriteria,
  SortDirection,
  SupportedTypes,
  Theme,
  TransformState,
  UiVisibility,
  WaveformData,
  Orientation,
  ThumbnailSize,
  ThumbnailAspectRatio,
  CullingSuggestions,
} from './components/ui/AppProperties';
import { ChannelConfig } from './components/adjustments/Curves';
import HdrModal from './components/modals/HdrModal';

const CLERK_PUBLISHABLE_KEY = 'pk_test_YnJpZWYtc2Vhc25haWwtMTIuY2xlcmsuYWNjb3VudHMuZGV2JA'; // local dev key

interface CollapsibleSectionsState {
  basic: boolean;
  color: boolean;
  curves: boolean;
  details: boolean;
  effects: boolean;
}

interface ConfirmModalState {
  confirmText?: string;
  confirmVariant?: string;
  isOpen: boolean;
  message?: string;
  onConfirm?(): void;
  title?: string;
}

interface Metadata {
  adjustments: Adjustments;
  rating: number;
  tags: Array<string> | null;
  version: number;
}

interface MultiSelectOptions {
  onSimpleClick(p: any): void;
  updateLibraryActivePath: boolean;
  shiftAnchor: string | null;
}

interface CollageModalState {
  isOpen: boolean;
  sourceImages: ImageFile[];
}

interface PanoramaModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface HdrModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface DenoiseModalState {
  isOpen: boolean;
  isProcessing: boolean;
  previewBase64: string | null;
  originalBase64?: string | null;
  error: string | null;
  targetPaths: string[];
  progressMessage: string | null;
  isRaw: boolean;
}

interface NegativeConversionModalState {
  isOpen: boolean;
  targetPaths: Array<string>;
}

interface CullingModalState {
  isOpen: boolean;
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
  pathsToCull: Array<string>;
}

interface LutData {
  size: number;
}

interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

export interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

const RIGHT_PANEL_ORDER = [
  Panel.Metadata,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
  Panel.Export,
];

const DEBUG = false;

const getParentDir = (filePath: string): string => {
  const separator = filePath.includes('/') ? '/' : '\\';
  const lastSeparatorIndex = filePath.lastIndexOf(separator);
  if (lastSeparatorIndex === -1) {
    return '';
  }
  return filePath.substring(0, lastSeparatorIndex);
};

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
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [osPlatform, setOsPlatform] = useState(() => {
    try {
      return platform();
    } catch (_err) {
      return '';
    }
  });
  const [activeView, setActiveView] = useState('library');
  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false);
  const [isInstantTransition, setIsInstantTransition] = useState(false);
  const [isLayoutReady, setIsLayoutReady] = useState(false);
  const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState(new Set<string>());
  const [folderTree, setFolderTree] = useState<any>(null);
  const [pinnedFolderTrees, setPinnedFolderTrees] = useState<any[]>([]);
  const [imageList, setImageList] = useState<Array<ImageFile>>([]);
  const [imageRatings, setImageRatings] = useState<Record<string, number>>({});
  const [sortCriteria, setSortCriteria] = useState<SortCriteria>({ key: 'name', order: SortDirection.Ascending });
  const [filterCriteria, setFilterCriteria] = useState<FilterCriteria>({
    colors: [],
    rating: 0,
    rawStatus: RawStatus.All,
  });
  const [supportedTypes, setSupportedTypes] = useState<SupportedTypes | null>(null);
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);
  const [multiSelectedPaths, setMultiSelectedPaths] = useState<Array<string>>([]);
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [libraryActivePath, setLibraryActivePath] = useState<string | null>(null);
  const [libraryActiveAdjustments, setLibraryActiveAdjustments] = useState<Adjustments>(INITIAL_ADJUSTMENTS);
  const [finalPreviewUrl, setFinalPreviewUrl] = useState<string | null>(null);
  const [uncroppedAdjustedPreviewUrl, setUncroppedAdjustedPreviewUrl] = useState<string | null>(null);
  const {
    state: historyAdjustments,
    setState: setHistoryAdjustments,
    undo: undoAdjustments,
    redo: redoAdjustments,
    canUndo,
    canRedo,
    resetHistory: resetAdjustmentsHistory,
    history: adjustmentsHistory,
    historyIndex: adjustmentsHistoryIndex,
    goToIndex: goToAdjustmentsHistoryIndex,
  } = useHistoryState(INITIAL_ADJUSTMENTS);
  const [adjustments, setLiveAdjustments] = useState<Adjustments>(INITIAL_ADJUSTMENTS);
  const [showOriginal, setShowOriginal] = useState(false);
  const [isTreeLoading, setIsTreeLoading] = useState(false);
  const [isViewLoading, setIsViewLoading] = useState(false);
  const [initialFileToOpen, setInitialFileToOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [histogram, setHistogram] = useState<ChannelConfig | null>(null);
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  const [isWaveformVisible, setIsWaveformVisible] = useState(false);
  const [activeWaveformChannel, setActiveWaveformChannel] = useState<string>('luma');
  const activeWaveformChannelRef = useRef(activeWaveformChannel);
  activeWaveformChannelRef.current = activeWaveformChannel;
  const [waveformHeight, setWaveformHeight] = useState<number>(220);
  const [uiVisibility, setUiVisibility] = useState<UiVisibility>({
    folderTree: true,
    filmstrip: true,
  });
  const [isSliderDragging, setIsSliderDragging] = useState(false);
  const [interactivePatch, setInteractivePatch] = useState<InteractivePatch | null>(null);
  const lastZoomPatchTime = useRef<number>(0);
  const dragIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAdjustmentsRef = useRef<{ path: string; adjustments: Adjustments } | null>(null);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isAnimatingTheme, setIsAnimatingTheme] = useState(false);
  const isInitialThemeMount = useRef(true);
  const [theme, setTheme] = useState(DEFAULT_THEME_ID);
  const [adaptivePalette, setAdaptivePalette] = useState<any>(null);
  const [activeRightPanel, setActiveRightPanel] = useState<Panel | null>(Panel.Adjustments);
  const [slideDirection, setSlideDirection] = useState(1);
  const [activeMaskContainerId, setActiveMaskContainerId] = useState<string | null>(null);
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
  const [activeAiPatchContainerId, setActiveAiPatchContainerId] = useState<string | null>(null);
  const [activeAiSubMaskId, setActiveAiSubMaskId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [displaySize, setDisplaySize] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [previewSize, setPreviewSize] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [baseRenderSize, setBaseRenderSize] = useState<ImageDimensions>({ width: 0, height: 0 });
  const baseRenderSizeRef = useRef<any>(null);
  const [originalSize, setOriginalSize] = useState<ImageDimensions>({ width: 0, height: 0 });
  const [isRotationActive, setIsRotationActive] = useState(false);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('thirds');
  const [overlayRotation, setOverlayRotation] = useState(0);
  const [transformedOriginalUrl, setTransformedOriginalUrl] = useState<string | null>(null);
  const patchesSentToBackend = useRef<Set<string>>(new Set());
  const imageCacheRef = useRef(new ImageLRUCache(20));
  const isBackendReadyRef = useRef(true);
  const cachedEditStateRef = useRef<ImageCacheEntry | null>(null);
  const [renderedRightPanel, setRenderedRightPanel] = useState<Panel | null>(activeRightPanel);
  const [collapsibleSectionsState, setCollapsibleSectionsState] = useState<CollapsibleSectionsState>({
    basic: true,
    color: false,
    curves: true,
    details: false,
    effects: false,
  });
  const [isLibraryExportPanelVisible, setIsLibraryExportPanelVisible] = useState(false);
  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(LibraryViewMode.Flat);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(256);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(320);
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(144);
  const [activeTreeSection, setActiveTreeSection] = useState<string | null>('current');
  const [isResizing, setIsResizing] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState(ThumbnailSize.Medium);
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState(ThumbnailAspectRatio.Cover);
  const [copiedAdjustments, setCopiedAdjustments] = useState<Adjustments | null>(null);
  const [isStraightenActive, setIsStraightenActive] = useState(false);
  const [isWbPickerActive, setIsWbPickerActive] = useState(false);
  const [liveRotation, setLiveRotation] = useState<number | null>(null);
  const [copiedFilePaths, setCopiedFilePaths] = useState<Array<string>>([]);
  const [aiModelDownloadStatus, setAiModelDownloadStatus] = useState<string | null>(null);
  const [copiedSectionAdjustments, setCopiedSectionAdjustments] = useState(null);
  const [copiedMask, setCopiedMask] = useState<MaskContainer | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isPasted, setIsPasted] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<Progress>({ current: 0, total: 0 });
  const [searchCriteria, setSearchCriteria] = useState<SearchCriteria>({
    tags: [],
    text: '',
    mode: 'OR',
  });
  const [brushSettings, setBrushSettings] = useState<BrushSettings | null>({
    size: 50,
    feather: 50,
    tool: ToolType.Brush,
  });
  const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
  const [isRenameFolderModalOpen, setIsRenameFolderModalOpen] = useState(false);
  const [isRenameFileModalOpen, setIsRenameFileModalOpen] = useState(false);
  const [renameTargetPaths, setRenameTargetPaths] = useState<Array<string>>([]);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isCopyPasteSettingsModalOpen, setIsCopyPasteSettingsModalOpen] = useState(false);
  const [importTargetFolder, setImportTargetFolder] = useState<string | null>(null);
  const [importSourcePaths, setImportSourcePaths] = useState<Array<string>>([]);
  const [folderActionTarget, setFolderActionTarget] = useState<string | null>(null);
  const [confirmModalState, setConfirmModalState] = useState<ConfirmModalState>({ isOpen: false });
  const [panoramaModalState, setPanoramaModalState] = useState<PanoramaModalState>({
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  });
  const [hdrModalState, setHdrModalState] = useState<HdrModalState>({
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  });
  const [negativeModalState, setNegativeModalState] = useState<NegativeConversionModalState>({
    isOpen: false,
    targetPaths: [],
  });
  const [denoiseModalState, setDenoiseModalState] = useState<DenoiseModalState>({
    isOpen: false,
    isProcessing: false,
    previewBase64: null,
    error: null,
    targetPaths: [],
    progressMessage: null,
    isRaw: false,
  });
  const [cullingModalState, setCullingModalState] = useState<CullingModalState>({
    isOpen: false,
    suggestions: null,
    progress: null,
    error: null,
    pathsToCull: [],
  });
  const [collageModalState, setCollageModalState] = useState<CollageModalState>({
    isOpen: false,
    sourceImages: [],
  });
  const [customEscapeHandler, setCustomEscapeHandler] = useState(null);
  const [isGeneratingAiMask, setIsGeneratingAiMask] = useState(false);
  const [isAIConnectorConnected, setisAIConnectorConnected] = useState(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isMaskControlHovered, setIsMaskControlHovered] = useState(false);
  const [libraryScrollTop, setLibraryScrollTop] = useState<number>(0);
  const [listColumnWidths, setListColumnWidths] = useState<ColumnWidths>({
    thumbnail: 4,
    name: 32,
    date: 30,
    rating: 15,
    color: 15,
  });
  const { showContextMenu } = useContextMenu();
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const { requestThumbnails, clearThumbnailQueue } = useThumbnails();
  const [thumbnailProgress, setThumbnailProgress] = useState<Progress>({ current: 0, total: 0 });
  const transformWrapperRef = useRef<any>(null);
  const isProgrammaticZoom = useRef(false);
  const currentResRef = useRef<number>(1280);
  const currentOriginalResRef = useRef<number>(0);
  const isInitialMount = useRef(true);
  const currentFolderPathRef = useRef<string>(currentFolderPath);
  const preloadedDataRef = useRef<{
    tree?: Promise<any>;
    images?: Promise<ImageFile[]>;
    rootPath?: string;
    currentPath?: string;
  }>({});
  const previewJobIdRef = useRef<number>(0);
  const latestRenderedJobIdRef = useRef<number>(0);
  const isAndroid = osPlatform === 'android';

  useEffect(() => {
    if (currentFolderPath) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        currentPath: currentFolderPath,
        images: Promise.resolve(imageList),
      };
    }
  }, [currentFolderPath, imageList]);

  useEffect(() => {
    if (rootPath && folderTree) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        rootPath: rootPath,
        tree: Promise.resolve(folderTree),
      };
    }
  }, [rootPath, folderTree]);

  const [exportState, setExportState] = useState<ExportState>({
    errorMessage: '',
    progress: { current: 0, total: 0 },
    status: Status.Idle,
  });

  const [importState, setImportState] = useState<ImportState>({
    errorMessage: '',
    path: '',
    progress: { current: 0, total: 0 },
    status: Status.Idle,
  });

  useEffect(() => {
    currentFolderPathRef.current = currentFolderPath;
  }, [currentFolderPath]);

  useEffect(() => {
    if (!isCopied) {
      return;
    }
    const timer = setTimeout(() => setIsCopied(false), 1000);
    return () => clearTimeout(timer);
  }, [isCopied]);

  useEffect(() => {
    if (!isPasted) {
      return;
    }
    const timer = setTimeout(() => setIsPasted(false), 1000);
    return () => clearTimeout(timer);
  }, [isPasted]);

  const isLightTheme = useMemo(() => [Theme.Light, Theme.Snow, Theme.Arctic].includes(theme as Theme), [theme]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      setError(null);
    }
  }, [error]);

  const debouncedSetHistory = useMemo(
    () => debounce((newAdjustments) => setHistoryAdjustments(newAdjustments), 500),
    [setHistoryAdjustments],
  );

  const setAdjustments = useCallback(
    (value: any) => {
      setLiveAdjustments((prevAdjustments: Adjustments) => {
        const newAdjustments = typeof value === 'function' ? value(prevAdjustments) : value;
        debouncedSetHistory(newAdjustments);
        return newAdjustments;
      });
    },
    [debouncedSetHistory],
  );

  const handleRotate = useCallback(
    (degrees: number) => {
      const increment = degrees > 0 ? 1 : 3;
      setAdjustments((prev: Adjustments) => {
        const newAspectRatio = prev.aspectRatio && prev.aspectRatio !== 0 ? 1 / prev.aspectRatio : null;
        const newOrientationSteps = ((prev.orientationSteps || 0) + increment) % 4;

        const newCrop =
          selectedImage?.width && selectedImage?.height
            ? calculateCenteredCrop(selectedImage.width, selectedImage.height, newOrientationSteps, newAspectRatio)
            : null;

        return {
          ...prev,
          aspectRatio: newAspectRatio,
          orientationSteps: newOrientationSteps,
          rotation: 0,
          crop: newCrop,
        };
      });
    },
    [setAdjustments, selectedImage],
  );

  const handleStraighten = useCallback(
    (angleCorrection: number) => {
      setAdjustments((prev: Partial<Adjustments>) => {
        const newRotation = (prev.rotation || 0) + angleCorrection;
        return { ...prev, rotation: newRotation, crop: null };
      });

      setIsStraightenActive(false);
    },
    [setAdjustments],
  );

  const toggleWbPicker = useCallback(() => {
    setIsWbPickerActive((prev) => !prev);
  }, []);

  const handleWbPicked = useCallback(() => {
    //setIsWbPickerActive(false); // lets keep it active
  }, []);

  useEffect(() => {
    setLiveAdjustments(historyAdjustments);
  }, [historyAdjustments]);

  useEffect(() => {
    if (
      (activeRightPanel !== Panel.Masks || !activeMaskContainerId) &&
      (activeRightPanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setIsMaskControlHovered(false);
    }
  }, [activeRightPanel, activeMaskContainerId, activeAiPatchContainerId]);

  const geometricAdjustmentsKey = useMemo(() => {
    if (!adjustments) return '';
    const { crop, rotation, flipHorizontal, flipVertical, orientationSteps } = adjustments;
    return JSON.stringify({ crop, rotation, flipHorizontal, flipVertical, orientationSteps });
  }, [
    adjustments?.crop,
    adjustments?.rotation,
    adjustments?.flipHorizontal,
    adjustments?.flipVertical,
    adjustments?.orientationSteps,
  ]);

  const visualAdjustmentsKey = useMemo(() => {
    if (!adjustments) return '';
    const { rating: _rating, sectionVisibility: _sectionVisibility, ...visualAdjustments } = adjustments;
    return JSON.stringify(visualAdjustments);
  }, [adjustments]);

  const undo = useCallback(() => {
    if (canUndo) {
      undoAdjustments();
      debouncedSetHistory.cancel();
    }
  }, [canUndo, undoAdjustments, debouncedSetHistory]);
  const redo = useCallback(() => {
    if (canRedo) {
      redoAdjustments();
      debouncedSetHistory.cancel();
    }
  }, [canRedo, redoAdjustments, debouncedSetHistory]);

  useEffect(() => {
    if (currentFolderPath) {
      refreshImageList();
    }
  }, [libraryViewMode]);

  useEffect(() => {
    const unlisten = listen('ai-connector-status-update', (event: any) => {
      setisAIConnectorConnected(event.payload.connected);
    });
    invoke(Invokes.CheckAIConnectorStatus);
    const interval = setInterval(() => invoke(Invokes.CheckAIConnectorStatus), 10000);
    return () => {
      clearInterval(interval);
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const activeSubMask =
      adjustments?.masks?.flatMap((m: any) => m.subMasks).find((sm: any) => sm.id === activeMaskId) ||
      adjustments?.aiPatches?.flatMap((p: any) => p.subMasks).find((sm: any) => sm.id === activeAiSubMaskId);

    if (activeSubMask?.type === 'ai-subject' && selectedImage?.path) {
      const transformAdjustments = {
        transformDistortion: adjustments.transformDistortion,
        transformVertical: adjustments.transformVertical,
        transformHorizontal: adjustments.transformHorizontal,
        transformRotate: adjustments.transformRotate,
        transformAspect: adjustments.transformAspect,
        transformScale: adjustments.transformScale,
        transformXOffset: adjustments.transformXOffset,
        transformYOffset: adjustments.transformYOffset,
        lensDistortionAmount: adjustments.lensDistortionAmount,
        lensVignetteAmount: adjustments.lensVignetteAmount,
        lensTcaAmount: adjustments.lensTcaAmount,
        lensDistortionParams: adjustments.lensDistortionParams,
        lensMaker: adjustments.lensMaker,
        lensModel: adjustments.lensModel,
        lensDistortionEnabled: adjustments.lensDistortionEnabled,
        lensTcaEnabled: adjustments.lensTcaEnabled,
        lensVignetteEnabled: adjustments.lensVignetteEnabled,
      };

      invoke('precompute_ai_subject_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
      }).catch((err) => console.error('Failed to precompute AI subject mask:', err));
    }
  }, [activeMaskId, activeAiSubMaskId, selectedImage?.path]);

  const updateSubMask = (subMaskId: string, updatedData: any) => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      masks: prev.masks.map((c: MaskContainer) => ({
        ...c,
        subMasks: c.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
      aiPatches: (prev.aiPatches || []).map((p: AiPatch) => ({
        ...p,
        subMasks: p.subMasks.map((sm: SubMask) => (sm.id === subMaskId ? { ...sm, ...updatedData } : sm)),
      })),
    }));
  };

  const handleGenerativeReplace = useCallback(
    async (patchId: string, prompt: string, useFastInpaint: boolean) => {
      if (!selectedImage?.path || isGeneratingAi) {
        return;
      }

      const patch: AiPatch | undefined = adjustments.aiPatches.find((p: AiPatch) => p.id === patchId);
      if (!patch) {
        console.error('Could not find AI patch to generate for:', patchId);
        return;
      }

      const patchDefinition = { ...patch, prompt };

      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true, prompt } : p)),
      }));

      setIsGeneratingAi(true);

      try {
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: adjustments,
          patchDefinition: patchDefinition,
          path: selectedImage.path,
          useFastInpaint: useFastInpaint,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        patchesSentToBackend.current.delete(patchId);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  name: useFastInpaint ? 'Inpaint' : prompt && prompt.trim() ? prompt.trim() : p.name,
                }
              : p,
          ),
        }));
        setActiveAiPatchContainerId(null);
        setActiveAiSubMaskId(null);
      } catch (err) {
        console.error('Generative replace failed:', err);
        setError(`AI Replace Failed: ${err}`);
        setAdjustments((prev: Adjustments) => ({
          ...prev,
          aiPatches: prev.aiPatches.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setIsGeneratingAi(false);
      }
    },
    [
      selectedImage?.path,
      isGeneratingAi,
      adjustments,
      setAdjustments,
      setActiveAiPatchContainerId,
      setActiveAiSubMaskId,
    ],
  );

  const handleQuickErase = useCallback(
    async (subMaskId: string | null, startPoint: Coord, endPoint: Coord) => {
      if (!selectedImage?.path || isGeneratingAi) {
        return;
      }

      const patchId = adjustments.aiPatches.find((p: AiPatch) =>
        p.subMasks.some((sm: SubMask) => sm.id === subMaskId),
      )?.id;
      if (!patchId) {
        console.error('Could not find AI patch container for Quick Erase.');
        return;
      }

      setIsGeneratingAi(true);
      setAdjustments((prev: Partial<Adjustments>) => ({
        ...prev,
        aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: true } : p)),
      }));

      try {
        const transformAdjustments = {
          transformDistortion: adjustments.transformDistortion,
          transformVertical: adjustments.transformVertical,
          transformHorizontal: adjustments.transformHorizontal,
          transformRotate: adjustments.transformRotate,
          transformAspect: adjustments.transformAspect,
          transformScale: adjustments.transformScale,
          transformXOffset: adjustments.transformXOffset,
          transformYOffset: adjustments.transformYOffset,
          lensDistortionAmount: adjustments.lensDistortionAmount,
          lensVignetteAmount: adjustments.lensVignetteAmount,
          lensTcaAmount: adjustments.lensTcaAmount,
          lensDistortionParams: adjustments.lensDistortionParams,
          lensMaker: adjustments.lensMaker,
          lensModel: adjustments.lensModel,
          lensDistortionEnabled: adjustments.lensDistortionEnabled,
          lensTcaEnabled: adjustments.lensTcaEnabled,
          lensVignetteEnabled: adjustments.lensVignetteEnabled,
        };

        const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
          jsAdjustments: transformAdjustments,
          endPoint: [endPoint.x, endPoint.y],
          flipHorizontal: adjustments.flipHorizontal,
          flipVertical: adjustments.flipVertical,
          orientationSteps: adjustments.orientationSteps,
          path: selectedImage.path,
          rotation: adjustments.rotation,
          startPoint: [startPoint.x, startPoint.y],
        });

        const subMaskToUpdate = adjustments.aiPatches
          ?.find((p: AiPatch) => p.id === patchId)
          ?.subMasks.find((sm: SubMask) => sm.id === subMaskId);
        const finalSubMaskParams: any = { ...subMaskToUpdate?.parameters, ...newMaskParams };
        const updatedAdjustmentsForBackend = {
          ...adjustments,
          aiPatches: adjustments.aiPatches.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        };

        const patchDefinitionForBackend = updatedAdjustmentsForBackend.aiPatches.find((p: AiPatch) => p.id === patchId);
        const newPatchDataJson: any = await invoke(Invokes.InvokeGenerativeReplaseWithMaskDef, {
          currentAdjustments: updatedAdjustmentsForBackend,
          patchDefinition: { ...patchDefinitionForBackend, prompt: '' },
          path: selectedImage.path,
          useFastInpaint: true,
        });

        const newPatchData = JSON.parse(newPatchDataJson);
        if (!newPatchData?.color || !newPatchData?.mask) {
          throw new Error('Inpainting failed to return a valid result.');
        }
        patchesSentToBackend.current.delete(patchId);

        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) =>
            p.id === patchId
              ? {
                  ...p,
                  patchData: newPatchData,
                  isLoading: false,
                  subMasks: p.subMasks.map((sm: SubMask) =>
                    sm.id === subMaskId ? { ...sm, parameters: finalSubMaskParams } : sm,
                  ),
                }
              : p,
          ),
        }));
        setActiveAiPatchContainerId(null);
        setActiveAiSubMaskId(null);
      } catch (err: any) {
        console.error('Quick Erase failed:', err);
        setError(`Quick Erase Failed: ${err.message || String(err)}`);
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          aiPatches: prev.aiPatches?.map((p: AiPatch) => (p.id === patchId ? { ...p, isLoading: false } : p)),
        }));
      } finally {
        setIsGeneratingAi(false);
      }
    },
    [
      selectedImage?.path,
      isGeneratingAi,
      adjustments,
      setAdjustments,
      setActiveAiPatchContainerId,
      setActiveAiSubMaskId,
    ],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        setActiveMaskContainerId(null);
        setActiveMaskId(null);
      }
    },
    [setAdjustments, activeMaskContainerId],
  );

  const handleDeleteAiPatch = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).filter((p) => p.id !== patchId),
      }));
      if (activeAiPatchContainerId === patchId) {
        setActiveAiPatchContainerId(null);
        setActiveAiSubMaskId(null);
      }
    },
    [setAdjustments, activeAiPatchContainerId],
  );

  const handleToggleAiPatchVisibility = useCallback(
    (patchId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        aiPatches: (prev.aiPatches || []).map((p: AiPatch) => (p.id === patchId ? { ...p, visible: !p.visible } : p)),
      }));
    },
    [setAdjustments],
  );

  const handleGenerateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    setIsGeneratingAiMask(true);
    try {
      const transformAdjustments = {
        transformDistortion: adjustments.transformDistortion,
        transformVertical: adjustments.transformVertical,
        transformHorizontal: adjustments.transformHorizontal,
        transformRotate: adjustments.transformRotate,
        transformAspect: adjustments.transformAspect,
        transformScale: adjustments.transformScale,
        transformXOffset: adjustments.transformXOffset,
        transformYOffset: adjustments.transformYOffset,
        lensDistortionAmount: adjustments.lensDistortionAmount,
        lensVignetteAmount: adjustments.lensVignetteAmount,
        lensTcaAmount: adjustments.lensTcaAmount,
        lensDistortionParams: adjustments.lensDistortionParams,
        lensMaker: adjustments.lensMaker,
        lensModel: adjustments.lensModel,
        lensDistortionEnabled: adjustments.lensDistortionEnabled,
        lensTcaEnabled: adjustments.lensTcaEnabled,
        lensVignetteEnabled: adjustments.lensVignetteEnabled,
      };
      const newParameters = await invoke(Invokes.GenerateAiSubjectMask, {
        jsAdjustments: transformAdjustments,
        endPoint: [endPoint.x, endPoint.y],
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        path: selectedImage.path,
        rotation: adjustments.rotation,
        startPoint: [startPoint.x, startPoint.y],
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.current.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI subject mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      setIsGeneratingAiMask(false);
    }
  };

  const handleGenerateAiDepthMask = async (subMaskId: string, parameters: any) => {
    if (!selectedImage?.path) return;
    console.log('trying to generate depth map');
    setIsGeneratingAiMask(true);

    try {
      const transformAdjustments = {
        transformDistortion: adjustments.transformDistortion,
        transformVertical: adjustments.transformVertical,
        transformHorizontal: adjustments.transformHorizontal,
        transformRotate: adjustments.transformRotate,
        transformAspect: adjustments.transformAspect,
        transformScale: adjustments.transformScale,
        transformXOffset: adjustments.transformXOffset,
        transformYOffset: adjustments.transformYOffset,
        lensDistortionAmount: adjustments.lensDistortionAmount,
        lensVignetteAmount: adjustments.lensVignetteAmount,
        lensTcaAmount: adjustments.lensTcaAmount,
        lensDistortionParams: adjustments.lensDistortionParams,
        lensMaker: adjustments.lensMaker,
        lensModel: adjustments.lensModel,
        lensDistortionEnabled: adjustments.lensDistortionEnabled,
        lensTcaEnabled: adjustments.lensTcaEnabled,
        lensVignetteEnabled: adjustments.lensVignetteEnabled,
      };

      const newParameters = await invoke('generate_ai_depth_mask', {
        jsAdjustments: transformAdjustments,
        path: selectedImage.path,
        minDepth: parameters.minDepth ?? 20,
        maxDepth: parameters.maxDepth ?? 100,
        minFade: parameters.minFade ?? 15,
        maxFade: parameters.maxFade ?? 15,
        feather: parameters.feather ?? 10,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.current.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI depth mask:', error);
      setError(`AI Depth Mask Failed: ${error}`);
    } finally {
      setIsGeneratingAiMask(false);
    }
  };

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    setIsGeneratingAiMask(true);
    try {
      const transformAdjustments = {
        transformDistortion: adjustments.transformDistortion,
        transformVertical: adjustments.transformVertical,
        transformHorizontal: adjustments.transformHorizontal,
        transformRotate: adjustments.transformRotate,
        transformAspect: adjustments.transformAspect,
        transformScale: adjustments.transformScale,
        transformXOffset: adjustments.transformXOffset,
        transformYOffset: adjustments.transformYOffset,
        lensDistortionAmount: adjustments.lensDistortionAmount,
        lensVignetteAmount: adjustments.lensVignetteAmount,
        lensTcaAmount: adjustments.lensTcaAmount,
        lensDistortionParams: adjustments.lensDistortionParams,
        lensMaker: adjustments.lensMaker,
        lensModel: adjustments.lensModel,
        lensDistortionEnabled: adjustments.lensDistortionEnabled,
        lensTcaEnabled: adjustments.lensTcaEnabled,
        lensVignetteEnabled: adjustments.lensVignetteEnabled,
      };
      const newParameters = await invoke(Invokes.GenerateAiForegroundMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.current.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI foreground mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      setIsGeneratingAiMask(false);
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    setIsGeneratingAiMask(true);
    try {
      const transformAdjustments = {
        transformDistortion: adjustments.transformDistortion,
        transformVertical: adjustments.transformVertical,
        transformHorizontal: adjustments.transformHorizontal,
        transformRotate: adjustments.transformRotate,
        transformAspect: adjustments.transformAspect,
        transformScale: adjustments.transformScale,
        transformXOffset: adjustments.transformXOffset,
        transformYOffset: adjustments.transformYOffset,
        lensDistortionAmount: adjustments.lensDistortionAmount,
        lensVignetteAmount: adjustments.lensVignetteAmount,
        lensTcaAmount: adjustments.lensTcaAmount,
        lensDistortionParams: adjustments.lensDistortionParams,
        lensMaker: adjustments.lensMaker,
        lensModel: adjustments.lensModel,
        lensDistortionEnabled: adjustments.lensDistortionEnabled,
        lensTcaEnabled: adjustments.lensTcaEnabled,
        lensVignetteEnabled: adjustments.lensVignetteEnabled,
      };
      const newParameters = await invoke(Invokes.GenerateAiSkyMask, {
        jsAdjustments: transformAdjustments,
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      patchesSentToBackend.current.delete(subMaskId);
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI sky mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      setIsGeneratingAiMask(false);
    }
  };

  const sortedImageList = useMemo(() => {
    let processedList = imageList;

    if (filterCriteria.rawStatus === RawStatus.RawOverNonRaw && supportedTypes) {
      const rawBaseNames = new Set<string>();

      for (const image of imageList) {
        const pathWithoutVC = image.path.split('?vc=')[0];
        const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
        const lastDotIndex = filename.lastIndexOf('.');
        const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

        if (extension && supportedTypes.raw.includes(extension)) {
          const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
          const parentDir = getParentDir(pathWithoutVC);
          const uniqueKey = `${parentDir}/${baseName}`;
          rawBaseNames.add(uniqueKey);
        }
      }

      if (rawBaseNames.size > 0) {
        processedList = imageList.filter((image) => {
          const pathWithoutVC = image.path.split('?vc=')[0];
          const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
          const lastDotIndex = filename.lastIndexOf('.');
          const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

          const isNonRaw = extension && supportedTypes.nonRaw.includes(extension);

          if (isNonRaw) {
            const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
            const parentDir = getParentDir(pathWithoutVC);
            const uniqueKey = `${parentDir}/${baseName}`;

            if (rawBaseNames.has(uniqueKey)) {
              return false;
            }
          }

          return true;
        });
      }
    }

    const filteredList = processedList.filter((image) => {
      if (filterCriteria.rating > 0) {
        const rating = imageRatings[image.path] || 0;
        if (filterCriteria.rating === 5) {
          if (rating !== 5) return false;
        } else {
          if (rating < filterCriteria.rating) return false;
        }
      }

      if (
        filterCriteria.rawStatus &&
        filterCriteria.rawStatus !== RawStatus.All &&
        filterCriteria.rawStatus !== RawStatus.RawOverNonRaw &&
        supportedTypes
      ) {
        const extension = image.path.split('.').pop()?.toLowerCase() || '';
        const isRaw = supportedTypes.raw?.includes(extension);

        if (filterCriteria.rawStatus === RawStatus.RawOnly && !isRaw) {
          return false;
        }
        if (filterCriteria.rawStatus === RawStatus.NonRawOnly && isRaw) {
          return false;
        }
      }

      if (filterCriteria.colors && filterCriteria.colors.length > 0) {
        const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);

        const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
        const matchesNone = !imageColor && filterCriteria.colors.includes('none');

        if (!hasMatchingColor && !matchesNone) {
          return false;
        }
      }

      return true;
    });

    const { tags: searchTags, text: searchText, mode: searchMode } = searchCriteria;
    const lowerCaseSearchText = searchText.trim().toLowerCase();

    const filteredBySearch =
      searchTags.length === 0 && lowerCaseSearchText === ''
        ? filteredList
        : filteredList.filter((image: ImageFile) => {
            const lowerCaseImageTags = (image.tags || []).map((t) => t.toLowerCase().replace('user:', ''));
            const filename = image?.path?.split(/[\\/]/)?.pop()?.toLowerCase() || '';

            let tagsMatch = true;
            if (searchTags.length > 0) {
              const lowerCaseSearchTags = searchTags.map((t) => t.toLowerCase());
              if (searchMode === 'OR') {
                tagsMatch = lowerCaseSearchTags.some((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              } else {
                tagsMatch = lowerCaseSearchTags.every((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              }
            }

            let textMatch = true;
            if (lowerCaseSearchText !== '') {
              textMatch =
                filename.includes(lowerCaseSearchText) ||
                lowerCaseImageTags.some((t) => t.includes(lowerCaseSearchText));
            }

            return tagsMatch && textMatch;
          });

    const list = [...filteredBySearch];

    const parseShutter = (val: string | undefined): number | null => {
      if (!val) return null;
      const cleanVal = val.replace(/s/i, '').trim();
      const parts = cleanVal.split('/');
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        return den !== 0 ? num / den : null;
      }
      const numVal = parseFloat(cleanVal);
      return isNaN(numVal) ? null : numVal;
    };

    const parseAperture = (val: string | undefined): number | null => {
      if (!val) return null;
      const match = val.match(/(\d+(\.\d+)?)/);
      const numVal = match ? parseFloat(match[0]) : null;
      return numVal === null || isNaN(numVal) ? null : numVal;
    };

    const parseFocalLength = (val: string | undefined): number | null => {
      if (!val) return null;
      const match = val.match(/(\d+(\.\d+)?)/);
      if (!match) return null;
      const numVal = parseFloat(match[0]);
      return isNaN(numVal) ? null : numVal;
    };

    list.sort((a, b) => {
      const { key, order } = sortCriteria;
      let comparison = 0;

      const compareNullable = (valA: any, valB: any) => {
        if (valA !== null && valB !== null) {
          if (valA < valB) return -1;
          if (valA > valB) return 1;
          return 0;
        }
        if (valA !== null) return -1;
        if (valB !== null) return 1;
        return 0;
      };

      switch (key) {
        case 'date_taken': {
          const dateA = a.exif?.DateTimeOriginal;
          const dateB = b.exif?.DateTimeOriginal;
          comparison = compareNullable(dateA, dateB);
          if (comparison === 0) comparison = a.modified - b.modified;
          break;
        }
        case 'iso': {
          const getIso = (exif: { [key: string]: string } | null): number | null => {
            if (!exif) return null;
            const isoStr = exif.PhotographicSensitivity || exif.ISOSpeedRatings;
            if (!isoStr) return null;
            const isoNum = parseInt(isoStr, 10);
            return isNaN(isoNum) ? null : isoNum;
          };
          const isoA = getIso(a.exif);
          const isoB = getIso(b.exif);
          comparison = compareNullable(isoA, isoB);
          break;
        }
        case 'shutter_speed': {
          const shutterA = parseShutter(a.exif?.ExposureTime);
          const shutterB = parseShutter(b.exif?.ExposureTime);
          comparison = compareNullable(shutterA, shutterB);
          break;
        }
        case 'aperture': {
          const apertureA = parseAperture(a.exif?.FNumber);
          const apertureB = parseAperture(b.exif?.FNumber);
          comparison = compareNullable(apertureA, apertureB);
          break;
        }
        case 'focal_length': {
          const focalA = parseFocalLength(a.exif?.FocalLength);
          const focalB = parseFocalLength(b.exif?.FocalLength);
          comparison = compareNullable(focalA, focalB);
          break;
        }
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
          break;
        default:
          comparison = a.path.localeCompare(b.path);
          break;
      }

      if (comparison === 0 && key !== 'name') {
        return a.path.localeCompare(b.path);
      }

      return order === SortDirection.Ascending ? comparison : -comparison;
    });
    return list;
  }, [imageList, sortCriteria, imageRatings, filterCriteria, supportedTypes, searchCriteria, appSettings]);

  useEffect(() => {
    if (selectedImage?.path && selectedImage.isReady && finalPreviewUrl) {
      cachedEditStateRef.current = {
        adjustments,
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage,
        originalSize,
        previewSize,
      };
    } else {
      cachedEditStateRef.current = null;
    }
  }, [
    selectedImage,
    adjustments,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    previewSize,
  ]);

  const handleDisplaySizeChange = useCallback(
    (
      size: ImageDimensions & {
        scale?: number;
        offsetX?: number;
        offsetY?: number;
        containerWidth?: number;
        containerHeight?: number;
      },
    ) => {
      setDisplaySize({ width: size.width, height: size.height });

      if (size.scale) {
        const baseWidth = size.width / size.scale;
        const baseHeight = size.height / size.scale;
        const newSize = {
          width: baseWidth,
          height: baseHeight,
          offsetX: size.offsetX || 0,
          offsetY: size.offsetY || 0,
          containerWidth: size.containerWidth || 0,
          containerHeight: size.containerHeight || 0,
        };
        baseRenderSizeRef.current = newSize;
        setBaseRenderSize(newSize as any);
      }
    },
    [],
  );

  const calculateROI = useCallback(() => {
    if (!transformWrapperRef.current) return null;
    const state = transformWrapperRef.current.instance.transformState;
    if (!state) return null;

    const currentBaseSize = baseRenderSizeRef.current;
    if (!currentBaseSize) return null;

    const { scale, positionX, positionY } = state;
    const { width: baseW, height: baseH, offsetX, offsetY, containerWidth, containerHeight } = currentBaseSize;

    if (!baseW || !baseH || !containerWidth || !containerHeight) return null;

    if (scale <= 1.01) return null;

    const visibleLeft = -positionX / scale;
    const visibleTop = -positionY / scale;
    const visibleRight = visibleLeft + containerWidth / scale;
    const visibleBottom = visibleTop + containerHeight / scale;

    const imgLeft = offsetX;
    const imgTop = offsetY;
    const imgRight = offsetX + baseW;
    const imgBottom = offsetY + baseH;

    const intersectLeft = Math.max(visibleLeft, imgLeft);
    const intersectTop = Math.max(visibleTop, imgTop);
    const intersectRight = Math.min(visibleRight, imgRight);
    const intersectBottom = Math.min(visibleBottom, imgBottom);

    if (intersectLeft >= intersectRight || intersectTop >= intersectBottom) {
      return null;
    }

    let roiX = (intersectLeft - imgLeft) / baseW;
    let roiY = (intersectTop - imgTop) / baseH;
    let roiW = (intersectRight - intersectLeft) / baseW;
    let roiH = (intersectBottom - intersectTop) / baseH;

    const padX = roiW * 0.2;
    const padY = roiH * 0.2;

    roiX = Math.max(0, roiX - padX);
    roiY = Math.max(0, roiY - padY);
    roiW = Math.min(1 - roiX, roiW + padX * 2);
    roiH = Math.min(1 - roiY, roiH + padY * 2);

    if (roiW > 0.95 && roiH > 0.95) return null;

    return [roiX, roiY, roiW, roiH] as [number, number, number, number];
  }, []);

  const applyAdjustments = useCallback(
    async (currentAdjustments: Adjustments, dragging: boolean = false, targetRes?: number) => {
      if (!selectedImage?.isReady) return;
      if (!isBackendReadyRef.current) return;
      const currentPath = selectedImage.path;

      const payload = JSON.parse(JSON.stringify(currentAdjustments));

      const processSubMasks = (subMasks: any[]) => {
        if (!Array.isArray(subMasks)) return;
        subMasks.forEach((sm: any) => {
          if (sm.id && sm.parameters) {
            const keys = ['mask_data_base64', 'maskDataBase64'];
            let foundMaskData = false;

            for (const key of keys) {
              if (sm.parameters[key] !== undefined && sm.parameters[key] !== null) {
                foundMaskData = true;
                if (patchesSentToBackend.current.has(sm.id)) {
                  sm.parameters[key] = null;
                }
              }
            }
            if (foundMaskData && !patchesSentToBackend.current.has(sm.id)) {
              patchesSentToBackend.current.add(sm.id);
            }
          }
        });
      };

      if (payload.aiPatches && Array.isArray(payload.aiPatches)) {
        payload.aiPatches.forEach((p: any) => {
          if (p.id && p.patchData && !p.isLoading) {
            if (patchesSentToBackend.current.has(p.id)) {
              p.patchData = null;
            } else {
              patchesSentToBackend.current.add(p.id);
            }
          }
          if (p.subMasks) {
            processSubMasks(p.subMasks);
          }
        });
      }

      if (payload.masks && Array.isArray(payload.masks)) {
        payload.masks.forEach((container: any) => {
          if (container.subMasks) {
            processSubMasks(container.subMasks);
          }
        });
      }

      const jobId = ++previewJobIdRef.current;
      const roi = calculateROI();

      try {
        const buffer: ArrayBuffer = await invoke(Invokes.ApplyAdjustments, {
          jsAdjustments: payload,
          isInteractive: dragging,
          targetResolution: targetRes || null,
          roi: roi || null,
          computeWaveform: !!isWaveformVisible,
          activeWaveformChannel: activeWaveformChannelRef.current || null,
        });

        if (currentPath !== selectedImagePathRef.current) return;

        if (buffer && buffer.byteLength > 0 && jobId >= latestRenderedJobIdRef.current) {
          latestRenderedJobIdRef.current = jobId;

          if (dragging) {
            const view = new DataView(buffer);
            const patchX = view.getUint32(0, true);
            const patchY = view.getUint32(4, true);
            const patchW = view.getUint32(8, true);
            const patchH = view.getUint32(12, true);
            const fullW = view.getUint32(16, true);
            const fullH = view.getUint32(20, true);

            const imageBuffer = buffer.slice(24);
            const blob = new Blob([imageBuffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            setInteractivePatch((prev) => {
              if (prev && prev.url) setTimeout(() => URL.revokeObjectURL(prev.url), 100);
              return {
                url,
                normX: patchX / fullW,
                normY: patchY / fullH,
                normW: patchW / fullW,
                normH: patchH / fullH,
              };
            });
          } else {
            const blob = new Blob([buffer], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);

            if (currentPath !== selectedImagePathRef.current || jobId < latestRenderedJobIdRef.current) {
              URL.revokeObjectURL(url);
              return;
            }

            setFinalPreviewUrl((prevUrl) => {
              if (prevUrl && prevUrl.startsWith('blob:') && !imageCacheRef.current.isProtected(prevUrl)) {
                setTimeout(() => {
                  if (!imageCacheRef.current.isProtected(prevUrl)) {
                    URL.revokeObjectURL(prevUrl);
                  }
                }, 250);
              }
              return url;
            });

            setInteractivePatch((prev) => {
              if (prev && prev.url) {
                setTimeout(() => URL.revokeObjectURL(prev.url), 500);
              }
              return null;
            });
          }
        }
      } catch (err) {
        if (err !== 'Superseded or worker failed') {
          console.error('Failed to apply adjustments:', err);
        }

        if (!dragging) {
          setInteractivePatch((prev) => {
            if (prev && prev.url) URL.revokeObjectURL(prev.url);
            return null;
          });
        }
      }
    },
    [selectedImage?.isReady, selectedImage?.path, calculateROI, isWaveformVisible],
  );

  const generateUncroppedPreview = useCallback(
    (currentAdjustments: Adjustments) => {
      if (!selectedImage?.isReady) {
        return;
      }
      invoke(Invokes.GenerateUncroppedPreview, { jsAdjustments: currentAdjustments }).catch((err) =>
        console.error('Failed to generate uncropped preview:', err),
      );
    },
    [selectedImage?.isReady],
  );

  useEffect(() => {
    if (activeRightPanel === Panel.Crop && selectedImage?.isReady && isBackendReadyRef.current) {
      generateUncroppedPreview(adjustments);
    }
  }, [adjustments, activeRightPanel, selectedImage?.isReady, generateUncroppedPreview]);

  const debouncedSave = useCallback(
    debounce((path, adjustmentsToSave) => {
      invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments: adjustmentsToSave }).catch((err) => {
        console.error('Auto-save failed:', err);
        setError(`Failed to save changes: ${err}`);
      });
    }, 300),
    [],
  );

  const createResizeHandler = (setter: any, startSize: number) => (e: any) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const doDrag = (moveEvent: any) => {
      if (setter === setLeftPanelWidth) {
        setter(Math.max(200, Math.min(startSize + (moveEvent.clientX - startX), 500)));
      } else if (setter === setRightPanelWidth) {
        setter(Math.max(280, Math.min(startSize - (moveEvent.clientX - startX), 600)));
      } else if (setter === setBottomPanelHeight) {
        setter(Math.max(100, Math.min(startSize - (moveEvent.clientY - startY), 400)));
      }
    };
    const stopDrag = () => {
      document.documentElement.style.cursor = '';
      window.removeEventListener('mousemove', doDrag);
      window.removeEventListener('mouseup', stopDrag);
      setIsResizing(false);
    };
    document.documentElement.style.cursor = setter === setBottomPanelHeight ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', doDrag);
    window.addEventListener('mouseup', stopDrag);
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const checkFullscreen = async () => {
      setIsWindowFullScreen(await appWindow.isFullscreen());
    };
    checkFullscreen();

    const unlistenPromise = appWindow.onResized(checkFullscreen);

    return () => {
      unlistenPromise.then((unlisten: any) => unlisten());
    };
  }, []);

  const handleLutSelect = useCallback(
    async (path: string) => {
      try {
        const result: LutData = await invoke('load_and_parse_lut', { path });
        const name = path.split(/[\\/]/).pop() || 'LUT';
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          sectionVisibility: {
            ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
            effects: true,
          },
        }));
      } catch (err) {
        console.error('Failed to load or parse LUT:', err);
        setError(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments],
  );

  const handleRightPanelSelect = useCallback(
    (panelId: Panel) => {
      if (panelId === activeRightPanel) {
        setActiveRightPanel(null);
      } else {
        const currentIndex = activeRightPanel ? RIGHT_PANEL_ORDER.indexOf(activeRightPanel) : -1;
        const newIndex = RIGHT_PANEL_ORDER.indexOf(panelId);
        setSlideDirection(newIndex > currentIndex ? 1 : -1);
        setActiveRightPanel(panelId);
        setRenderedRightPanel(panelId);
      }
      setActiveMaskId(null);
      setActiveAiSubMaskId(null);
      setIsWbPickerActive(false);
    },
    [activeRightPanel],
  );

  const handleSettingsChange = useCallback(
    (newSettings: AppSettings): Promise<void> => {
      if (!newSettings) {
        console.error('handleSettingsChange was called with null settings. Aborting save operation.');
        return Promise.resolve();
      }
      if (newSettings.theme && newSettings.theme !== theme) {
        setTheme(newSettings.theme);
      }

      const { searchCriteria: _searchCriteria, ...settingsToSave } = newSettings as any;
      setAppSettings(newSettings);
      return invoke(Invokes.SaveSettings, { settings: settingsToSave })
        .then(() => {})
        .catch((err) => {
          console.error('Failed to save settings:', err);
        });
    },
    [theme],
  );

  useEffect(() => {
    try {
      setOsPlatform(platform());
    } catch (e) {
      console.error('Failed to get platform:', e);
    }
  }, []);

  useEffect(() => {
    invoke(Invokes.LoadSettings)
      .then(async (settings: any) => {
        if (
          !settings.copyPasteSettings ||
          !settings.copyPasteSettings.includedAdjustments ||
          settings.copyPasteSettings.includedAdjustments.length === 0
        ) {
          settings.copyPasteSettings = {
            mode: 'merge',
            includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
          };
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
        if (settings?.theme) {
          setTheme(settings.theme);
        }
        if (settings?.uiVisibility) {
          setUiVisibility((prev) => ({ ...prev, ...settings.uiVisibility }));
        }
        if (settings?.libraryViewMode) {
          setLibraryViewMode(settings.libraryViewMode);
        }
        if (settings?.thumbnailSize) {
          setThumbnailSize(settings.thumbnailSize);
        }
        if (settings?.thumbnailAspectRatio) {
          setThumbnailAspectRatio(settings.thumbnailAspectRatio);
        }
        if (settings?.activeTreeSection) {
          setActiveTreeSection(settings.activeTreeSection);
        }
        if (typeof settings?.isWaveformVisible === 'boolean') {
          setIsWaveformVisible(settings.isWaveformVisible);
        }
        if (settings?.activeWaveformChannel) {
          setActiveWaveformChannel(settings.activeWaveformChannel);
        }
        if (settings?.waveformHeight !== undefined) {
          setWaveformHeight(settings.waveformHeight);
        }
        if (settings?.pinnedFolders && settings.pinnedFolders.length > 0) {
          try {
            const trees = await invoke(Invokes.GetPinnedFolderTrees, {
              paths: settings.pinnedFolders,
              expandedFolders: settings.lastFolderState?.expandedFolders || [],
              showImageCounts: settings.enableFolderImageCounts ?? false,
            });
            setPinnedFolderTrees(trees);
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
        setAppSettings({ lastRootPath: null, theme: DEFAULT_THEME_ID });
      })
      .finally(() => {
        isInitialMount.current = false;
      });
  }, [isAndroid]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.uiVisibility) !== JSON.stringify(uiVisibility)) {
      handleSettingsChange({ ...appSettings, uiVisibility });
    }
  }, [uiVisibility, appSettings, handleSettingsChange]);

  const handleToggleWaveform = useCallback(() => {
    setIsWaveformVisible((prev: boolean) => !prev);
  }, []);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailSize !== thumbnailSize) {
      handleSettingsChange({ ...appSettings, thumbnailSize });
    }
  }, [thumbnailSize, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailAspectRatio !== thumbnailAspectRatio) {
      handleSettingsChange({ ...appSettings, thumbnailAspectRatio });
    }
  }, [thumbnailAspectRatio, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.libraryViewMode !== libraryViewMode) {
      handleSettingsChange({ ...appSettings, libraryViewMode });
    }
  }, [libraryViewMode, appSettings, handleSettingsChange]);

  useEffect(() => {
    invoke(Invokes.GetSupportedFileTypes)
      .then((types: any) => setSupportedTypes(types))
      .catch((err) => console.error('Failed to load supported file types:', err));
  }, []);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.sortCriteria) !== JSON.stringify(sortCriteria)) {
      handleSettingsChange({ ...appSettings, sortCriteria });
    }
  }, [sortCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.filterCriteria) !== JSON.stringify(filterCriteria)) {
      handleSettingsChange({ ...appSettings, filterCriteria });
    }
  }, [filterCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (
      appSettings.isWaveformVisible !== isWaveformVisible ||
      appSettings.activeWaveformChannel !== activeWaveformChannel ||
      appSettings.waveformHeight !== waveformHeight
    ) {
      handleSettingsChange({
        ...appSettings,
        isWaveformVisible,
        activeWaveformChannel,
        waveformHeight,
      });
    }
  }, [isWaveformVisible, activeWaveformChannel, waveformHeight, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (!appSettings?.adaptiveEditorTheme || !selectedImage) {
      setAdaptivePalette(null);
      return;
    }
    if (isSliderDragging || !finalPreviewUrl) {
      return;
    }
    generatePaletteFromImage(finalPreviewUrl)
      .then(setAdaptivePalette)
      .catch((_err) => {
        const darkTheme = THEMES.find((t) => t.id === Theme.Dark);
        setAdaptivePalette(darkTheme ? darkTheme.cssVariables : null);
      });
  }, [appSettings?.adaptiveEditorTheme, selectedImage, finalPreviewUrl, isSliderDragging]);

  useEffect(() => {
    const root = document.documentElement;
    const currentThemeId = theme || DEFAULT_THEME_ID;

    const baseTheme =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    if (!baseTheme) {
      return;
    }

    let finalCssVariables: any = { ...baseTheme.cssVariables };
    const effectThemeForWindow = baseTheme.id;

    if (adaptivePalette) {
      finalCssVariables = { ...finalCssVariables, ...adaptivePalette };
    }

    Object.entries(finalCssVariables).forEach(([key, value]) => {
      root.style.setProperty(key, value as string);
    });

    const fontFamily = appSettings?.fontFamily || 'poppins';
    const fontStack =
      fontFamily === 'system'
        ? '-apple-system, BlinkMacSystemFont, system-ui, sans-serif'
        : "'Poppins', system-ui, sans-serif";
    root.style.setProperty('--font-family', fontStack);

    const isLight = [Theme.Light, Theme.Snow, Theme.Arctic].includes(effectThemeForWindow);
    invoke(Invokes.UpdateWindowEffect, { theme: isLight ? Theme.Light : Theme.Dark });
  }, [theme, adaptivePalette, appSettings?.fontFamily]);

  useEffect(() => {
    if (isInitialThemeMount.current) {
      isInitialThemeMount.current = false;
      return;
    }

    setIsAnimatingTheme(true);
    const timer = setTimeout(() => setIsAnimatingTheme(false), 500);

    return () => clearTimeout(timer);
  }, [theme]);

  const refreshAllFolderTrees = useCallback(
    async (currentExpanded?: Set<string>) => {
      const activeExpanded = currentExpanded || expandedFolders;
      const expandedArr = Array.from(activeExpanded);
      const showCounts = appSettings?.enableFolderImageCounts ?? false;

      if (rootPath) {
        try {
          const treeData = await invoke(Invokes.GetFolderTree, {
            path: rootPath,
            expandedFolders: expandedArr,
            showImageCounts: showCounts,
          });
          setFolderTree(treeData);
        } catch (err) {
          console.error('Failed to refresh main folder tree:', err);
          setError(`Failed to refresh folder tree: ${err}.`);
        }
      }

      const currentPins = appSettings?.pinnedFolders || [];
      if (currentPins.length > 0) {
        try {
          const trees = await invoke(Invokes.GetPinnedFolderTrees, {
            paths: currentPins,
            expandedFolders: expandedArr,
            showImageCounts: showCounts,
          });
          setPinnedFolderTrees(trees);
        } catch (err) {
          console.error('Failed to refresh pinned folder trees:', err);
        }
      }
    },
    [rootPath, appSettings?.pinnedFolders, appSettings?.enableFolderImageCounts, expandedFolders],
  );

  const pinnedFolders = useMemo(() => appSettings?.pinnedFolders || [], [appSettings]);

  const handleTogglePinFolder = useCallback(
    async (path: string) => {
      if (!appSettings) return;
      const currentPins = appSettings.pinnedFolders || [];
      const isPinned = currentPins.includes(path);
      const newPins = isPinned
        ? currentPins.filter((p) => p !== path)
        : [...currentPins, path].sort((a, b) => a.localeCompare(b));

      if (!isPinned) {
        handleActiveTreeSectionChange('pinned');
      }

      handleSettingsChange({ ...appSettings, pinnedFolders: newPins });

      try {
        const trees = await invoke(Invokes.GetPinnedFolderTrees, {
          paths: newPins,
          expandedFolders: Array.from(expandedFolders),
          showImageCounts: appSettings.enableFolderImageCounts ?? false,
        });
        setPinnedFolderTrees(trees);
      } catch (err) {
        console.error('Failed to refresh pinned folders:', err);
      }
    },
    [appSettings, expandedFolders, handleSettingsChange],
  );

  const handleActiveTreeSectionChange = (section: string | null) => {
    setActiveTreeSection(section);
    if (appSettings) {
      handleSettingsChange({ ...appSettings, activeTreeSection: section });
    }
  };

  const handleSelectSubfolder = useCallback(
    async (path: string | null, isNewRoot = false, preloadedImages?: ImageFile[], expandParents = true) => {
      await invoke('cancel_thumbnail_generation');
      clearThumbnailQueue();
      setIsViewLoading(true);
      setSearchCriteria({ tags: [], text: '', mode: 'OR' });
      setLibraryScrollTop(0);
      setThumbnails({});
      imageCacheRef.current.clear();
      try {
        setCurrentFolderPath(path);
        setActiveView('library');

        if (isNewRoot) {
          if (path) {
            setExpandedFolders(new Set([path]));
          }
        } else if (path && expandParents) {
          setExpandedFolders((prev) => {
            const newSet = new Set(prev);
            const allRoots = [rootPath, ...pinnedFolders].filter(Boolean) as string[];
            const relevantRoot = allRoots.find((r) => path.startsWith(r));

            if (relevantRoot) {
              const separator = path.includes('/') ? '/' : '\\';
              const parentSeparatorIndex = path.lastIndexOf(separator);

              if (parentSeparatorIndex > -1 && path.length > relevantRoot.length) {
                let current = path.substring(0, parentSeparatorIndex);
                while (current && current.length >= relevantRoot.length) {
                  newSet.add(current);
                  const nextParentIndex = current.lastIndexOf(separator);
                  if (nextParentIndex === -1 || current === relevantRoot) {
                    break;
                  }
                  current = current.substring(0, nextParentIndex);
                }
              }
              newSet.add(relevantRoot);
            }
            return newSet;
          });
        }

        if (isNewRoot) {
          if (path && !pinnedFolders.includes(path)) {
            handleActiveTreeSectionChange('current');
          }
          setIsTreeLoading(true);
          handleSettingsChange({ ...appSettings, lastRootPath: path } as AppSettings);
          try {
            const treeData = await invoke(Invokes.GetFolderTree, {
              path,
              expandedFolders: [path],
              showImageCounts: appSettings?.enableFolderImageCounts ?? false,
            });
            setFolderTree(treeData);
          } catch (err) {
            console.error('Failed to load folder tree:', err);
            setError(`Failed to load folder tree: ${err}. Some sub-folders might be inaccessible.`);
          } finally {
            setIsTreeLoading(false);
          }
        }

        setImageList([]);
        setMultiSelectedPaths([]);
        setLibraryActivePath(null);
        if (selectedImage) {
          debouncedSave.flush();
          debouncedSetHistory.cancel();
          setSelectedImage(null);
          setFinalPreviewUrl(null);
          setUncroppedAdjustedPreviewUrl(null);
          setHistogram(null);
          setLiveAdjustments(INITIAL_ADJUSTMENTS);
          resetAdjustmentsHistory(INITIAL_ADJUSTMENTS);
        }

        const command =
          libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

        let files: ImageFile[];
        if (preloadedImages) {
          files = preloadedImages;
        } else {
          files = await invoke(command, { path });
        }

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) {
            initialRatings[f.path] = f.rating;
          }
        });
        setImageRatings(initialRatings);

        const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
        const isExifSortActive = exifSortKeys.includes(sortCriteria.key);
        const shouldReadExif = appSettings?.enableExifReading ?? false;

        if (shouldReadExif && files.length > 0) {
          const paths = files.map((f: ImageFile) => f.path);

          if (isExifSortActive) {
            const exifDataMap: Record<string, any> = await invoke(Invokes.ReadExifForPaths, { paths });
            const finalImageList = files.map((image) => ({
              ...image,
              exif: exifDataMap[image.path] || image.exif || null,
            }));
            setImageList(finalImageList);
          } else {
            setImageList(files);
            invoke(Invokes.ReadExifForPaths, { paths })
              .then((exifDataMap: any) => {
                setImageList((currentImageList) =>
                  currentImageList.map((image) => ({
                    ...image,
                    exif: exifDataMap[image.path] || image.exif || null,
                  })),
                );
              })
              .catch((err) => {
                console.error('Failed to read EXIF data in background:', err);
              });
          }
        } else {
          setImageList(files);
        }

        invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
          console.error('Failed to start background indexing:', err);
        });
      } catch (err) {
        console.error('Failed to load folder contents:', err);
        setError('Failed to load images from the selected folder.');
        setIsTreeLoading(false);
      } finally {
        setIsViewLoading(false);
      }
    },
    [
      appSettings,
      handleSettingsChange,
      selectedImage,
      rootPath,
      sortCriteria.key,
      pinnedFolders,
      libraryViewMode,
      debouncedSave,
      debouncedSetHistory,
      resetAdjustmentsHistory,
    ],
  );

  const handleLibraryRefresh = useCallback(() => {
    if (currentFolderPath) handleSelectSubfolder(currentFolderPath, false);
  }, [currentFolderPath, handleSelectSubfolder]);

  const refreshImageList = useCallback(async () => {
    if (!currentFolderPath) return;
    try {
      const command =
        libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

      const files: ImageFile[] = await invoke(command, { path: currentFolderPath });

      setImageRatings((prev) => {
        const newRatings = { ...prev };
        files.forEach((f) => {
          if (f.rating !== undefined) {
            newRatings[f.path] = f.rating;
          }
        });
        return newRatings;
      });

      const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
      const isExifSortActive = exifSortKeys.includes(sortCriteria.key);
      const shouldReadExif = appSettings?.enableExifReading ?? false;

      let freshExifData: Record<string, any> | null = null;

      if (shouldReadExif && files.length > 0 && isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        freshExifData = await invoke(Invokes.ReadExifForPaths, { paths });
      }

      setImageList((prevList) => {
        const prevMap = new Map(prevList.map((img) => [img.path, img]));

        return files.map((newFile) => {
          if (freshExifData && freshExifData[newFile.path]) {
            newFile.exif = freshExifData[newFile.path];
            return newFile;
          }
          const existing = prevMap.get(newFile.path);
          if (existing && existing.modified === newFile.modified) {
            return existing;
          }

          return newFile;
        });
      });

      if (shouldReadExif && files.length > 0 && !isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        invoke(Invokes.ReadExifForPaths, { paths })
          .then((exifDataMap: any) => {
            setImageList((currentImageList) =>
              currentImageList.map((image) => {
                if (exifDataMap[image.path] && !image.exif) {
                  return { ...image, exif: exifDataMap[image.path] };
                }
                return image;
              }),
            );
          })
          .catch((err) => {
            console.error('Failed to read EXIF data in background:', err);
          });
      }
    } catch (err) {
      console.error('Failed to refresh image list:', err);
      setError('Failed to refresh image list.');
    }
  }, [currentFolderPath, sortCriteria.key, appSettings?.enableExifReading, libraryViewMode]);

  const handleToggleFolder = useCallback(
    async (path: string) => {
      const isExpanding = !expandedFolders.has(path);
      setExpandedFolders((prev) => {
        const newSet = new Set(prev);
        if (isExpanding) {
          newSet.add(path);
        } else {
          newSet.delete(path);
        }
        return newSet;
      });
      if (!isExpanding) return;
      try {
        const showCounts = appSettings?.enableFolderImageCounts ?? false;
        const newChildren: any[] = await invoke(Invokes.GetFolderChildren, {
          path,
          showImageCounts: showCounts,
        });
        setFolderTree((prevTree: any) => insertChildrenIntoTree(prevTree, path, newChildren));
        setPinnedFolderTrees((prevTrees: any[]) =>
          prevTrees.map((tree) => insertChildrenIntoTree(tree, path, newChildren)),
        );
      } catch (err) {
        console.error('Failed to fetch folder children:', err);
        setError(`Failed to load folder: ${err}`);
      }
    },
    [expandedFolders, appSettings?.enableFolderImageCounts],
  );

  useEffect(() => {
    if (isInitialMount.current || !appSettings || !rootPath) {
      return;
    }

    const newFolderState = {
      currentFolderPath,
      expandedFolders: Array.from(expandedFolders),
    };

    if (JSON.stringify(appSettings.lastFolderState) === JSON.stringify(newFolderState)) {
      return;
    }

    handleSettingsChange({ ...appSettings, lastFolderState: newFolderState });
  }, [currentFolderPath, expandedFolders, rootPath, appSettings, handleSettingsChange]);

  useEffect(() => {
    const handleGlobalContextMenu = (event: any) => {
      if (!DEBUG) event.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  const handleBackToLibrary = useCallback(() => {
    if (selectedImage?.path && cachedEditStateRef.current) {
      imageCacheRef.current.set(selectedImage.path, cachedEditStateRef.current);
    }
    if (transformWrapperRef.current) {
      transformWrapperRef.current.resetTransform(0);
    }
    setZoom(1);

    debouncedSave.flush();
    debouncedSetHistory.cancel();

    const lastActivePath = selectedImage?.path ?? null;
    setSelectedImage(null);
    setFinalPreviewUrl(null);
    setUncroppedAdjustedPreviewUrl(null);
    setHistogram(null);
    setWaveform(null);
    setActiveMaskId(null);
    setActiveMaskContainerId(null);
    setActiveAiPatchContainerId(null);
    setIsWbPickerActive(false);
    setActiveAiSubMaskId(null);
    setLibraryActivePath(lastActivePath);
    setSlideDirection(1);
    setLiveAdjustments(INITIAL_ADJUSTMENTS);
    resetAdjustmentsHistory(INITIAL_ADJUSTMENTS);
    isBackendReadyRef.current = true;
    setInteractivePatch((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, [selectedImage?.path, resetAdjustmentsHistory, debouncedSave, debouncedSetHistory]);

  const handleImageSelect = useCallback(
    (path: string) => {
      if (selectedImage?.path === path) return;

      debouncedSave.flush();
      debouncedSetHistory.cancel();

      if (selectedImage?.path && cachedEditStateRef.current) {
        imageCacheRef.current.set(selectedImage.path, cachedEditStateRef.current);
      }

      patchesSentToBackend.current.clear();

      setMultiSelectedPaths([path]);
      setLibraryActivePath(null);
      setSelectionAnchorPath(path);
      setError(null);
      setShowOriginal(false);
      setActiveMaskId(null);
      setActiveMaskContainerId(null);
      setActiveAiPatchContainerId(null);
      setActiveAiSubMaskId(null);
      setIsWbPickerActive(false);
      setTransformedOriginalUrl(null);
      setIsLibraryExportPanelVisible(false);

      const cached = imageCacheRef.current.get(path);

      if (cached?.finalPreviewUrl && cached.selectedImage?.isReady) {
        setSelectedImage({
          ...cached.selectedImage,
          thumbnailUrl: thumbnails[path] || cached.selectedImage.thumbnailUrl,
        });
        setOriginalSize(cached.originalSize);
        setPreviewSize(cached.previewSize);

        setLiveAdjustments(cached.adjustments);
        resetAdjustmentsHistory(cached.adjustments);
        prevAdjustmentsRef.current = { path, adjustments: cached.adjustments };

        setHistogram(cached.histogram);
        setWaveform(cached.waveform);
        setFinalPreviewUrl(cached.finalPreviewUrl);
        setUncroppedAdjustedPreviewUrl(cached.uncroppedPreviewUrl);
        setIsViewLoading(false);

        latestRenderedJobIdRef.current = previewJobIdRef.current;
        isBackendReadyRef.current = false;
        currentResRef.current = Infinity;

        invoke('load_image', { path })
          .then((_result: any) => {
            if (selectedImagePathRef.current !== path) return;
            isBackendReadyRef.current = true;
            currentResRef.current = 0;
            setOriginalSize({ width: _result.width, height: _result.height });
          })
          .catch((err: any) => {
            if (String(err).includes('cancelled')) return;
            console.error('Background load_image failed on cache hit:', err);
            isBackendReadyRef.current = true;
            currentResRef.current = 0;
          });

        invoke(Invokes.LoadMetadata, { path })
          .then((metadata: any) => {
            if (selectedImagePathRef.current !== path) return;
            let freshAdjustments: Adjustments;
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              freshAdjustments = normalizeLoadedAdjustments(metadata.adjustments);
            } else {
              freshAdjustments = { ...INITIAL_ADJUSTMENTS };
            }
            if (!isSliderDragging && JSON.stringify(cached.adjustments) !== JSON.stringify(freshAdjustments)) {
              setLiveAdjustments(freshAdjustments);
              resetAdjustmentsHistory(freshAdjustments);
              prevAdjustmentsRef.current = { path, adjustments: freshAdjustments };
              imageCacheRef.current.set(path, { ...cached, adjustments: freshAdjustments });
            }
          })
          .catch((err) => console.error('Failed background metadata sync on cache hit:', err));

        return;
      }

      isBackendReadyRef.current = true;

      setSelectedImage({
        exif: null,
        height: 0,
        isRaw: false,
        isReady: false,
        metadata: null,
        originalUrl: null,
        path,
        thumbnailUrl: thumbnails[path],
        width: 0,
      });
      setOriginalSize({ width: 0, height: 0 });
      setPreviewSize({ width: 0, height: 0 });
      setIsViewLoading(true);
      setHistogram(null);
      setWaveform(null);
      setUncroppedAdjustedPreviewUrl(null);

      setFinalPreviewUrl((prev) => {
        if (prev?.startsWith('blob:') && !imageCacheRef.current.isProtected(prev)) {
          setTimeout(() => {
            if (!imageCacheRef.current.isProtected(prev)) {
              URL.revokeObjectURL(prev);
            }
          }, 250);
        }
        return null;
      });
      setInteractivePatch((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return null;
      });
    },
    [selectedImage?.path, debouncedSave, debouncedSetHistory, thumbnails, resetAdjustmentsHistory],
  );

  const executeDelete = useCallback(
    async (pathsToDelete: Array<string>, options = { includeAssociated: false }) => {
      if (!pathsToDelete || pathsToDelete.length === 0) {
        return;
      }

      const activePath = selectedImage ? selectedImage.path : libraryActivePath;
      let nextImagePath: string | null = null;

      if (activePath) {
        const physicalPath = activePath.split('?vc=')[0];
        const isActiveImageDeleted = pathsToDelete.some((p) => p === activePath || p === physicalPath);

        if (isActiveImageDeleted) {
          const currentIndex = sortedImageList.findIndex((img) => img.path === activePath);
          if (currentIndex !== -1) {
            const nextCandidate = sortedImageList
              .slice(currentIndex + 1)
              .find((img) => !pathsToDelete.includes(img.path));

            if (nextCandidate) {
              nextImagePath = nextCandidate.path;
            } else {
              const prevCandidate = sortedImageList
                .slice(0, currentIndex)
                .reverse()
                .find((img) => !pathsToDelete.includes(img.path));

              if (prevCandidate) {
                nextImagePath = prevCandidate.path;
              }
            }
          }
        } else {
          nextImagePath = activePath;
        }
      }

      try {
        const command = options.includeAssociated ? 'delete_files_with_associated' : 'delete_files_from_disk';
        await invoke(command, { paths: pathsToDelete });

        await refreshImageList();

        if (selectedImage) {
          const physicalPath = selectedImage.path.split('?vc=')[0];
          const isFileBeingEditedDeleted = pathsToDelete.some((p) => p === selectedImage.path || p === physicalPath);

          if (isFileBeingEditedDeleted) {
            if (nextImagePath) {
              handleImageSelect(nextImagePath);
            } else {
              handleBackToLibrary();
            }
          }
        } else {
          if (nextImagePath) {
            setMultiSelectedPaths([nextImagePath]);
            setLibraryActivePath(nextImagePath);
          } else {
            setMultiSelectedPaths([]);
            setLibraryActivePath(null);
          }
        }
      } catch (err) {
        console.error('Failed to delete files:', err);
        setError(`Failed to delete files: ${err}`);
      }
    },
    [refreshImageList, selectedImage, handleBackToLibrary, libraryActivePath, sortedImageList, handleImageSelect],
  );

  const handleDeleteSelected = useCallback(() => {
    const pathsToDelete = multiSelectedPaths;
    if (pathsToDelete.length === 0) {
      return;
    }

    const isSingle = pathsToDelete.length === 1;

    const selectionHasVirtualCopies =
      isSingle &&
      !pathsToDelete[0].includes('?vc=') &&
      imageList.some((image) => image.path.startsWith(`${pathsToDelete[0]}?vc=`));

    let modalTitle = 'Confirm Delete';
    let modalMessage = '';
    let confirmText = 'Delete';

    if (selectionHasVirtualCopies) {
      modalTitle = 'Delete Image and All Virtual Copies?';
      modalMessage = `Are you sure you want to permanently delete this image and all of its virtual copies? This action cannot be undone.`;
      confirmText = 'Delete All';
    } else if (isSingle) {
      modalMessage = `Are you sure you want to permanently delete this image? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
      confirmText = 'Delete Selected Only';
    } else {
      modalMessage = `Are you sure you want to permanently delete these ${pathsToDelete.length} images? This action cannot be undone. Right-click for more options (e.g., deleting associated files).`;
      confirmText = 'Delete Selected Only';
    }

    setConfirmModalState({
      confirmText,
      confirmVariant: 'destructive',
      isOpen: true,
      message: modalMessage,
      onConfirm: () => executeDelete(pathsToDelete, { includeAssociated: false }),
      title: modalTitle,
    });
  }, [multiSelectedPaths, executeDelete, imageList]);

  const handleToggleFullScreen = useCallback(() => {
    const currentlyZoomed = zoom > 1.01;
    setIsInstantTransition(currentlyZoomed);

    if (isFullScreen) {
      setIsFullScreen(false);
    } else {
      if (!selectedImage) {
        return;
      }
      setIsFullScreen(true);
    }

    if (currentlyZoomed) {
      setTimeout(() => setIsInstantTransition(false), 100);
    }
  }, [isFullScreen, selectedImage, zoom]);

  const handleCopyAdjustments = useCallback(() => {
    const sourceAdjustments = selectedImage ? adjustments : libraryActiveAdjustments;
    const adjustmentsToCopy: any = {};

    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        adjustmentsToCopy[key] = structuredClone(sourceAdjustments[key]);
      }
    }

    setCopiedAdjustments(adjustmentsToCopy);
    setIsCopied(true);
  }, [selectedImage, adjustments, libraryActiveAdjustments]);

  const handlePasteAdjustments = useCallback(
    (paths?: Array<string>) => {
      if (!copiedAdjustments || !appSettings) {
        return;
      }

      const { mode, includedAdjustments } = appSettings.copyPasteSettings;

      const adjustmentsToApply: Partial<Adjustments> = {};

      for (const key of includedAdjustments) {
        if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
          const value = copiedAdjustments[key as keyof Adjustments];

          if (mode === PasteMode.Merge) {
            const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              adjustmentsToApply[key as keyof Adjustments] = value;
            }
          } else {
            adjustmentsToApply[key as keyof Adjustments] = value;
          }
        }
      }

      if (Object.keys(adjustmentsToApply).length === 0) {
        setIsPasted(true);
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) {
        return;
      }

      pathsToUpdate.forEach((p) => imageCacheRef.current.delete(p));

      if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
        const newAdjustments = { ...adjustments, ...adjustmentsToApply };
        setAdjustments(newAdjustments);
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply }).catch(
        (err) => {
          console.error('Failed to paste adjustments to multiple images:', err);
          setError(`Failed to paste adjustments: ${err}`);
        },
      );
      setIsPasted(true);
    },
    [copiedAdjustments, appSettings, multiSelectedPaths, selectedImage, adjustments, setAdjustments],
  );

  const handleAutoAdjustments = async () => {
    if (!selectedImage?.isReady) {
      return;
    }
    imageCacheRef.current.delete(selectedImage.path);
    try {
      const autoAdjustments: Adjustments = await invoke(Invokes.CalculateAutoAdjustments);
      setAdjustments((prev: Adjustments) => {
        const newAdjustments = { ...prev, ...autoAdjustments };
        newAdjustments.sectionVisibility = {
          ...prev.sectionVisibility,
          ...autoAdjustments.sectionVisibility,
        };

        return newAdjustments;
      });
    } catch (err) {
      console.error('Failed to calculate auto adjustments:', err);
      setError(`Failed to apply auto adjustments: ${err}`);
    }
  };

  const handleRate = useCallback(
    (newRating: number, paths?: Array<string>) => {
      const pathsToRate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToRate.length === 0) {
        return;
      }

      const activePath = selectedImage?.path || libraryActivePath;
      const currentRating = activePath ? imageRatings[activePath] || 0 : 0;

      const finalRating = newRating === currentRating ? 0 : newRating;

      setImageRatings((prev: Record<string, number>) => {
        const newRatings = { ...prev };
        pathsToRate.forEach((path: string) => {
          newRatings[path] = finalRating;
        });
        return newRatings;
      });

      if (selectedImage && pathsToRate.includes(selectedImage.path)) {
        setAdjustments((prev: Adjustments) => ({ ...prev, rating: finalRating }));
      }

      if (libraryActivePath && pathsToRate.includes(libraryActivePath)) {
        setLibraryActiveAdjustments((prev) => ({ ...prev, rating: finalRating }));
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToRate, adjustments: { rating: finalRating } }).catch(
        (err) => {
          console.error('Failed to apply rating to paths:', err);
          setError(`Failed to apply rating: ${err}`);
        },
      );
    },
    [
      multiSelectedPaths,
      selectedImage,
      libraryActivePath,
      imageRatings,
      setAdjustments,
    ],
  );

  const handleSetColorLabel = useCallback(
    async (color: string | null, paths?: Array<string>) => {
      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) {
        return;
      }
      const primaryPath = selectedImage?.path || libraryActivePath;
      const primaryImage = imageList.find((img: ImageFile) => img.path === primaryPath);
      let currentColor = null;
      if (primaryImage && primaryImage.tags) {
        const colorTag = primaryImage.tags.find((tag: string) => tag.startsWith('color:'));
        if (colorTag) {
          currentColor = colorTag.substring(6);
        }
      }
      const finalColor = color !== null && color === currentColor ? null : color;
      try {
        await invoke(Invokes.SetColorLabelForPaths, { paths: pathsToUpdate, color: finalColor });

        setImageList((prevList: Array<ImageFile>) =>
          prevList.map((image: ImageFile) => {
            if (pathsToUpdate.includes(image.path)) {
              const otherTags = (image.tags || []).filter((tag: string) => !tag.startsWith('color:'));
              const newTags = finalColor ? [...otherTags, `color:${finalColor}`] : otherTags;
              return { ...image, tags: newTags };
            }
            return image;
          }),
        );
      } catch (err) {
        console.error('Failed to set color label:', err);
        setError(`Failed to set color label: ${err}`);
      }
    },
    [multiSelectedPaths, selectedImage, libraryActivePath, imageList],
  );

  const getCommonTags = useCallback(
    (paths: string[]): { tag: string; isUser: boolean }[] => {
      if (paths.length === 0) return [];
      const imageFiles = imageList.filter((img) => paths.includes(img.path));
      if (imageFiles.length === 0) return [];

      const allTagsSets = imageFiles.map((img) => {
        const tagsWithPrefix = (img.tags || []).filter((t) => !t.startsWith('color:'));
        return new Set(tagsWithPrefix);
      });

      if (allTagsSets.length === 0) return [];

      const commonTagsWithPrefix = allTagsSets.reduce((intersection, currentSet) => {
        return new Set([...intersection].filter((tag) => currentSet.has(tag)));
      });

      return Array.from(commonTagsWithPrefix)
        .map((tag) => ({
          tag: tag.startsWith('user:') ? tag.substring(5) : tag,
          isUser: tag.startsWith('user:'),
        }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
    },
    [imageList],
  );

  const handleTagsChanged = useCallback(
    (changedPaths: string[], newTags: { tag: string; isUser: boolean }[]) => {
      setImageList((prevList) =>
        prevList.map((image) => {
          if (changedPaths.includes(image.path)) {
            const colorTags = (image.tags || []).filter((t) => t.startsWith('color:'));
            const prefixedNewTags = newTags.map((t) => (t.isUser ? `user:${t.tag}` : t.tag));
            const finalTags = [...colorTags, ...prefixedNewTags].sort();
            return { ...image, tags: finalTags.length > 0 ? finalTags : null };
          }
          return image;
        }),
      );
    },
    [setImageList],
  );

  const closeConfirmModal = () => setConfirmModalState({ ...confirmModalState, isOpen: false });

  const handlePasteFiles = useCallback(
    async (mode = 'copy') => {
      if (copiedFilePaths.length === 0 || !currentFolderPath) {
        return;
      }
      try {
        if (mode === 'copy')
          await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
        else {
          await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
          setCopiedFilePaths([]);
        }
        await refreshImageList();
      } catch (err) {
        setError(`Failed to ${mode} files: ${err}`);
      }
    },
    [copiedFilePaths, currentFolderPath, refreshImageList],
  );

  const calculateTargetRes = useCallback(() => {
    const baseTargetRes = appSettings?.editorPreviewResolution || 1920;
    if (!(appSettings?.enableZoomHifi ?? true) || displaySize.width === 0) {
      return baseTargetRes;
    }

    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const sharpnessFactor = 1.15;
    const zoomMultiplier = appSettings?.highResZoomMultiplier || 1.0;

    const effectiveDpr = appSettings?.useFullDpiRendering ? dpr : 1;

    let targetRes = Math.max(displaySize.width, displaySize.height) * effectiveDpr * sharpnessFactor * zoomMultiplier;
    targetRes = Math.max(targetRes, 512);

    if (originalSize && originalSize.width > 0 && originalSize.height > 0) {
      const origMax = Math.max(originalSize.width, originalSize.height);
      targetRes = Math.min(targetRes, origMax);
      if (targetRes >= origMax * 0.8) {
        targetRes = origMax;
      }
    }

    if (originalSize && targetRes !== Math.max(originalSize.width, originalSize.height)) {
      targetRes = Math.ceil(targetRes / 256) * 256;
    }

    return Math.round(targetRes);
  }, [
    appSettings?.enableZoomHifi,
    appSettings?.editorPreviewResolution,
    appSettings?.highResZoomMultiplier,
    appSettings?.useFullDpiRendering,
    displaySize.width,
    displaySize.height,
    originalSize,
  ]);

  const requestHiFiZoom = useCallback(
    debounce((currentAdjustments: Adjustments, targetRes: number) => {
      if (targetRes > currentResRef.current) {
        currentResRef.current = targetRes;
        applyAdjustments(currentAdjustments, false, targetRes);
      }
    }, 100),
    [applyAdjustments],
  );

  useEffect(() => {
    if (selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let baseRes = calculateTargetRes();

      if (isFullScreen && originalSize.width > 0 && originalSize.height > 0) {
        baseRes = Math.max(originalSize.width, originalSize.height);
      }

      if (originalSize.width > 0 && originalSize.height > 0) {
        const maxRes = Math.max(originalSize.width, originalSize.height);
        if (baseRes > maxRes) {
          baseRes = maxRes;
        }
      }
      const finalRes = Math.round(baseRes);

      if (finalRes > currentResRef.current) {
        requestHiFiZoom(adjustments, finalRes);
      }
    }

    return () => {
      requestHiFiZoom.cancel();
    };
  }, [
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    adjustments,
    requestHiFiZoom,
    isFullScreen,
    originalSize,
    applyAdjustments,
  ]);

  useEffect(() => {
    if (!selectedImage?.isReady) return;

    if (dragIdleTimer.current) {
      clearTimeout(dragIdleTimer.current);
    }

    const targetRes = calculateTargetRes();

    if (isSliderDragging) {
      if (appSettings?.enableLivePreviews !== false) {
        applyAdjustments(adjustments, true, targetRes);
      }
    } else {
      dragIdleTimer.current = setTimeout(() => {
        currentResRef.current = targetRes;
        applyAdjustments(adjustments, false, targetRes);
        debouncedSave(selectedImage.path, adjustments);

        const otherPaths = multiSelectedPaths.filter((p) => p !== selectedImage.path);
        if (otherPaths.length > 0) {
          const prev = prevAdjustmentsRef.current;
          if (prev && prev.path === selectedImage.path) {
            const delta: Partial<Adjustments> = {};
            for (const key of Object.keys(adjustments) as Array<keyof Adjustments>) {
              if (JSON.stringify(adjustments[key]) !== JSON.stringify(prev.adjustments[key])) {
                (delta as any)[key] = adjustments[key];
              }
            }
            if (Object.keys(delta).length > 0) {
              otherPaths.forEach((p) => imageCacheRef.current.delete(p));
              invoke(Invokes.ApplyAdjustmentsToPaths, { paths: otherPaths, adjustments: delta }).catch((err) => {
                console.error('Failed to apply adjustments to multi-selection:', err);
              });
            }
          }
        }
        prevAdjustmentsRef.current = { path: selectedImage.path, adjustments };
      }, 50);
    }

    return () => {
      if (dragIdleTimer.current) clearTimeout(dragIdleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    adjustments,
    selectedImage?.path,
    selectedImage?.isReady,
    isSliderDragging,
    multiSelectedPaths,
    applyAdjustments,
    debouncedSave,
    appSettings?.enableLivePreviews,
  ]);

  const handleZoomChange = useCallback(
    (zoomValue: number, fitToWindow: boolean = false) => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      let targetZoomPercent: number;

      const orientationSteps = adjustments.orientationSteps || 0;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;
      const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;
      const effectiveOriginalHeight = isSwapped ? originalSize.width : originalSize.height;

      if (fitToWindow) {
        if (
          effectiveOriginalWidth > 0 &&
          effectiveOriginalHeight > 0 &&
          baseRenderSize.width > 0 &&
          baseRenderSize.height > 0
        ) {
          const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
          const baseAspect = baseRenderSize.width / baseRenderSize.height;
          if (originalAspect > baseAspect) {
            targetZoomPercent = baseRenderSize.width / effectiveOriginalWidth;
          } else {
            targetZoomPercent = baseRenderSize.height / effectiveOriginalHeight;
          }
        } else {
          targetZoomPercent = 1.0;
        }
      } else {
        targetZoomPercent = zoomValue / dpr;
      }

      targetZoomPercent = Math.max(0.1 / dpr, Math.min(2.0, targetZoomPercent));

      let transformZoom = 1.0;
      if (
        effectiveOriginalWidth > 0 &&
        effectiveOriginalHeight > 0 &&
        baseRenderSize.width > 0 &&
        baseRenderSize.height > 0
      ) {
        const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
        const baseAspect = baseRenderSize.width / baseRenderSize.height;
        if (originalAspect > baseAspect) {
          transformZoom = (targetZoomPercent * effectiveOriginalWidth) / baseRenderSize.width;
        } else {
          transformZoom = (targetZoomPercent * effectiveOriginalHeight) / baseRenderSize.height;
        }
      }
      isProgrammaticZoom.current = true;
      setZoom(transformZoom);
    },
    [originalSize, baseRenderSize, adjustments.orientationSteps],
  );

  const handleUserTransform = useCallback((transformState: TransformState) => {
    if (isProgrammaticZoom.current) {
      isProgrammaticZoom.current = false;
      return;
    }
    setZoom(transformState.scale);
  }, []);

  useEffect(() => {
    setTransformedOriginalUrl(null);
    currentOriginalResRef.current = 0;
  }, [geometricAdjustmentsKey, selectedImage?.path]);

  const requestHiFiOriginalZoom = useCallback(
    debounce(async (currentAdjustments: Adjustments, targetRes: number) => {
      if (targetRes > currentOriginalResRef.current) {
        try {
          const base64Data: string = await invoke('generate_original_transformed_preview', {
            jsAdjustments: currentAdjustments,
            targetResolution: targetRes,
          });
          currentOriginalResRef.current = targetRes;
          setTransformedOriginalUrl(base64Data);
        } catch (e) {
          console.error('Failed to generate hi-fi original preview:', e);
        }
      }
    }, 200),
    [],
  );

  useEffect(() => {
    if (showOriginal && selectedImage?.isReady && displaySize.width > 0 && !isSliderDragging) {
      let targetRes = calculateTargetRes();

      if (isFullScreen && originalSize.width > 0 && originalSize.height > 0) {
        targetRes = Math.max(originalSize.width, originalSize.height);
      }

      if (targetRes > currentOriginalResRef.current) {
        requestHiFiOriginalZoom(adjustments, targetRes);
      }
    }
    return () => {
      requestHiFiOriginalZoom.cancel();
    };
  }, [
    showOriginal,
    displaySize.width,
    displaySize.height,
    calculateTargetRes,
    selectedImage?.isReady,
    isSliderDragging,
    adjustments,
    requestHiFiOriginalZoom,
    isFullScreen,
    originalSize,
  ]);

  useEffect(() => {
    let isEffectActive = true;

    const generate = async () => {
      if (showOriginal && selectedImage?.path && !transformedOriginalUrl) {
        try {
          const targetRes = calculateTargetRes();

          const base64Data: string = await invoke('generate_original_transformed_preview', {
            jsAdjustments: adjustments,
            targetResolution: targetRes,
          });
          if (isEffectActive) {
            currentOriginalResRef.current = targetRes;
            setTransformedOriginalUrl(base64Data);
          }
        } catch (e) {
          if (isEffectActive) {
            console.error('Failed to generate original preview:', e);
            setError('Failed to show original image.');
            setShowOriginal(false);
          }
        }
      }
    };

    generate();

    return () => {
      isEffectActive = false;
    };
  }, [showOriginal, selectedImage?.path, adjustments, transformedOriginalUrl, calculateTargetRes]);

  const isAnyModalOpen =
    isCreateFolderModalOpen ||
    isRenameFolderModalOpen ||
    isRenameFileModalOpen ||
    isImportModalOpen ||
    isCopyPasteSettingsModalOpen ||
    confirmModalState.isOpen ||
    panoramaModalState.isOpen ||
    cullingModalState.isOpen ||
    collageModalState.isOpen ||
    denoiseModalState.isOpen ||
    negativeModalState.isOpen;

  useKeyboardShortcuts({
    isModalOpen: isAnyModalOpen,
    osPlatform,
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
    handleRotate,
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
    brushSettings: brushSettings,
    setBrushSettings: setBrushSettings,
  });

  useEffect(() => {
    let isEffectActive = true;
    const listeners = [
      listen('preview-update-uncropped', (event: any) => {
        if (isEffectActive) {
          setUncroppedAdjustedPreviewUrl(event.payload);
        }
      }),
      listen('histogram-update', (event: any) => {
        if (isEffectActive && event.payload.path === selectedImagePathRef.current) {
          setHistogram(event.payload.data);
        }
      }),
      listen('open-with-file', (event: any) => {
        if (isEffectActive) {
          setInitialFileToOpen(event.payload as string);
        }
      }),
      listen('waveform-update', (event: any) => {
        if (isEffectActive && event.payload.path === selectedImagePathRef.current) {
          setWaveform(event.payload.data);
        }
      }),
      listen('thumbnail-progress', (event: any) => {
        if (isEffectActive) {
          setThumbnailProgress({ current: event.payload.current, total: event.payload.total });
        }
      }),
      listen('thumbnail-generation-complete', () => {
        if (isEffectActive) {
          setThumbnailProgress({ current: 0, total: 0 });
        }
      }),
      listen('thumbnail-generated', (event: any) => {
        if (isEffectActive) {
          const { path, data, rating } = event.payload;
          if (data) {
            setThumbnails((prev) => ({ ...prev, [path]: data }));
          }
          if (rating !== undefined) {
            setImageRatings((prev) => ({ ...prev, [path]: rating }));
          }
        }
      }),
      listen('ai-model-download-start', (event: any) => {
        if (isEffectActive) {
          setAiModelDownloadStatus(event.payload);
        }
      }),
      listen('ai-model-download-finish', () => {
        if (isEffectActive) {
          setAiModelDownloadStatus(null);
        }
      }),
      listen('indexing-started', () => {
        if (isEffectActive) {
          setIsIndexing(true);
          setIndexingProgress({ current: 0, total: 0 });
        }
      }),
      listen('indexing-progress', (event: any) => {
        if (isEffectActive) {
          setIndexingProgress(event.payload);
        }
      }),
      listen('indexing-finished', () => {
        if (isEffectActive) {
          setIsIndexing(false);
          setIndexingProgress({ current: 0, total: 0 });
          if (currentFolderPathRef.current) {
            const refreshImageList = async () => {
              try {
                const list: ImageFile[] = await invoke(Invokes.ListImagesInDir, { path: currentFolderPathRef.current });
                if (Array.isArray(list)) {
                  setImageList(list);
                  setImageRatings((prev) => {
                    const newRatings = { ...prev };
                    list.forEach((f) => {
                      if (f.rating !== undefined) {
                        newRatings[f.path] = f.rating;
                      }
                    });
                    return newRatings;
                  });
                }
              } catch (err) {
                console.error('Failed to refresh after indexing:', err);
              }
            };
            refreshImageList();
          }
        }
      }),
      listen('batch-export-progress', (event: any) => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, progress: event.payload }));
        }
      }),
      listen('export-complete', () => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, status: Status.Success }));
        }
      }),
      listen('export-error', (event) => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({
            ...prev,
            status: Status.Error,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown export error occurred.',
          }));
        }
      }),
      listen('export-cancelled', () => {
        if (isEffectActive) {
          setExportState((prev: ExportState) => ({ ...prev, status: Status.Cancelled }));
        }
      }),
      listen('import-start', (event: any) => {
        if (isEffectActive) {
          setImportState({
            errorMessage: '',
            path: '',
            progress: { current: 0, total: event.payload.total },
            status: Status.Importing,
          });
        }
      }),
      listen('import-progress', (event: any) => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({
            ...prev,
            path: event.payload.path,
            progress: { current: event.payload.current, total: event.payload.total },
          }));
        }
      }),
      listen('import-complete', () => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({ ...prev, status: Status.Success }));
          refreshAllFolderTrees();
          if (currentFolderPathRef.current) {
            handleSelectSubfolder(currentFolderPathRef.current, false);
          }
        }
      }),
      listen('import-error', (event) => {
        if (isEffectActive) {
          setImportState((prev: ImportState) => ({
            ...prev,
            errorMessage: typeof event.payload === 'string' ? event.payload : 'An unknown import error occurred.',
            status: Status.Error,
          }));
        }
      }),
      listen('denoise-progress', (event: any) => {
        if (isEffectActive) {
          setDenoiseModalState((prev) => ({ ...prev, progressMessage: event.payload as string }));
        }
      }),
      listen('denoise-complete', (event: any) => {
        if (isEffectActive) {
          const payload = event.payload;
          const isObject = typeof payload === 'object' && payload !== null;

          setDenoiseModalState((prev) => ({
            ...prev,
            isProcessing: false,
            previewBase64: isObject ? payload.denoised : payload,
            originalBase64: isObject ? payload.original : null,
            progressMessage: null,
          }));
        }
      }),
      listen('denoise-error', (event: any) => {
        if (isEffectActive) {
          setDenoiseModalState((prev) => ({
            ...prev,
            isProcessing: false,
            error: String(event.payload),
            progressMessage: null,
          }));
        }
      }),
    ];
    return () => {
      isEffectActive = false;
      listeners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [refreshAllFolderTrees, handleSelectSubfolder]);

  useEffect(() => {
    if ([Status.Success, Status.Error, Status.Cancelled].includes(exportState.status)) {
      const timeoutDuration = exportState.status === Status.Success ? 5000 : 3000;

      const timer = setTimeout(() => {
        setExportState({ status: Status.Idle, progress: { current: 0, total: 0 }, errorMessage: '' });
      }, timeoutDuration);
      return () => clearTimeout(timer);
    }
  }, [exportState.status]);

  useEffect(() => {
    if ([Status.Success, Status.Error].includes(importState.status)) {
      const timer = setTimeout(() => {
        setImportState({ status: Status.Idle, progress: { current: 0, total: 0 }, path: '', errorMessage: '' });
      }, IMPORT_TIMEOUT);

      return () => clearTimeout(timer);
    }
  }, [importState.status]);

  useEffect(() => {
    if (libraryActivePath) {
      invoke(Invokes.LoadMetadata, { path: libraryActivePath })
        .then((metadata: any) => {
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            const normalized: Adjustments = normalizeLoadedAdjustments(metadata.adjustments);
            setLibraryActiveAdjustments(normalized);
          } else {
            setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
          }
        })
        .catch((err) => {
          console.error('Failed to load metadata for library active image', err);
          setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
        });
    } else {
      setLibraryActiveAdjustments(INITIAL_ADJUSTMENTS);
    }
  }, [libraryActivePath]);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenProgress = listen('panorama-progress', (event: any) => {
      if (isEffectActive) {
        setPanoramaModalState((prev: PanoramaModalState) => {
          if (prev.finalImageBase64 || prev.error) return prev;
          return {
            ...prev,
            progressMessage: event.payload,
          };
        });
      }
    });

    const unlistenComplete = listen('panorama-complete', (event: any) => {
      if (isEffectActive) {
        const { base64 } = event.payload;
        setPanoramaModalState((prev: PanoramaModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: base64,
          isProcessing: false,
          progressMessage: null,
        }));
      }
    });

    const unlistenError = listen('panorama-error', (event: any) => {
      if (isEffectActive) {
        setPanoramaModalState((prev: PanoramaModalState) => ({
          ...prev,
          error: String(event.payload),
          finalImageBase64: null,
          isProcessing: false,
          progressMessage: null,
        }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenProgress.then((f: any) => f());
      unlistenComplete.then((f: any) => f());
      unlistenError.then((f: any) => f());
    };
  }, []);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenProgress = listen('hdr-progress', (event: any) => {
      if (isEffectActive) {
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: null,
          isOpen: true,
          progressMessage: event.payload,
        }));
      }
    });

    const unlistenComplete = listen('hdr-complete', (event: any) => {
      if (isEffectActive) {
        const { base64 } = event.payload;
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: null,
          finalImageBase64: base64,
          isProcessing: false,
          progressMessage: 'Hdr Ready',
        }));
      }
    });

    const unlistenError = listen('hdr-error', (event: any) => {
      if (isEffectActive) {
        setHdrModalState((prev: HdrModalState) => ({
          ...prev,
          error: String(event.payload),
          finalImageBase64: null,
          isProcessing: false,
          progressMessage: 'An error occurred.',
        }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenProgress.then((f: any) => f());
      unlistenComplete.then((f: any) => f());
      unlistenError.then((f: any) => f());
    };
  }, []);

  useEffect(() => {
    let isEffectActive = true;

    const unlistenStart = listen('culling-start', (event: any) => {
      if (isEffectActive) {
        setCullingModalState({
          isOpen: true,
          progress: { current: 0, total: event.payload, stage: 'Initializing...' },
          suggestions: null,
          error: null,
        });
      }
    });

    const unlistenProgress = listen('culling-progress', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: event.payload }));
      }
    });

    const unlistenComplete = listen('culling-complete', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: null, suggestions: event.payload }));
      }
    });

    const unlistenError = listen('culling-error', (event: any) => {
      if (isEffectActive) {
        setCullingModalState((prev) => ({ ...prev, progress: null, error: String(event.payload) }));
      }
    });

    return () => {
      isEffectActive = false;
      unlistenStart.then((f) => f());
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  const handleStartPanorama = (paths: string[]) => {
    setPanoramaModalState((prev: PanoramaModalState) => ({
      ...prev,
      isProcessing: true,
      error: null,
      finalImageBase64: null,
      progressMessage: 'Starting panorama process...',
    }));
    invoke(Invokes.StitchPanorama, { paths }).catch((err) => {
      setPanoramaModalState((prev: PanoramaModalState) => ({
        ...prev,
        isProcessing: false,
        error: String(err),
      }));
    });
  };

  const handleSavePanorama = async (): Promise<string> => {
    if (panoramaModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      setPanoramaModalState((prev: PanoramaModalState) => ({ ...prev, error: err }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: panoramaModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      setPanoramaModalState((prev: PanoramaModalState) => ({ ...prev, error: String(err) }));
      throw err;
    }
  };

  const handleStartHdr = (paths: string[]) => {
    setHdrModalState((prev: HdrModalState) => ({
      ...prev,
      isProcessing: true,
      error: null,
      finalImageBase64: null,
      progressMessage: 'Starting HDR process...',
    }));
    invoke(Invokes.MergeHdr, { paths }).catch((err) => {
      setHdrModalState((prev: HdrModalState) => ({
        ...prev,
        isProcessing: false,
        error: String(err),
      }));
    });
  };

  const handleSaveHdr = async (): Promise<string> => {
    if (hdrModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for HDR not found.';
      setHdrModalState((prev: HdrModalState) => ({ ...prev, error: err }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SaveHdr, {
        firstPathStr: hdrModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save HDR image:', err);
      setHdrModalState((prev: HdrModalState) => ({ ...prev, error: String(err) }));
      throw err;
    }
  };

  const handleApplyDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d') => {
      if (denoiseModalState.targetPaths.length === 0) return;

      setDenoiseModalState((prev) => ({
        ...prev,
        isProcessing: true,
        error: null,
        progressMessage: 'Starting engine...',
      }));

      try {
        await invoke(Invokes.ApplyDenoising, {
          path: denoiseModalState.targetPaths[0],
          intensity: intensity,
          method: method,
        });
      } catch (err) {
        setDenoiseModalState((prev) => ({
          ...prev,
          isProcessing: false,
          error: String(err),
        }));
      }
    },
    [denoiseModalState.targetPaths],
  );

  const handleBatchDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d', paths: string[]) => {
      try {
        const savedPaths: string[] = await invoke('batch_denoise_images', {
          paths,
          intensity,
          method,
        });
        await refreshImageList();
        return savedPaths;
      } catch (err) {
        setDenoiseModalState((prev) => ({
          ...prev,
          error: String(err),
        }));
        throw err;
      }
    },
    [refreshImageList],
  );

  const handleSaveDenoisedImage = async (): Promise<string> => {
    if (denoiseModalState.targetPaths.length === 0) throw new Error('No target path');
    const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
      originalPathStr: denoiseModalState.targetPaths[0],
    });
    await refreshImageList();
    return savedPath;
  };

  const handleSaveCollage = async (base64Data: string, firstPath: string): Promise<string> => {
    try {
      const savedPath: string = await invoke(Invokes.SaveCollage, {
        base64Data,
        firstPathStr: firstPath,
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save collage:', err);
      setError(`Failed to save collage: ${err}`);
      throw err;
    }
  };

  const handleOpenFolder = async () => {
    try {
      if (isAndroid) {
        const libraryRoot = await invoke<string>(Invokes.GetOrCreateInternalLibraryRoot);
        setRootPath(libraryRoot);
        await handleSelectSubfolder(libraryRoot, true);
        return;
      }

      const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
      if (typeof selected === 'string') {
        setRootPath(selected);
        await handleSelectSubfolder(selected, true);
      }
    } catch (err) {
      console.error(isAndroid ? 'Failed to open Android library root:' : 'Failed to open directory dialog:', err);
      setError(isAndroid ? 'Failed to open library.' : 'Failed to open folder selection dialog.');
    }
  };

  useEffect(() => {
    if (!rootPath) {
      setIsLayoutReady(false);
      return;
    }

    const timer = setTimeout(() => {
      setIsLayoutReady(true);
    }, 100);

    return () => clearTimeout(timer);
  }, [rootPath]);

  const handleContinueSession = () => {
    const restore = async () => {
      if (!appSettings?.lastRootPath) {
        return;
      }

      const root = appSettings.lastRootPath;
      const folderState = appSettings.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || root;

      setRootPath(root);

      if (folderState?.expandedFolders) {
        const newExpandedFolders = new Set(folderState.expandedFolders);
        setExpandedFolders(newExpandedFolders);
      } else {
        setExpandedFolders(new Set([root]));
      }

      setIsTreeLoading(true);
      try {
        let treeData;
        if (preloadedDataRef.current.rootPath === root && preloadedDataRef.current.tree) {
          treeData = await preloadedDataRef.current.tree;
          console.log('Preload cache hit for folder tree.');
        } else {
          const expandedArr = folderState?.expandedFolders ? Array.from(new Set(folderState.expandedFolders)) : [root];
          treeData = await invoke(Invokes.GetFolderTree, {
            path: root,
            expandedFolders: expandedArr,
            showImageCounts: appSettings?.enableFolderImageCounts ?? false,
          });
        }
        setFolderTree(treeData);
      } catch (err) {
        console.error('Failed to restore folder tree:', err);
      } finally {
        setIsTreeLoading(false);
      }

      let preloadedImages: ImageFile[] | undefined = undefined;
      if (preloadedDataRef.current.currentPath === pathToSelect && preloadedDataRef.current.images) {
        try {
          preloadedImages = await preloadedDataRef.current.images;
          console.log('Preload cache hit for image list.');
        } catch (e) {
          console.error('Failed to retrieve preloaded images', e);
        }
      }

      await handleSelectSubfolder(pathToSelect, false, preloadedImages, false);
    };
    restore().catch((err) => {
      console.error('Failed to restore session, folder might be missing:', err);
      setError('Failed to restore session. The last used folder may have been moved or deleted.');
      if (appSettings) {
        handleSettingsChange({ ...appSettings, lastRootPath: null, lastFolderState: null });
      }
      handleGoHome();
      setIsTreeLoading(false);
    });
  };

  useEffect(() => {
    if (!initialFileToOpen || !appSettings) {
      return;
    }
    const parentDir = getParentDir(initialFileToOpen);
    if (currentFolderPath !== parentDir) {
      setRootPath(parentDir);
      handleSelectSubfolder(parentDir, true);
      return;
    }
    const isImageInList = imageList.some((image) => image.path === initialFileToOpen);
    if (isImageInList) {
      handleImageSelect(initialFileToOpen);
      setInitialFileToOpen(null);
    } else if (!isViewLoading) {
      console.warn(`'open-with-file' target ${initialFileToOpen} not found in its directory after loading. Aborting.`);
      setInitialFileToOpen(null);
    }
  }, [
    initialFileToOpen,
    appSettings,
    currentFolderPath,
    imageList,
    isViewLoading,
    handleSelectSubfolder,
    handleImageSelect,
  ]);

  const handleGoHome = () => {
    setRootPath(null);
    setCurrentFolderPath(null);
    setImageList([]);
    setImageRatings({});
    setFolderTree(null);
    setMultiSelectedPaths([]);
    setLibraryActivePath(null);
    setIsLibraryExportPanelVisible(false);
    setExpandedFolders(new Set());
  };

  const handleMultiSelectClick = (path: string, event: any, options: MultiSelectOptions) => {
    const { ctrlKey, metaKey, shiftKey } = event;
    const isCtrlPressed = ctrlKey || metaKey;
    const { shiftAnchor, onSimpleClick, updateLibraryActivePath } = options;

    if (shiftKey && shiftAnchor) {
      const anchorIndex = sortedImageList.findIndex((f) => f.path === shiftAnchor);
      const currentIndex = sortedImageList.findIndex((f) => f.path === path);

      if (anchorIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        const range = sortedImageList.slice(start, end + 1).map((f: ImageFile) => f.path);
        const baseSelection = isCtrlPressed ? multiSelectedPaths : [];
        const newSelection = Array.from(new Set([...baseSelection, ...range]));

        setMultiSelectedPaths(newSelection);
        setSelectionAnchorPath(path);
        if (updateLibraryActivePath) {
          setLibraryActivePath(path);
        }
      }
    } else if (isCtrlPressed) {
      const newSelection = new Set(multiSelectedPaths);
      if (newSelection.has(path)) {
        newSelection.delete(path);
      } else {
        newSelection.add(path);
      }

      const newSelectionArray = Array.from(newSelection);
      setMultiSelectedPaths(newSelectionArray);
      setSelectionAnchorPath(path);

      if (updateLibraryActivePath) {
        if (newSelectionArray.includes(path)) {
          setLibraryActivePath(path);
        } else if (newSelectionArray.length > 0) {
          setLibraryActivePath(newSelectionArray[newSelectionArray.length - 1]);
        } else {
          setLibraryActivePath(null);
        }
      }
    } else {
      onSimpleClick(path);
      setSelectionAnchorPath(path);
    }
  };

  const handleLibraryImageSingleClick = (path: string, event: any) => {
    handleMultiSelectClick(path, event, {
      shiftAnchor: selectionAnchorPath ?? libraryActivePath,
      updateLibraryActivePath: true,
      onSimpleClick: (p: any) => {
        setMultiSelectedPaths([p]);
        setLibraryActivePath(p);
        setSelectionAnchorPath(p);
      },
    });
  };

  const handleImageClick = (path: string, event: any) => {
    const inEditor = !!selectedImage;
    handleMultiSelectClick(path, event, {
      shiftAnchor: selectionAnchorPath ?? (inEditor ? selectedImage.path : libraryActivePath),
      updateLibraryActivePath: !inEditor,
      onSimpleClick: (p: string) => {
        handleImageSelect(p);
        setSelectionAnchorPath(p);
      },
    });
  };

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;

      const loadMetadataEarly = async () => {
        try {
          const metadata: any = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
          if (!isEffectActive) return;

          let initialAdjusts;
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(metadata.adjustments);
          } else {
            initialAdjusts = { ...INITIAL_ADJUSTMENTS };
          }

          setLiveAdjustments(initialAdjusts);
          resetAdjustmentsHistory(initialAdjusts);
        } catch (err) {
          console.error('Failed to load metadata early:', err);
        }
      };

      const loadFullImageData = async () => {
        try {
          const loadImageResult: any = await invoke(Invokes.LoadImage, { path: selectedImage.path });
          if (!isEffectActive) {
            return;
          }

          const { width, height } = loadImageResult;
          setOriginalSize({ width, height });

          if (appSettings?.editorPreviewResolution) {
            const maxSize = appSettings.editorPreviewResolution;
            const aspectRatio = width / height;

            if (width > height) {
              const pWidth = Math.min(width, maxSize);
              const pHeight = Math.round(pWidth / aspectRatio);
              setPreviewSize({ width: pWidth, height: pHeight });
            } else {
              const pHeight = Math.min(height, maxSize);
              const pWidth = Math.round(pHeight * aspectRatio);
              setPreviewSize({ width: pWidth, height: pHeight });
            }
          } else {
            setPreviewSize({ width: 0, height: 0 });
          }

          setSelectedImage((currentSelected: SelectedImage | null) => {
            if (currentSelected && currentSelected.path === selectedImage.path) {
              return {
                ...currentSelected,
                exif: loadImageResult.exif,
                height: loadImageResult.height,
                isRaw: loadImageResult.is_raw,
                isReady: true,
                metadata: loadImageResult.metadata,
                originalUrl: null,
                width: loadImageResult.width,
              };
            }
            return currentSelected;
          });

          setLiveAdjustments((prev: Adjustments) => {
            if (!prev.aspectRatio && !prev.crop) {
              return { ...prev, aspectRatio: loadImageResult.width / loadImageResult.height };
            }
            return prev;
          });
        } catch (err) {
          if (isEffectActive) {
            console.error('Failed to load image:', err);
            setError(`Failed to load image: ${err}`);
            setSelectedImage(null);
          }
        } finally {
          if (isEffectActive) {
            setIsViewLoading(false);
          }
        }
      };

      const loadAll = async () => {
        await loadMetadataEarly();
        if (isEffectActive) {
          await loadFullImageData();
        }
      };

      loadAll();

      return () => {
        isEffectActive = false;
      };
    }
  }, [selectedImage?.path, selectedImage?.isReady, resetAdjustmentsHistory, appSettings?.editorPreviewResolution]);

  const handleClearSelection = () => {
    if (selectedImage) {
      setMultiSelectedPaths([selectedImage.path]);
    } else {
      setMultiSelectedPaths([]);
      setLibraryActivePath(null);
    }
  };

  const handleRenameFiles = useCallback(async (paths: Array<string>) => {
    if (paths && paths.length > 0) {
      setRenameTargetPaths(paths);
      setIsRenameFileModalOpen(true);
    }
  }, []);

  const handleSaveRename = useCallback(
    async (nameTemplate: string) => {
      if (renameTargetPaths.length > 0 && nameTemplate) {
        try {
          const newPaths: Array<string> = await invoke(Invokes.RenameFiles, {
            nameTemplate,
            paths: renameTargetPaths,
          });

          await refreshImageList();

          if (selectedImage && renameTargetPaths.includes(selectedImage.path)) {
            const oldPathIndex = renameTargetPaths.indexOf(selectedImage.path);

            if (newPaths[oldPathIndex]) {
              handleImageSelect(newPaths[oldPathIndex]);
            } else {
              handleBackToLibrary();
            }
          }

          if (libraryActivePath && renameTargetPaths.includes(libraryActivePath)) {
            const oldPathIndex = renameTargetPaths.indexOf(libraryActivePath);

            if (newPaths[oldPathIndex]) {
              setLibraryActivePath(newPaths[oldPathIndex]);
            } else {
              setLibraryActivePath(null);
            }
          }

          setMultiSelectedPaths(newPaths);
        } catch (err) {
          setError(`Failed to rename files: ${err}`);
        }
      }

      setRenameTargetPaths([]);
    },
    [renameTargetPaths, refreshImageList, selectedImage, libraryActivePath, handleImageSelect, handleBackToLibrary],
  );

  const handleStartImport = async (settings: AppSettings) => {
    if (importSourcePaths.length > 0 && importTargetFolder) {
      invoke(Invokes.ImportFiles, {
        destinationFolder: importTargetFolder,
        settings: settings,
        sourcePaths: importSourcePaths,
      }).catch((err) => {
        console.error('Failed to start import:', err);
        setImportState({ status: Status.Error, errorMessage: `Failed to start import: ${err}` });
      });
    }
  };

  const handleResetAdjustments = useCallback(
    (paths?: Array<string>) => {
      const pathsToReset = paths || multiSelectedPaths;
      if (pathsToReset.length === 0) {
        return;
      }

      pathsToReset.forEach((p) => imageCacheRef.current.delete(p));
      debouncedSetHistory.cancel();

      invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset })
        .then(() => {
          if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
            setLibraryActiveAdjustments((prev: Adjustments) => ({ ...INITIAL_ADJUSTMENTS, rating: prev.rating }));
          }
          if (selectedImage && pathsToReset.includes(selectedImage.path)) {
            const currentRating = adjustments.rating;

            const originalAspectRatio =
              selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;

            resetAdjustmentsHistory({
              ...INITIAL_ADJUSTMENTS,
              aspectRatio: originalAspectRatio,
              rating: currentRating,
              aiPatches: [],
            });
          }
        })
        .catch((err) => {
          console.error('Failed to reset adjustments:', err);
          setError(`Failed to reset adjustments: ${err}`);
        });
    },
    [
      multiSelectedPaths,
      libraryActivePath,
      selectedImage,
      adjustments.rating,
      resetAdjustmentsHistory,
      debouncedSetHistory,
    ],
  );

  const handleImportClick = useCallback(
    async (targetPath: string) => {
      try {
        const nonRaw = supportedTypes?.nonRaw || [];
        const raw = supportedTypes?.raw || [];

        const expandExtensions = (exts: string[]) => {
          return Array.from(new Set(exts.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()])));
        };

        const processedNonRaw = expandExtensions(nonRaw);
        const processedRaw = expandExtensions(raw);
        const allImageExtensions = [...processedNonRaw, ...processedRaw];

        const selected = await open({
          filters: [
            {
              name: 'All Supported Images',
              extensions: allImageExtensions,
            },
            {
              name: 'RAW Images',
              extensions: processedRaw,
            },
            {
              name: 'Standard Images (JPEG, PNG, etc.)',
              extensions: processedNonRaw,
            },
            {
              name: 'All Files',
              extensions: ['*'],
            },
          ],
          multiple: true,
          title: 'Select files to import',
        });

        if (Array.isArray(selected) && selected.length > 0) {
          setImportSourcePaths(selected);
          setImportTargetFolder(targetPath);
          setIsImportModalOpen(true);
        }
      } catch (err) {
        console.error('Failed to open file dialog for import:', err);
      }
    },
    [supportedTypes],
  );

  const handleEditorContextMenu = (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedImage) return;

    const handleCreateVirtualCopy = async (sourcePath: string) => {
      try {
        await invoke(Invokes.CreateVirtualCopy, { sourceVirtualPath: sourcePath });
        await refreshImageList();
      } catch (err) {
        console.error('Failed to create virtual copy:', err);
        setError(`Failed to create virtual copy: ${err}`);
      }
    };

    const commonTags = getCommonTags([selectedImage.path]);

    const options: Array<Option> = [
      {
        label: 'Export Image',
        icon: Save,
        onClick: () => {
          setRenderedRightPanel(Panel.Export);
          setActiveRightPanel(Panel.Export);
        },
      },
      { type: OPTION_SEPARATOR },
      { label: 'Undo', icon: Undo, onClick: undo, disabled: !canUndo },
      { label: 'Redo', icon: Redo, onClick: redo, disabled: !canRedo },
      { type: OPTION_SEPARATOR },
      { label: 'Copy Adjustments', icon: Copy, onClick: handleCopyAdjustments },
      {
        label: 'Paste Adjustments',
        icon: ClipboardPaste,
        onClick: handlePasteAdjustments,
        disabled: copiedAdjustments === null,
      },
      {
        label: 'Productivity',
        icon: Gauge,
        submenu: [
          {
            label: 'Auto Adjust Image',
            icon: Aperture,
            onClick: handleAutoAdjustments,
            disabled: !selectedImage?.isReady,
          },
          {
            label: 'Denoise Image',
            icon: Grip,
            onClick: () => {
              setDenoiseModalState({
                isOpen: true,
                isProcessing: false,
                previewBase64: null,
                error: null,
                targetPaths: [selectedImage.path],
                progressMessage: null,
                isRaw: selectedImage?.isRaw,
              });
            },
          },
          {
            label: 'Convert Negative',
            icon: Film,
            onClick: () => {
              if (selectedImage) {
                setNegativeModalState({
                  isOpen: true,
                  targetPaths: [selectedImage.path],
                });
              }
            },
          },
          {
            disabled: true,
            icon: SquaresUnite,
            label: 'Stitch Panorama',
          },
          {
            disabled: true,
            icon: Images,
            label: 'Merge to HDR',
          },
          {
            icon: LayoutTemplate,
            label: 'Frame Image',
            onClick: () => {
              setCollageModalState({
                isOpen: true,
                sourceImages: [selectedImage],
              });
            },
          },
          {
            label: 'Cull Image',
            icon: Users,
            disabled: true,
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Rating',
        icon: Star,
        submenu: [0, 1, 2, 3, 4, 5].map((rating: number) => ({
          label: rating === 0 ? 'No Rating' : `${rating} Star${rating !== 1 ? 's' : ''}`,
          onClick: () => handleRate(rating),
        })),
      },
      {
        label: 'Color Label',
        icon: Palette,
        submenu: [
          { label: 'No Label', onClick: () => handleSetColorLabel(null) },
          ...COLOR_LABELS.map((label: Color) => ({
            label: label.name.charAt(0).toUpperCase() + label.name.slice(1),
            color: label.color,
            onClick: () => handleSetColorLabel(label.name),
          })),
        ],
      },
      {
        label: 'Tagging',
        icon: Tag,
        submenu: [
          {
            customComponent: TaggingSubMenu,
            customProps: {
              paths: [selectedImage.path],
              initialTags: commonTags,
              onTagsChanged: handleTagsChanged,
              appSettings,
            },
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Reset Adjustments',
        icon: RotateCcw,
        onClick: () => {
          debouncedSetHistory.cancel();
          const currentRating = adjustments.rating;

          const originalAspectRatio =
            selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;

          resetAdjustmentsHistory({
            ...INITIAL_ADJUSTMENTS,
            aspectRatio: originalAspectRatio,
            rating: currentRating,
            aiPatches: [],
          });
        },
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleThumbnailContextMenu = (event: any, path: string) => {
    event.preventDefault();
    event.stopPropagation();

    const isTargetInSelection = multiSelectedPaths.includes(path);
    let finalSelection;

    if (!isTargetInSelection) {
      finalSelection = [path];
      setMultiSelectedPaths([path]);
      if (!selectedImage) {
        setLibraryActivePath(path);
      }
    } else {
      finalSelection = multiSelectedPaths;
    }

    const commonTags = getCommonTags(finalSelection);

    const selectionCount = finalSelection.length;
    const isSingleSelection = selectionCount === 1;
    const isEditingThisImage = selectedImage?.path === path;
    const deleteLabel = isSingleSelection ? 'Delete Image' : `Delete ${selectionCount} Images`;
    const exportLabel = isSingleSelection ? 'Export Image' : `Export ${selectionCount} Images`;

    const selectionHasVirtualCopies =
      isSingleSelection &&
      !finalSelection[0].includes('?vc=') &&
      imageList.some((image) => image.path.startsWith(`${finalSelection[0]}?vc=`));

    const hasAssociatedFiles = finalSelection.some((selectedPath) => {
      const lastDotIndex = selectedPath.lastIndexOf('.');
      if (lastDotIndex === -1) return false;
      const basePath = selectedPath.substring(0, lastDotIndex);
      return imageList.some((image) => image.path.startsWith(basePath + '.') && image.path !== selectedPath);
    });

    let deleteSubmenu;
    if (selectionHasVirtualCopies) {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Confirm Delete + Virtual Copies',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
      ];
    } else if (hasAssociatedFiles) {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Delete Selected Only',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
        {
          label: 'Delete + Associated',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: true }),
        },
      ];
    } else {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Confirm',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
      ];
    }

    const deleteOption = {
      label: deleteLabel,
      icon: Trash2,
      isDestructive: true,
      submenu: deleteSubmenu,
    };

    const pasteLabel = isSingleSelection ? 'Paste Adjustments' : `Paste Adjustments to ${selectionCount} Images`;
    const resetLabel = isSingleSelection ? 'Reset Adjustments' : `Reset Adjustments on ${selectionCount} Images`;
    const copyLabel = isSingleSelection ? 'Copy Image' : `Copy ${selectionCount} Images`;
    const autoAdjustLabel = isSingleSelection ? 'Auto Adjust Image' : `Auto Adjust Images`;
    const renameLabel = isSingleSelection ? 'Rename Image' : `Rename ${selectionCount} Images`;
    const cullLabel = isSingleSelection ? 'Cull Image' : `Cull Images`;
    const collageLabel = isSingleSelection ? 'Frame Image' : 'Create Collage';
    const stitchLabel = 'Stitch Panorama';
    const conversionLabel = isSingleSelection ? 'Convert Negative' : 'Convert Negatives';
    const denoiseLabel = isSingleSelection ? 'Denoise Image' : 'Denoise Images';
    const mergeLabel = `Merge to HDR`;

    const handleCreateVirtualCopy = async (sourcePath: string) => {
      try {
        await invoke(Invokes.CreateVirtualCopy, { sourceVirtualPath: sourcePath });
        await refreshImageList();
      } catch (err) {
        console.error('Failed to create virtual copy:', err);
        setError(`Failed to create virtual copy: ${err}`);
      }
    };

    const handleApplyAutoAdjustmentsToSelection = () => {
      if (finalSelection.length === 0) return;
      finalSelection.forEach((p) => imageCacheRef.current.delete(p));

      invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths: finalSelection })
        .then(async () => {
          if (selectedImage && finalSelection.includes(selectedImage.path)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, {
              path: selectedImage.path,
            });
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              const normalized = normalizeLoadedAdjustments(metadata.adjustments);
              setLiveAdjustments(normalized);
              resetAdjustmentsHistory(normalized);
            }
          }
          if (libraryActivePath && finalSelection.includes(libraryActivePath)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, {
              path: libraryActivePath,
            });
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              const normalized = normalizeLoadedAdjustments(metadata.adjustments);
              setLibraryActiveAdjustments(normalized);
            }
          }
        })
        .catch((err) => {
          console.error('Failed to apply auto adjustments to paths:', err);
          setError(`Failed to apply auto adjustments: ${err}`);
        });
    };

    const onExportClick = () => {
      if (selectedImage) {
        if (selectedImage.path !== path) {
          handleImageSelect(path);
        }
        setMultiSelectedPaths(finalSelection);
        setRenderedRightPanel(Panel.Export);
        setActiveRightPanel(Panel.Export);
      } else {
        setMultiSelectedPaths(finalSelection);
        setIsLibraryExportPanelVisible(true);
      }
    };

    const options = [
      ...(!isEditingThisImage
        ? [
            {
              disabled: !isSingleSelection,
              icon: Edit,
              label: 'Edit Image',
              onClick: () => handleImageSelect(finalSelection[0]),
            },
            {
              icon: Save,
              label: exportLabel,
              onClick: onExportClick,
            },
            { type: OPTION_SEPARATOR },
          ]
        : [
            {
              icon: Save,
              label: exportLabel,
              onClick: onExportClick,
            },
            { type: OPTION_SEPARATOR },
          ]),
      {
        disabled: !isSingleSelection,
        icon: Copy,
        label: 'Copy Adjustments',
        onClick: async () => {
          try {
            const metadata: any = await invoke(Invokes.LoadMetadata, { path: finalSelection[0] });
            const sourceAdjustments =
              metadata.adjustments && !metadata.adjustments.is_null
                ? { ...INITIAL_ADJUSTMENTS, ...metadata.adjustments }
                : INITIAL_ADJUSTMENTS;
            const adjustmentsToCopy: any = {};
            for (const key of COPYABLE_ADJUSTMENT_KEYS) {
              if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
                adjustmentsToCopy[key] = sourceAdjustments[key];
              }
            }
            setCopiedAdjustments(adjustmentsToCopy);
            setIsCopied(true);
          } catch (err) {
            console.error('Failed to load metadata for copy:', err);
            setError(`Failed to copy adjustments: ${err}`);
          }
        },
      },
      {
        disabled: copiedAdjustments === null,
        icon: ClipboardPaste,
        label: pasteLabel,
        onClick: () => handlePasteAdjustments(finalSelection),
      },
      {
        label: 'Productivity',
        icon: Gauge,
        submenu: [
          {
            label: autoAdjustLabel,
            icon: Aperture,
            onClick: handleApplyAutoAdjustmentsToSelection,
          },
          {
            label: denoiseLabel,
            icon: Grip,
            disabled: finalSelection.length === 0,
            onClick: () => {
              setDenoiseModalState({
                isOpen: true,
                isProcessing: false,
                previewBase64: null,
                error: null,
                targetPaths: finalSelection,
                progressMessage: null,
                isRaw: selectedImage?.isRaw || false,
              });
            },
          },
          {
            label: conversionLabel,
            icon: Film,
            disabled: selectionCount === 0,
            onClick: () => {
              setNegativeModalState({
                isOpen: true,
                targetPaths: finalSelection,
              });
            },
          },
          {
            disabled: selectionCount < 2 || selectionCount > 30,
            icon: SquaresUnite,
            label: stitchLabel,
            onClick: () => {
              setPanoramaModalState({
                error: null,
                finalImageBase64: null,
                isOpen: true,
                isProcessing: false,
                progressMessage: null,
                stitchingSourcePaths: finalSelection,
              });
            },
          },
          {
            disabled: selectionCount < 2 || selectionCount > 9,
            icon: Images,
            label: mergeLabel,
            onClick: () => {
              setHdrModalState({
                error: null,
                finalImageBase64: null,
                isOpen: true,
                isProcessing: false,
                progressMessage: null,
                stitchingSourcePaths: finalSelection,
              });
            },
          },
          {
            icon: LayoutTemplate,
            label: collageLabel,
            onClick: () => {
              const imagesForCollage = imageList.filter((img) => finalSelection.includes(img.path));
              setCollageModalState({
                isOpen: true,
                sourceImages: imagesForCollage,
              });
            },
            disabled: selectionCount === 0 || selectionCount > 9,
          },
          {
            label: cullLabel,
            icon: Users,
            onClick: () =>
              setCullingModalState({
                isOpen: true,
                progress: null,
                suggestions: null,
                error: null,
                pathsToCull: finalSelection,
              }),
            disabled: selectionCount < 2,
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: copyLabel,
        icon: Copy,
        onClick: () => {
          setCopiedFilePaths(finalSelection);
          setIsCopied(true);
        },
      },
      {
        icon: CopyPlus,
        label: 'Duplicate Image',
        disabled: !isSingleSelection,
        submenu: [
          {
            label: 'Physical Copy',
            icon: Copy,
            onClick: async () => {
              try {
                await invoke(Invokes.DuplicateFile, { path: finalSelection[0] });
                await refreshImageList();
              } catch (err) {
                console.error('Failed to duplicate file:', err);
                setError(`Failed to duplicate file: ${err}`);
              }
            },
          },
          {
            label: 'Virtual Copy',
            icon: CopyPlus,
            onClick: () => handleCreateVirtualCopy(finalSelection[0]),
          },
        ],
      },
      { icon: FileEdit, label: renameLabel, onClick: () => handleRenameFiles(finalSelection) },
      { type: OPTION_SEPARATOR },
      {
        icon: Star,
        label: 'Rating',
        submenu: [0, 1, 2, 3, 4, 5].map((rating: number) => ({
          label: rating === 0 ? 'No Rating' : `${rating} Star${rating !== 1 ? 's' : ''}`,
          onClick: () => handleRate(rating, finalSelection),
        })),
      },
      {
        label: 'Color Label',
        icon: Palette,
        submenu: [
          { label: 'No Label', onClick: () => handleSetColorLabel(null, finalSelection) },
          ...COLOR_LABELS.map((label: Color) => ({
            label: label.name.charAt(0).toUpperCase() + label.name.slice(1),
            color: label.color,
            onClick: () => handleSetColorLabel(label.name, finalSelection),
          })),
        ],
      },
      {
        label: 'Tagging',
        icon: Tag,
        submenu: [
          {
            customComponent: TaggingSubMenu,
            customProps: {
              paths: finalSelection,
              initialTags: commonTags,
              onTagsChanged: handleTagsChanged,
              appSettings,
            },
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: !isSingleSelection,
        icon: Folder,
        label: 'Show in File Explorer',
        onClick: () => {
          invoke(Invokes.ShowInFinder, { path: finalSelection[0] }).catch((err) =>
            setError(`Could not show file in explorer: ${err}`),
          );
        },
      },
      { label: resetLabel, icon: RotateCcw, onClick: () => handleResetAdjustments(finalSelection) },
      deleteOption,
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleCreateFolder = async (folderName: string) => {
    if (folderName && folderName.trim() !== '' && folderActionTarget) {
      try {
        await invoke(Invokes.CreateFolder, { path: `${folderActionTarget}/${folderName.trim()}` });
        refreshAllFolderTrees();
      } catch (err) {
        setError(`Failed to create folder: ${err}`);
      }
    }
  };

  const handleRenameFolder = async (newName: string) => {
    if (newName && newName.trim() !== '' && folderActionTarget) {
      try {
        const oldPath = folderActionTarget;
        const trimmedNewName = newName.trim();

        await invoke(Invokes.RenameFolder, { path: oldPath, newName: trimmedNewName });

        const parentDir = getParentDir(oldPath);
        const separator = oldPath.includes('/') ? '/' : '\\';
        const newPath = parentDir ? `${parentDir}${separator}${trimmedNewName}` : trimmedNewName;

        const newAppSettings = { ...appSettings } as AppSettings;
        let settingsChanged = false;

        if (rootPath === oldPath) {
          setRootPath(newPath);
          newAppSettings.lastRootPath = newPath;
          settingsChanged = true;
        }
        if (currentFolderPath?.startsWith(oldPath)) {
          const newCurrentPath = currentFolderPath.replace(oldPath, newPath);
          setCurrentFolderPath(newCurrentPath);
        }

        const currentPins = appSettings?.pinnedFolders || [];
        if (currentPins.includes(oldPath)) {
          const newPins = currentPins.map((p) => (p === oldPath ? newPath : p)).sort((a, b) => a.localeCompare(b));
          newAppSettings.pinnedFolders = newPins;
          settingsChanged = true;
        }

        if (settingsChanged) {
          handleSettingsChange(newAppSettings);
        }

        await refreshAllFolderTrees();
      } catch (err) {
        setError(`Failed to rename folder: ${err}`);
      }
    }
  };

  const handleFolderTreeContextMenu = (event: any, path: string, isCurrentlyPinned?: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const targetPath = path || rootPath;
    if (!targetPath) {
      return;
    }
    const isRoot = targetPath === rootPath;
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const pinOption = isCurrentlyPinned
      ? {
          icon: PinOff,
          label: 'Unpin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        }
      : {
          icon: Pin,
          label: 'Pin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        };

    const options = [
      pinOption,
      { type: OPTION_SEPARATOR },
      {
        icon: FolderPlus,
        label: 'New Folder',
        onClick: () => {
          setFolderActionTarget(targetPath);
          setIsCreateFolderModalOpen(true);
        },
      },
      {
        disabled: isRoot,
        icon: FileEdit,
        label: 'Rename Folder',
        onClick: () => {
          setFolderActionTarget(targetPath);
          setIsRenameFolderModalOpen(true);
        },
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: copiedFilePaths.length === 0,
        icon: ClipboardPaste,
        label: 'Paste',
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                if (targetPath === currentFolderPath) handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                setCopiedFilePaths([]);
                setMultiSelectedPaths([]);
                refreshAllFolderTrees();
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to move files: ${err}`);
              }
            },
          },
        ],
      },
      { icon: FolderInput, label: 'Import Images', onClick: () => handleImportClick(targetPath) },
      { type: OPTION_SEPARATOR },
      {
        icon: Folder,
        label: 'Show in File Explorer',
        onClick: () =>
          invoke(Invokes.ShowInFinder, { path: targetPath }).catch((err) => setError(`Could not show folder: ${err}`)),
      },
      ...(path
        ? [
            {
              disabled: isRoot,
              icon: Trash2,
              isDestructive: true,
              label: 'Delete Folder',
              submenu: [
                { label: 'Cancel', icon: X, onClick: () => {} },
                {
                  label: 'Confirm',
                  icon: Check,
                  isDestructive: true,
                  onClick: async () => {
                    try {
                      await invoke(Invokes.DeleteFolder, { path: targetPath });
                      if (currentFolderPath?.startsWith(targetPath)) await handleSelectSubfolder(rootPath);
                      refreshAllFolderTrees();
                    } catch (err) {
                      setError(`Failed to delete folder: ${err}`);
                    }
                  },
                },
              ],
            },
          ]
        : []),
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleMainLibraryContextMenu = (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const options = [
      {
        label: 'Refresh Folder',
        icon: RefreshCw,
        onClick: handleLibraryRefresh,
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Paste',
        icon: ClipboardPaste,
        disabled: copiedFilePaths.length === 0,
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
                setCopiedFilePaths([]);
                setMultiSelectedPaths([]);
                refreshAllFolderTrees();
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to move files: ${err}`);
              }
            },
          },
        ],
      },
      {
        icon: FolderInput,
        label: 'Import Images',
        onClick: () => handleImportClick(currentFolderPath as string),
        disabled: !currentFolderPath,
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

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
          expandedFolders={expandedFolders}
          isLoading={isTreeLoading}
          isResizing={isResizing}
          isVisible={uiVisibility.folderTree}
          onContextMenu={handleFolderTreeContextMenu}
          onFolderSelect={(path) => handleSelectSubfolder(path, false)}
          onToggleFolder={handleToggleFolder}
          selectedPath={currentFolderPath}
          setIsVisible={(value: boolean) => setUiVisibility((prev: UiVisibility) => ({ ...prev, folderTree: value }))}
          style={{ width: uiVisibility.folderTree ? `${leftPanelWidth}px` : '32px' }}
          tree={folderTree}
          pinnedFolderTrees={pinnedFolderTrees}
          pinnedFolders={pinnedFolders}
          activeSection={activeTreeSection}
          onActiveSectionChange={handleActiveTreeSectionChange}
          showImageCounts={appSettings?.enableFolderImageCounts ?? false}
          isInstantTransition={isInstantTransition}
        />
        <Resizer
          direction={Orientation.Vertical}
          onMouseDown={createResizeHandler(setLeftPanelWidth, leftPanelWidth)}
        />
      </div>
    );
  };

  const renderLibraryView = () => (
    <div className="flex flex-row grow h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 gap-2">
        {activeView === 'community' ? (
          <CommunityPage
            onBackToLibrary={() => setActiveView('library')}
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
            filterCriteria={filterCriteria}
            imageList={sortedImageList}
            imageRatings={imageRatings}
            importState={importState}
            indexingProgress={indexingProgress}
            isIndexing={isIndexing}
            isLoading={isViewLoading}
            isTreeLoading={isTreeLoading}
            isAndroid={isAndroid}
            libraryScrollTop={libraryScrollTop}
            libraryViewMode={libraryViewMode}
            multiSelectedPaths={multiSelectedPaths}
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
            onRequestThumbnails={requestThumbnails}
            rootPath={rootPath}
            searchCriteria={searchCriteria}
            setFilterCriteria={setFilterCriteria}
            setLibraryScrollTop={setLibraryScrollTop}
            setLibraryViewMode={setLibraryViewMode}
            setSearchCriteria={setSearchCriteria}
            setSortCriteria={setSortCriteria}
            sortCriteria={sortCriteria}
            theme={theme}
            thumbnailAspectRatio={thumbnailAspectRatio}
            thumbnails={thumbnails}
            thumbnailProgress={thumbnailProgress}
            thumbnailSize={thumbnailSize}
            onNavigateToCommunity={() => setActiveView('community')}
            listColumnWidths={listColumnWidths}
            setListColumnWidths={setListColumnWidths}
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
        <div className="flex flex-row grow h-full min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            <Editor
              activeAiPatchContainerId={activeAiPatchContainerId}
              activeAiSubMaskId={activeAiSubMaskId}
              activeMaskContainerId={activeMaskContainerId}
              activeMaskId={activeMaskId}
              activeRightPanel={activeRightPanel}
              adjustments={adjustments}
              brushSettings={brushSettings}
              canRedo={canRedo}
              canUndo={canUndo}
              finalPreviewUrl={finalPreviewUrl}
              interactivePatch={interactivePatch}
              isFullScreen={isFullScreen}
              isLoading={isViewLoading}
              isSliderDragging={isSliderDragging}
              isMaskControlHovered={isMaskControlHovered}
              isStraightenActive={isStraightenActive}
              onBackToLibrary={handleBackToLibrary}
              onContextMenu={handleEditorContextMenu}
              onGenerateAiMask={handleGenerateAiMask}
              onQuickErase={handleQuickErase}
              onRedo={redo}
              onSelectAiSubMask={setActiveAiSubMaskId}
              onSelectMask={setActiveMaskId}
              onStraighten={handleStraighten}
              onToggleFullScreen={handleToggleFullScreen}
              onUndo={undo}
              onZoomed={handleUserTransform}
              renderedRightPanel={renderedRightPanel}
              selectedImage={selectedImage}
              isWbPickerActive={isWbPickerActive}
              onWbPicked={handleWbPicked}
              setAdjustments={setAdjustments}
              setShowOriginal={setShowOriginal}
              showOriginal={showOriginal}
              targetZoom={zoom}
              thumbnails={thumbnails}
              transformWrapperRef={transformWrapperRef}
              transformedOriginalUrl={transformedOriginalUrl}
              uncroppedAdjustedPreviewUrl={uncroppedAdjustedPreviewUrl}
              updateSubMask={updateSubMask}
              onDisplaySizeChange={handleDisplaySizeChange}
              originalSize={originalSize}
              isRotationActive={isRotationActive}
              overlayMode={overlayMode}
              overlayRotation={overlayRotation}
              adjustmentsHistory={adjustmentsHistory}
              adjustmentsHistoryIndex={adjustmentsHistoryIndex}
              goToAdjustmentsHistoryIndex={goToAdjustmentsHistoryIndex}
              liveRotation={liveRotation}
              isInstantTransition={isInstantTransition}
            />
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
                onRequestThumbnails={requestThumbnails}
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
              'flex h-full overflow-hidden shrink-0',
              !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
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
                className={clsx(
                  'h-full overflow-hidden',
                  !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
                )}
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
                            adjustments={adjustments}
                            collapsibleState={collapsibleSectionsState}
                            copiedSectionAdjustments={copiedSectionAdjustments}
                            handleAutoAdjustments={handleAutoAdjustments}
                            histogram={histogram}
                            selectedImage={selectedImage}
                            setAdjustments={setAdjustments}
                            setCollapsibleState={setCollapsibleSectionsState}
                            setCopiedSectionAdjustments={setCopiedSectionAdjustments}
                            theme={theme}
                            handleLutSelect={handleLutSelect}
                            appSettings={appSettings}
                            isWbPickerActive={isWbPickerActive}
                            toggleWbPicker={toggleWbPicker}
                            onDragStateChange={setIsSliderDragging}
                            isWaveformVisible={isWaveformVisible}
                            waveform={waveform}
                            onToggleWaveform={handleToggleWaveform}
                            activeWaveformChannel={activeWaveformChannel}
                            setActiveWaveformChannel={setActiveWaveformChannel}
                            waveformHeight={waveformHeight}
                            setWaveformHeight={setWaveformHeight}
                          />
                        )}
                        {renderedRightPanel === Panel.Metadata && (
                          <MetadataPanel
                            selectedImage={selectedImage}
                            rating={adjustments.rating || 0}
                            tags={imageList.find((img) => img.path === selectedImage.path)?.tags || []}
                            onRate={handleRate}
                            onSetColorLabel={handleSetColorLabel}
                            onTagsChanged={handleTagsChanged}
                            appSettings={appSettings}
                          />
                        )}
                        {renderedRightPanel === Panel.Crop && (
                          <CropPanel
                            adjustments={adjustments}
                            isStraightenActive={isStraightenActive}
                            selectedImage={selectedImage}
                            setAdjustments={setAdjustments}
                            setIsStraightenActive={setIsStraightenActive}
                            setIsRotationActive={setIsRotationActive}
                            overlayMode={overlayMode}
                            overlayRotation={overlayRotation}
                            setOverlayRotation={setOverlayRotation}
                            setOverlayMode={setOverlayMode}
                            onLiveRotationChange={setLiveRotation}
                          />
                        )}
                        {renderedRightPanel === Panel.Masks && (
                          <MasksPanel
                            activeMaskContainerId={activeMaskContainerId}
                            activeMaskId={activeMaskId}
                            adjustments={adjustments}
                            aiModelDownloadStatus={aiModelDownloadStatus}
                            appSettings={appSettings}
                            brushSettings={brushSettings}
                            copiedMask={copiedMask}
                            histogram={histogram}
                            isGeneratingAiMask={isGeneratingAiMask}
                            onGenerateAiDepthMask={handleGenerateAiDepthMask}
                            onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                            onGenerateAiSkyMask={handleGenerateAiSkyMask}
                            onSelectContainer={setActiveMaskContainerId}
                            onSelectMask={setActiveMaskId}
                            selectedImage={selectedImage}
                            setAdjustments={setAdjustments}
                            setBrushSettings={setBrushSettings}
                            setCopiedMask={setCopiedMask}
                            setCustomEscapeHandler={setCustomEscapeHandler}
                            onDragStateChange={setIsSliderDragging}
                            isWaveformVisible={isWaveformVisible}
                            onToggleWaveform={handleToggleWaveform}
                            waveform={waveform}
                            activeWaveformChannel={activeWaveformChannel}
                            setActiveWaveformChannel={setActiveWaveformChannel}
                            waveformHeight={waveformHeight}
                            setWaveformHeight={setWaveformHeight}
                            setIsMaskControlHovered={setIsMaskControlHovered}
                          />
                        )}
                        {renderedRightPanel === Panel.Presets && (
                          <PresetsPanel
                            activePanel={activeRightPanel}
                            adjustments={adjustments}
                            selectedImage={selectedImage}
                            onNavigateToCommunity={() => {
                              handleBackToLibrary();
                              setActiveView('community');
                            }}
                            setAdjustments={setAdjustments}
                          />
                        )}
                        {renderedRightPanel === Panel.Export && (
                          <ExportPanel
                            adjustments={adjustments}
                            exportState={exportState}
                            multiSelectedPaths={multiSelectedPaths}
                            selectedImage={selectedImage}
                            setExportState={setExportState}
                            appSettings={appSettings}
                            onSettingsChange={handleSettingsChange}
                            rootPath={rootPath}
                          />
                        )}
                        {renderedRightPanel === Panel.Ai && (
                          <AIPanel
                            activePatchContainerId={activeAiPatchContainerId}
                            activeSubMaskId={activeAiSubMaskId}
                            adjustments={adjustments}
                            aiModelDownloadStatus={aiModelDownloadStatus}
                            brushSettings={brushSettings}
                            isAIConnectorConnected={isAIConnectorConnected}
                            isGeneratingAi={isGeneratingAi}
                            isGeneratingAiMask={isGeneratingAiMask}
                            onDeletePatch={handleDeleteAiPatch}
                            onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                            onGenerativeReplace={handleGenerativeReplace}
                            onSelectPatchContainer={setActiveAiPatchContainerId}
                            onSelectSubMask={setActiveAiSubMaskId}
                            onTogglePatchVisibility={handleToggleAiPatchVisibility}
                            selectedImage={selectedImage}
                            setAdjustments={setAdjustments}
                            setBrushSettings={setBrushSettings}
                            setCustomEscapeHandler={setCustomEscapeHandler}
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
                <RightPanelSwitcher
                  activePanel={activeRightPanel}
                  onPanelSelect={handleRightPanelSelect}
                  isInstantTransition={isInstantTransition}
                />
              </div>
            </div>
          </div>
        </div>
      );
    }
    return renderLibraryView();
  };

  const renderContent = () => {
    return renderMainView();
  };

  return (
    <div
      className={clsx(
        'flex flex-col h-screen bg-bg-primary font-sans text-text-primary overflow-hidden select-none',
        (appSettings?.adaptiveEditorTheme || isAnimatingTheme) && !isInstantTransition && 'enable-color-transitions',
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
          [
            rootPath && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2'),
            !appSettings?.decorations && !isWindowFullScreen && !isFullScreen && (rootPath ? 'pt-12' : 'pt-10'),
          ],
        )}
      >
        <div className="flex flex-row grow h-full min-h-0">
          {renderFolderTree()}
          <div className="flex-1 flex flex-col min-w-0">{renderContent()}</div>
          {!selectedImage && isLibraryExportPanelVisible && (
            <Resizer
              direction={Orientation.Vertical}
              onMouseDown={createResizeHandler(setRightPanelWidth, rightPanelWidth)}
            />
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
              onClose={() => setIsLibraryExportPanelVisible(false)}
              setExportState={setExportState}
              appSettings={appSettings}
              onSettingsChange={handleSettingsChange}
              rootPath={rootPath}
            />
          </div>
        </div>
      </div>
      <CopyPasteSettingsModal
        isOpen={isCopyPasteSettingsModalOpen}
        onClose={() => setIsCopyPasteSettingsModalOpen(false)}
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
        loadingImageUrl={
          panoramaModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                panoramaModalState.stitchingSourcePaths[Math.floor(panoramaModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setPanoramaModalState({
            isOpen: false,
            isProcessing: false,
            progressMessage: '',
            finalImageBase64: null,
            error: null,
            stitchingSourcePaths: [],
          })
        }
        onOpenFile={(path: string) => handleImageSelect(path)}
        onSave={handleSavePanorama}
        onStitch={() => handleStartPanorama(panoramaModalState.stitchingSourcePaths)}
        progressMessage={panoramaModalState.progressMessage}
      />
      <HdrModal
        error={hdrModalState.error}
        finalImageBase64={hdrModalState.finalImageBase64}
        imageCount={hdrModalState.stitchingSourcePaths.length}
        isOpen={hdrModalState.isOpen}
        isProcessing={hdrModalState.isProcessing}
        loadingImageUrl={
          hdrModalState.stitchingSourcePaths.length > 0
            ? thumbnails[
                hdrModalState.stitchingSourcePaths[Math.floor(hdrModalState.stitchingSourcePaths.length / 2)]
              ] || null
            : null
        }
        onClose={() =>
          setHdrModalState({
            isOpen: false,
            isProcessing: false,
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
        onMerge={() => handleStartHdr(hdrModalState.stitchingSourcePaths)}
        progressMessage={hdrModalState.progressMessage}
      />
      <NegativeConversionModal
        isOpen={negativeModalState.isOpen}
        onClose={() => setNegativeModalState((prev) => ({ ...prev, isOpen: false }))}
        targetPaths={negativeModalState.targetPaths}
        onSave={(savedPaths) => {
          refreshImageList().then(() => {
            if (selectedImage && negativeModalState.targetPaths.includes(selectedImage.path) && savedPaths.length > 0) {
              handleImageSelect(savedPaths[0]);
            }
          });
        }}
      />
      <DenoiseModal
        isOpen={denoiseModalState.isOpen}
        onClose={() => setDenoiseModalState((prev) => ({ ...prev, isOpen: false }))}
        onDenoise={handleApplyDenoise}
        onBatchDenoise={handleBatchDenoise}
        onSave={handleSaveDenoisedImage}
        onOpenFile={handleImageSelect}
        previewBase64={denoiseModalState.previewBase64}
        originalBase64={denoiseModalState.originalBase64 || null}
        isProcessing={denoiseModalState.isProcessing}
        error={denoiseModalState.error}
        progressMessage={denoiseModalState.progressMessage}
        aiModelDownloadStatus={aiModelDownloadStatus}
        isRaw={denoiseModalState.isRaw}
        targetPaths={denoiseModalState.targetPaths}
        loadingImageUrl={
          denoiseModalState.targetPaths.length > 0
            ? thumbnails[denoiseModalState.targetPaths[0]] ||
              (selectedImage?.path === denoiseModalState.targetPaths[0] ? finalPreviewUrl : null)
            : null
        }
      />
      <CreateFolderModal
        isOpen={isCreateFolderModalOpen}
        onClose={() => setIsCreateFolderModalOpen(false)}
        onSave={handleCreateFolder}
      />
      <RenameFolderModal
        currentName={folderActionTarget ? folderActionTarget.split(/[\\/]/).pop() : ''}
        isOpen={isRenameFolderModalOpen}
        onClose={() => setIsRenameFolderModalOpen(false)}
        onSave={handleRenameFolder}
      />
      <RenameFileModal
        filesToRename={renameTargetPaths}
        isOpen={isRenameFileModalOpen}
        onClose={() => setIsRenameFileModalOpen(false)}
        onSave={handleSaveRename}
      />
      <ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />
      <ImportSettingsModal
        fileCount={importSourcePaths.length}
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onSave={handleStartImport}
      />
      <CullingModal
        isOpen={cullingModalState.isOpen}
        onClose={() =>
          setCullingModalState({ isOpen: false, progress: null, suggestions: null, error: null, pathsToCull: [] })
        }
        progress={cullingModalState.progress}
        suggestions={cullingModalState.suggestions}
        error={cullingModalState.error}
        imagePaths={cullingModalState.pathsToCull}
        thumbnails={thumbnails}
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
        isOpen={collageModalState.isOpen}
        onClose={() => setCollageModalState({ isOpen: false, sourceImages: [] })}
        onSave={handleSaveCollage}
        sourceImages={collageModalState.sourceImages}
        thumbnails={thumbnails}
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
