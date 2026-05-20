import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Aperture,
  Check,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Edit,
  FileEdit,
  FileInput,
  Folder,
  FolderInput,
  FolderPlus,
  Images,
  LayoutTemplate,
  Redo,
  RefreshCw,
  RotateCcw,
  Star,
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
  Home,
  Plane,
  Mountain,
  Sun,
  Camera,
  Map,
  Heart,
  Car,
  Briefcase,
  User,
  Album as AlbumIcon,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useContextMenu } from '../context/ContextMenuContext';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useProcessStore } from '../store/useProcessStore';
import { useUIStore } from '../store/useUIStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes, Option, OPTION_SEPARATOR, Panel, AlbumItem, Album, AlbumGroup } from '../components/ui/AppProperties';
import { Color, COLOR_LABELS, INITIAL_ADJUSTMENTS, normalizeLoadedAdjustments } from '../utils/adjustments';
import TaggingSubMenu from '../context/TaggingSubMenu';
import { useEditorActions } from './useEditorActions';
import { useLibraryActions } from './useLibraryActions';
import { globalImageCache } from '../utils/ImageLRUCache';

const RIGHT_PANEL_ORDER = [
  Panel.Metadata,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
  Panel.Export,
];

const ALBUM_ICONS = [
  { label: 'Folder (Default)', value: undefined, icon: Folder },
  { label: 'Travel', value: 'plane', icon: Plane },
  { label: 'Nature', value: 'mountain', icon: Mountain },
  { label: 'Summer', value: 'sun', icon: Sun },
  { label: 'Photography', value: 'camera', icon: Camera },
  { label: 'Locations', value: 'map', icon: Map },
  { label: 'Favorites', value: 'heart', icon: Heart },
  { label: 'Featured', value: 'star', icon: Star },
  { label: 'People', value: 'users', icon: Users },
  { label: 'Person', value: 'user', icon: User },
  { label: 'Automotive', value: 'car', icon: Car },
  { label: 'Portfolio', value: 'briefcase', icon: Briefcase },
];

export interface UseAppContextMenusProps {
  handleImageSelect: (path: string) => void;
  handleBackToLibrary: () => void;
  handleRenameFiles: (paths: string[]) => void;
  handleImportClick: (path: string) => void;
  handleLibraryRefresh: () => Promise<void>;
  refreshAllFolderTrees: () => Promise<void>;
  refreshImageList: () => Promise<void>;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleTogglePinFolder: (path: string) => Promise<void>;
}

