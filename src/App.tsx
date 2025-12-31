import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import debounce from 'lodash.debounce';
import { ClerkProvider } from '@clerk/clerk-react';
import { useBloc } from '@blac/react';
import clsx from 'clsx';
import { ModalsCubit, SettingsCubit, NavigationCubit, LibraryCubit, EditorCubit, MasksCubit, FolderNode } from './cubits';
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
  RotateCcw,
  Star,
  Save,
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
} from 'lucide-react';
import TitleBar from './window/TitleBar';
import CommunityPage from './components/panel/CommunityPage';
import MainLibrary from './components/panel/MainLibrary';
import FolderTree from './components/panel/FolderTree';
import Editor from './components/panel/Editor';
import Controls from './components/panel/right/ControlsPanel';
import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import RightPanelSwitcher from './components/panel/right/RightPanelSwitcher';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
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
import DenoiseModal from './components/modals/DenoiseModal';
import CollageModal from './components/modals/CollageModal';
import CopyPasteSettingsModal from './components/modals/CopyPasteSettingsModal';
import CullingModal from './components/modals/CullingModal';

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
import { generatePaletteFromImage } from './utils/palette';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { THEMES, DEFAULT_THEME_ID, ThemeProps } from './utils/themes';
import { SubMask } from './components/panel/right/Masks';
import {
  ExportState,
  IMPORT_TIMEOUT,
  ImportState,
  Status,
} from './components/panel/right/ExportImportProperties';
import {
  AppSettings,
  Invokes,
  ImageFile,
  Option,
  OPTION_SEPARATOR,
  LibraryViewMode,
  Panel,
  Progress,
  RawStatus,
  SupportedTypes,
  Theme,
  TransformState,
  Orientation,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from './components/ui/AppProperties';


const CLERK_PUBLISHABLE_KEY = 'pk_test_YnJpZWYtc2Vhc25haWwtMTIuY2xlcmsuYWNjb3VudHMuZGV2JA'; // local dev key



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









interface LutData {
  size: number;
}

interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

const DEBUG = false;
const REVOCATION_DELAY = 5000;

const useDelayedRevokeBlobUrl = (url: string | null | undefined) => {
  const previousUrlRef = useRef<string | null | undefined>(null);

  useEffect(() => {
    if (previousUrlRef.current && previousUrlRef.current !== url) {
      const urlToRevoke = previousUrlRef.current;
      if (urlToRevoke && urlToRevoke.startsWith('blob:')) {
        setTimeout(() => {
          URL.revokeObjectURL(urlToRevoke);
        }, REVOCATION_DELAY);
      }
    }
    previousUrlRef.current = url;
  }, [url]);

  useEffect(() => {
    return () => {
      const finalUrl = previousUrlRef.current;
      if (finalUrl && finalUrl.startsWith('blob:')) {
        URL.revokeObjectURL(finalUrl);
      }
    };
  }, []);
};

const getParentDir = (filePath: string): string => {
  const separator = filePath.includes('/') ? '/' : '\\';
  const lastSeparatorIndex = filePath.lastIndexOf(separator);
  if (lastSeparatorIndex === -1) {
    return '';
  }
  return filePath.substring(0, lastSeparatorIndex);
};

function App() {
  const [modalsState, modalsCubit] = useBloc(ModalsCubit);
  const [settingsState, settingsCubit] = useBloc(SettingsCubit);
  const [navigationState, navigationCubit] = useBloc(NavigationCubit);
  const [libraryState, libraryCubit] = useBloc(LibraryCubit);
  const [editorState, editorCubit] = useBloc(EditorCubit);
  const [masksState, masksCubit] = useBloc(MasksCubit);

  // Destructure commonly used state from LibraryCubit (early for useThumbnails)
  const {
    imageList,
    imageRatings,
    thumbnails,
    multiSelectedPaths,
    sortCriteria,
    filterCriteria,
    searchCriteria,
  } = libraryState;

  // Navigation state from NavigationCubit - single source of truth
  const {
    rootPath,
    currentFolderPath,
    expandedFolders,
    folderTree,
    pinnedFolderTrees,
    pinnedFolders,
    activeTreeSection,
    isTreeLoading,
    activeView,
    libraryViewMode,
  } = navigationState;

  // Settings state from SettingsCubit - single source of truth
  const { theme, appSettings } = settingsState;

  const [isWindowFullScreen, setIsWindowFullScreen] = useState(false);
  const [supportedTypes, setSupportedTypes] = useState<SupportedTypes | null>(null);

  // Editor state from EditorCubit - single source of truth
  const {
    selectedImage,
    adjustments,
    zoom,
    displaySize,
    previewSize,
    baseRenderSize,
    originalSize,
    showOriginal,
    isFullScreen,
    isFullScreenLoading,
    isAdjusting,
    isLoadingFullRes,
    isFullResolution,
    isViewLoading,
    copiedAdjustments,
    copiedSectionAdjustments,
    activeRightPanel,
    renderedRightPanel,
    isStraightenActive,
    isWbPickerActive,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    fullScreenUrl,
    fullResolutionUrl,
    transformedOriginalUrl,
    histogram,
    waveform,
    isWaveformVisible,
    collapsibleSectionsState,
    error,
    libraryActivePath,
    libraryActiveAdjustments,
    initialFitScale,
  } = editorState;

  // Computed getters from EditorCubit
  const canUndo = editorCubit.canUndo;
  const canRedo = editorCubit.canRedo;

  // Wrapper setters that delegate to EditorCubit methods (for backward compatibility)
  const setError = editorCubit.setError;
  const setSelectedImage = editorCubit.setSelectedImage;
  const setShowOriginal = editorCubit.setShowOriginal;
  const setIsFullScreen = editorCubit.setIsFullScreen;
  const setIsFullScreenLoading = editorCubit.setIsFullScreenLoading;
  const setIsAdjusting = editorCubit.setIsAdjusting;
  const setIsLoadingFullRes = editorCubit.setIsLoadingFullRes;
  const setIsFullResolution = editorCubit.setIsFullResolution;
  const setIsViewLoading = editorCubit.setIsViewLoading;
  const setCopiedAdjustments = editorCubit.setCopiedAdjustments;
  const setCopiedSectionAdjustments = editorCubit.setCopiedSectionAdjustments;
  const setActiveRightPanel = editorCubit.setActiveRightPanel;
  const setRenderedRightPanel = editorCubit.setRenderedRightPanel;
  const setIsStraightenActive = editorCubit.setIsStraightenActive;
  const setFinalPreviewUrl = editorCubit.setFinalPreviewUrl;
  const setUncroppedAdjustedPreviewUrl = editorCubit.setUncroppedAdjustedPreviewUrl;
  const setFullScreenUrl = editorCubit.setFullScreenUrl;
  const setFullResolutionUrl = editorCubit.setFullResolutionUrl;
  const setTransformedOriginalUrl = editorCubit.setTransformedOriginalUrl;
  const setHistogram = editorCubit.setHistogram;
  const setWaveform = editorCubit.setWaveform;
  const setIsWaveformVisible = editorCubit.setIsWaveformVisible;
  const setCollapsibleSectionsState = editorCubit.setCollapsibleSectionsState;
  const setLibraryActivePath = editorCubit.setLibraryActivePath;
  const setLibraryActiveAdjustments = editorCubit.setLibraryActiveAdjustments;
  const setInitialFitScale = editorCubit.setInitialFitScale;
  const setZoom = editorCubit.setZoom;
  const setOriginalSize = editorCubit.setOriginalSize;
  const setPreviewSize = editorCubit.setPreviewSize;
  const setDisplaySize = editorCubit.setDisplaySize;
  const setBaseRenderSize = editorCubit.setBaseRenderSize;
  const resetAdjustmentsHistory = editorCubit.resetHistory;
  const setIsWbPickerActive = editorCubit.setIsWbPickerActive;

  // For callback-style setSelectedImage updates
  const updateSelectedImage = editorCubit.updateSelectedImage;

  // handleDisplaySizeChange wraps EditorCubit.setDisplaySize
  const handleDisplaySizeChange = useCallback((size: ImageDimensions & { scale?: number }) => {
    editorCubit.setDisplaySize(size);
  }, [editorCubit]);

  const [initialFileToOpen, setInitialFileToOpen] = useState<string | null>(null);
  // uiVisibility is derived from appSettings (SettingsCubit is single source of truth)
  const uiVisibility = appSettings?.uiVisibility ?? { folderTree: true, filmstrip: true };
  const [isAnimatingTheme, setIsAnimatingTheme] = useState(false);
  const isInitialThemeMount = useRef(true);
  const [adaptivePalette, setAdaptivePalette] = useState<any>(null);
  // Masks state from MasksCubit - single source of truth
  const {
    activeMaskContainerId,
    activeMaskId,
    activeAiPatchContainerId,
    activeAiSubMaskId,
    brushSettings,
    isGeneratingAiMask,
    isMaskControlHovered,
  } = masksState;
  const fullResRequestRef = useRef<any>(null);
  const fullResCacheKeyRef = useRef<string | null>(null);

  // NOTE: Blob URLs are now managed by EditorCubit.clearSelectedImage()
  // useDelayedRevokeBlobUrl hooks removed - cubit handles cleanup

  const [isLibraryExportPanelVisible, setIsLibraryExportPanelVisible] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(256);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(320);
  const [bottomPanelHeight, setBottomPanelHeight] = useState<number>(144);
  const [isResizing, setIsResizing] = useState(false);
  // thumbnailSize and thumbnailAspectRatio derived from appSettings (SettingsCubit is single source of truth)
  const thumbnailSize = appSettings?.thumbnailSize ?? ThumbnailSize.Medium;
  const thumbnailAspectRatio = appSettings?.thumbnailAspectRatio ?? ThumbnailAspectRatio.Cover;
  const [copiedFilePaths, setCopiedFilePaths] = useState<Array<string>>([]);
  const [aiModelDownloadStatus, setAiModelDownloadStatus] = useState<string | null>(null);
  // copiedMask now comes from MasksCubit
  const { copiedMask } = masksState;
  const [isCopied, setIsCopied] = useState(false);
  const [isPasted, setIsPasted] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<Progress>({ current: 0, total: 0 });

  // NOTE: brushSettings, isGeneratingAiMask, isMaskControlHovered now come from MasksCubit

  const [folderActionTarget, setFolderActionTarget] = useState<string | null>(null);
  const [customEscapeHandler, setCustomEscapeHandler] = useState(null);
  const [isComfyUiConnected, setIsComfyUiConnected] = useState(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [libraryScrollTop, setLibraryScrollTop] = useState<number>(0);
  const { showContextMenu } = useContextMenu();
  const { loading: isThumbnailsLoading } = useThumbnails(imageList, (updater: any) => {
    if (typeof updater === 'function') {
      libraryCubit.update((state) => ({
        ...state,
        thumbnails: updater(state.thumbnails),
      }));
    } else {
      libraryCubit.setThumbnails(updater);
    }
  });
  const transformWrapperRef = useRef<any>(null);
  const isProgrammaticZoom = useRef(false);
  const isInitialMount = useRef(true);
  const currentFolderPathRef = useRef<string>(currentFolderPath);

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

  // setAdjustments wraps EditorCubit.setAdjustments
  const setAdjustments = editorCubit.setAdjustments;

  const handleStraighten = useCallback(
    (angleCorrection: number) => {
      editorCubit.setAdjustments((prev: Adjustments) => {
        const newRotation = (prev.rotation || 0) + angleCorrection;
        return { ...prev, rotation: newRotation, crop: null };
      });

      editorCubit.setIsStraightenActive(false);
    },
    [editorCubit],
  );

  const toggleWbPicker = useCallback(() => {
    editorCubit.toggleWbPicker();
  }, [editorCubit]);

  const handleWbPicked = useCallback(() => {
    //editorCubit.setIsWbPickerActive(false); // lets keep it active
  }, []);

  useEffect(() => {
    if (
      (activeRightPanel !== Panel.Masks || !activeMaskContainerId) &&
      (activeRightPanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      masksCubit.setIsMaskControlHovered(false);
    }
  }, [activeRightPanel, activeMaskContainerId, activeAiPatchContainerId, masksCubit]);

  // Computed keys from EditorCubit for tracking adjustment changes
  const geometricAdjustmentsKey = editorCubit.geometricAdjustmentsKey;
  const visualAdjustmentsKey = editorCubit.visualAdjustmentsKey;

  const undo = useCallback(() => {
    if (canUndo) {
      editorCubit.undo();
    }
  }, [canUndo, editorCubit]);
  const redo = useCallback(() => {
    if (canRedo) {
      editorCubit.redo();
    }
  }, [canRedo, editorCubit]);

  useEffect(() => {
    setTransformedOriginalUrl(null);
  }, [geometricAdjustmentsKey, selectedImage?.path]);

  useEffect(() => {
    let isEffectActive = true;
    let objectUrl: string | null = null;

    const generate = async () => {
      if (showOriginal && selectedImage?.path && !transformedOriginalUrl) {
        try {
          const imageData: Uint8Array = await invoke('generate_original_transformed_preview', {
            jsAdjustments: adjustments,
          });
          if (isEffectActive) {
            const blob = new Blob([imageData], { type: 'image/jpeg' });
            objectUrl = URL.createObjectURL(blob);
            setTransformedOriginalUrl(objectUrl);
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
  }, [showOriginal, selectedImage?.path, adjustments, transformedOriginalUrl]);

  useEffect(() => {
    if (currentFolderPath) {
      refreshImageList();
    }
  }, [libraryViewMode]);

  useEffect(() => {
    const unlisten = listen('comfyui-status-update', (event: any) => {
      setIsComfyUiConnected(event.payload.connected);
    });
    invoke(Invokes.CheckComfyuiStatus);
    const interval = setInterval(() => invoke(Invokes.CheckComfyuiStatus), 3000);
    return () => {
      clearInterval(interval);
      unlisten.then((f) => f());
    };
  }, []);

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
        masksCubit.clearActiveAiPatch();
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
    [selectedImage?.path, isGeneratingAi, adjustments, setAdjustments, masksCubit],
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
        const newMaskParams: any = await invoke(Invokes.GenerateAiSubjectMask, {
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
        masksCubit.clearActiveAiPatch();
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
    [selectedImage?.path, isGeneratingAi, adjustments, setAdjustments, masksCubit],
  );

  const handleDeleteMaskContainer = useCallback(
    (containerId: string) => {
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        masks: (prev.masks || []).filter((c) => c.id !== containerId),
      }));
      if (activeMaskContainerId === containerId) {
        masksCubit.clearActiveMask();
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
        masksCubit.clearActiveAiPatch();
      }
    },
    [setAdjustments, activeAiPatchContainerId, masksCubit],
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
    masksCubit.setIsGeneratingAiMask(true);
    try {
      const newParameters = await invoke(Invokes.GenerateAiSubjectMask, {
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
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI subject mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      masksCubit.setIsGeneratingAiMask(false);
    }
  };

  const handleGenerateAiForegroundMask = async (subMaskId: string) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    masksCubit.setIsGeneratingAiMask(true);
    try {
      const newParameters = await invoke(Invokes.GenerateAiForegroundMask, {
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI foreground mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      masksCubit.setIsGeneratingAiMask(false);
    }
  };

  const handleGenerateAiSkyMask = async (subMaskId: string) => {
    if (!selectedImage?.path) {
      console.error('Cannot generate AI mask: No image selected.');
      return;
    }
    masksCubit.setIsGeneratingAiMask(true);
    try {
      const newParameters = await invoke(Invokes.GenerateAiSkyMask, {
        flipHorizontal: adjustments.flipHorizontal,
        flipVertical: adjustments.flipVertical,
        orientationSteps: adjustments.orientationSteps,
        rotation: adjustments.rotation,
      });

      const subMask = adjustments.aiPatches
        ?.flatMap((p: AiPatch) => p.subMasks)
        .find((sm: SubMask) => sm.id === subMaskId);

      const mergedParameters = { ...(subMask?.parameters || {}), ...newParameters };
      updateSubMask(subMaskId, { parameters: mergedParameters });
    } catch (error) {
      console.error('Failed to generate AI sky mask:', error);
      setError(`AI Mask Failed: ${error}`);
    } finally {
      masksCubit.setIsGeneratingAiMask(false);
    }
  };

  // Sorted/filtered image list from LibraryCubit
  const sortedImageList = libraryCubit.sortedImageList;

  const applyAdjustments = useCallback(
    debounce((currentAdjustments) => {
      if (!selectedImage?.isReady) {
        return;
      }
      setIsAdjusting(true);
      invoke(Invokes.ApplyAdjustments, { jsAdjustments: currentAdjustments }).catch((err) => {
        console.error('Failed to invoke apply_adjustments:', err);
        setError(`Processing failed: ${err}`);
        setIsAdjusting(false);
      });
    }, 50),
    [selectedImage?.isReady],
  );

  const debouncedGenerateUncroppedPreview = useCallback(
    debounce((currentAdjustments) => {
      if (!selectedImage?.isReady) {
        return;
      }
      invoke(Invokes.GenerateUncroppedPreview, { jsAdjustments: currentAdjustments }).catch((err) =>
        console.error('Failed to generate uncropped preview:', err),
      );
    }, 50),
    [selectedImage?.isReady],
  );

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
        setActiveRightPanel(panelId);
        setRenderedRightPanel(panelId);
      }
      masksCubit.setActiveMask(null);
      masksCubit.setActiveAiSubMask(null);
    },
    [activeRightPanel, masksCubit],
  );

  const handleSettingsChange = useCallback(
    (newSettings: AppSettings) => {
      if (!newSettings) {
        console.error('handleSettingsChange was called with null settings. Aborting save operation.');
        return;
      }
      if (newSettings.theme && newSettings.theme !== theme) {
        settingsCubit.setTheme(newSettings.theme);
      }
      // Update the cubit - this will auto-save via debounced stateChanged event
      settingsCubit.updateAppSettings(newSettings);
    },
    [theme, settingsCubit],
  );

  // Initialize SettingsCubit on mount
  useEffect(() => {
    settingsCubit.loadSettings();
  }, [settingsCubit]);



  // React to settingsState.isLoaded to sync other cubits and initialize app
  useEffect(() => {
    if (!settingsState.isLoaded) return;

    const settings = settingsState.appSettings;

    // Sync to LibraryCubit
    if (settings?.sortCriteria) libraryCubit.setSortCriteria(settings.sortCriteria);
    if (settings?.filterCriteria) {
      libraryCubit.setFilterCriteria({
        ...settings.filterCriteria,
        rawStatus: settings.filterCriteria.rawStatus || RawStatus.All,
        colors: settings.filterCriteria.colors || [],
      });
    }

    // Sync to NavigationCubit
    if (settings?.activeTreeSection) {
      navigationCubit.setActiveTreeSection(settings.activeTreeSection);
    }
    if (settings?.pinnedFolders && settings.pinnedFolders.length > 0) {
      navigationCubit.setPinnedFolders(settings.pinnedFolders);
      invoke<FolderNode[]>(Invokes.GetPinnedFolderTrees, { paths: settings.pinnedFolders })
        .then((trees) => {
          navigationCubit.setPinnedFolderTrees(trees);
        })
        .catch((err) => {
          console.error('Failed to load pinned folder trees:', err);
        });
    }

    // Notify backend that frontend is ready
    invoke('frontend_ready').catch(e => console.error("Failed to notify backend of readiness:", e));

    isInitialMount.current = false;
  }, [settingsState.isLoaded]);

  // NOTE: Removed uiVisibility sync useEffect - now derived from appSettings (SettingsCubit)

  const handleToggleWaveform = useCallback(() => {
    editorCubit.toggleWaveform();
  }, [editorCubit]);

  // NOTE: Removed thumbnailSize and thumbnailAspectRatio sync useEffects - now derived from appSettings (SettingsCubit)

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
    if (appSettings?.adaptiveEditorTheme && selectedImage && finalPreviewUrl) {
      generatePaletteFromImage(finalPreviewUrl)
        .then(setAdaptivePalette)
        .catch((err) => {
          const darkTheme = THEMES.find((t) => t.id === Theme.Dark);
          setAdaptivePalette(darkTheme ? darkTheme.cssVariables : null);
        });
    } else if (!appSettings?.adaptiveEditorTheme || !selectedImage) {
      setAdaptivePalette(null);
    }
  }, [appSettings?.adaptiveEditorTheme, selectedImage, finalPreviewUrl]);

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
    let effectThemeForWindow = baseTheme.id;

    if (adaptivePalette) {
      finalCssVariables = { ...finalCssVariables, ...adaptivePalette };
    }

    Object.entries(finalCssVariables).forEach(([key, value]) => {
      root.style.setProperty(key, value as string);
    });

    const isLight = [Theme.Light, Theme.Snow, Theme.Arctic].includes(effectThemeForWindow);
    invoke(Invokes.UpdateWindowEffect, { theme: isLight ? Theme.Light : Theme.Dark });
  }, [theme, adaptivePalette]);

  useEffect(() => {
    if (isInitialThemeMount.current) {
      isInitialThemeMount.current = false;
      return;
    }

    setIsAnimatingTheme(true);
    const timer = setTimeout(() => setIsAnimatingTheme(false), 500);

    return () => clearTimeout(timer);
  }, [theme]);

  const refreshAllFolderTrees = useCallback(async () => {
    if (rootPath) {
      try {
        const treeData: FolderNode = await invoke(Invokes.GetFolderTree, { path: rootPath });
        navigationCubit.setFolderTree(treeData);
      } catch (err) {
        console.error('Failed to refresh main folder tree:', err);
        setError(`Failed to refresh folder tree: ${err}.`);
      }
    }

    const currentPins = appSettings?.pinnedFolders || [];
    if (currentPins.length > 0) {
      try {
        const trees: FolderNode[] = await invoke(Invokes.GetPinnedFolderTrees, { paths: currentPins });
        navigationCubit.setPinnedFolderTrees(trees);
      } catch (err) {
        console.error('Failed to refresh pinned folder trees:', err);
      }
    }
  }, [rootPath, appSettings?.pinnedFolders, navigationCubit]);

  const handleTogglePinFolder = useCallback(async (path: string) => {
    if (!appSettings) return;
    const currentPins = appSettings.pinnedFolders || [];
    const isPinned = currentPins.includes(path);
    const newPins = isPinned
      ? currentPins.filter((p: string) => p !== path)
      : [...currentPins, path].sort((a: string, b: string) => a.localeCompare(b));

    if (!isPinned && path === currentFolderPath) {
      handleActiveTreeSectionChange('pinned');
    }

    handleSettingsChange({ ...appSettings, pinnedFolders: newPins });
    navigationCubit.setPinnedFolders(newPins);

    try {
      const trees: FolderNode[] = await invoke(Invokes.GetPinnedFolderTrees, { paths: newPins });
      navigationCubit.setPinnedFolderTrees(trees);
    } catch (err) {
      console.error('Failed to refresh pinned folders:', err);
    }
  }, [appSettings, handleSettingsChange, currentFolderPath, navigationCubit]);

  const handleActiveTreeSectionChange = (section: string | null) => {
    navigationCubit.setActiveTreeSection(section);
    if (appSettings) {
      handleSettingsChange({ ...appSettings, activeTreeSection: section });
    }
  };

  const handleSelectSubfolder = useCallback(
    async (path: string | null, isNewRoot = false) => {
      await invoke('cancel_thumbnail_generation');
      setIsViewLoading(true);
      libraryCubit.clearSearch();
      setLibraryScrollTop(0);
      try {
        navigationCubit.setCurrentFolderPath(path);
        navigationCubit.setActiveView('library');

        if (isNewRoot && path) {
          navigationCubit.setExpandedFolders([path]);
        } else if (path) {
          // Expand parent folders to show the selected path
          const newSet = new Set(expandedFolders);
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
          navigationCubit.setExpandedFolders(Array.from(newSet));
        }

        if (isNewRoot) {
          if (path && !pinnedFolders.includes(path)) {
            handleActiveTreeSectionChange('current');
          }
          navigationCubit.setIsTreeLoading(true);
          handleSettingsChange({ ...appSettings, lastRootPath: path } as AppSettings);
          try {
            const treeData: FolderNode = await invoke(Invokes.GetFolderTree, { path });
            navigationCubit.setFolderTree(treeData);
          } catch (err) {
            console.error('Failed to load folder tree:', err);
            setError(`Failed to load folder tree: ${err}. Some sub-folders might be inaccessible.`);
          } finally {
            navigationCubit.setIsTreeLoading(false);
          }
        }

        libraryCubit.clear();
        setLibraryActivePath(null);
        if (selectedImage) {
          setSelectedImage(null);
          setFinalPreviewUrl(null);
          setUncroppedAdjustedPreviewUrl(null);
          setHistogram(null);
        }

        const command =
          libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

        const files: ImageFile[] = await invoke(command, { path });
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
            libraryCubit.setImageList(finalImageList);
          } else {
            libraryCubit.setImageList(files);
            invoke(Invokes.ReadExifForPaths, { paths })
              .then((exifDataMap: any) => {
                libraryCubit.update((state) => ({
                  ...state,
                  imageList: state.imageList.map((image) => ({
                    ...image,
                    exif: exifDataMap[image.path] || image.exif || null,
                  })),
                }));
              })
              .catch((err) => {
                console.error('Failed to read EXIF data in background:', err);
              });
          }
        } else {
          libraryCubit.setImageList(files);
        }

        invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
          console.error('Failed to start background indexing:', err);
        });
      } catch (err) {
        console.error('Failed to load folder contents:', err);
        setError('Failed to load images from the selected folder.');
        navigationCubit.setIsTreeLoading(false);
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
      const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
      const isExifSortActive = exifSortKeys.includes(sortCriteria.key);
      const shouldReadExif = appSettings?.enableExifReading ?? false;

      let freshExifData: Record<string, any> | null = null;

      if (shouldReadExif && files.length > 0 && isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        freshExifData = await invoke(Invokes.ReadExifForPaths, { paths });
      }

      libraryCubit.update((state) => {
        const prevMap = new Map(state.imageList.map((img) => [img.path, img]));

        return {
          ...state,
          imageList: files.map((newFile) => {
            if (freshExifData && freshExifData[newFile.path]) {
              newFile.exif = freshExifData[newFile.path];
              return newFile;
            }
            const existing = prevMap.get(newFile.path);
            if (existing && existing.modified === newFile.modified) {
              return existing;
            }

            return newFile;
          }),
        };
      });

      if (shouldReadExif && files.length > 0 && !isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        invoke(Invokes.ReadExifForPaths, { paths })
          .then((exifDataMap: any) => {
            libraryCubit.update((state) => ({
              ...state,
              imageList: state.imageList.map((image) => {
                if (exifDataMap[image.path] && !image.exif) {
                   return { ...image, exif: exifDataMap[image.path] };
                }
                return image;
              }),
            }));
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

  const handleToggleFolder = useCallback((path: string) => {
    navigationCubit.toggleFolderExpanded(path);
  }, [navigationCubit]);

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
    const lastActivePath = selectedImage?.path ?? null;
    setSelectedImage(null);
    setFinalPreviewUrl(null);
    setUncroppedAdjustedPreviewUrl(null);
    setHistogram(null);
    setWaveform(null);
    setIsWaveformVisible(false);
    masksCubit.clearActiveMask();
    masksCubit.clearActiveAiPatch();
    setIsWbPickerActive(false);
    setLibraryActivePath(lastActivePath);
  }, [selectedImage?.path, masksCubit]);

  const handleImageSelect = useCallback(
    (path: string) => {
      if (selectedImage?.path === path) {
        return;
      }
      applyAdjustments.cancel();
      debouncedSave.cancel();

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
      libraryCubit.setSelection([path]);
      setLibraryActivePath(null);
      setIsViewLoading(true);
      setError(null);
      setHistogram(null);
      setFinalPreviewUrl(null);
      setUncroppedAdjustedPreviewUrl(null);
      setFullScreenUrl(null);
      setFullResolutionUrl(null);
      setTransformedOriginalUrl(null);
      resetAdjustmentsHistory(INITIAL_ADJUSTMENTS);
      setShowOriginal(false);
      masksCubit.clearActiveMask();
      masksCubit.clearActiveAiPatch();
      setIsWbPickerActive(false); 

      if (transformWrapperRef.current) {
        transformWrapperRef.current.resetTransform(0);
      }

      setZoom(1);
      setIsLibraryExportPanelVisible(false);
    },
    [selectedImage?.path, applyAdjustments, debouncedSave, thumbnails, resetAdjustmentsHistory, masksCubit],
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
        const isActiveImageDeleted = pathsToDelete.some(
          (p) => p === activePath || p === physicalPath,
        );

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
          const isFileBeingEditedDeleted = pathsToDelete.some(
            (p) => p === selectedImage.path || p === physicalPath,
          );

          if (isFileBeingEditedDeleted) {
            if (nextImagePath) {
              handleImageSelect(nextImagePath);
            } else {
              handleBackToLibrary();
            }
          }
        } else {
          if (nextImagePath) {
            libraryCubit.setSelection([nextImagePath]);
            setLibraryActivePath(nextImagePath);
          } else {
            libraryCubit.clearSelection();
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

    modalsCubit.openConfirm({
      title: modalTitle,
      message: modalMessage,
      confirmText,
      confirmVariant: 'destructive',
      onConfirm: () => executeDelete(pathsToDelete, { includeAssociated: false }),
    });
  }, [multiSelectedPaths, executeDelete, imageList, modalsCubit]);

  const handleToggleFullScreen = useCallback(() => {
    if (isFullScreen) {
      setIsFullScreen(false);
      setFullScreenUrl(null);
    } else {
      if (!selectedImage) {
        return;
      }
      setIsFullScreen(true);
    }
  }, [isFullScreen, selectedImage]);

  useEffect(() => {
    if (!isFullScreen || !selectedImage?.isReady) {
      return;
    }

    let url: string | null = null;
    const generate = async () => {
      setIsFullScreenLoading(true);
      try {
        const imageData: Uint8Array = await invoke(Invokes.GenerateFullscreenPreview, { jsAdjustments: adjustments });
        const blob = new Blob([imageData], { type: 'image/jpeg' });
        url = URL.createObjectURL(blob);
        setFullScreenUrl(url);
      } catch (e) {
        console.error('Failed to generate fullscreen preview:', e);
        setError('Failed to generate full screen preview.');
      } finally {
        setIsFullScreenLoading(false);
      }
    };
    generate();
  }, [isFullScreen, selectedImage?.path, selectedImage?.isReady, adjustments]);

  const handleCopyAdjustments = useCallback(() => {
    const sourceAdjustments = selectedImage ? adjustments : libraryActiveAdjustments;
    const adjustmentsToCopy: any = {};
    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (sourceAdjustments.hasOwnProperty(key)) adjustmentsToCopy[key] = sourceAdjustments[key];
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
    if (!selectedImage) {
      return;
    }
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

      let currentRating = 0;
      if (selectedImage && pathsToRate.includes(selectedImage.path)) {
        currentRating = adjustments.rating;
      } else if (libraryActivePath && pathsToRate.includes(libraryActivePath)) {
        currentRating = libraryActiveAdjustments.rating;
      }

      const finalRating = newRating === currentRating ? 0 : newRating;

      pathsToRate.forEach((path: string) => {
        libraryCubit.setImageRating(path, finalRating);
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
      adjustments.rating,
      libraryActiveAdjustments.rating,
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

        libraryCubit.update((state) => ({
          ...state,
          imageList: state.imageList.map((image: ImageFile) => {
            if (pathsToUpdate.includes(image.path)) {
              const otherTags = (image.tags || []).filter((tag: string) => !tag.startsWith('color:'));
              const newTags = finalColor ? [...otherTags, `color:${finalColor}`] : otherTags;
              return { ...image, tags: newTags };
            }
            return image;
          }),
        }));
      } catch (err) {
        console.error('Failed to set color label:', err);
        setError(`Failed to set color label: ${err}`);
      }
    },
    [multiSelectedPaths, selectedImage, libraryActivePath, imageList],
  );

  const getCommonTags = useCallback((paths: string[]): { tag: string; isUser: boolean }[] => {
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
  }, [imageList]);

  const handleTagsChanged = useCallback((changedPaths: string[], newTags: { tag: string; isUser: boolean }[]) => {
    libraryCubit.update((state) => ({
      ...state,
      imageList: state.imageList.map((image) => {
        if (changedPaths.includes(image.path)) {
          const colorTags = (image.tags || []).filter((t: string) => t.startsWith('color:'));
          const prefixedNewTags = newTags.map((t) => (t.isUser ? `user:${t.tag}` : t.tag));
          const finalTags = [...colorTags, ...prefixedNewTags].sort();
          return { ...image, tags: finalTags.length > 0 ? finalTags : null };
        }
        return image;
      }),
    }));
  }, [libraryCubit]);



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

  const requestFullResolution = useCallback(
    debounce((currentAdjustments: any, key: string) => {
      if (!selectedImage?.path) return;

      if (fullResRequestRef.current) {
        fullResRequestRef.current.cancelled = true;
      }

      const request = { cancelled: false };
      fullResRequestRef.current = request;

      invoke(Invokes.GenerateFullscreenPreview, {
        jsAdjustments: currentAdjustments,
      })
        .then((imageData: Uint8Array) => {
          if (!request.cancelled) {
            const blob = new Blob([imageData], { type: 'image/jpeg' });
            const url = URL.createObjectURL(blob);
            setFullResolutionUrl(url);
            fullResCacheKeyRef.current = key;
            setIsFullResolution(true);
            setIsLoadingFullRes(false);
          }
        })
        .catch((error: any) => {
          if (!request.cancelled) {
            console.error('Failed to generate full resolution preview:', error);
            setIsFullResolution(false);
            setFullResolutionUrl(null);
            fullResCacheKeyRef.current = null;
            setIsLoadingFullRes(false);
          }
        });
    }, 300),
    [selectedImage?.path],
  );

  useEffect(() => {
    if (isFullResolution && selectedImage?.path) {
      if (fullResCacheKeyRef.current !== visualAdjustmentsKey) {
        setIsLoadingFullRes(true);
        requestFullResolution(adjustments, visualAdjustmentsKey);
      }
    }
  }, [adjustments, isFullResolution, selectedImage?.path, requestFullResolution, visualAdjustmentsKey]);

  const handleFullResolutionLogic = useCallback(
    (targetZoomPercent: number, currentDisplayWidth: number) => {
      if (appSettings?.enableZoomHifi === false) {
        return;
      }

      if (!initialFitScale) {
        return;
      }
      const highResThreshold = Math.max(initialFitScale * 2, 0.5);
      const needsFullRes = targetZoomPercent > highResThreshold;
      const previewIsAlreadyFullRes = previewSize.width >= originalSize.width;
      if (needsFullRes && !previewIsAlreadyFullRes) {
        if (isFullResolution) {
          return;
        }
        if (fullResolutionUrl && fullResCacheKeyRef.current === visualAdjustmentsKey) {
          setIsFullResolution(true);
          return;
        }
        if (!isLoadingFullRes) {
          setIsLoadingFullRes(true);
          requestFullResolution(adjustments, visualAdjustmentsKey);
        }
      } else {
        if (fullResRequestRef.current) {
          fullResRequestRef.current.cancelled = true;
        }
        if (requestFullResolution.cancel) {
          requestFullResolution.cancel();
        }
        if (isFullResolution) {
          setIsFullResolution(false);
        }
        if (isLoadingFullRes) {
          setIsLoadingFullRes(false);
        }
      }
    },
    [
      initialFitScale,
      previewSize.width,
      originalSize.width,
      isFullResolution,
      isLoadingFullRes,
      requestFullResolution,
      adjustments,
      fullResolutionUrl,
      visualAdjustmentsKey,
      appSettings,
    ],
  );

  const handleZoomChange = useCallback(
    (zoomValue: number, fitToWindow: boolean = false) => {
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
        targetZoomPercent = zoomValue;
      }
      targetZoomPercent = Math.max(0.1, Math.min(2.0, targetZoomPercent));
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
      const currentDisplayWidth = baseRenderSize.width * transformZoom;
      handleFullResolutionLogic(targetZoomPercent, currentDisplayWidth);
    },
    [originalSize, baseRenderSize, handleFullResolutionLogic, adjustments.orientationSteps],
  );

  const handleUserTransform = useCallback(
    (transformState: TransformState) => {
      if (isProgrammaticZoom.current) {
        isProgrammaticZoom.current = false;
        return;
      }

      setZoom(transformState.scale);

      if (originalSize.width > 0 && baseRenderSize.width > 0) {
        const orientationSteps = adjustments.orientationSteps || 0;
        const isSwapped = orientationSteps === 1 || orientationSteps === 3;
        const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;

        const targetZoomPercent = (baseRenderSize.width * transformState.scale) / effectiveOriginalWidth;
        const currentDisplayWidth = baseRenderSize.width * transformState.scale;
        handleFullResolutionLogic(targetZoomPercent, currentDisplayWidth);
      }
    },
    [originalSize, baseRenderSize, handleFullResolutionLogic, adjustments.orientationSteps],
  );

  const isAnyModalOpen = 
    modalsState.createFolder.isOpen ||
    modalsState.renameFolder.isOpen ||
    modalsState.renameFile.isOpen ||
    modalsState.import.isOpen ||
    modalsState.copyPasteSettings.isOpen ||
    modalsState.confirm.isOpen ||
    modalsState.panorama.isOpen ||
    modalsState.culling.isOpen ||
    modalsState.collage.isOpen;

  useKeyboardShortcuts({
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
    setCopiedFilePaths,
    onSelectPatchContainer: masksCubit.setActiveAiPatchContainer,
  });

  useEffect(() => {
    let isEffectActive = true;
    const listeners = [
      listen('preview-update-final', (event: any) => {
        if (isEffectActive) {
          const imageData = new Uint8Array(event.payload);
          const blob = new Blob([imageData], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          setFinalPreviewUrl(url);
          setIsAdjusting(false);
        }
      }),
      listen('preview-update-uncropped', (event: any) => {
        if (isEffectActive) {
          const imageData = new Uint8Array(event.payload);
          const blob = new Blob([imageData], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          setUncroppedAdjustedPreviewUrl(url);
        }
      }),
      listen('histogram-update', (event: any) => {
        if (isEffectActive) {
          setHistogram(event.payload);
        }
      }),
      listen('open-with-file', (event: any) => {
        if (isEffectActive) {
          setInitialFileToOpen(event.payload as string);
        }
      }),
      listen('waveform-update', (event: any) => {
        if (isEffectActive) {
          setWaveform(event.payload);
        }
      }),
      listen('thumbnail-generated', (event: any) => {
        if (isEffectActive) {
          const { path, data, rating } = event.payload;
          if (data) {
            libraryCubit.setThumbnail(path, data);
          }
          if (rating !== undefined) {
            libraryCubit.setImageRating(path, rating);
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
                  libraryCubit.setImageList(list);
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
          modalsCubit.updateDenoiseState({ progressMessage: event.payload as string });
        }
      }),
      listen('denoise-complete', (event: any) => {
        if (isEffectActive) {
          const payload = event.payload;
          const isObject = typeof payload === 'object' && payload !== null;
          
          modalsCubit.updateDenoiseState({
            isProcessing: false,
            previewBase64: isObject ? payload.denoised : payload,
            originalBase64: isObject ? payload.original : null,
            progressMessage: null
          });
        }
      }),
      listen('denoise-error', (event: any) => {
        if (isEffectActive) {
          modalsCubit.updateDenoiseState({
            isProcessing: false,
            error: String(event.payload),
            progressMessage: null
          });
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
        modalsCubit.updatePanoramaProgress(event.payload);
      }
    });

    const unlistenComplete = listen('panorama-complete', (event: any) => {
      if (isEffectActive) {
        const { base64 } = event.payload;
        modalsCubit.setPanoramaResult(base64);
      }
    });

    const unlistenError = listen('panorama-error', (event: any) => {
      if (isEffectActive) {
        modalsCubit.setPanoramaError(String(event.payload));
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
        modalsCubit.updateCullingProgress(0, event.payload, 'Initializing...');
      }
    });

    const unlistenProgress = listen('culling-progress', (event: any) => {
      if (isEffectActive) {
        modalsCubit.updateCullingProgress(event.payload.current, event.payload.total, event.payload.stage);
      }
    });

    const unlistenComplete = listen('culling-complete', (event: any) => {
      if (isEffectActive) {
        modalsCubit.setCullingSuggestions(event.payload);
      }
    });

    const unlistenError = listen('culling-error', (event: any) => {
      if (isEffectActive) {
        modalsCubit.setCullingError(String(event.payload));
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

  const handleSavePanorama = async (): Promise<string> => {
    const { stitchingSourcePaths } = modalsState.panorama;
    if (stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      modalsCubit.setPanoramaError(err);
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      modalsCubit.setPanoramaError(String(err));
      throw err;
    }
  };

  const handleApplyDenoise = useCallback(async (intensity: number) => {
    const { targetPath } = modalsState.denoise;
    if (!targetPath) return;
    
    modalsCubit.updateDenoiseState({ 
      isProcessing: true, 
      error: null, 
      progressMessage: "Starting engine..." 
    });
    
    try {
        await invoke(Invokes.ApplyDenoising, { 
            path: targetPath,
            intensity: intensity 
        });
    } catch (err) {
        modalsCubit.updateDenoiseState({ 
            isProcessing: false, 
            error: String(err) 
        });
    }
  }, [modalsState.denoise.targetPath, modalsCubit]);

  const handleSaveDenoisedImage = async (): Promise<string> => {
    const { targetPath } = modalsState.denoise;
    if (!targetPath) throw new Error("No target path");
    const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
        originalPathStr: targetPath
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

  useEffect(() => {
    if (selectedImage?.isReady) {
      applyAdjustments(adjustments);
      debouncedSave(selectedImage.path, adjustments);
    }
    return () => {
      applyAdjustments.cancel();
      debouncedSave.cancel();
    };
  }, [adjustments, selectedImage?.path, selectedImage?.isReady, applyAdjustments, debouncedSave]);

  useEffect(() => {
    if (activeRightPanel === Panel.Crop && selectedImage?.isReady) {
      debouncedGenerateUncroppedPreview(adjustments);
    }

    return () => debouncedGenerateUncroppedPreview.cancel();
  }, [adjustments, activeRightPanel, selectedImage?.isReady, debouncedGenerateUncroppedPreview]);

  const handleOpenFolder = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
      if (typeof selected === 'string') {
        navigationCubit.setRootPathSimple(selected);
        await handleSelectSubfolder(selected, true);
      }
    } catch (err) {
      console.error('Failed to open directory dialog:', err);
      setError('Failed to open folder selection dialog.');
    }
  };

  const handleContinueSession = () => {
    const restore = async () => {
      if (!appSettings?.lastRootPath) {
        return;
      }

      const root = appSettings.lastRootPath;
      const folderState = appSettings.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || root;

      navigationCubit.setRootPathSimple(root);

      if (folderState?.expandedFolders) {
        const newExpandedFolders = [...folderState.expandedFolders, root];
        navigationCubit.setExpandedFolders(newExpandedFolders);
      } else {
        navigationCubit.setExpandedFolders([root]);
      }

      navigationCubit.setIsTreeLoading(true);
      try {
        const treeData: FolderNode = await invoke(Invokes.GetFolderTree, { path: root });
        navigationCubit.setFolderTree(treeData);
      } catch (err) {
        console.error('Failed to restore folder tree:', err);
      } finally {
        navigationCubit.setIsTreeLoading(false);
      }

      await handleSelectSubfolder(pathToSelect, false);
    };
    restore().catch((err) => {
      console.error('Failed to restore session, folder might be missing:', err);
      setError('Failed to restore session. The last used folder may have been moved or deleted.');
      if (appSettings) {
        handleSettingsChange({ ...appSettings, lastRootPath: null, lastFolderState: null });
      }
      handleGoHome();
      navigationCubit.setIsTreeLoading(false);
    });
  };

  useEffect(() => {
    if (!initialFileToOpen || !appSettings) {
      return;
    }
    const parentDir = getParentDir(initialFileToOpen);
    if (currentFolderPath !== parentDir) {
      navigationCubit.setRootPathSimple(parentDir);
      handleSelectSubfolder(parentDir, true);
      return;
    }
    const isImageInList = imageList.some(image => image.path === initialFileToOpen);
    if (isImageInList) {
      handleImageSelect(initialFileToOpen);
      setInitialFileToOpen(null);
    } else if (!isViewLoading) {
      console.warn(`'open-with-file' target ${initialFileToOpen} not found in its directory after loading. Aborting.`);
      setInitialFileToOpen(null);
    }
  }, [initialFileToOpen, appSettings, currentFolderPath, imageList, isViewLoading, handleSelectSubfolder, handleImageSelect, navigationCubit]);

  const handleGoHome = () => {
    navigationCubit.clearRootPath();
    libraryCubit.clear();
    setLibraryActivePath(null);
    setIsLibraryExportPanelVisible(false);
  };

  const handleMultiSelectClick = (path: string, event: any, options: MultiSelectOptions) => {
    const { ctrlKey, metaKey, shiftKey } = event;
    const isCtrlPressed = ctrlKey || metaKey;
    const { shiftAnchor, onSimpleClick, updateLibraryActivePath } = options;

    if (shiftKey && shiftAnchor) {
      const lastIndex = sortedImageList.findIndex((f) => f.path === shiftAnchor);
      const currentIndex = sortedImageList.findIndex((f) => f.path === path);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const range = sortedImageList.slice(start, end + 1).map((f: ImageFile) => f.path);
        const baseSelection = isCtrlPressed ? multiSelectedPaths : [shiftAnchor];
        const newSelection = Array.from(new Set([...baseSelection, ...range]));

        libraryCubit.setSelection(newSelection);
        if (updateLibraryActivePath) {
          setLibraryActivePath(path);
        }
      }
    } else if (isCtrlPressed) {
      if (multiSelectedPaths.includes(path)) {
        libraryCubit.removeFromSelection(path);
      } else {
        libraryCubit.addToSelection(path);
      }

      const newSelectionArray = libraryCubit.state.multiSelectedPaths;

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
    }
  };

  const handleLibraryImageSingleClick = (path: string, event: any) => {
    handleMultiSelectClick(path, event, {
      shiftAnchor: libraryActivePath,
      updateLibraryActivePath: true,
      onSimpleClick: (p: string) => {
        libraryCubit.setSelection([p]);
        setLibraryActivePath(p);
      },
    });
  };

  const handleImageClick = (path: string, event: any) => {
    const inEditor = !!selectedImage;
    handleMultiSelectClick(path, event, {
      shiftAnchor: inEditor ? selectedImage.path : libraryActivePath,
      updateLibraryActivePath: !inEditor,
      onSimpleClick: handleImageSelect,
    });
  };

  useEffect(() => {
    const invokeWaveForm = async () => {
      const waveForm: any = await invoke(Invokes.GenerateWaveform).catch((err) =>
        console.error('Failed to generate waveform:', err),
      );
      if (waveForm) {
        setWaveform(waveForm);
      }
    };

    if (isWaveformVisible && selectedImage?.isReady && !waveform) {
      invokeWaveForm();
    }
  }, [isWaveformVisible, selectedImage?.isReady, waveform]);

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
    let isEffectActive = true;
    const loadFullImageData = async () => {
        try {
        const loadImageResult: any = await invoke(Invokes.LoadImage, { path: selectedImage.path });
        if (!isEffectActive) {
            return;
        }
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

        setIsFullResolution(false);
        setFullResolutionUrl(null);
        fullResCacheKeyRef.current = null;

        const blob = new Blob([loadImageResult.original_image_bytes], { type: 'image/jpeg' });
        const originalUrl = URL.createObjectURL(blob);

        // Update selected image with loaded data
        if (editorState.selectedImage && editorState.selectedImage.path === selectedImage.path) {
          updateSelectedImage({
            exif: loadImageResult.exif,
            height: loadImageResult.height,
            isRaw: loadImageResult.is_raw,
            isReady: true,
            metadata: loadImageResult.metadata,
            originalUrl: originalUrl,
            width: loadImageResult.width,
          });
        }

        let initialAdjusts;
        if (loadImageResult.metadata.adjustments && !loadImageResult.metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(loadImageResult.metadata.adjustments);
        } else {
            initialAdjusts = {
            ...INITIAL_ADJUSTMENTS,
            aspectRatio: loadImageResult.width / loadImageResult.height,
            };
        }
        if (loadImageResult.metadata.adjustments && !loadImageResult.metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(loadImageResult.metadata.adjustments);
        }
        resetAdjustmentsHistory(initialAdjusts);
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
    loadFullImageData();
    return () => {
        isEffectActive = false;
    };
    }
  }, [selectedImage?.path, selectedImage?.isReady, resetAdjustmentsHistory, appSettings?.editorPreviewResolution]);

  const handleClearSelection = () => {
    if (selectedImage) {
      libraryCubit.setSelection([selectedImage.path]);
    } else {
      libraryCubit.clearSelection();
      setLibraryActivePath(null);
    }
  };

  const handleRenameFiles = useCallback(async (paths: Array<string>) => {
    if (paths && paths.length > 0) {
      modalsCubit.openRenameFile(paths);
    }
  }, [modalsCubit]);

  const handleSaveRename = useCallback(
    async (nameTemplate: string) => {
      const renameTargetPaths = modalsState.renameFile.paths || [];
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

          libraryCubit.setSelection(newPaths);
        } catch (err) {
          setError(`Failed to rename files: ${err}`);
        }
      }
    },
    [modalsState.renameFile.paths, refreshImageList, selectedImage, libraryActivePath, handleImageSelect, handleBackToLibrary, libraryCubit],
  );

  const handleStartImport = async (settings: AppSettings) => {
    const { targetFolder, sourcePaths } = modalsState.import;
    if (sourcePaths && sourcePaths.length > 0 && targetFolder) {
      invoke(Invokes.ImportFiles, {
        destinationFolder: targetFolder,
        settings: settings,
        sourcePaths: sourcePaths,
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

      editorCubit.cancelPendingHistoryUpdate();

      invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset })
        .then(() => {
          if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
            setLibraryActiveAdjustments((prev: Adjustments) => ({ ...INITIAL_ADJUSTMENTS, rating: prev.rating }));
          }
          if (selectedImage && pathsToReset.includes(selectedImage.path)) {
            const currentRating = adjustments.rating;
            resetAdjustmentsHistory({ ...INITIAL_ADJUSTMENTS, rating: currentRating, aiPatches: [] });
          }
        })
        .catch((err) => {
          console.error('Failed to reset adjustments:', err);
          setError(`Failed to reset adjustments: ${err}`);
        });
    },
    [multiSelectedPaths, libraryActivePath, selectedImage, adjustments.rating, resetAdjustmentsHistory, editorCubit],
  );

  const handleImportClick = useCallback(
    async (targetPath: string) => {
      try {
        const nonRaw = supportedTypes?.nonRaw || [];
        const raw = supportedTypes?.raw || [];
        const allImageExtensions = [...nonRaw, ...raw];

        const selected = await open({
          filters: [
            {
              name: 'All Supported Images',
              extensions: allImageExtensions,
            },
            {
              name: 'RAW Images',
              extensions: raw,
            },
            {
              name: 'Standard Images (JPEG, PNG, etc.)',
              extensions: nonRaw,
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
          modalsCubit.openImport(targetPath, selected);
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
      { type: OPTION_SEPARATOR },
      { label: 'Auto Adjust Image', icon: Aperture, onClick: handleAutoAdjustments },
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
          editorCubit.cancelPendingHistoryUpdate();
          const currentRating = adjustments.rating;
          resetAdjustmentsHistory({ ...INITIAL_ADJUSTMENTS, rating: currentRating, aiPatches: [] });
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
      libraryCubit.setSelection([path]);
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
      return imageList.some(
        (image) => image.path.startsWith(basePath + '.') && image.path !== selectedPath,
      );
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
    const autoAdjustLabel = isSingleSelection ? 'Auto Adjust Image' : `Auto Adjust ${selectionCount} Images`;
    const renameLabel = isSingleSelection ? 'Rename Image' : `Rename ${selectionCount} Images`;
    const cullLabel = isSingleSelection ? 'Cull Image' : `Cull ${selectionCount} Images`;
    const collageLabel = isSingleSelection ? 'Create Collage' : `Create Collage`;
    const stitchLabel = `Stitch Panorama`;

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

      invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths: finalSelection })
        .then(async () => {
          if (selectedImage && finalSelection.includes(selectedImage.path)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              const normalized = normalizeLoadedAdjustments(metadata.adjustments);
              resetAdjustmentsHistory(normalized);
            }
          }
          if (libraryActivePath && finalSelection.includes(libraryActivePath)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, { path: libraryActivePath });
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
        setRenderedRightPanel(Panel.Export);
        setActiveRightPanel(Panel.Export);
      } else {
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
              if (sourceAdjustments.hasOwnProperty(key)) adjustmentsToCopy[key] = sourceAdjustments[key];
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
        onClick: handlePasteAdjustments,
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
            disabled: !isSingleSelection,
            icon: CopyPlus,
            label: 'Create Virtual Copy',
            onClick: () => handleCreateVirtualCopy(finalSelection[0]),
          },
          {
            label: 'Denoise',
            icon: Grip,
            disabled: !isSingleSelection,
            onClick: () => {
                modalsCubit.openDenoise(finalSelection[0]);
            }
          },
          {
            disabled: selectionCount < 2  || selectionCount > 30,
            icon: Images,
            label: stitchLabel,
            onClick: () => {
              modalsCubit.openPanorama(finalSelection);
              modalsCubit.updatePanoramaProgress('Starting panorama process...');
              invoke(Invokes.StitchPanorama, { paths: finalSelection }).catch((err) => {
                modalsCubit.setPanoramaError(String(err));
              });
            },
          },
          {
            icon: LayoutTemplate,
            label: collageLabel,
            onClick: () => {
              const imagesForCollage = imageList.filter(img => finalSelection.includes(img.path));
              modalsCubit.openCollage(imagesForCollage);
            },
            disabled: selectionCount === 0 || selectionCount > 9,
          },
          {
            label: cullLabel,
            icon: Users,
            onClick: () => modalsCubit.openCulling(finalSelection),
            disabled: imageList.length < 2,
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
        disabled: !isSingleSelection,
        icon: CopyPlus,
        label: 'Duplicate Image',
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
    const parentPath = modalsState.createFolder.parentPath;
    if (folderName && folderName.trim() !== '' && parentPath) {
      try {
        await invoke(Invokes.CreateFolder, { path: `${parentPath}/${folderName.trim()}` });
        refreshAllFolderTrees();
      } catch (err) {
        setError(`Failed to create folder: ${err}`);
      }
    }
  };

  const handleRenameFolder = async (newName: string) => {
    const folderPath = modalsState.renameFolder.path;
    if (newName && newName.trim() !== '' && folderPath) {
      try {
        const oldPath = folderPath;
        const trimmedNewName = newName.trim();

        await invoke(Invokes.RenameFolder, { path: oldPath, newName: trimmedNewName });

        const parentDir = getParentDir(oldPath);
        const separator = oldPath.includes('/') ? '/' : '\\';
        const newPath = parentDir ? `${parentDir}${separator}${trimmedNewName}` : trimmedNewName;

        const newAppSettings = { ...appSettings } as AppSettings;
        let settingsChanged = false;

        if (rootPath === oldPath) {
          navigationCubit.setRootPathSimple(newPath);
          newAppSettings.lastRootPath = newPath;
          settingsChanged = true;
        }
        if (currentFolderPath?.startsWith(oldPath)) {
          const newCurrentPath = currentFolderPath.replace(oldPath, newPath);
          navigationCubit.setCurrentFolderPath(newCurrentPath);
        }

        const currentPins = appSettings?.pinnedFolders || [];
        if (currentPins.includes(oldPath)) {
          const newPins = currentPins.map((p: string) => (p === oldPath ? newPath : p)).sort((a: string, b: string) => a.localeCompare(b));
          newAppSettings.pinnedFolders = newPins;
          navigationCubit.setPinnedFolders(newPins);
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
          modalsCubit.openCreateFolder(targetPath);
        },
      },
      {
        disabled: isRoot,
        icon: FileEdit,
        label: 'Rename Folder',
        onClick: () => {
          setFolderActionTarget(targetPath);
          const currentName = targetPath.split(/[\\/]/).pop() || '';
          modalsCubit.openRenameFolder(targetPath, currentName);
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
                libraryCubit.clearSelection();
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
                libraryCubit.clearSelection();
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

  const renderMainView = () => {
    const panelVariants: any = {
      animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'circOut' } },
      exit: { opacity: 0.4, y: -20, transition: { duration: 0.1, ease: 'circIn' } },
      initial: { opacity: 0.4, y: 20 },
    };

    if (selectedImage) {
      return (
        <div className="flex flex-row flex-grow h-full min-h-0">
          <div className="flex-1 flex flex-col min-w-0">
            <Editor
              isLoading={isViewLoading}
              onBackToLibrary={handleBackToLibrary}
              onContextMenu={handleEditorContextMenu}
              onGenerateAiMask={handleGenerateAiMask}
              onQuickErase={handleQuickErase}
              onStraighten={handleStraighten}
              onToggleFullScreen={handleToggleFullScreen}
              onZoomed={handleUserTransform}
              targetZoom={zoom}
              thumbnails={thumbnails}
              transformWrapperRef={transformWrapperRef}
              updateSubMask={updateSubMask}
              onDisplaySizeChange={handleDisplaySizeChange}
              onInitialFitScale={setInitialFitScale}
              onZoomChange={handleZoomChange}
              onWbPicked={handleWbPicked}
            />
            <Resizer
              direction={Orientation.Horizontal}
              onMouseDown={createResizeHandler(setBottomPanelHeight, bottomPanelHeight)}
            />
            <BottomBar
              filmstripHeight={bottomPanelHeight}
              isCopied={isCopied}
              isCopyDisabled={!selectedImage}
              isPasted={isPasted}
              isPasteDisabled={copiedAdjustments === null}
              isRatingDisabled={!selectedImage}
              isResizing={isResizing}
              onClearSelection={handleClearSelection}
              onContextMenu={handleThumbnailContextMenu}
              onCopy={handleCopyAdjustments}
              onOpenCopyPasteSettings={() => modalsCubit.openCopyPasteSettings()}
              onImageSelect={handleImageClick}
              onPaste={() => handlePasteAdjustments()}
              onRate={handleRate}
              onZoomChange={handleZoomChange}
              rating={adjustments.rating || 0}
            />
          </div>

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
                <AnimatePresence mode="wait">
                  {activeRightPanel && (
                    <motion.div
                      animate="animate"
                      className="h-full w-full"
                      exit="exit"
                      initial="initial"
                      key={renderedRightPanel}
                      variants={panelVariants}
                    >
                      {renderedRightPanel === Panel.Adjustments && (
                        <Controls
                          handleAutoAdjustments={handleAutoAdjustments}
                          handleLutSelect={handleLutSelect}
                        />
                      )}
                      {renderedRightPanel === Panel.Metadata && <MetadataPanel selectedImage={selectedImage} />}
                      {renderedRightPanel === Panel.Crop && <CropPanel />}
                      {renderedRightPanel === Panel.Masks && (
                        <MasksPanel
                          aiModelDownloadStatus={aiModelDownloadStatus}
                          onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                          onGenerateAiSkyMask={handleGenerateAiSkyMask}
                          setCustomEscapeHandler={setCustomEscapeHandler}
                        />
                      )}
                      {renderedRightPanel === Panel.Presets && (
                        <PresetsPanel
                          activePanel={activeRightPanel}
                          adjustments={adjustments}
                          selectedImage={selectedImage}
                          onNavigateToCommunity={() => {
                            handleBackToLibrary();
                            navigationCubit.switchToCommunity();
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
                        />
                      )}
                      {renderedRightPanel === Panel.Ai && (
                        <AIPanel
                          aiModelDownloadStatus={aiModelDownloadStatus}
                          isComfyUiConnected={isComfyUiConnected}
                          isGeneratingAi={isGeneratingAi}
                          onDeletePatch={handleDeleteAiPatch}
                          onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                          onGenerativeReplace={handleGenerativeReplace}
                          onTogglePatchVisibility={handleToggleAiPatchVisibility}
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
              <RightPanelSwitcher activePanel={activeRightPanel} onPanelSelect={handleRightPanelSelect} />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-row flex-grow h-full min-h-0">
        <div className="flex-1 flex flex-col min-w-0 gap-2">
          {activeView === 'community' ? (
            <CommunityPage
              onBackToLibrary={() => navigationCubit.switchToLibrary()}
              supportedTypes={supportedTypes}
              imageList={sortedImageList}
              currentFolderPath={currentFolderPath}
            />
          ) : (
            <MainLibrary
              activePath={libraryActivePath}
              aiModelDownloadStatus={aiModelDownloadStatus}
              importState={importState}
              indexingProgress={indexingProgress}
              isIndexing={isIndexing}
              isThumbnailsLoading={isThumbnailsLoading}
              isLoading={isViewLoading}
              libraryScrollTop={libraryScrollTop}
              onContextMenu={handleThumbnailContextMenu}
              onContinueSession={handleContinueSession}
              onEmptyAreaContextMenu={handleMainLibraryContextMenu}
              onGoHome={handleGoHome}
              onImageClick={handleLibraryImageSingleClick}
              onImageDoubleClick={handleImageSelect}
              onLibraryRefresh={handleLibraryRefresh}
              onOpenFolder={handleOpenFolder}
              setLibraryScrollTop={setLibraryScrollTop}
              onNavigateToCommunity={() => navigationCubit.switchToCommunity()}
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
              onCopy={handleCopyAdjustments}
              onExportClick={() => setIsLibraryExportPanelVisible((prev) => !prev)}
              onOpenCopyPasteSettings={() => modalsCubit.openCopyPasteSettings()}
              onPaste={() => handlePasteAdjustments()}
              onRate={handleRate}
              onReset={() => handleResetAdjustments()}
              rating={libraryActiveAdjustments.rating || 0}
            />
          )}
        </div>
      </div>
    );
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
      {appSettings?.decorations || (!isWindowFullScreen && <TitleBar />)}
      <div
        className={clsx('flex-1 flex flex-col min-h-0', [
          rootPath && 'p-2 gap-2',
          !appSettings?.decorations && rootPath && !isWindowFullScreen && 'pt-12',
        ])}
      >
        {error && (
          <div className="absolute top-12 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-4 py-2 rounded-lg z-50">
            {error}
            <button onClick={() => setError(null)} className="ml-4 font-bold hover:text-gray-200">
              ×
            </button>
          </div>
        )}
        <div className="flex flex-row flex-grow h-full min-h-0">
          {rootPath && (
            <>
              <FolderTree
                isResizing={isResizing}
                onContextMenu={handleFolderTreeContextMenu}
                style={{ width: uiVisibility.folderTree ? `${leftPanelWidth}px` : '32px' }}
              />
              <Resizer
                direction={Orientation.Vertical}
                onMouseDown={createResizeHandler(setLeftPanelWidth, leftPanelWidth)}
              />
            </>
          )}
          <div className="flex-1 flex flex-col min-w-0">{renderContent()}</div>
          {!selectedImage && isLibraryExportPanelVisible && (
            <Resizer
              direction={Orientation.Vertical}
              onMouseDown={createResizeHandler(setRightPanelWidth, rightPanelWidth)}
            />
          )}
          <div
            className={clsx('flex-shrink-0 overflow-hidden', !isResizing && 'transition-all duration-300 ease-in-out')}
            style={{ width: isLibraryExportPanelVisible ? `${rightPanelWidth}px` : '0px' }}
          >
            <LibraryExportPanel
              exportState={exportState}
              imageList={sortedImageList}
              isVisible={isLibraryExportPanelVisible}
              multiSelectedPaths={multiSelectedPaths}
              onClose={() => setIsLibraryExportPanelVisible(false)}
              setExportState={setExportState}
            />
          </div>
        </div>
      </div>
      <CopyPasteSettingsModal
        settings={appSettings?.copyPasteSettings as CopyPasteSettings}
        onSave={(newSettings) => handleSettingsChange({ ...appSettings, copyPasteSettings: newSettings } as AppSettings)}
      />
      <PanoramaModal
        onOpenFile={(path: string) => {
          handleImageSelect(path);
        }}
        onSave={handleSavePanorama}
      />
      <DenoiseModal 
        onDenoise={handleApplyDenoise}
        onSave={handleSaveDenoisedImage}
        onOpenFile={handleImageSelect}
      />
      <CreateFolderModal onSave={handleCreateFolder} />
      <RenameFolderModal onSave={handleRenameFolder} />
      <RenameFileModal onSave={handleSaveRename} />
      <ConfirmModal />
      <ImportSettingsModal onSave={handleStartImport} />
      <CullingModal
        thumbnails={thumbnails}
        onApply={(action, paths) => {
          if (action === 'reject') {
            handleSetColorLabel('red', paths);
          } else if (action === 'rate_zero') {
            handleRate(1, paths);
          } else if (action === 'delete') {
            executeDelete(paths, { includeAssociated: false });
          }
          modalsCubit.closeCulling();
        }}
      />
      <CollageModal
        onSave={handleSaveCollage}
        thumbnails={thumbnails}
      />
    </div>
  );
}

const AppWrapper = () => (
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
    <ContextMenuProvider>
      <App />
    </ContextMenuProvider>
  </ClerkProvider>
);

export default AppWrapper;