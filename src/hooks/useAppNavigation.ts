import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { homeDir } from '@tauri-apps/api/path';
import { toast } from 'react-toastify';
import { useLibraryStore } from '../store/useLibraryStore';
import { useEditorStore } from '../store/useEditorStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Invokes, LibraryViewMode, ImageFile, DirectoryTree, AlbumItem, Album } from '../components/ui/AppProperties';
import { INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { globalImageCache, ImageCacheEntry } from '../utils/ImageLRUCache';
import { debouncedSave, debouncedSetHistory } from './useEditorActions';

import type { CanvasTransformHandle } from '../components/panel/Editor';
import type { PreloadedData, PreviousAdjustments } from './hookTypes';

export interface AppNavigationProps {
  clearThumbnailQueue: () => void;
  invalidateSourceThumbnails: (path: string, sourceRevision: string | null) => void;
  needsSourceThumbnailRefresh: (path: string, sourceRevision: string) => boolean;
  refs: {
    transformWrapperRef: React.RefObject<CanvasTransformHandle | null>;
    preloadedDataRef: React.RefObject<PreloadedData | null>;
    cachedEditStateRef: React.RefObject<ImageCacheEntry | null>;
    selectedImagePathRef: React.RefObject<string | null>;
    latestRenderedJobIdRef: React.RefObject<number>;
    previewJobIdRef: React.RefObject<number>;
    currentResRef: React.RefObject<number>;
    prevAdjustmentsRef: React.RefObject<PreviousAdjustments | null>;
  };
}

const loadExifForImages = async (
  files: ImageFile[],
  expectedFolderPath: string | null,
  sortKey: string,
  setLibrary: ReturnType<typeof useLibraryStore.getState>['setLibrary'],
) => {
  const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
  const isExifSortActive = exifSortKeys.includes(sortKey);

  if (files.length === 0) {
    setLibrary({ imageList: files });
    return;
  }

  const paths = files.map((f: ImageFile) => f.path);

  if (isExifSortActive) {
    let combinedExifMap: Record<string, ImageFile['exif']> = {};
    const chunkSize = 100;

    for (let i = 0; i < paths.length; i += chunkSize) {
      const chunk = paths.slice(i, i + chunkSize);
      try {
        const chunkExif: Record<string, ImageFile['exif']> = await invoke(Invokes.ReadExifForPaths, { paths: chunk });
        combinedExifMap = { ...combinedExifMap, ...chunkExif };
      } catch (err) {
        console.error('Failed to read EXIF chunk:', err);
      }
    }

    const finalImageList = files.map((image) => ({
      ...image,
      exif: combinedExifMap[image.path] || image.exif || null,
    }));
    setLibrary({ imageList: finalImageList });
  } else {
    setLibrary({ imageList: files });

    setTimeout(() => {
      const fetchExifInChunks = async () => {
        const chunkSize = 50;
        for (let i = 0; i < paths.length; i += chunkSize) {
          if (useLibraryStore.getState().currentFolderPath !== expectedFolderPath) break;

          const chunk = paths.slice(i, i + chunkSize);
          try {
            const chunkExif: Record<string, ImageFile['exif']> = await invoke(Invokes.ReadExifForPaths, {
              paths: chunk,
            });
            setLibrary((state) => ({
              imageList: state.imageList.map((image: ImageFile) => ({
                ...image,
                exif: chunkExif[image.path] || image.exif || null,
              })),
            }));
            await new Promise((resolve) => setTimeout(resolve, 50));
          } catch (err) {
            console.error('Failed to read EXIF chunk:', err);
          }
        }
      };
      fetchExifInChunks();
    }, 500);
  }
};

export function useAppNavigation({
  clearThumbnailQueue,
  invalidateSourceThumbnails,
  needsSourceThumbnailRefresh,
  refs,
}: AppNavigationProps) {
  const {
    transformWrapperRef,
    preloadedDataRef,
    cachedEditStateRef,
    selectedImagePathRef,
    latestRenderedJobIdRef,
    previewJobIdRef,
    currentResRef,
    prevAdjustmentsRef,
  } = refs;

  const handleGoHome = useCallback(() => {
    useLibraryStore.getState().setLibrary({
      rootPaths: [],
      currentFolderPath: null,
      activeAlbumId: null,
      imageList: [],
      imageRatings: {},
      folderTrees: [],
      multiSelectedPaths: [],
      libraryActivePath: null,
      expandedFolders: new Set(),
    });
    useUIStore.getState().setUI({ isLibraryExportPanelVisible: false });
  }, []);

  const handleBackToLibrary = useCallback(() => {
    const { selectedImage } = useEditorStore.getState();
    const { setLibrary } = useLibraryStore.getState();
    const { setUI } = useUIStore.getState();

    if (selectedImage?.isReady && cachedEditStateRef.current?.selectedImage.path === selectedImage.path) {
      globalImageCache.set(selectedImage.path, cachedEditStateRef.current);
    }
    if (transformWrapperRef.current) {
      transformWrapperRef.current.resetTransform(0);
    }
    useEditorStore.getState().setEditor({
      zoom: 1,
      showOriginal: false,
      previewOverride: null,
    });

    debouncedSave.flush();
    debouncedSetHistory.cancel();

    const lastActivePath = selectedImage?.path ?? null;

    setLibrary({ libraryActivePath: lastActivePath });
    setUI({ activeView: 'library', slideDirection: 1 });
  }, [refs]);

  const handleImageSelect = useCallback(
    async (path: string, openInEditor: boolean = true) => {
      const { selectedImage, resetHistory, setEditor } = useEditorStore.getState();
      const { setLibrary, multiSelectedPaths } = useLibraryStore.getState();
      const { activeView, setUI } = useUIStore.getState();
      const reopeningSamePath = openInEditor && activeView !== 'editor' && selectedImage?.path === path;

      if (openInEditor) {
        setUI({ activeView: 'editor' });
      }

      if (selectedImage?.path === path && !reopeningSamePath) return;

      useEditorStore.getState().patchesSentToBackend.clear();
      debouncedSave.flush();
      debouncedSetHistory.cancel();

      if (selectedImage?.isReady && cachedEditStateRef.current?.selectedImage.path === selectedImage.path) {
        globalImageCache.set(selectedImage.path, cachedEditStateRef.current);
      }

      const cached = globalImageCache.peek(path);
      const currentAdjustments = reopeningSamePath ? useEditorStore.getState().adjustments : null;
      if (reopeningSamePath) {
        // The library keeps the editor mounted. Reopening the same path still
        // needs a fresh native source generation and a distinct image session.
        setEditor({ selectedImage: null });
      }
      selectedImagePathRef.current = path;

      const newMultiSelectedPaths = multiSelectedPaths.includes(path) ? multiSelectedPaths : [path];

      setLibrary({
        multiSelectedPaths: newMultiSelectedPaths,
        libraryActivePath: path,
        selectionAnchorPath: path,
      });

      setEditor({
        showOriginal: false,
        activeMaskId: null,
        activeMaskContainerId: null,
        activeAiPatchContainerId: null,
        activeAiSubMaskId: null,
        isWbPickerActive: false,
        previewOverride: null,
      });

      setUI({
        isLibraryExportPanelVisible: false,
        compactEditorPanelHeightOverride: null,
      });

      const imageFile = useLibraryStore.getState().imageList.find((img) => img.path === path);
      setEditor({
        selectedImage: {
          exif: null,
          group_id: imageFile?.group_id ?? null,
          height: 0,
          isRaw: false,
          isReady: false,
          metadata: null,
          path,
          // Path-keyed thumbnails can outlive a replaced source. Only reveal
          // cached pixels after the physical source revision is checked.
          thumbnailUrl: '',
          preserveCachedAdjustments: !!cached || reopeningSamePath,
          cachedSourceRevision:
            cached?.sourceRevision ?? (reopeningSamePath ? selectedImage?.sourceRevision : undefined),
          width: 0,
        },
        adjustments: currentAdjustments ?? cached?.adjustments ?? { ...INITIAL_ADJUSTMENTS },
        originalSize: { width: 0, height: 0 },
        previewSize: { width: 0, height: 0 },
        histogram: null,
        waveform: null,
        uncroppedAdjustedPreviewUrl: null,
      });

      setLibrary({ isViewLoading: true });
      if (cached) {
        if (!reopeningSamePath) resetHistory(cached.adjustments);
        prevAdjustmentsRef.current = { path, adjustments: currentAdjustments ?? cached.adjustments };
      }

      setEditor((state) => {
        const prev = state.finalPreviewUrl;
        if (prev?.startsWith('blob:') && !globalImageCache.isProtected(prev)) {
          setTimeout(() => {
            if (!globalImageCache.isProtected(prev)) {
              URL.revokeObjectURL(prev);
            }
          }, 250);
        }
        return { finalPreviewUrl: null };
      });

      setEditor((state) => {
        if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
        return { interactivePatch: null };
      });

      const physicalPath = path.split('?vc=')[0];
      const process = useProcessStore.getState();
      const hasSourceThumbnail = [...Object.keys(process.thumbnails), ...Object.keys(process.mediumThumbnails)].some(
        (candidate) => candidate === physicalPath || candidate.startsWith(`${physicalPath}?vc=`),
      );
      if (!cached && !hasSourceThumbnail) return;

      const session = useEditorStore.getState().imageSession;
      let sourceRevision: string | null = null;
      try {
        sourceRevision = await invoke<string>(Invokes.GetSourceRevision, { path });
      } catch {
        // load_image reports a missing/unreadable source through the normal UI.
      }
      const current = useEditorStore.getState();
      if (current.imageSession !== session || current.selectedImage?.path !== path) return;
      // The completed native load has the authoritative source revision. A
      // slower preflight must not replace its thumbnail revision with an older
      // token or restore the snapshot it already rejected.
      if (current.selectedImage.isReady) return;

      const snapshotChanged =
        !!cached && (!sourceRevision || !cached.sourceRevision || sourceRevision !== cached.sourceRevision);
      if (!sourceRevision || snapshotChanged || needsSourceThumbnailRefresh(path, sourceRevision)) {
        invalidateSourceThumbnails(path, sourceRevision);
      }
      if (!cached) {
        const currentThumbnails = useProcessStore.getState();
        const verifiedMedium = currentThumbnails.mediumThumbnails[path];
        if (sourceRevision && verifiedMedium && currentThumbnails.thumbnailSourceRevisions[path] === sourceRevision) {
          setEditor({
            selectedImage: {
              ...current.selectedImage,
              thumbnailUrl: verifiedMedium,
              cachedSourceRevision: sourceRevision,
            },
          });
        }
        return;
      }
      if (!sourceRevision || snapshotChanged) {
        globalImageCache.deleteByPrefix(physicalPath);
        return;
      }
      if (current.adjustments !== cached.adjustments) return;
      if (globalImageCache.get(path) !== cached) return;

      setEditor({
        selectedImage: {
          ...cached.selectedImage,
          isReady: false,
          thumbnailUrl: cached.selectedImage.thumbnailUrl,
          preserveCachedAdjustments: true,
          cachedSourceRevision: sourceRevision,
        },
        originalSize: cached.originalSize,
        previewSize: cached.previewSize,
        histogram: cached.histogram,
        waveform: cached.waveform,
        finalPreviewUrl: cached.finalPreviewUrl,
        uncroppedAdjustedPreviewUrl: cached.uncroppedPreviewUrl,
      });
      setLibrary({ isViewLoading: false });
      latestRenderedJobIdRef.current = previewJobIdRef.current;
      currentResRef.current = 0;
    },
    [refs, invalidateSourceThumbnails, needsSourceThumbnailRefresh],
  );

  const handleSelectSubfolder = useCallback(
    async (
      path: string | null,
      isNewRoot = false,
      preloadedImages?: ImageFile[],
      expandParents = true,
      preserveEditor = false,
      skipHistory = false,
    ) => {
      const { appSettings, handleSettingsChange } = useSettingsStore.getState();
      const { pinnedFolders } = appSettings || { pinnedFolders: [] };
      const { setLibrary, sortCriteria } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();
      const { setProcess } = useProcessStore.getState();
      const { selectedImage, resetHistory, setEditor } = useEditorStore.getState();
      const libraryViewMode = appSettings?.libraryViewMode;

      if (!skipHistory && path) {
        useLibraryStore.getState().pushNavHistory({ type: 'folder', path });
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation');
        clearThumbnailQueue();
        setLibrary({ isViewLoading: true, activeAlbumId: null, libraryScrollTop: 0 });
        setProcess({ thumbnails: {}, mediumThumbnails: {}, thumbnailSourceRevisions: {} });
        globalImageCache.clear();
        setUI({ activeView: 'library' });
      } else {
        setLibrary({ isViewLoading: true });
      }

      try {
        const { rootPaths, expandedFolders: currentExpandedFolders } = useLibraryStore.getState();
        let newExpandedFolders = new Set(currentExpandedFolders);

        if (isNewRoot && path) {
          newExpandedFolders = new Set([path]);
          if (appSettings) {
            handleSettingsChange({ ...appSettings, lastRootPath: path });
          }
        } else if (path && expandParents) {
          const allRoots = [...(rootPaths || []), ...(pinnedFolders || [])].filter(Boolean) as string[];
          const relevantRoot = allRoots.find((r) => path.startsWith(r));

          if (relevantRoot) {
            const separator = path.includes('/') ? '/' : '\\';
            const parentSeparatorIndex = path.lastIndexOf(separator);

            if (parentSeparatorIndex > -1 && path.length > relevantRoot.length) {
              let current = path.substring(0, parentSeparatorIndex);
              while (current && current.length >= relevantRoot.length) {
                newExpandedFolders.add(current);
                const nextParentIndex = current.lastIndexOf(separator);
                if (nextParentIndex === -1 || current === relevantRoot) break;
                current = current.substring(0, nextParentIndex);
              }
            }
            newExpandedFolders.add(relevantRoot);
          }
        }

        setLibrary({
          currentFolderPath: path,
          expandedFolders: newExpandedFolders,
          ...(preserveEditor ? {} : { imageList: [], multiSelectedPaths: [], libraryActivePath: null }),
        });

        if (!preserveEditor && selectedImage) {
          debouncedSave.flush();
          debouncedSetHistory.cancel();
          setEditor({ selectedImage: null, finalPreviewUrl: null, uncroppedAdjustedPreviewUrl: null, histogram: null });
          setEditor({ adjustments: INITIAL_ADJUSTMENTS });
          resetHistory(INITIAL_ADJUSTMENTS);
          useEditorStore.getState().patchesSentToBackend.clear();
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
        setLibrary({ imageRatings: initialRatings });

        await loadExifForImages(files, path, sortCriteria.key, setLibrary);

        if (!preserveEditor) {
          invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
            console.error('Failed to start background indexing:', err);
          });
        }
      } catch (err) {
        console.error('Failed to load folder contents:', err);
        toast.error('Failed to load images from the selected folder.');
      } finally {
        useLibraryStore.getState().setLibrary({ isViewLoading: false });
      }
    },
    [clearThumbnailQueue, refs],
  );

  const handleSelectAlbum = useCallback(
    async (albumId: string, albumName: string, imagePaths: string[], preserveEditor = false, skipHistory = false) => {
      const { setLibrary, sortCriteria } = useLibraryStore.getState();
      const { setUI } = useUIStore.getState();

      if (!skipHistory) {
        useLibraryStore.getState().pushNavHistory({ type: 'album', path: albumId, albumName, images: imagePaths });
      }

      if (!preserveEditor) {
        await invoke('cancel_thumbnail_generation');
        clearThumbnailQueue();
        setLibrary({ libraryScrollTop: 0 });
        globalImageCache.clear();
        setUI({ activeView: 'library' });
      }

      const albumFolderPath = `Album: ${albumName}`;

      setLibrary({
        isViewLoading: true,
        currentFolderPath: albumFolderPath,
        activeAlbumId: albumId,
      });

      try {
        const files: ImageFile[] = await invoke(Invokes.GetAlbumImages, { paths: imagePaths });

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) initialRatings[f.path] = f.rating;
        });

        setLibrary({
          imageRatings: initialRatings,
          ...(preserveEditor ? {} : { multiSelectedPaths: [], libraryActivePath: null }),
        });

        await loadExifForImages(files, albumFolderPath, sortCriteria.key, setLibrary);
      } catch (err) {
        console.error('Failed to load album images:', err);
        toast.error(`Failed to load album: ${err}`);
      } finally {
        setLibrary({ isViewLoading: false });
      }
    },
    [clearThumbnailQueue],
  );

  const handleNavBack = useCallback(async () => {
    const { navHistory, navIndex, setLibrary } = useLibraryStore.getState();

    if (navIndex > 0) {
      const targetIndex = navIndex - 1;
      const target = navHistory[targetIndex];
      setLibrary({ navIndex: targetIndex });

      if (target.type === 'folder') {
        handleSelectSubfolder(target.path, false, undefined, true, false, true);
      } else if (target.type === 'album') {
        handleSelectAlbum(target.path, target.albumName!, target.images!, false, true);
      }
    }
  }, [handleSelectSubfolder, handleSelectAlbum]);

  const handleNavForward = useCallback(async () => {
    const { navHistory, navIndex, setLibrary } = useLibraryStore.getState();

    if (navIndex < navHistory.length - 1) {
      const targetIndex = navIndex + 1;
      const target = navHistory[targetIndex];
      setLibrary({ navIndex: targetIndex });

      if (target.type === 'folder') {
        handleSelectSubfolder(target.path, false, undefined, true, false, true);
      } else if (target.type === 'album') {
        handleSelectAlbum(target.path, target.albumName!, target.images!, false, true);
      }
    }
  }, [handleSelectSubfolder, handleSelectAlbum]);

  const handleOpenFolder = useCallback(async () => {
    const { osPlatform, appSettings, handleSettingsChange } = useSettingsStore.getState();
    const { rootPaths, folderTrees, setLibrary } = useLibraryStore.getState();
    const isAndroid = osPlatform === 'android';

    try {
      let selectedPath = '';
      if (isAndroid) {
        selectedPath = await invoke<string>(Invokes.GetOrCreateInternalLibraryRoot);
      } else {
        const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
        if (typeof selected === 'string') {
          selectedPath = selected;
        }
      }

      if (selectedPath) {
        if (!rootPaths.includes(selectedPath)) {
          const newRootPaths = [...rootPaths, selectedPath];
          setLibrary({ rootPaths: newRootPaths });

          if (appSettings) {
            handleSettingsChange({ ...appSettings, rootFolders: newRootPaths });
          }

          setLibrary({ isTreeLoading: true });
          try {
            const newTree = await invoke<DirectoryTree>(Invokes.GetFolderTree, {
              path: selectedPath,
              expandedFolders: [selectedPath],
              showImageCounts:
                appSettings?.enableFolderImageCounts || appSettings?.folderTreeSort?.key === 'imageCount',
            });
            setLibrary({ folderTrees: [...folderTrees, newTree] });
          } catch (e) {
            toast.error(`Failed to load folder tree: ${e}`);
          } finally {
            setLibrary({ isTreeLoading: false });
          }
        }
        await handleSelectSubfolder(selectedPath, true);
      }
    } catch (err) {
      console.error(isAndroid ? 'Failed to open Android library root:' : 'Failed to open directory dialog:', err);
      toast.error(isAndroid ? 'Failed to open library.' : 'Failed to open folder selection dialog.');
    }
  }, [handleSelectSubfolder]);

  const handleContinueSession = () => {
    const restore = async () => {
      const { appSettings } = useSettingsStore.getState();
      const { setLibrary } = useLibraryStore.getState();

      const rootFolders = appSettings?.rootFolders?.length
        ? appSettings.rootFolders
        : appSettings?.lastRootPath
          ? [appSettings.lastRootPath]
          : [];

      if (rootFolders.length === 0) return;

      const folderState = appSettings?.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || rootFolders[0];

      setLibrary({ rootPaths: rootFolders });

      if (folderState?.expandedFolders) {
        const newExpandedFolders = new Set<string>(folderState.expandedFolders);
        setLibrary({ expandedFolders: newExpandedFolders });
      } else {
        setLibrary({ expandedFolders: new Set(rootFolders) });
      }

      setLibrary({ isTreeLoading: true });
      try {
        let treesData;
        if (preloadedDataRef.current?.rootPaths?.join() === rootFolders.join() && preloadedDataRef.current.trees) {
          treesData = await preloadedDataRef.current.trees;
          preloadedDataRef.current.trees = undefined;
        } else {
          const expandedArr = folderState?.expandedFolders
            ? Array.from(new Set(folderState.expandedFolders))
            : rootFolders;
          treesData = await invoke<DirectoryTree[]>(Invokes.GetPinnedFolderTrees, {
            paths: rootFolders,
            expandedFolders: expandedArr,
            showImageCounts: appSettings?.enableFolderImageCounts || appSettings?.folderTreeSort?.key === 'imageCount',
          });
        }
        setLibrary({ folderTrees: treesData });
      } catch (err) {
        console.error('Failed to restore folder trees:', err);
      } finally {
        setLibrary({ isTreeLoading: false });
      }

      let preloadedImages: ImageFile[] | undefined = undefined;
      if (preloadedDataRef.current?.currentPath === pathToSelect && preloadedDataRef.current.images) {
        try {
          preloadedImages = await preloadedDataRef.current.images;
          preloadedDataRef.current.images = undefined;
        } catch (e) {
          console.error('Failed to retrieve preloaded images', e);
        }
      }

      if (pathToSelect && pathToSelect.startsWith('Album: ')) {
        const activeAlbumId = folderState?.activeAlbumId;
        if (activeAlbumId) {
          try {
            const albumTree: AlbumItem[] = await invoke(Invokes.GetAlbums);
            setLibrary({ albumTree });

            const findObj = (nodes: AlbumItem[]): Album | null => {
              for (const n of nodes) {
                if (n.type === 'album' && n.id === activeAlbumId) return n;
                if (n.type === 'group') {
                  const f = findObj(n.children);
                  if (f) return f;
                }
              }
              return null;
            };

            const album = findObj(albumTree);
            if (album) {
              await handleSelectAlbum(album.id, album.name, album.images);
            } else {
              await handleSelectSubfolder(rootFolders[0], false, undefined, false);
            }
          } catch (e) {
            console.error('Failed to restore album session:', e);
            await handleSelectSubfolder(rootFolders[0], false, undefined, false);
          }
        } else {
          await handleSelectSubfolder(rootFolders[0], false, undefined, false);
        }
      } else {
        await handleSelectSubfolder(pathToSelect, false, preloadedImages, false);
      }
    };

    restore().catch((err) => {
      console.error('Failed to restore session:', err);
      toast.error('Failed to restore session. A folder may have been moved or deleted.');
      handleGoHome();
      useLibraryStore.getState().setLibrary({ isTreeLoading: false });
    });
  };

  return {
    handleGoHome,
    handleBackToLibrary,
    handleImageSelect,
    handleSelectSubfolder,
    handleSelectAlbum,
    handleOpenFolder,
    handleNavBack,
    handleNavForward,
    handleContinueSession,
  };
}