export function useAppContextMenus(props: UseAppContextMenusProps) {
  const { showContextMenu } = useContextMenu();

  const { handleAutoAdjustments, handleResetAdjustments, handleCopyAdjustments, handlePasteAdjustments } =
    useEditorActions();
  const { handleRate, handleSetColorLabel, handleTagsChanged } = useLibraryActions();

  const getCommonTags = useCallback((paths: string[]): { tag: string; isUser: boolean }[] => {
    const { imageList } = useLibraryStore.getState();
    if (paths.length === 0) return [];
    const imageFiles = imageList.filter((img) => paths.includes(img.path));
    if (imageFiles.length === 0) return [];

    const allTagsSets = imageFiles.map((img) => {
      const tagsWithPrefix = (img.tags || []).filter((t: string) => !t.startsWith('color:'));
      return new Set(tagsWithPrefix);
    });

    if (allTagsSets.length === 0) return [];

    const commonTagsWithPrefix = allTagsSets.reduce((intersection, currentSet) => {
      return new Set([...intersection].filter((tag) => currentSet.has(tag)));
    });

    return Array.from(commonTagsWithPrefix)
      .map((tag: string) => ({
        tag: tag.startsWith('user:') ? tag.substring(5) : tag,
        isUser: tag.startsWith('user:'),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, []);

  const buildAddToAlbumMenu = useCallback((items: AlbumItem[], pathsToAdd: string[]): Option[] => {
    return items.map((item) => {
      const customIconDef = item.icon ? ALBUM_ICONS.find((i) => i.value === item.icon) : null;
      const ResolvedIcon = customIconDef?.icon || (item.type === 'group' ? Folder : AlbumIcon);

      if (item.type === 'group') {
        return {
          label: item.name,
          icon: ResolvedIcon,
          submenu:
            (item as AlbumGroup).children.length > 0
              ? buildAddToAlbumMenu((item as AlbumGroup).children, pathsToAdd)
              : [{ label: '(Empty Group)', disabled: true }],
        };
      } else {
        return {
          label: item.name,
          icon: ResolvedIcon,
          onClick: () => {
            invoke(Invokes.AddToAlbum, { albumId: item.id, paths: pathsToAdd })
              .then(() => {
                console.log(`Added image(s) to ${item.name}`);
                invoke(Invokes.GetAlbums).then((res: any) => useLibraryStore.getState().setLibrary({ albumTree: res }));
              })
              .catch((err) => toast.error(`Failed to add to album: ${err}`));
          },
        };
      }
    });
  }, []);

  const handleEditorContextMenu = useCallback(
    (event: any) => {
      event.preventDefault();
      event.stopPropagation();

      const { selectedImage, history, historyIndex, undo, redo, resetHistory, copiedAdjustments, setEditor } =
        useEditorStore.getState();
      const { appSettings } = useSettingsStore.getState();
      const { setRightPanel, setUI } = useUIStore.getState();

      if (!selectedImage) return;

      const canUndo = historyIndex > 0;
      const canRedo = historyIndex < history.length - 1;
      const commonTags = getCommonTags([selectedImage.path]);

      const options: Array<Option> = [
        {
          label: 'Export Image',
          icon: FileInput,
          onClick: () => setRightPanel(Panel.Export, RIGHT_PANEL_ORDER),
        },
        { type: OPTION_SEPARATOR },
        { label: 'Undo', icon: Undo, onClick: undo, disabled: !canUndo },
        { label: 'Redo', icon: Redo, onClick: redo, disabled: !canRedo },
        { type: OPTION_SEPARATOR },
        { label: 'Copy Adjustments', icon: Copy, onClick: handleCopyAdjustments },
        {
          label: 'Paste Adjustments',
          icon: ClipboardPaste,
          onClick: () => handlePasteAdjustments(),
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
                setUI({
                  denoiseModalState: {
                    isOpen: true,
                    isProcessing: false,
                    previewBase64: null,
                    error: null,
                    targetPaths: [selectedImage.path],
                    progressMessage: null,
                    isRaw: selectedImage?.isRaw || false,
                  },
                });
              },
            },
            {
              label: 'Convert Negative',
              icon: Film,
              onClick: () => {
                if (selectedImage) {
                  setUI({ negativeModalState: { isOpen: true, targetPaths: [selectedImage.path] } });
                }
              },
            },
            { disabled: true, icon: SquaresUnite, label: 'Stitch Panorama' },
            { disabled: true, icon: Images, label: 'Merge to HDR' },
            {
              icon: LayoutTemplate,
              label: 'Frame Image',
              onClick: () => {
                setUI({ collageModalState: { isOpen: true, sourceImages: [selectedImage] } });
              },
            },
            { label: 'Cull Image', icon: Users, disabled: true },
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
          submenu: [
            { label: 'Cancel', icon: X, onClick: () => {} },
            {
              label: 'Confirm Reset',
              icon: Check,
              isDestructive: true,
              onClick: () => {
                const originalAspectRatio =
                  selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;
                resetHistory({
                  ...INITIAL_ADJUSTMENTS,
                  aspectRatio: originalAspectRatio,
                  aiPatches: [],
                });
                setEditor({ adjustments: { ...INITIAL_ADJUSTMENTS, aspectRatio: originalAspectRatio, aiPatches: [] } });
              },
            },
          ],
        },
      ];
      showContextMenu(event.clientX, event.clientY, options);
    },
    [
      getCommonTags,
      handleCopyAdjustments,
      handlePasteAdjustments,
      handleAutoAdjustments,
      handleRate,
      handleSetColorLabel,
      handleTagsChanged,
      showContextMenu,
    ],
  );

  const handleThumbnailContextMenu = useCallback(
    (event: any, path: string) => {
      event.preventDefault();
      event.stopPropagation();

      const { selectedImage, copiedAdjustments, setEditor } = useEditorStore.getState();
      const { multiSelectedPaths, imageList, libraryActivePath, albumTree, activeAlbumId, setLibrary } =
        useLibraryStore.getState();
      const { appSettings } = useSettingsStore.getState();
      const { setUI, setRightPanel } = useUIStore.getState();
      const { setProcess } = useProcessStore.getState();

      const isTargetInSelection = multiSelectedPaths.includes(path);
      let finalSelection: string[];

      if (!isTargetInSelection) {
        finalSelection = [path];
        setLibrary({ multiSelectedPaths: [path] });
        if (!selectedImage) {
          setLibrary({ libraryActivePath: path });
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
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
        ];
      } else if (hasAssociatedFiles) {
        deleteSubmenu = [
          { label: 'Cancel', icon: X, onClick: () => {} },
          {
            label: 'Delete Selected Only',
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
          {
            label: 'Delete + Associated',
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: true }),
          },
        ];
      } else {
        deleteSubmenu = [
          { label: 'Cancel', icon: X, onClick: () => {} },
          {
            label: 'Confirm Delete',
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
        ];
      }

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
          await invoke(Invokes.CreateVirtualCopy, {
            sourceVirtualPath: sourcePath,
            targetAlbumId: activeAlbumId || null,
          });

          if (activeAlbumId) {
            const sortedTree = await invoke<AlbumItem[]>(Invokes.GetAlbums);
            setLibrary({ albumTree: sortedTree });
          }
          await props.refreshImageList();
        } catch (err) {
          toast.error(`Failed to create virtual copy: ${err}`);
        }
      };

      const handleApplyAutoAdjustmentsToSelection = () => {
        if (finalSelection.length === 0) return;
        finalSelection.forEach((p) => globalImageCache.delete(p));

        invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths: finalSelection })
          .then(async () => {
            if (selectedImage && finalSelection.includes(selectedImage.path)) {
              const metadata: any = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
              if (metadata.adjustments && !metadata.adjustments.is_null) {
                const normalized = normalizeLoadedAdjustments(metadata.adjustments);
                setEditor({ adjustments: normalized });
                useEditorStore.getState().resetHistory(normalized);
              }
            }
            if (libraryActivePath && finalSelection.includes(libraryActivePath)) {
              const metadata: any = await invoke(Invokes.LoadMetadata, { path: libraryActivePath });
              if (metadata.adjustments && !metadata.adjustments.is_null) {
                const normalized = normalizeLoadedAdjustments(metadata.adjustments);
                setLibrary({ libraryActiveAdjustments: normalized });
              }
            }
          })
          .catch((err) => {
            console.error('Failed to apply auto adjustments to paths:', err);
            toast.error(`Failed to apply auto adjustments: ${err}`);
          });
      };

      const onExportClick = () => {
        if (selectedImage) {
          if (selectedImage.path !== path) {
            props.handleImageSelect(path);
          }
          setLibrary({ multiSelectedPaths: finalSelection });
          setRightPanel(Panel.Export, RIGHT_PANEL_ORDER);
        } else {
          setLibrary({ multiSelectedPaths: finalSelection });
          setUI({ isLibraryExportPanelVisible: true });
        }
      };

      const handleRemoveFromAlbum = async () => {
        if (!activeAlbumId) return;
        const newTree = JSON.parse(JSON.stringify(albumTree));

        const removeImages = (nodes: AlbumItem[]): boolean => {
          for (const n of nodes) {
            if (n.id === activeAlbumId && n.type === 'album') {
              (n as Album).images = (n as Album).images.filter((p) => !finalSelection.includes(p));
              return true;
            } else if (n.type === 'group') {
              if (removeImages(n.children)) return true;
            }
          }
          return false;
        };

        if (removeImages(newTree)) {
          try {
            await invoke(Invokes.SaveAlbums, { tree: newTree });
            const sortedTree = await invoke<AlbumItem[]>(Invokes.GetAlbums);
            setLibrary({ albumTree: sortedTree });

            const albumObj = sortedTree.reduce((acc: any, cur: any) => {
              const find = (n: any): any =>
                n.id === activeAlbumId
                  ? n
                  : n.type === 'group'
                    ? n.children.reduce((a: any, c: any) => a || find(c), null)
                    : null;
              return acc || find(cur);
            }, null) as Album;

            if (albumObj) {
              setLibrary({ imageList: imageList.filter((i) => albumObj.images.includes(i.path)) });
            }
          } catch (e) {
            toast.error(`Failed to remove images: ${e}`);
          }
        }
      };

      const options = [
        ...(!isEditingThisImage
          ? [
              {
                disabled: !isSingleSelection,
                icon: Edit,
                label: 'Edit Image',
                onClick: () => props.handleImageSelect(finalSelection[0]),
              },
              { icon: FileInput, label: exportLabel, onClick: onExportClick },
              { type: OPTION_SEPARATOR },
            ]
          : [{ icon: FileInput, label: exportLabel, onClick: onExportClick }, { type: OPTION_SEPARATOR }]),
        {
          disabled: !isSingleSelection,
          icon: Copy,
          label: 'Copy Adjustments',
          onClick: handleCopyAdjustments,
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
            { label: autoAdjustLabel, icon: Aperture, onClick: handleApplyAutoAdjustmentsToSelection },
            {
              label: denoiseLabel,
              icon: Grip,
              disabled: finalSelection.length === 0,
              onClick: () => {
                setUI({
                  denoiseModalState: {
                    isOpen: true,
                    isProcessing: false,
                    previewBase64: null,
                    error: null,
                    targetPaths: finalSelection,
                    progressMessage: null,
                    isRaw: selectedImage?.isRaw || false,
                  },
                });
              },
            },
            {
              label: conversionLabel,
              icon: Film,
              disabled: selectionCount === 0,
              onClick: () => {
                setUI({ negativeModalState: { isOpen: true, targetPaths: finalSelection } });
              },
            },
            {
              disabled: selectionCount < 2 || selectionCount > 30,
              icon: SquaresUnite,
              label: stitchLabel,
              onClick: () => {
                setUI({
                  panoramaModalState: {
                    error: null,
                    finalImageBase64: null,
                    isOpen: true,
                    isProcessing: false,
                    progressMessage: null,
                    stitchingSourcePaths: finalSelection,
                  },
                });
              },
            },
            {
              disabled: selectionCount < 2 || selectionCount > 9,
              icon: Images,
              label: mergeLabel,
              onClick: () => {
                setUI({
                  hdrModalState: {
                    error: null,
                    finalImageBase64: null,
                    isOpen: true,
                    isProcessing: false,
                    progressMessage: null,
                    stitchingSourcePaths: finalSelection,
                  },
                });
              },
            },
            {
              icon: LayoutTemplate,
              label: collageLabel,
              onClick: () => {
                const imagesForCollage = imageList.filter((img) => finalSelection.includes(img.path));
                setUI({ collageModalState: { isOpen: true, sourceImages: imagesForCollage } });
              },
              disabled: selectionCount === 0 || selectionCount > 9,
            },
            {
              label: cullLabel,
              icon: Users,
              onClick: () =>
                setUI({
                  cullingModalState: {
                    isOpen: true,
                    progress: null,
                    suggestions: null,
                    error: null,
                    pathsToCull: finalSelection,
                  },
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
            setProcess({ copiedFilePaths: finalSelection, isCopied: true });
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
                  await invoke(Invokes.DuplicateFile, {
                    path: finalSelection[0],
                    targetAlbumId: activeAlbumId || null,
                  });
                  if (activeAlbumId) {
                    const sortedTree = await invoke<AlbumItem[]>(Invokes.GetAlbums);
                    setLibrary({ albumTree: sortedTree });
                  }
                  await props.refreshImageList();
                } catch (err) {
                  console.error('Failed to duplicate file:', err);
                  toast.error(`Failed to duplicate file: ${err}`);
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
        { icon: FileEdit, label: renameLabel, onClick: () => props.handleRenameFiles(finalSelection) },
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
          label: 'Add to Album',
          icon: FolderPlus,
          submenu:
            albumTree.length > 0
              ? buildAddToAlbumMenu(albumTree, finalSelection)
              : [{ label: 'No Albums Available', disabled: true }],
        },
        ...(activeAlbumId
          ? [
              {
                label: isSingleSelection ? 'Remove from Album' : `Remove ${selectionCount} Images from Album`,
                icon: Trash2,
                isDestructive: true,
                onClick: handleRemoveFromAlbum,
              },
            ]
          : []),
        { type: OPTION_SEPARATOR },
        {
          disabled: !isSingleSelection,
          icon: Folder,
          label: 'Show in File Explorer',
          onClick: () => {
            invoke(Invokes.ShowInFinder, { path: finalSelection[0] }).catch((err) =>
              toast.error(`Could not show file in explorer: ${err}`),
            );
          },
        },
        {
          label: resetLabel,
          icon: RotateCcw,
          submenu: [
            { label: 'Cancel', icon: X, onClick: () => {} },
            {
              label: 'Confirm Reset',
              icon: Check,
              isDestructive: true,
              onClick: () => handleResetAdjustments(finalSelection),
            },
          ],
        },
        {
          label: deleteLabel,
          icon: Trash2,
          isDestructive: true,
          submenu: deleteSubmenu,
        },
      ];
      showContextMenu(event.clientX, event.clientY, options);
    },
    [
      getCommonTags,
      buildAddToAlbumMenu,
      handleCopyAdjustments,
      handlePasteAdjustments,
      handleRate,
      handleSetColorLabel,
      handleTagsChanged,
      handleResetAdjustments,
      showContextMenu,
      props,
    ],
  );

  const handleFolderTreeContextMenu = useCallback(
    (event: any, path: string, isCurrentlyPinned?: boolean) => {
      event.preventDefault();
      event.stopPropagation();

      const { rootPaths, currentFolderPath, folderTrees, setLibrary } = useLibraryStore.getState();
      const { copiedFilePaths, setProcess } = useProcessStore.getState();
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { setUI } = useUIStore.getState();

      const targetPath = path || currentFolderPath || rootPaths?.[0];
      if (!targetPath) return;

      const isRoot = rootPaths.includes(targetPath);
      const numCopied = copiedFilePaths.length;
      const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
      const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

      const pinOption = isCurrentlyPinned
        ? { icon: PinOff, label: 'Unpin Folder', onClick: () => props.handleTogglePinFolder(targetPath) }
        : { icon: Pin, label: 'Pin Folder', onClick: () => props.handleTogglePinFolder(targetPath) };

      const options = [
        ...(isRoot
          ? [
              {
                icon: Trash2,
                label: 'Remove Root Folder',
                isDestructive: true,
                onClick: () => {
                  const newRoots = rootPaths.filter((r: string) => r !== targetPath);
                  const newFolderTrees = folderTrees.filter((t: any) => t.path !== targetPath);

                  const isCurrentInTarget =
                    currentFolderPath === targetPath ||
                    currentFolderPath?.startsWith(targetPath + '/') ||
                    currentFolderPath?.startsWith(targetPath + '\\');

                  const updates: any = {
                    rootPaths: newRoots,
                    folderTrees: newFolderTrees,
                  };

                  if (isCurrentInTarget) {
                    updates.currentFolderPath = null;
                    updates.imageList = [];
                    updates.libraryActivePath = null;
                    updates.multiSelectedPaths = [];
                    updates.selectionAnchorPath = null;
                    props.handleBackToLibrary();
                  }

                  setLibrary(updates);

                  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
                  if (appSettings) {
                    const newSettings = { ...appSettings, rootFolders: newRoots } as any;
                    if (newRoots.length === 0) {
                      newSettings.lastRootPath = null;
                      newSettings.lastFolderState = null;
                    } else if (newSettings.lastRootPath === targetPath) {
                      newSettings.lastRootPath = newRoots[0];
                    }

                    if (isCurrentInTarget) {
                      newSettings.lastFolderState = null;
                    }

                    handleSettingsChange(newSettings);
                  }
                },
              },
              { type: OPTION_SEPARATOR },
            ]
          : []),
        pinOption,
        { type: OPTION_SEPARATOR },
        {
          icon: FolderPlus,
          label: 'New Folder',
          onClick: () => {
            setUI({ folderActionTarget: targetPath, isCreateFolderModalOpen: true });
          },
        },
        {
          disabled: isRoot,
          icon: FileEdit,
          label: 'Rename Folder',
          onClick: () => {
            setUI({ folderActionTarget: targetPath, isRenameFolderModalOpen: true });
          },
        },
        {
          label: 'Change Icon',
          icon: Palette,
          submenu: ALBUM_ICONS.map((iconDef) => ({
            label: iconDef.label,
            icon: iconDef.icon,
            onClick: () => {
              if (appSettings) {
                const currentIcons = appSettings.folderIcons || {};
                const newIcons = { ...currentIcons };

                if (iconDef.value) {
                  newIcons[targetPath] = iconDef.value;
                } else {
                  delete newIcons[targetPath];
                }

                handleSettingsChange({ ...appSettings, folderIcons: newIcons });
              }
            },
          })),
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
                  if (targetPath === currentFolderPath) props.handleLibraryRefresh();
                } catch (err) {
                  toast.error(`Failed to copy files: ${err}`);
                }
              },
            },
            {
              label: movePastedLabel,
              onClick: async () => {
                try {
                  await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                  setProcess({ copiedFilePaths: [] });
                  setLibrary({ multiSelectedPaths: [] });
                  props.refreshAllFolderTrees();
                  props.handleLibraryRefresh();
                } catch (err) {
                  toast.error(`Failed to move files: ${err}`);
                }
              },
            },
          ],
        },
        { icon: FolderInput, label: 'Import Images', onClick: () => props.handleImportClick(targetPath) },
        { type: OPTION_SEPARATOR },
        {
          icon: Folder,
          label: 'Show in File Explorer',
          onClick: () =>
            invoke(Invokes.ShowInFinder, { path: targetPath }).catch((err) =>
              toast.error(`Could not show folder: ${err}`),
            ),
        },
        {
          icon: RefreshCw,
          label: 'Refresh Folders',
          onClick: () => props.refreshAllFolderTrees(),
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

                        const isCurrentInTarget =
                          currentFolderPath === targetPath ||
                          currentFolderPath?.startsWith(targetPath + '/') ||
                          currentFolderPath?.startsWith(targetPath + '\\');

                        if (isCurrentInTarget) {
                          props.handleBackToLibrary();
                          setLibrary({
                            currentFolderPath: null,
                            imageList: [],
                            libraryActivePath: null,
                            multiSelectedPaths: [],
                            selectionAnchorPath: null,
                          });

                          const { appSettings, handleSettingsChange } = useSettingsStore.getState();
                          if (appSettings) {
                            handleSettingsChange({ ...appSettings, lastFolderState: null } as any);
                          }
                        }

                        props.refreshAllFolderTrees();
                      } catch (err) {
                        toast.error(`Failed to delete folder: ${err}`);
                      }
                    },
                  },
                ],
              },
            ]
          : []),
      ];
      showContextMenu(event.clientX, event.clientY, options);
    },
    [props, showContextMenu],
  );

  const handleAlbumTreeContextMenu = useCallback(
    (event: any, item: AlbumItem | null) => {
      event.preventDefault();
      event.stopPropagation();

      const { setUI } = useUIStore.getState();
      const { albumTree, setLibrary } = useLibraryStore.getState();

      const findParentId = (
        nodes: AlbumItem[],
        childId: string,
        parentId: string | null = null,
      ): string | null | undefined => {
        for (const n of nodes) {
          if (n.id === childId) return parentId;
          if (n.type === 'group') {
            const found = findParentId((n as AlbumGroup).children, childId, n.id);
            if (found !== undefined) return found;
          }
        }
        return undefined;
      };

      const currentParentId = item ? findParentId(albumTree, item.id) : undefined;

      const handleMove = (targetId: string | null) => {
        if (!item) return;
        const newTree = structuredClone(albumTree);
        let extractedItem: AlbumItem | null = null;

        const removeAndGet = (nodes: AlbumItem[], id: string): AlbumItem | null => {
          for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].id === id) return nodes.splice(i, 1)[0];
            if (nodes[i].type === 'group') {
              const res = removeAndGet((nodes[i] as AlbumGroup).children, id);
              if (res) return res;
            }
          }
          return null;
        };

        extractedItem = removeAndGet(newTree, item.id);
        if (!extractedItem) return;

        if (!targetId) {
          newTree.push(extractedItem);
        } else {
          let inserted = false;

          const insert = (nodes: AlbumItem[]) => {
            for (const n of nodes) {
              if (n.id === targetId && n.type === 'group') {
                n.children.push(extractedItem!);
                inserted = true;
                return;
              } else if (n.type === 'group') {
                insert(n.children);
                if (inserted) return;
              }
            }
          };

          insert(newTree);

          if (!inserted) {
            toast.error('Failed to move: Target group not found or invalid.');
            return;
          }
        }

        invoke(Invokes.SaveAlbums, { tree: newTree })
          .then(() => invoke(Invokes.GetAlbums))
          .then((sortedTree: any) => setLibrary({ albumTree: sortedTree }))
          .catch((err) => toast.error(`Failed to move: ${err}`));
      };

      const buildMoveSubmenu = (nodes: AlbumItem[]): Option[] => {
        let opts: Option[] = [];
        nodes.forEach((n) => {
          if (n.type === 'group' && n.id !== item?.id) {
            const isCurrentParent = n.id === currentParentId;
            const subOpts = buildMoveSubmenu((n as AlbumGroup).children);

            const customIconDef = n.icon ? ALBUM_ICONS.find((i) => i.value === n.icon) : null;
            const ResolvedIcon = customIconDef?.icon || Folder;

            if (subOpts.length > 0) {
              opts.push({
                label: n.name,
                icon: ResolvedIcon,
                submenu: [
                  {
                    label: isCurrentParent ? 'Already Here' : 'Move Here',
                    icon: Check,
                    disabled: isCurrentParent,
                    onClick: isCurrentParent ? undefined : () => handleMove(n.id),
                  },
                  { type: OPTION_SEPARATOR },
                  ...subOpts,
                ],
              });
            } else {
              opts.push({
                label: isCurrentParent ? `${n.name} (Current)` : n.name,
                icon: ResolvedIcon,
                disabled: isCurrentParent,
                onClick: isCurrentParent ? undefined : () => handleMove(n.id),
              });
            }
          }
        });
        return opts;
      };

      const moveOptions = buildMoveSubmenu(albumTree);
      const isAtRoot = currentParentId === null;
      const isMoveDisabled = moveOptions.length === 0 && isAtRoot;

      const options: Option[] = [
        {
          label: 'New Album',
          icon: Images,
          onClick: () => setUI({ albumActionTarget: item?.id || null, isCreateAlbumModalOpen: true }),
        },
        {
          label: 'New Group',
          icon: FolderPlus,
          onClick: () => setUI({ albumActionTarget: item?.id || null, isCreateAlbumGroupModalOpen: true }),
        },
        ...(item
          ? [
              { type: OPTION_SEPARATOR },
              {
                label: 'Rename Album',
                icon: FileEdit,
                onClick: () => setUI({ albumActionTarget: item.id, isRenameAlbumModalOpen: true }),
              },
              {
                label: 'Change Icon',
                icon: Palette,
                submenu: ALBUM_ICONS.map((iconDef) => ({
                  label: iconDef.label,
                  icon: iconDef.icon,
                  onClick: () => {
                    const newTree = structuredClone(albumTree);
                    const updateIcon = (nodes: AlbumItem[]) => {
                      for (const n of nodes) {
                        if (n.id === item.id) {
                          n.icon = iconDef.value;
                          return true;
                        }
                        if (n.type === 'group' && updateIcon((n as AlbumGroup).children)) return true;
                      }
                      return false;
                    };

                    if (updateIcon(newTree)) {
                      invoke(Invokes.SaveAlbums, { tree: newTree })
                        .then(() => invoke(Invokes.GetAlbums))
                        .then((sorted: any) => setLibrary({ albumTree: sorted }))
                        .catch((err) => toast.error(`Failed to change icon: ${err}`));
                    }
                  },
                })),
              },
              {
                label: 'Move To...',
                icon: FolderInput,
                disabled: isMoveDisabled,
                submenu: isMoveDisabled
                  ? []
                  : [
                      {
                        label: isAtRoot ? 'Already at Root' : 'Root Directory',
                        icon: Home,
                        disabled: isAtRoot,
                        onClick: isAtRoot ? undefined : () => handleMove(null),
                      },
                      ...(moveOptions.length > 0 ? [{ type: OPTION_SEPARATOR }, ...moveOptions] : []),
                    ],
              },
              { type: OPTION_SEPARATOR },
              {
                label: item.type === 'group' ? 'Delete Group' : 'Delete Album',
                icon: Trash2,
                isDestructive: true,
                submenu: [
                  { label: 'Cancel', icon: X, onClick: () => {} },
                  {
                    label:
                      item.type === 'album'
                        ? 'Confirm Delete Album'
                        : (item as AlbumGroup).children.length > 0
                          ? 'Confirm Delete Group & All Nested Albums'
                          : 'Confirm Delete Album Group',
                    icon: Check,
                    isDestructive: true,
                    onClick: () => {
                      const newTree = structuredClone(albumTree);
                      const del = (nodes: AlbumItem[]) => {
                        const idx = nodes.findIndex((n) => n.id === item.id);
                        if (idx !== -1) nodes.splice(idx, 1);
                        else
                          nodes.forEach((n) => {
                            if (n.type === 'group') del((n as AlbumGroup).children);
                          });
                      };
                      del(newTree);
                      invoke(Invokes.SaveAlbums, { tree: newTree })
                        .then(() => invoke(Invokes.GetAlbums))
                        .then((sorted: any) => setLibrary({ albumTree: sorted }))
                        .catch((err) => toast.error(`Failed to delete: ${err}`));
                    },
                  },
                ],
              },
            ]
          : []),
      ];

      showContextMenu(event.clientX, event.clientY, options);
    },
    [showContextMenu],
  );

  const handleMainLibraryContextMenu = useCallback(
    (event: any) => {
      event.preventDefault();
      event.stopPropagation();

      const { copiedFilePaths, setProcess } = useProcessStore.getState();
      const { currentFolderPath, activeAlbumId, setLibrary } = useLibraryStore.getState();

      const numCopied = copiedFilePaths.length;
      const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
      const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;
      const addCopiedToAlbumLabel =
        numCopied === 1 ? 'Add copied image to album' : `Add ${numCopied} copied images to album`;

      const isAlbumView = !!activeAlbumId;

      const pasteOption = isAlbumView
        ? {
            label: addCopiedToAlbumLabel,
            icon: ClipboardPaste,
            disabled: copiedFilePaths.length === 0,
            onClick: async () => {
              try {
                await invoke(Invokes.AddToAlbum, { albumId: activeAlbumId, paths: copiedFilePaths });
                console.log(`Added ${numCopied} image(s) to album`);
                const updatedTree = await invoke<AlbumItem[]>(Invokes.GetAlbums);
                setLibrary({ albumTree: updatedTree });
                await props.refreshImageList();
              } catch (err) {
                toast.error(`Failed to add to album: ${err}`);
              }
            },
          }
        : {
            label: 'Paste',
            icon: ClipboardPaste,
            disabled: copiedFilePaths.length === 0,
            submenu: [
              {
                label: copyPastedLabel,
                onClick: async () => {
                  try {
                    await invoke(Invokes.CopyFiles, {
                      sourcePaths: copiedFilePaths,
                      destinationFolder: currentFolderPath,
                    });
                    props.handleLibraryRefresh();
                  } catch (err) {
                    toast.error(`Failed to copy files: ${err}`);
                  }
                },
              },
              {
                label: movePastedLabel,
                onClick: async () => {
                  try {
                    await invoke(Invokes.MoveFiles, {
                      sourcePaths: copiedFilePaths,
                      destinationFolder: currentFolderPath,
                    });
                    setProcess({ copiedFilePaths: [] });
                    setLibrary({ multiSelectedPaths: [] });
                    props.refreshAllFolderTrees();
                    props.handleLibraryRefresh();
                  } catch (err) {
                    toast.error(`Failed to move files: ${err}`);
                  }
                },
              },
            ],
          };

      const options = [
        { label: 'Refresh View', icon: RefreshCw, onClick: props.handleLibraryRefresh },
        { type: OPTION_SEPARATOR },
        pasteOption,
        {
          icon: FolderInput,
          label: 'Import Images',
          onClick: () => props.handleImportClick(currentFolderPath as string),
          disabled: !currentFolderPath || isAlbumView,
        },
      ];

      showContextMenu(event.clientX, event.clientY, options);
    },
    [props, showContextMenu],
  );

  return {
    handleEditorContextMenu,
    handleThumbnailContextMenu,
    handleFolderTreeContextMenu,
    handleAlbumTreeContextMenu,
    handleMainLibraryContextMenu,
  };
}
