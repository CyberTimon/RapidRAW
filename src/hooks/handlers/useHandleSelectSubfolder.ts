import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { ImageFile, AppSettings, Invokes, LibraryViewMode } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';
import { useHandleSettingsChange } from './useHandleSettingsChange';
import { useHandleActiveTreeSectionChange } from './useHandleActiveTreeSectionChange';

export function useHandleSelectSubfolder() {
  const {
    appSettings,
    selectedImage,
    rootPath,
    sortCriteria,
    pinnedFolders,
    libraryViewMode,
    setIsViewLoading,
    setIsTreeLoading,
    setError,
    setImageList,
    setHistogram,
    setUncroppedAdjustedPreviewUrl,
    setFinalPreviewUrl,
    setSelectedImage,
    setLibraryActivePath,
    setMultiSelectedPaths,
    setImageRatings,
    setFolderTree,
    setExpandedFolders,
    setActiveView,
    setCurrentFolderPath,
    setThumbnails,
    setLibraryScrollTop,
    setSearchCriteria,
  } = useAppState();
  const handleSettingsChange = useHandleSettingsChange();
  const handleActiveTreeSectionChange = useHandleActiveTreeSectionChange();

  const handleSelectSubfolder = useCallback(
    async (path: string | null, isNewRoot = false, preloadedImages?: ImageFile[]) => {
      await invoke('cancel_thumbnail_generation');
      setIsViewLoading(true);
      setSearchCriteria({ tags: [], text: '', mode: 'OR' });
      setLibraryScrollTop(0);
      setThumbnails({});
      try {
        setCurrentFolderPath(path);
        setActiveView('library');

        if (isNewRoot) {
          setExpandedFolders(new Set([path]));
        } else if (path) {
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
            const treeData = await invoke(Invokes.GetFolderTree, { path });
            setFolderTree(treeData);
          } catch (err) {
            console.error('Failed to load folder tree:', err);
            setError(`Failed to load folder tree: ${err}. Some sub-folders might be inaccessible.`);
          } finally {
            setIsTreeLoading(false);
          }
        }

        setImageList([]);
        setImageRatings({});
        setMultiSelectedPaths([]);
        setLibraryActivePath(null);
        if (selectedImage) {
          setSelectedImage(null);
          setFinalPreviewUrl(null);
          setUncroppedAdjustedPreviewUrl(null);
          setHistogram(null);
        }

        const command =
          libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

        let files: ImageFile[];
        if (preloadedImages) {
          files = preloadedImages;
        } else {
          files = await invoke(command, { path });
        }

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
    [appSettings, handleSettingsChange, selectedImage, rootPath, sortCriteria.key, pinnedFolders, libraryViewMode],
  );

  return handleSelectSubfolder;
}
