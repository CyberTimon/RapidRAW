import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import debounce from 'lodash.debounce';
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
import { useContextMenu } from './context/ContextMenuContext';
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
import GlobalTooltip from './components/ui/GlobalTooltip';
import { THEMES, DEFAULT_THEME_ID, ThemeProps } from './utils/themes';
import { SubMask } from './components/panel/right/Masks';
import { ExportState, IMPORT_TIMEOUT, ImportState, Status } from './components/ui/ExportImportProperties';
import {
  FilterCriteria,
  Invokes,
  ImageFile,
  Option,
  OPTION_SEPARATOR,
  LibraryViewMode,
  Panel,
  RawStatus,
  SelectedImage,
  SortDirection,
  Theme,
  TransformState,
  UiVisibility,
  Orientation,
  CullingSuggestions,
  AppSettings,
} from './components/ui/AppProperties';
import HdrModal from './components/modals/HdrModal';
import { ContextProviders, useAppState } from './context/ContextProviders';
import { getParentDir } from './utils/helpers';
import { useSortedImageList } from './hooks/useSortedImageList';
import { useHandleBackToLibrary } from './hooks/handlers/useHandleBackToLibrary';
import { useDebouncedSave } from './hooks/handlers/useDebounce';
import { useApplyAdjustments } from './hooks/handlers/useApplyAdjustments';
import { useHandleImageSelect } from './hooks/handlers/useHandleImageSelect';
import { useRefreshImageList } from './hooks/handlers/useRefreshImageList';
import { useExecuteDelete } from './hooks/handlers/useExecuteDelete';
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

