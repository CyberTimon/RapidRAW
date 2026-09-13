import { useEffect } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';
import { useProcessStore } from '../store/useProcessStore';
import { requestLibraryExif } from './libraryExifQueue';

/** Library metadata does not require an editor session or decoded sensor pixels. */
export function useMetadataImage() {
  const activeView = useUIStore((s) => s.activeView);
  const editorImage = useEditorStore((s) => s.selectedImage);
  const path = useLibraryStore((s) => s.libraryActivePath);
  const image = useLibraryStore((s) => s.imageList.find((item) => item.path === s.libraryActivePath));
  const thumbnailUrl = useProcessStore((s) => (path ? s.thumbnails[path] : undefined));
  useEffect(() => {
    if (activeView === 'library' && path) requestLibraryExif([path]);
  }, [activeView, path]);
  if (activeView !== 'library') return editorImage;
  if (!image) return null;
  const exif = image.exif ?? {};
  return {
    ...image,
    exif,
    thumbnailUrl,
    width: Number(exif.ExifImageWidth || exif.PixelXDimension || exif.ImageWidth) || 0,
    height: Number(exif.ExifImageHeight || exif.PixelYDimension || exif.ImageHeight) || 0,
  };
}
