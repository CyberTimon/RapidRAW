import { invoke } from '@tauri-apps/api/core';
import { Color } from 'framer-motion';
import {
  Save,
  Undo,
  Redo,
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
  Star,
  Palette,
  Tag,
  RotateCcw,
} from 'lucide-react';

import { Invokes, Panel, OPTION_SEPARATOR, Option } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import TaggingSubMenu from '../../context/TaggingSubMenu';
import { COLOR_LABELS, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useRefreshImageList } from './useRefreshImageList';
import { useGetCommonTags } from './useGetCommonTags';
import { useUndo } from './useUndo';
import { useRedo } from './useRedo';
import { useHandleCopyAdjustments } from './useHandleCopyAdjustments';
import { useHandlePasteAdjustments } from './useHandlePasteAdjustments';
import { useContextMenu } from '../../context/ContextMenuContext';
import { useDebouncedSetHistory } from './useDebouncedSetHistory';
import { useHandleTagsChanged } from './useHandleTagsChanged';
import { useHandleSetColorLabel } from './useHandleSetColorLabel';
import { useHandleRate } from './useHandleRate';
import { useHandleAutoAdjustments } from './useHandleAutoAdjustments';

export function useHandleEditorContextMenu() {
  const {
    selectedImage,
    setError,
    setRenderedRightPanel,
    setActiveRightPanel,
    history,
    copiedAdjustments,
    adjustments,
    appSettings,
    setCollageModalState,
    setNegativeModalState,
    setDenoiseModalState,
  } = useAppState();
  const { canRedo, canUndo, resetHistory: resetAdjustmentsHistory } = history;
  const { showContextMenu } = useContextMenu();
  const refreshImageList = useRefreshImageList();
  const getCommonTags = useGetCommonTags();
  const undo = useUndo();
  const redo = useRedo();
  const handleCopyAdjustments = useHandleCopyAdjustments();
  const handlePasteAdjustments = useHandlePasteAdjustments();
  const debouncedSetHistory = useDebouncedSetHistory();
  const handleTagsChanged = useHandleTagsChanged();
  const handleSetColorLabel = useHandleSetColorLabel();
  const handleRate = useHandleRate();
  const handleAutoAdjustments = useHandleAutoAdjustments();

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

  return handleEditorContextMenu;
}