interface Metadata {
  adjustments: Adjustments;
  rating: number;
  tags: Array<string> | null;
  version: number;
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
    setSelectedImage,
    appSettings,
    rootPath,
    setRootPath,
    activeView,
    setActiveView,
    isWindowFullScreen,
    isLayoutReady,
    setIsLayoutReady,
    currentFolderPath,
    setCurrentFolderPath,
    expandedFolders,
    setExpandedFolders,
    folderTree,
    setFolderTree,
    setPinnedFolderTrees,
    imageList,
    setImageList,
    imageRatings,
    setImageRatings,
    sortCriteria,
    filterCriteria,
    supportedTypes,
    multiSelectedPaths,
    setMultiSelectedPaths,
    libraryActivePath,
    setLibraryActivePath,
    libraryActiveAdjustments,
    setLibraryActiveAdjustments,
    setFinalPreviewUrl,
    setUncroppedAdjustedPreviewUrl,
    setShowOriginal,
    adjustments,
    setAdjustments: setLiveAdjustments,
    isTreeLoading,
    setIsTreeLoading,
    isViewLoading,
    setIsViewLoading,
    initialFileToOpen,
    setInitialFileToOpen,
    setError,
    setHistogram,
    waveform,
    setWaveform,
    isWaveformVisible,
    setIsWaveformVisible,
    uiVisibility,
    setUiVisibility,
    isSliderDragging,
    setIsSliderDragging,
    isFullScreen,
    setIsFullScreen,
    isHighResNeeded,
    setIsHighResNeeded,
    isAnimatingTheme,
    theme,
    dragIdleTimer,
    activeRightPanel,
    setActiveRightPanel,
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
    setZoom,
    displaySize,
    previewSize,
    setPreviewSize,
    baseRenderSize,
    originalSize,
    setOriginalSize,
    setIsLoadingFullRes,
    fullResCacheKeyRef,
    initialFitScale,
    setInitialFitScale,
    renderedRightPanel,
    setRenderedRightPanel,
    isLibraryExportPanelVisible,
    setIsLibraryExportPanelVisible,
    libraryViewMode,
    leftPanelWidth,
    setLeftPanelWidth,
    rightPanelWidth,
    setRightPanelWidth,
    bottomPanelHeight,
    setBottomPanelHeight,
    setActiveTreeSection,
    isResizing,
    thumbnailSize,
    setThumbnailSize,
    thumbnailAspectRatio,
    setThumbnailAspectRatio,
    copiedAdjustments,
    setCopiedAdjustments,
    isStraightenActive,
    setIsStraightenActive,
    copiedFilePaths,
    setCopiedFilePaths,
    aiModelDownloadStatus,
    setAiModelDownloadStatus,
    isCopied,
    setIsCopied,
    isPasted,
    setIsPasted,
    isIndexing,
    setIsIndexing,
    indexingProgress,
    setIndexingProgress,
    searchCriteria,
    setSearchCriteria,
    isCreateFolderModalOpen,
    setIsCreateFolderModalOpen,
    isRenameFolderModalOpen,
    setIsRenameFolderModalOpen,
    isRenameFileModalOpen,
    setIsRenameFileModalOpen,
    renameTargetPaths,
    setRenameTargetPaths,
    isImportModalOpen,
    setIsImportModalOpen,
    isCopyPasteSettingsModalOpen,
    setIsCopyPasteSettingsModalOpen,
    importTargetFolder,
    setImportTargetFolder,
    importSourcePaths,
    setImportSourcePaths,
    folderActionTarget,
    setFolderActionTarget,
    confirmModalState,
    setConfirmModalState,
    panoramaModalState,
    setPanoramaModalState,
    hdrModalState,
    setHdrModalState,
    negativeModalState,
    setNegativeModalState,
    denoiseModalState,
    setDenoiseModalState,
    collageModalState,
    setCullingModalState,
    cullingModalState,
    setCollageModalState,
    customEscapeHandler,
    libraryScrollTop,
    setLibraryScrollTop,
    thumbnails,
    setThumbnails,
    isInitialMount,
    isProgrammaticZoom,
    currentFolderPathRef,
    preloadedDataRef,
    previewJobIdRef,
    latestRenderedJobIdRef,
    history,
    exportState,
    setExportState,
    importState,
    setImportState,
    isLightTheme,
    visualAdjustmentsKey,
    pinnedFolders,
    isAnyModalOpen,
  } = useAppState();

  const { sortedImageList } = useSortedImageList();

  const { canUndo, canRedo, resetHistory: resetAdjustmentsHistory, goToIndex: goToAdjustmentsHistoryIndex } = history;

  const {
    handleBackToLibrary,
    handleImageSelect,
    executeDelete,
    handleDeleteSelected,
    refreshImageList,
    applyAdjustments,
    debouncedSave,
    handleDisplaySizeChange,
    debouncedSetHistory,
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
    refreshAllFolderTrees,
    handleActiveTreeSectionChange,
    handleTogglePinFolder,
    handleSelectSubfolder,
    handleLibraryRefresh,
    handleToggleFolder,
    handleToggleFullScreen,
    handleCopyAdjustments,
    handlePasteAdjustments,
    handleAutoAdjustments,
    handleRate,
    handleSetColorLabel,
    getCommonTags,
    handleTagsChanged,
    closeConfirmModal,
    handlePasteFiles,
    requestFullResolution,
    handleFullResolutionLogic,
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
    handleMultiSelectClick,
    handleLibraryImageSingleClick,
    handleImageClick,
    handleClearSelection,
    handleRenameFiles,
    handleSaveRename,
    handleStartImport,
    handleResetAdjustments,
    handleImportClick,
  } = useHandlers();

  useGlobalEffects();

  const { showContextMenu } = useContextMenu();
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
          },
          {
            icon: CopyPlus,
            label: 'Create Virtual Copy',
            onClick: () => handleCreateVirtualCopy(selectedImage.path),
          },
          {
            label: 'Denoise',
            icon: Grip,
            onClick: () => {
              setDenoiseModalState({
                isOpen: true,
                isProcessing: false,
                previewBase64: null,
                error: null,
                targetPath: selectedImage.path,
                progressMessage: null,
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
                  targetPath: selectedImage.path,
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
    const stitchLabel = `Stitch Panorama`;
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
              setDenoiseModalState({
                isOpen: true,
                isProcessing: false,
                previewBase64: null,
                error: null,
                targetPath: finalSelection[0],
                progressMessage: null,
              });
            },
          },
          {
            label: 'Convert Negative',
            icon: Film,
            disabled: !isSingleSelection,
            onClick: () => {
              setNegativeModalState({
                isOpen: true,
                targetPath: finalSelection[0],
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
                progressMessage: 'Starting panorama process...',
                stitchingSourcePaths: finalSelection,
              });
              invoke(Invokes.StitchPanorama, { paths: finalSelection }).catch((err) => {
                setPanoramaModalState((prev: PanoramaModalState) => ({
                  ...prev,
                  error: String(err),
                  isOpen: true,
                  progressMessage: 'Failed to start.',
                }));
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
                progressMessage: 'Starting hdr process...',
                stitchingSourcePaths: finalSelection,
              });
              invoke(Invokes.MergeHdr, { paths: finalSelection }).catch((err) => {
                setHdrModalState((prev: HdrModalState) => ({
                  ...prev,
                  error: String(err),
                  isOpen: true,
                  progressMessage: 'Failed to start.',
                }));
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
