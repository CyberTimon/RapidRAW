import { useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Aperture,
  Check,
  Eraser,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Edit,
  FileEdit,
  FileInput,
  Folder,
  FolderInput,
  FolderMinus,
  FolderPlus,
  Images,
  LayoutTemplate,
  LayersArrowDown,
  GalleryHorizontalEnd,
  Waves,
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
  Layers,
  Grip,
  Maximize2,
  Film,
  Clapperboard,
  ListPlus,
  Timer,
  Contrast,
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
  PencilSparkles,
  ScanLine,
  MonitorUp,
  AppWindow,
  Settings,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useTranslation } from 'react-i18next';
import { useContextMenu } from '../context/ContextMenuContext';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { JobKind, useProcessStore } from '../store/useProcessStore';
import { openMergeModal, useUIStore } from '../store/useUIStore';
import {
  MenuEntry,
  addToProjectFile,
  canCreateFrom,
  editHistory,
  editorMenu,
  followProjectDelete,
  isPhotoFile,
  isProjectPath,
  isVideoPath,
  mediaMenu,
  newVideoProject,
  newVideoProjectFrom,
  openTimelapseDialog,
  projectsToAddTo,
  timelapsePhotos,
  videoKind,
} from '../store/videoIntegration';
import { exportVideoFrame } from '../store/videoExport';
import { useSettingsStore } from '../store/useSettingsStore';
import { getOpenImageDefaults, hasCustomDefaults, openImageHasCustomDefaults } from '../utils/developDefaults';
import { Invokes } from '../types/invokes';
import { ImageFlag, AlbumItem, Album, AlbumGroup, MAX_BURST_FRAMES } from '../types/library';
import { Option, OPTION_SEPARATOR, Panel } from '../types/ui';
import { EditInApp } from '../types/settings';
import { colorLabelMenu, flagMenu, ratingMenu } from '../utils/metadataMenus';
import {
  AutoAdjustMode,
  getAiDenoiseEnablePatch,
  INITIAL_ADJUSTMENTS,
  isLensCorrectionActive,
  LENS_CORRECTION_AUTO,
  LENS_CORRECTION_OFF,
} from '../utils/adjustments';
import TaggingSubMenu from '../components/panel/library/TaggingSubMenu';
import {
  adjustmentsCopySource,
  buildAutoAdjustModeOptions,
  debouncedSave,
  reloadAdjustmentsForPaths,
  useEditorActions,
} from './useEditorActions';
import { useLibraryActions } from './useLibraryActions';
import { transferFiles } from './useFileOperations';
import { globalImageCache } from '../utils/ImageLRUCache';
import { immichAlbumOf, isImmichAlbumId, isImmichPath, removeFromImmichAlbum } from '../utils/immichApi';
import { useImmichStore } from '../store/useImmichStore';
import type { ParseKeys, TFunction } from 'i18next';

const FILE_LABELS = {
  copy: [
    'contextMenus.thumbnail.copyImage',
    'contextMenus.videos.copy',
    'contextMenus.files.copy',
    'contextMenus.projects.copy',
  ],
  rename: [
    'contextMenus.thumbnail.renameImage',
    'contextMenus.videos.rename',
    'contextMenus.thumbnail.renameFile',
    'contextMenus.projects.rename',
  ],
  delete: [
    'contextMenus.thumbnail.deleteImage',
    'contextMenus.videos.delete',
    'contextMenus.files.delete',
    'contextMenus.projects.delete',
  ],
  export: ['contextMenus.thumbnail.exportImage', 'contextMenus.videos.export', 'contextMenus.files.export'],
  pasteAdjustments: [
    'contextMenus.thumbnail.pasteAdjustments',
    'contextMenus.videos.pasteAdjustments',
    'contextMenus.files.pasteAdjustments',
  ],
  resetAdjustments: [
    'contextMenus.thumbnail.resetAdjustments',
    'contextMenus.videos.resetAdjustments',
    'contextMenus.files.resetAdjustments',
  ],
  removeFromAlbum: [
    'contextMenus.thumbnail.removeFromAlbum',
    'contextMenus.videos.removeFromAlbum',
    'contextMenus.files.removeFromAlbum',
  ],
  copyHere: ['contextMenus.folders.copyHere', 'contextMenus.videos.copyHere', 'contextMenus.files.copyHere'],
  moveHere: ['contextMenus.folders.moveHere', 'contextMenus.videos.moveHere', 'contextMenus.files.moveHere'],
  addCopiedToAlbum: [
    'contextMenus.library.addCopiedToAlbum',
    'contextMenus.videos.addCopiedToAlbum',
    'contextMenus.files.addCopiedToAlbum',
  ],
} as const satisfies Record<string, readonly [ParseKeys, ParseKeys, ParseKeys, ParseKeys?]>;

const fileLabel = (t: TFunction, label: keyof typeof FILE_LABELS, paths: Array<string>) => {
  const [photo, video, file, project = file] = FILE_LABELS[label];
  const key = paths.every(isPhotoFile)
    ? photo
    : paths.every(isVideoPath)
      ? video
      : paths.every(isProjectPath)
        ? project
        : file;
  return t(key, { count: paths.length });
};

export interface UseAppContextMenusProps {
  handleImageSelect: (path: string) => void;
  handleBackToLibrary: () => void;
  handleRenameFiles: (paths: string[]) => void;
  handleImportClick: (path: string) => void;
  handleLibraryRefresh: () => Promise<void>;
  refreshAllFolderTrees: () => Promise<void>;
  refreshImageList: () => Promise<void>;
  executeDelete: (paths: string[], options: any) => Promise<void>;
  handleDeleteRejected: () => void;
  handleTogglePinFolder: (path: string) => Promise<void>;
}

