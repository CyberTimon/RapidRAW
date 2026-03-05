import { invoke } from '@tauri-apps/api/core';
import {
  X,
  Check,
  Trash2,
  Edit,
  Save,
  Copy,
  ClipboardPaste,
  Gauge,
  Aperture,
  CopyPlus,
  Grip,
  Film,
  SquaresUnite,
  Images,
  LayoutTemplate,
  Users,
  FileEdit,
  Star,
  Palette,
  Tag,
  Folder,
  RotateCcw,
} from 'lucide-react';
import { PanoramaModalState, HdrModalState } from '../../App';
import { Invokes, Panel, OPTION_SEPARATOR } from '../../components/ui/AppProperties';
import { useContextMenu } from '../../context/ContextMenuContext';
import { useAppState } from '../../context/ContextProviders';
import TaggingSubMenu from '../../context/TaggingSubMenu';
import {
  Adjustments,
  Color,
  COLOR_LABELS,
  COPYABLE_ADJUSTMENT_KEYS,
  INITIAL_ADJUSTMENTS,
  normalizeLoadedAdjustments,
} from '../../utils/adjustments';
import { useHandleResetAdjustments } from './useHandleResetAdjustments';
import { useHandleTagsChanged } from './useHandleTagsChanged';
import { useHandleSetColorLabel } from './useHandleSetColorLabel';
import { useHandleRate } from './useHandleRate';
import { useHandleRenameFiles } from './useHandleRenameFiles';
import { useRefreshImageList } from './useRefreshImageList';
import { useHandlePasteAdjustments } from './useHandlePasteAdjustments';
import { useHandleImageClick } from './useHandleImageClick';
import { useHandleImageSelect } from './useHandleImageSelect';
import { useExecuteDelete } from './useExecuteDelete';
import { useGetCommonTags } from './useGetCommonTags';

interface Metadata {
  adjustments: Adjustments;
  rating: number;
  tags: Array<string> | null;
  version: number;
}

export function useHandleThumbnailContextMenu() {
  const {
    multiSelectedPaths,
    setMultiSelectedPaths,
    setError,
    appSettings,
    setIsCopied,
    setCopiedFilePaths,
    setCullingModalState,
    setCollageModalState,
    setHdrModalState,
    setPanoramaModalState,
    setNegativeModalState,
    setDenoiseModalState,
    copiedAdjustments,
    setCopiedAdjustments,
    imageList,
    setIsLibraryExportPanelVisible,
    setActiveRightPanel,
    setRenderedRightPanel,
    selectedImage,
    setLibraryActiveAdjustments,
    libraryActivePath,
    history,
    setAdjustments: setLiveAdjustments,
    setLibraryActivePath,
  } = useAppState();
  const { showContextMenu } = useContextMenu();
  const { resetHistory: resetAdjustmentsHistory } = history;

  const handleResetAdjustments = useHandleResetAdjustments();
  const handleTagsChanged = useHandleTagsChanged();
  const handleSetColorLabel = useHandleSetColorLabel();
  const handleRate = useHandleRate();
  const handleRenameFiles = useHandleRenameFiles();
  const refreshImageList = useRefreshImageList();
  const handlePasteAdjustments = useHandlePasteAdjustments();
  const handleImageSelect = useHandleImageSelect();
  const executeDelete = useExecuteDelete();
  const getCommonTags = useGetCommonTags();

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

  return handleThumbnailContextMenu;
}
