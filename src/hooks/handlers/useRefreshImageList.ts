import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';
import { ImageFile, Invokes, LibraryViewMode } from '../../components/ui/AppProperties';
import { invoke } from '@tauri-apps/api/core';

export function useRefreshImageList() {
  const { currentFolderPath, libraryViewMode, sortCriteria, appSettings, setImageList, setError } = useAppState();

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

  return refreshImageList;
}