export function useAppContextMenus(latestProps: UseAppContextMenusProps) {
  const propsRef = useRef(latestProps);
  propsRef.current = latestProps;
  const props = useMemo<UseAppContextMenusProps>(
    () => ({
      handleImageSelect: (path) => propsRef.current.handleImageSelect(path),
      handleBackToLibrary: () => propsRef.current.handleBackToLibrary(),
      handleRenameFiles: (paths) => propsRef.current.handleRenameFiles(paths),
      handleImportClick: (path) => propsRef.current.handleImportClick(path),
      handleLibraryRefresh: () => propsRef.current.handleLibraryRefresh(),
      refreshAllFolderTrees: () => propsRef.current.refreshAllFolderTrees(),
      refreshImageList: () => propsRef.current.refreshImageList(),
      executeDelete: (paths, options) => propsRef.current.executeDelete(paths, options),
      handleDeleteRejected: () => propsRef.current.handleDeleteRejected(),
      handleTogglePinFolder: (path) => propsRef.current.handleTogglePinFolder(path),
    }),
    [],
  );
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();

  const {
    handleAutoAdjustments,
    handleAutoLensCorrection,
    handleAutoStraighten,
    handleAutoStraightenPaths,
    handleEnableAdjustments,
    handleResetAdjustments,
    handleCopyAdjustments,
    handlePasteAdjustments,
  } = useEditorActions();
  const { handleRate, handleSetFlag, handleSetColorLabel, handleTagsChanged } = useLibraryActions();

  const buildFlagMenu = useCallback(
    (paths?: string[], keys = true) => flagMenu(t, (flag) => handleSetFlag(flag, paths), keys),
    [handleSetFlag, t],
  );

  const buildRatingMenu = useCallback(
    (paths?: string[], keys = true) => ratingMenu(t, (rating) => handleRate(rating, paths), keys),
    [handleRate, t],
  );

  const buildColorLabelMenu = useCallback(
    (paths?: string[], keys = true) => colorLabelMenu(t, (color) => handleSetColorLabel(color, paths), keys),
    [handleSetColorLabel, t],
  );

  const albumIcons = useMemo(
    () => [
      { label: t('contextMenus.albumIcons.default'), value: undefined, icon: Folder },
      { label: t('contextMenus.albumIcons.travel'), value: 'plane', icon: Plane },
      { label: t('contextMenus.albumIcons.nature'), value: 'mountain', icon: Mountain },
      { label: t('contextMenus.albumIcons.summer'), value: 'sun', icon: Sun },
      { label: t('contextMenus.albumIcons.photography'), value: 'camera', icon: Camera },
      { label: t('contextMenus.albumIcons.locations'), value: 'map', icon: Map },
      { label: t('contextMenus.albumIcons.favorites'), value: 'heart', icon: Heart },
      { label: t('contextMenus.albumIcons.featured'), value: 'star', icon: Star },
      { label: t('contextMenus.albumIcons.people'), value: 'users', icon: Users },
      { label: t('contextMenus.albumIcons.person'), value: 'user', icon: User },
      { label: t('contextMenus.albumIcons.automotive'), value: 'car', icon: Car },
      { label: t('contextMenus.albumIcons.portfolio'), value: 'briefcase', icon: Briefcase },
    ],
    [t],
  );

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

  const buildAddToAlbumMenu = useCallback(
    (items: AlbumItem[], pathsToAdd: string[]): Option[] => {
      return items.map((item) => {
        const customIconDef = item.icon ? albumIcons.find((i) => i.value === item.icon) : null;
        const ResolvedIcon = customIconDef?.icon || (item.type === 'group' ? Folder : AlbumIcon);

        if (item.type === 'group') {
          return {
            label: item.name,
            icon: ResolvedIcon,
            submenu:
              (item as AlbumGroup).children.length > 0
                ? buildAddToAlbumMenu((item as AlbumGroup).children, pathsToAdd)
                : [{ label: t('contextMenus.album.emptyGroup'), disabled: true }],
          };
        } else {
          return {
            label: item.name,
            icon: ResolvedIcon,
            onClick: () => {
              invoke(Invokes.AddToAlbum, { albumId: item.id, paths: pathsToAdd })
                .then(() => {
                  console.log(`Added image(s) to ${item.name}`);
                  invoke(Invokes.GetAlbums).then((res: any) =>
                    useLibraryStore.getState().setLibrary({ albumTree: res }),
                  );
                })
                .catch((err) => toast.error(t('contextMenus.toasts.failedAddToAlbum', { err })));
            },
          };
        }
      });
    },
    [albumIcons, t],
  );

  const handleEditInApp = useCallback(
    async (path: string, app: EditInApp) => {
      const { selectedImage, adjustments } = useEditorStore.getState();
      const sessionId = crypto.randomUUID();
      let running = true;
      let cancelled = false;
      debouncedSave.flush();
      const toastId = toast.info(t('contextMenus.toasts.editInWaiting', { app: app.name }), {
        autoClose: false,
        closeOnClick: false,
        onClose: () => {
          if (!running) return;
          cancelled = true;
          invoke(Invokes.CancelEditInApp, { sessionId });
        },
      });
      try {
        const newPath = await invoke<string | null>(Invokes.EditInApp, {
          path,
          app,
          sessionId,
          currentEditAdjustments: selectedImage?.path === path ? adjustments : null,
        });
        running = false;
        toast.dismiss(toastId);
        await props.refreshImageList();
        if (newPath) {
          props.handleImageSelect(newPath);
        } else if (!cancelled) {
          toast.info(t('contextMenus.toasts.editInNoOutput', { app: app.name }));
        }
      } catch (err) {
        running = false;
        toast.dismiss(toastId);
        await props.refreshImageList();
        toast.error(t('contextMenus.toasts.editInFailed', { app: app.name, err }));
      }
    },
    [props, t],
  );

  const buildEditInOptions = useCallback(
    (path: string): Array<MenuEntry> => {
      const apps = useSettingsStore.getState().appSettings?.editInApps ?? [];
      if (apps.length === 0) return [];
      return [
        {
          photoOnly: true,
          label: t('contextMenus.editor.editIn'),
          icon: AppWindow,
          submenu: apps.map((app) => ({ label: app.name, onClick: () => handleEditInApp(path, app) })),
        },
      ];
    },
    [handleEditInApp, t],
  );

  const handleEditorContextMenu = useCallback(
    (event: any) => {
      event.preventDefault();
      event.stopPropagation();

      const { selectedImage, adjustments, resetHistory, copiedAdjustments, setEditor } = useEditorStore.getState();
      const { appSettings, osPlatform } = useSettingsStore.getState();
      const { setPanel, setUI, isViewerOpen, toggleViewerWindow } = useUIStore.getState();

      if (!selectedImage) return;

      const history = editHistory();
      const commonTags = getCommonTags([selectedImage.path]);

      const options: Array<MenuEntry> = [
        {
          label: videoKind() === 'none' ? t('contextMenus.editor.exportImage') : t('video.export.button'),
          icon: FileInput,
          onClick: () => setPanel(Panel.Export),
          shortcut: 'toggle_export',
        },
        {
          videoOnly: true,
          label: t('video.frame.export'),
          icon: Camera,
          onClick: () => void exportVideoFrame(),
          shortcut: 'video_export_frame',
        },
        ...buildEditInOptions(selectedImage.path),
        ...(osPlatform !== 'android'
          ? [
              {
                label: isViewerOpen ? t('contextMenus.editor.closeViewer') : t('contextMenus.editor.openViewer'),
                icon: MonitorUp,
                onClick: toggleViewerWindow,
                shortcut: 'toggle_viewer_window',
              },
            ]
          : []),
        { type: OPTION_SEPARATOR },
        {
          label: t('contextMenus.editor.undo'),
          icon: Undo,
          onClick: history.undo,
          disabled: !history.canUndo,
          shortcut: ['video_undo', 'undo'],
        },
        {
          label: t('contextMenus.editor.redo'),
          icon: Redo,
          onClick: history.redo,
          disabled: !history.canRedo,
          shortcut: ['video_redo', 'redo'],
        },
        { type: OPTION_SEPARATOR },
        {
          needsLook: true,
          label: t('contextMenus.editor.copyAdjustments'),
          icon: Copy,
          onClick: () => handleCopyAdjustments(),
          shortcut: ['video_copy_adjustments', 'copy_adjustments'],
        },
        {
          needsLook: true,
          label: t('contextMenus.editor.pasteAdjustments'),
          icon: ClipboardPaste,
          onClick: () => handlePasteAdjustments(),
          disabled: copiedAdjustments === null,
          shortcut: 'paste_adjustments',
        },
        {
          needsLook: true,
          videoOnly: true,
          label: t('contextMenus.editor.copyPasteSettings'),
          icon: Settings,
          onClick: () => setUI({ isCopyPasteSettingsModalOpen: true }),
        },
        {
          needsLook: true,
          label: t('contextMenus.editor.productivity'),
          icon: Gauge,
          submenu: [
            {
              label: t('contextMenus.editor.autoAdjust'),
              icon: PencilSparkles,
              disabled: !selectedImage?.isReady,
              submenu: buildAutoAdjustModeOptions(t, handleAutoAdjustments),
            },
            {
              photoOnly: true,
              label: t('contextMenus.editor.autoStraighten'),
              icon: ScanLine,
              onClick: handleAutoStraighten,
              disabled: !selectedImage?.isReady,
              shortcut: 'auto_straighten',
            },
            { type: OPTION_SEPARATOR },
            {
              photoOnly: true,
              label: isLensCorrectionActive(adjustments)
                ? t('contextMenus.editor.removeLensCorrection')
                : t('contextMenus.editor.lensCorrection'),
              icon: Aperture,
              onClick: () =>
                handleEnableAdjustments(
                  [selectedImage.path],
                  isLensCorrectionActive(adjustments) ? LENS_CORRECTION_OFF : LENS_CORRECTION_AUTO,
                ),
              disabled: !selectedImage?.isReady,
            },
            {
              photoOnly: true,
              label: adjustments.aiDenoiseEnabled
                ? t('contextMenus.editor.removeDenoise')
                : t('contextMenus.editor.denoise'),
              icon: Grip,
              onClick: () =>
                handleEnableAdjustments(
                  [selectedImage.path],
                  adjustments.aiDenoiseEnabled
                    ? { aiDenoiseEnabled: false }
                    : getAiDenoiseEnablePatch(useSettingsStore.getState().appSettings?.aiProvider),
                ),
              disabled: !selectedImage?.isReady,
            },
            ...(useSettingsStore.getState().appSettings?.aiProvider === 'ai-free'
              ? []
              : [
                  {
                    photoOnly: true,
                    label: adjustments.aiUpscaleEnabled
                      ? t('contextMenus.editor.removeSuperResolution')
                      : t('contextMenus.editor.superResolution'),
                    icon: Maximize2,
                    onClick: () =>
                      handleEnableAdjustments([selectedImage.path], {
                        aiUpscaleEnabled: !adjustments.aiUpscaleEnabled,
                      }),
                    disabled: !selectedImage?.isReady,
                  },
                ]),
            {
              label: adjustments.monochromeEnabled
                ? t('contextMenus.editor.removeBlackWhite')
                : t('contextMenus.editor.convertBlackWhite'),
              icon: Contrast,
              onClick: () =>
                handleEnableAdjustments([selectedImage.path], {
                  monochromeEnabled: !adjustments.monochromeEnabled,
                }),
              disabled: !selectedImage?.isReady,
              shortcut: 'toggle_black_white',
            },
            {
              photoOnly: true,
              label: adjustments.negativeConversionEnabled
                ? t('contextMenus.editor.removeNegativeConversion')
                : t('contextMenus.editor.convertNegative'),
              icon: Film,
              onClick: () =>
                handleEnableAdjustments([selectedImage.path], {
                  negativeConversionEnabled: !adjustments.negativeConversionEnabled,
                }),
              disabled: !selectedImage?.isReady,
            },
          ],
        },
        {
          photoOnly: true,
          icon: LayoutTemplate,
          label: t('contextMenus.editor.frameImage'),
          onClick: () => {
            setUI({ collageModalState: { isOpen: true, sourceImages: [selectedImage] } });
          },
        },
        { libraryOnly: true, type: OPTION_SEPARATOR },
        { libraryOnly: true, ...buildRatingMenu() },
        { libraryOnly: true, ...buildFlagMenu() },
        { libraryOnly: true, ...buildColorLabelMenu() },
        {
          libraryOnly: true,
          label: t('contextMenus.editor.tagging'),
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
          needsLook: true,
          label: t('contextMenus.editor.resetAdjustments'),
          icon: RotateCcw,
          submenu: [
            { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
            {
              label: openImageHasCustomDefaults()
                ? t('contextMenus.editor.resetToDefaults')
                : t('contextMenus.editor.confirmReset'),
              icon: Check,
              isDestructive: true,
              onClick: async () => {
                const resetData = { ...(await getOpenImageDefaults()), aiPatches: [] };
                resetHistory(resetData);
                setEditor({ adjustments: resetData });
              },
            },
            ...(openImageHasCustomDefaults()
              ? [
                  {
                    label: t('contextMenus.editor.resetToNeutral'),
                    icon: Eraser,
                    isDestructive: true,
                    onClick: () => {
                      const resetData = { ...structuredClone(INITIAL_ADJUSTMENTS), aiPatches: [] };
                      resetHistory(resetData);
                      setEditor({ adjustments: resetData });
                    },
                  },
                ]
              : []),
          ],
        },
      ];
      showContextMenu(event.clientX, event.clientY, editorMenu(options));
    },
    [
      getCommonTags,
      handleCopyAdjustments,
      handlePasteAdjustments,
      handleAutoAdjustments,
      buildRatingMenu,
      buildFlagMenu,
      buildColorLabelMenu,
      handleTagsChanged,
      buildEditInOptions,
      showContextMenu,
      t,
    ],
  );

  const handleThumbnailContextMenu = useCallback(
    (event: any, path: string, forceSingleSelection: boolean = false) => {
      event.preventDefault();
      event.stopPropagation();

      const { selectedImage, copiedAdjustments } = useEditorStore.getState();
      const { multiSelectedPaths, imageList, albumTree, activeAlbumId, currentFolderPath, setLibrary } =
        useLibraryStore.getState();
      const { appSettings } = useSettingsStore.getState();
      const { activeView, setUI, setPanel } = useUIStore.getState();
      const { setProcess } = useProcessStore.getState();

      const isTargetInSelection = multiSelectedPaths.includes(path);
      let finalSelection: string[];

      if (forceSingleSelection) {
        finalSelection = [path];
      } else if (!isTargetInSelection) {
        finalSelection = [path];
        setLibrary({ multiSelectedPaths: [path] });
        if (!selectedImage) {
          setLibrary({ libraryActivePath: path });
        }
      } else {
        finalSelection = multiSelectedPaths;
      }

      const copyLabel = fileLabel(t, 'copy', finalSelection);
      const renameLabel = fileLabel(t, 'rename', finalSelection);
      const deleteLabel = fileLabel(t, 'delete', finalSelection);
      const inLibrary = activeView === 'library';
      const keySelection = useLibraryStore.getState().multiSelectedPaths;
      const keysActOnSelection =
        keySelection.length === finalSelection.length && finalSelection.every((p) => keySelection.includes(p));
      const openShortcut =
        inLibrary && useLibraryStore.getState().libraryActivePath === path ? ('open_image' as const) : undefined;

      if (finalSelection.some(isProjectPath)) {
        const single = finalSelection.length === 1;
        showContextMenu(event.clientX, event.clientY, [
          {
            disabled: !single,
            icon: Clapperboard,
            label: t('contextMenus.thumbnail.openVideoProject'),
            onClick: () => props.handleImageSelect(finalSelection[0]),
            shortcut: openShortcut,
          },
          { type: OPTION_SEPARATOR },
          {
            label: copyLabel,
            icon: Copy,
            onClick: () => setProcess({ copiedFilePaths: finalSelection, isCopied: true }),
            shortcut: keysActOnSelection ? 'copy_files' : undefined,
          },
          { icon: FileEdit, label: renameLabel, onClick: () => props.handleRenameFiles(finalSelection) },
          { type: OPTION_SEPARATOR },
          {
            disabled: !single,
            icon: Folder,
            label: t('contextMenus.thumbnail.showExplorer'),
            onClick: () => {
              invoke(Invokes.ShowInFinder, { path: finalSelection[0] }).catch((err) =>
                toast.error(t('contextMenus.toasts.couldNotShowExplorer', { err })),
              );
            },
          },
          {
            label: deleteLabel,
            icon: Trash2,
            isDestructive: true,
            submenu: [
              { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
              {
                label: t('contextMenus.thumbnail.confirmDelete'),
                icon: Check,
                isDestructive: true,
                onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
              },
            ],
          },
        ]);
        return;
      }

      const commonTags = getCommonTags(finalSelection);

      const selectionCount = finalSelection.length;
      const isSingleSelection = selectionCount === 1;
      const isEditingThisImage = activeView === 'editor' && selectedImage?.path === path;
      const exportLabel = fileLabel(t, 'export', finalSelection);

      const selectionHasVirtualCopies =
        isSingleSelection &&
        !finalSelection[0].includes('?vc=') &&
        imageList.some((image) => image.path.startsWith(`${finalSelection[0]}?vc=`));

      const hasAssociatedFiles = finalSelection.some((selectedPath) => {
        const image = imageList.find((img) => img.path === selectedPath);
        if (image?.group_id != null) return true;

        const getBasePath = (p: string) => {
          const qMark = p.indexOf('?');
          const clean = qMark === -1 ? p : p.substring(0, qMark);
          const dot = clean.lastIndexOf('.');
          return dot === -1 ? clean : clean.substring(0, dot);
        };
        const basePath = getBasePath(selectedPath);

        return imageList.some((img) => img.path !== selectedPath && getBasePath(img.path) === basePath);
      });

      let deleteSubmenu;
      if (selectionHasVirtualCopies) {
        deleteSubmenu = [
          { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
          {
            label: t('contextMenus.thumbnail.confirmDeleteVc'),
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
        ];
      } else if (hasAssociatedFiles) {
        deleteSubmenu = [
          { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
          {
            label: t('contextMenus.thumbnail.deleteSelected'),
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
          {
            label: t('contextMenus.thumbnail.deleteAssociated'),
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: true }),
          },
        ];
      } else {
        deleteSubmenu = [
          { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
          {
            label: t('contextMenus.thumbnail.confirmDelete'),
            icon: Check,
            isDestructive: true,
            onClick: () => props.executeDelete(finalSelection, { includeAssociated: false }),
          },
        ];
      }

      const pasteLabel = fileLabel(t, 'pasteAdjustments', finalSelection);
      const resetLabel = fileLabel(t, 'resetAdjustments', finalSelection);
      const autoAdjustLabel = t('contextMenus.thumbnail.autoAdjust', { count: selectionCount });
      const cullLabel = t('contextMenus.thumbnail.cullImage', { count: selectionCount });
      const collageLabel = t('contextMenus.thumbnail.collage', { count: selectionCount });
      const stitchLabel = t('contextMenus.editor.stitchPanorama');
      const denoiseLabel = t('contextMenus.thumbnail.denoise', { count: selectionCount });
      const superResolutionLabel = t('contextMenus.thumbnail.superResolution', { count: selectionCount });
      const mergeLabel = t('contextMenus.editor.mergeHdr');

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
          toast.error(t('contextMenus.toasts.failedCreateVirtualCopy', { err }));
        }
      };

      const handleApplyAutoAdjustmentsToSelection = (mode: AutoAdjustMode) => {
        const editingPath = activeView === 'editor' ? selectedImage?.path : undefined;
        const batchPaths = finalSelection.filter((p) => p !== editingPath);
        if (batchPaths.length < finalSelection.length) {
          handleAutoAdjustments(mode);
        }
        if (batchPaths.length === 0) return;
        batchPaths.forEach((p) => globalImageCache.delete(p));

        invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths: batchPaths, mode })
          .then(() => reloadAdjustmentsForPaths(batchPaths))
          .catch((err) => {
            console.error('Failed to apply auto adjustments to paths:', err);
            toast.error(t('contextMenus.toasts.failedApplyAuto', { err }));
          });
      };

      const onExportClick = () => {
        setLibrary({ multiSelectedPaths: finalSelection });
        if (activeView === 'editor' && selectedImage && selectedImage.path !== path) {
          props.handleImageSelect(path);
        }
        setPanel(Panel.Export);
      };

      const handleRemoveFromAlbum = async () => {
        if (!activeAlbumId) return;
        const immichAlbum = immichAlbumOf(activeAlbumId);
        if (immichAlbum) {
          try {
            await removeFromImmichAlbum(immichAlbum, finalSelection);
            const removed = new Set(finalSelection.filter((p) => !p.includes('?vc=')));
            if (useLibraryStore.getState().activeAlbumId === activeAlbumId) {
              setLibrary((state) => ({
                imageList: state.imageList.filter((i) => !removed.has(i.path.split('?vc=')[0])),
              }));
            }
            useImmichStore.getState().loadAlbums();
          } catch (e) {
            toast.error(String(e));
          }
          return;
        }
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
            toast.error(t('contextMenus.toasts.failedRemoveImages', { err: e }));
          }
        }
      };

      const exportOption = {
        icon: FileInput,
        label: exportLabel,
        onClick: onExportClick,
        shortcut: keysActOnSelection && (inLibrary || isEditingThisImage) ? 'toggle_export' : undefined,
      };
      const newProjectOption = {
        icon: Clapperboard,
        label: t('contextMenus.library.newVideoProject'),
        disabled: !canCreateFrom(finalSelection),
        shortcut: keysActOnSelection && inLibrary ? 'new_video_project' : undefined,
        onClick: () => newVideoProjectFrom(finalSelection),
      };
      const addToProjects = projectsToAddTo().map((recent) => ({
        icon: ListPlus,
        label: t('contextMenus.thumbnail.addToNamedProject', { name: recent.name }),
        onClick: () => void addToProjectFile(recent.path, finalSelection),
      }));
      const options = [
        ...(!isEditingThisImage
          ? [
              {
                disabled: !isSingleSelection,
                icon: Edit,
                label: isVideoPath(path) ? t('contextMenus.videos.edit') : t('contextMenus.editor.editImage'),
                onClick: () => props.handleImageSelect(finalSelection[0]),
                shortcut: openShortcut,
              },
              exportOption,
            ]
          : [exportOption]),
        ...(isSingleSelection ? buildEditInOptions(finalSelection[0]) : []),
        { type: OPTION_SEPARATOR },
        {
          icon: Copy,
          label: t('contextMenus.editor.copyAdjustments'),
          onClick: () => handleCopyAdjustments(path),
          shortcut: adjustmentsCopySource() === path ? 'copy_adjustments' : undefined,
        },
        {
          disabled: copiedAdjustments === null,
          icon: ClipboardPaste,
          label: pasteLabel,
          onClick: () => handlePasteAdjustments(finalSelection),
          shortcut: keysActOnSelection ? 'paste_adjustments' : undefined,
        },
        {
          label: t('contextMenus.editor.productivity'),
          icon: Gauge,
          submenu: [
            {
              label: autoAdjustLabel,
              icon: PencilSparkles,
              submenu: buildAutoAdjustModeOptions(t, handleApplyAutoAdjustmentsToSelection),
            },
            {
              photoOnly: true,
              label: t('contextMenus.thumbnail.autoStraighten', { count: selectionCount }),
              icon: ScanLine,
              onClick: () => handleAutoStraightenPaths(finalSelection),
            },
            {
              photoOnly: true,
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
            { type: OPTION_SEPARATOR },
            {
              photoOnly: true,
              label: t('contextMenus.thumbnail.lensCorrection', { count: selectionCount }),
              icon: Aperture,
              disabled: selectionCount === 0,
              submenu: [
                {
                  label: t('contextMenus.thumbnail.enable'),
                  icon: Check,
                  onClick: () => handleAutoLensCorrection(finalSelection),
                },
                {
                  label: t('contextMenus.thumbnail.remove'),
                  icon: X,
                  onClick: () => handleEnableAdjustments(finalSelection, LENS_CORRECTION_OFF),
                },
              ],
            },
            {
              photoOnly: true,
              label: denoiseLabel,
              icon: Grip,
              disabled: finalSelection.length === 0,
              submenu: [
                {
                  label: t('contextMenus.thumbnail.enable'),
                  icon: Check,
                  onClick: () =>
                    handleEnableAdjustments(
                      finalSelection,
                      getAiDenoiseEnablePatch(useSettingsStore.getState().appSettings?.aiProvider),
                    ),
                },
                {
                  label: t('contextMenus.thumbnail.remove'),
                  icon: X,
                  onClick: () => handleEnableAdjustments(finalSelection, { aiDenoiseEnabled: false }),
                },
              ],
            },
            ...(useSettingsStore.getState().appSettings?.aiProvider === 'ai-free'
              ? []
              : [
                  {
                    photoOnly: true,
                    label: superResolutionLabel,
                    icon: Maximize2,
                    disabled: finalSelection.length === 0,
                    submenu: [
                      {
                        label: t('contextMenus.thumbnail.enable'),
                        icon: Check,
                        onClick: () => handleEnableAdjustments(finalSelection, { aiUpscaleEnabled: true }),
                      },
                      {
                        label: t('contextMenus.thumbnail.remove'),
                        icon: X,
                        onClick: () => handleEnableAdjustments(finalSelection, { aiUpscaleEnabled: false }),
                      },
                    ],
                  },
                ]),
            {
              label: t('contextMenus.editor.convertBlackWhite'),
              icon: Contrast,
              disabled: selectionCount === 0,
              submenu: [
                {
                  label: t('contextMenus.thumbnail.enable'),
                  icon: Check,
                  onClick: () => handleEnableAdjustments(finalSelection, { monochromeEnabled: true }),
                },
                {
                  label: t('contextMenus.thumbnail.remove'),
                  icon: X,
                  onClick: () => handleEnableAdjustments(finalSelection, { monochromeEnabled: false }),
                },
              ],
            },
            {
              photoOnly: true,
              label: t('contextMenus.editor.convertNegative'),
              icon: Film,
              disabled: selectionCount === 0,
              submenu: [
                {
                  label: t('contextMenus.thumbnail.enable'),
                  icon: Check,
                  onClick: () => handleEnableAdjustments(finalSelection, { negativeConversionEnabled: true }),
                },
                {
                  label: t('contextMenus.thumbnail.remove'),
                  icon: X,
                  onClick: () => handleEnableAdjustments(finalSelection, { negativeConversionEnabled: false }),
                },
              ],
            },
          ],
        },
        {
          photoOnly: true,
          label: t('contextMenus.merge.title'),
          icon: LayersArrowDown,
          submenu: [
            {
              disabled: selectionCount < 2 || selectionCount > 30,
              icon: SquaresUnite,
              label: stitchLabel,
              onClick: () => openMergeModal('panorama', finalSelection),
            },
            {
              disabled: selectionCount < 2 || selectionCount > 9,
              icon: Images,
              label: mergeLabel,
              onClick: () => openMergeModal('hdr', finalSelection),
            },
            {
              disabled: selectionCount < 2,
              icon: Layers,
              label: t('contextMenus.merge.focusStack'),
              onClick: () => openMergeModal('focusStack', finalSelection),
            },
            {
              disabled: selectionCount < 2 || selectionCount > MAX_BURST_FRAMES,
              icon: GalleryHorizontalEnd,
              label: t('contextMenus.merge.burstDenoise'),
              onClick: () => openMergeModal('burstDenoise', finalSelection),
            },
            {
              disabled: selectionCount < 2 || selectionCount > MAX_BURST_FRAMES,
              icon: Waves,
              label: t('contextMenus.merge.longExposure'),
              onClick: () => openMergeModal('longExposure', finalSelection),
            },
            { type: OPTION_SEPARATOR },
            {
              icon: LayoutTemplate,
              label: collageLabel,
              onClick: () => {
                const imagesForCollage = imageList.filter((img) => finalSelection.includes(img.path));
                setUI({ collageModalState: { isOpen: true, sourceImages: imagesForCollage } });
              },
              disabled: selectionCount === 0 || selectionCount > 9,
            },
          ],
        },
        addToProjects.length > 0 || finalSelection.some(isPhotoFile)
          ? {
              label: t('contextMenus.thumbnail.videoProject'),
              icon: Clapperboard,
              submenu: [
                newProjectOption,
                {
                  photoOnly: true,
                  icon: Timer,
                  label: t('video.timelapse.create'),
                  disabled: timelapsePhotos(finalSelection).length < 2,
                  onClick: () => openTimelapseDialog(finalSelection),
                },
                { type: OPTION_SEPARATOR },
                ...addToProjects,
              ],
            }
          : newProjectOption,
        { type: OPTION_SEPARATOR },
        {
          label: copyLabel,
          icon: Copy,
          onClick: () => {
            setProcess({ copiedFilePaths: finalSelection, isCopied: true });
          },
          shortcut: keysActOnSelection ? 'copy_files' : undefined,
        },
        {
          icon: CopyPlus,
          label: isVideoPath(path) ? t('contextMenus.videos.duplicate') : t('contextMenus.thumbnail.duplicateImage'),
          submenu: [
            {
              label: t('contextMenus.thumbnail.virtualCopy'),
              icon: CopyPlus,
              disabled: !isSingleSelection,
              onClick: () => handleCreateVirtualCopy(finalSelection[0]),
            },
            {
              label: t('contextMenus.thumbnail.physicalCopy'),
              icon: Copy,
              disabled: !isSingleSelection,
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
                  toast.error(t('contextMenus.toasts.failedDuplicate', { err }));
                }
              },
            },
          ],
        },
        { icon: FileEdit, label: renameLabel, onClick: () => props.handleRenameFiles(finalSelection) },
        { type: OPTION_SEPARATOR },
        buildRatingMenu(finalSelection, keysActOnSelection),
        buildFlagMenu(finalSelection, keysActOnSelection),
        buildColorLabelMenu(finalSelection, keysActOnSelection),
        {
          label: t('contextMenus.editor.tagging'),
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
        ...(isImmichAlbumId(activeAlbumId)
          ? []
          : [
              {
                label: t('contextMenus.thumbnail.addToAlbum'),
                icon: FolderPlus,
                submenu:
                  albumTree.length > 0
                    ? buildAddToAlbumMenu(albumTree, finalSelection)
                    : [{ label: t('contextMenus.thumbnail.noAlbums'), disabled: true }],
              },
            ]),
        ...(activeAlbumId && (!isImmichAlbumId(activeAlbumId) || immichAlbumOf(activeAlbumId))
          ? [
              {
                label: fileLabel(t, 'removeFromAlbum', finalSelection),
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
          label: t('contextMenus.thumbnail.showExplorer'),
          onClick: () => {
            invoke(Invokes.ShowInFinder, { path: finalSelection[0] }).catch((err) =>
              toast.error(t('contextMenus.toasts.couldNotShowExplorer', { err })),
            );
          },
        },
        {
          label: resetLabel,
          icon: RotateCcw,
          submenu: [
            { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
            {
              label: hasCustomDefaults(appSettings)
                ? t('contextMenus.editor.resetToDefaults')
                : t('contextMenus.editor.confirmReset'),
              icon: Check,
              isDestructive: true,
              onClick: () => handleResetAdjustments(finalSelection),
            },
            ...(hasCustomDefaults(appSettings)
              ? [
                  {
                    label: t('contextMenus.editor.resetToNeutral'),
                    icon: Eraser,
                    isDestructive: true,
                    onClick: () => handleResetAdjustments(finalSelection, true),
                  },
                ]
              : []),
          ],
        },
        {
          label: deleteLabel,
          icon: Trash2,
          isDestructive: true,
          submenu: deleteSubmenu,
        },
      ];
      showContextMenu(event.clientX, event.clientY, mediaMenu(options, finalSelection));
    },
    [
      getCommonTags,
      buildAddToAlbumMenu,
      handleCopyAdjustments,
      handlePasteAdjustments,
      handleAutoAdjustments,
      buildRatingMenu,
      buildFlagMenu,
      buildColorLabelMenu,
      handleTagsChanged,
      handleResetAdjustments,
      buildEditInOptions,
      showContextMenu,
      props,
      t,
    ],
  );

  const handleFolderTreeContextMenu = useCallback(
    (event: any, path: string | null, isCurrentlyPinned?: boolean) => {
      event.preventDefault();
      event.stopPropagation();

      if (!path) {
        showContextMenu(event.clientX, event.clientY, [
          {
            icon: RefreshCw,
            label: t('contextMenus.folders.refresh'),
            onClick: () => props.refreshAllFolderTrees(),
          },
        ]);
        return;
      }

      const { rootPaths, currentFolderPath, folderTrees, setLibrary } = useLibraryStore.getState();
      const { copiedFilePaths, setProcess } = useProcessStore.getState();
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { setUI } = useUIStore.getState();
      const targetPath = path;
      const isRoot = rootPaths.includes(targetPath);
      const copyPastedLabel = fileLabel(t, 'copyHere', copiedFilePaths);
      const movePastedLabel = fileLabel(t, 'moveHere', copiedFilePaths);

      const pinOption = isCurrentlyPinned
        ? {
            icon: PinOff,
            label: t('contextMenus.folders.unpin'),
            onClick: () => props.handleTogglePinFolder(targetPath),
          }
        : { icon: Pin, label: t('contextMenus.folders.pin'), onClick: () => props.handleTogglePinFolder(targetPath) };

      const options = [
        pinOption,
        { type: OPTION_SEPARATOR },
        {
          icon: FolderPlus,
          label: t('contextMenus.folders.newFolder'),
          onClick: () => {
            setUI({ folderActionTarget: targetPath, isCreateFolderModalOpen: true });
          },
        },
        {
          disabled: isRoot,
          icon: FileEdit,
          label: t('contextMenus.folders.renameFolder'),
          onClick: () => {
            setUI({ folderActionTarget: targetPath, isRenameFolderModalOpen: true });
          },
        },
        {
          label: t('contextMenus.folders.changeIcon'),
          icon: Palette,
          submenu: albumIcons.map((iconDef) => ({
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
          label: t('contextMenus.folders.paste'),
          submenu: [
            {
              label: copyPastedLabel,
              onClick: async () => {
                try {
                  await transferFiles(JobKind.Copy, copiedFilePaths, targetPath);
                  if (targetPath === currentFolderPath) props.handleLibraryRefresh();
                } catch (err) {
                  toast.error(t('contextMenus.toasts.failedCopy', { err }));
                }
              },
            },
            {
              label: movePastedLabel,
              disabled: copiedFilePaths.some(isImmichPath),
              onClick: async () => {
                try {
                  await transferFiles(JobKind.Move, copiedFilePaths, targetPath);
                  setProcess({ copiedFilePaths: [] });
                  setLibrary({ multiSelectedPaths: [] });
                  props.refreshAllFolderTrees();
                  props.handleLibraryRefresh();
                } catch (err) {
                  toast.error(t('contextMenus.toasts.failedMove', { err }));
                }
              },
            },
          ],
        },
        {
          icon: FolderInput,
          label: t('contextMenus.folders.importImages'),
          onClick: () => props.handleImportClick(targetPath),
        },
        { type: OPTION_SEPARATOR },
        {
          icon: Folder,
          label: t('contextMenus.folders.showExplorer'),
          onClick: () =>
            invoke(Invokes.ShowInFinder, { path: targetPath }).catch((err) =>
              toast.error(t('contextMenus.toasts.couldNotShowFolder', { err })),
            ),
        },
        {
          icon: RefreshCw,
          label: t('contextMenus.folders.refresh'),
          onClick: () => props.refreshAllFolderTrees(),
        },
        isRoot
          ? {
              icon: FolderMinus,
              label: t('contextMenus.folders.removeRoot'),
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
            }
          : {
              icon: Trash2,
              isDestructive: true,
              label: t('contextMenus.folders.deleteFolder'),
              submenu: [
                { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
                {
                  label: t('contextMenus.folders.confirm'),
                  icon: Check,
                  isDestructive: true,
                  onClick: async () => {
                    try {
                      await followProjectDelete([targetPath], () => invoke(Invokes.DeleteFolder, { path: targetPath }));

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
                      } else if (
                        currentFolderPath &&
                        (targetPath.startsWith(currentFolderPath + '/') ||
                          targetPath.startsWith(currentFolderPath + '\\'))
                      ) {
                        props.refreshImageList();
                      }

                      props.refreshAllFolderTrees();
                    } catch (err) {
                      toast.error(t('contextMenus.toasts.failedDeleteFolder', { err }));
                    }
                  },
                },
              ],
            },
      ];
      showContextMenu(event.clientX, event.clientY, options);
    },
    [props, showContextMenu, albumIcons, t],
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
            toast.error(t('contextMenus.toasts.failedMoveInvalid'));
            return;
          }
        }

        invoke(Invokes.SaveAlbums, { tree: newTree })
          .then(() => invoke(Invokes.GetAlbums))
          .then((sortedTree: any) => setLibrary({ albumTree: sortedTree }))
          .catch((err) => toast.error(t('contextMenus.toasts.failedMoveError', { err })));
      };

      const buildMoveSubmenu = (nodes: AlbumItem[]): Option[] => {
        const opts: Option[] = [];
        nodes.forEach((n) => {
          if (n.type === 'group' && n.id !== item?.id) {
            const isCurrentParent = n.id === currentParentId;
            const subOpts = buildMoveSubmenu((n as AlbumGroup).children);

            const customIconDef = n.icon ? albumIcons.find((i) => i.value === n.icon) : null;
            const ResolvedIcon = customIconDef?.icon || Folder;

            if (subOpts.length > 0) {
              opts.push({
                label: n.name,
                icon: ResolvedIcon,
                submenu: [
                  {
                    label: isCurrentParent ? t('contextMenus.albums.alreadyHere') : t('contextMenus.albums.moveHere'),
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
          label: t('contextMenus.albums.newAlbum'),
          icon: Images,
          onClick: () => setUI({ albumActionTarget: item?.id || null, isCreateAlbumModalOpen: true }),
        },
        {
          label: t('contextMenus.albums.newGroup'),
          icon: FolderPlus,
          onClick: () => setUI({ albumActionTarget: item?.id || null, isCreateAlbumGroupModalOpen: true }),
        },
        ...(item
          ? [
              { type: OPTION_SEPARATOR },
              {
                label:
                  item.type === 'group' ? t('contextMenus.albums.renameGroup') : t('contextMenus.albums.renameAlbum'),
                icon: FileEdit,
                onClick: () => setUI({ albumActionTarget: item.id, isRenameAlbumModalOpen: true }),
              },
              {
                label: t('contextMenus.folders.changeIcon'),
                icon: Palette,
                submenu: albumIcons.map((iconDef) => ({
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
                        .catch((err) => toast.error(t('contextMenus.toasts.failedChangeIcon', { err })));
                    }
                  },
                })),
              },
              {
                label: t('contextMenus.albums.moveTo'),
                icon: FolderInput,
                disabled: isMoveDisabled,
                submenu: isMoveDisabled
                  ? []
                  : [
                      {
                        label: isAtRoot ? t('contextMenus.albums.alreadyAtRoot') : t('contextMenus.albums.rootDir'),
                        icon: Home,
                        disabled: isAtRoot,
                        onClick: isAtRoot ? undefined : () => handleMove(null),
                      },
                      ...(moveOptions.length > 0 ? [{ type: OPTION_SEPARATOR }, ...moveOptions] : []),
                    ],
              },
              { type: OPTION_SEPARATOR },
              {
                label:
                  item.type === 'group' ? t('contextMenus.albums.deleteGroup') : t('contextMenus.albums.deleteAlbum'),
                icon: Trash2,
                isDestructive: true,
                submenu: [
                  { label: t('contextMenus.editor.cancel'), icon: X, onClick: () => {} },
                  {
                    label:
                      item.type === 'album'
                        ? t('contextMenus.albums.confirmDeleteAlbum')
                        : (item as AlbumGroup).children.length > 0
                          ? t('contextMenus.albums.confirmDeleteGroupNested')
                          : t('contextMenus.albums.confirmDeleteGroupEmpty'),
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
                        .catch((err) => toast.error(t('contextMenus.toasts.failedDelete', { err })));
                    },
                  },
                ],
              },
            ]
          : []),
      ];

      showContextMenu(event.clientX, event.clientY, options);
    },
    [showContextMenu, albumIcons, t],
  );

  const handleMainLibraryContextMenu = useCallback(
    (event: any) => {
      event.preventDefault();
      event.stopPropagation();

      const { copiedFilePaths, setProcess } = useProcessStore.getState();
      const { currentFolderPath, activeAlbumId, imageList, setLibrary } = useLibraryStore.getState();

      const numCopied = copiedFilePaths.length;
      const copyPastedLabel = fileLabel(t, 'copyHere', copiedFilePaths);
      const movePastedLabel = fileLabel(t, 'moveHere', copiedFilePaths);
      const addCopiedToAlbumLabel = fileLabel(t, 'addCopiedToAlbum', copiedFilePaths);

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
                toast.error(t('contextMenus.toasts.failedAddToAlbum', { err }));
              }
            },
          }
        : {
            label: t('contextMenus.folders.paste'),
            icon: ClipboardPaste,
            disabled: copiedFilePaths.length === 0,
            submenu: [
              {
                label: copyPastedLabel,
                onClick: async () => {
                  try {
                    await transferFiles(JobKind.Copy, copiedFilePaths, currentFolderPath as string);
                    props.handleLibraryRefresh();
                  } catch (err) {
                    toast.error(t('contextMenus.toasts.failedCopy', { err }));
                  }
                },
              },
              {
                label: movePastedLabel,
                disabled: copiedFilePaths.some(isImmichPath),
                onClick: async () => {
                  try {
                    await transferFiles(JobKind.Move, copiedFilePaths, currentFolderPath as string);
                    setProcess({ copiedFilePaths: [] });
                    setLibrary({ multiSelectedPaths: [] });
                    props.refreshAllFolderTrees();
                    props.handleLibraryRefresh();
                  } catch (err) {
                    toast.error(t('contextMenus.toasts.failedMove', { err }));
                  }
                },
              },
            ],
          };

      const options = [
        { label: t('contextMenus.library.refreshView'), icon: RefreshCw, onClick: props.handleLibraryRefresh },
        { type: OPTION_SEPARATOR },
        pasteOption,
        {
          icon: FolderInput,
          label: t('contextMenus.folders.importImages'),
          onClick: () => props.handleImportClick(currentFolderPath as string),
          disabled: !currentFolderPath || isAlbumView,
        },
        {
          icon: Clapperboard,
          label: t('contextMenus.library.newVideoProject'),
          disabled: !canCreateFrom(useLibraryStore.getState().multiSelectedPaths),
          shortcut: 'new_video_project',
          onClick: newVideoProject,
        },
        { type: OPTION_SEPARATOR },
        {
          icon: Trash2,
          label: t('contextMenus.library.deleteRejected'),
          isDestructive: true,
          disabled: !imageList.some((image) => image.flag === ImageFlag.Reject),
          onClick: props.handleDeleteRejected,
          shortcut: 'delete_rejected',
        },
      ];

      showContextMenu(event.clientX, event.clientY, options);
    },
    [props, showContextMenu, t],
  );

  return {
    handleEditorContextMenu,
    handleThumbnailContextMenu,
    handleFolderTreeContextMenu,
    handleAlbumTreeContextMenu,
    handleMainLibraryContextMenu,
  };
}
