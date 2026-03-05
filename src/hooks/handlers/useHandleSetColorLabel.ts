import { invoke } from '@tauri-apps/api/core';
import { useCallback } from 'react';
import { ImageFile, Invokes } from '../../components/ui/AppProperties';
import { useAppState } from '../../context/ContextProviders';

export function useHandleSetColorLabel() {
  const { multiSelectedPaths, selectedImage, libraryActivePath, imageList, setImageList, setError } = useAppState();

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

        setImageList((prevList: Array<ImageFile>) =>
          prevList.map((image: ImageFile) => {
            if (pathsToUpdate.includes(image.path)) {
              const otherTags = (image.tags || []).filter((tag: string) => !tag.startsWith('color:'));
              const newTags = finalColor ? [...otherTags, `color:${finalColor}`] : otherTags;
              return { ...image, tags: newTags };
            }
            return image;
          }),
        );
      } catch (err) {
        console.error('Failed to set color label:', err);
        setError(`Failed to set color label: ${err}`);
      }
    },
    [multiSelectedPaths, selectedImage, libraryActivePath, imageList],
  );

  return handleSetColorLabel;
}
