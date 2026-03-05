import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useHandleTagsChanged() {
  const { setImageList } = useAppState();

  const handleTagsChanged = useCallback(
    (changedPaths: string[], newTags: { tag: string; isUser: boolean }[]) => {
      setImageList((prevList) =>
        prevList.map((image) => {
          if (changedPaths.includes(image.path)) {
            const colorTags = (image.tags || []).filter((t) => t.startsWith('color:'));
            const prefixedNewTags = newTags.map((t) => (t.isUser ? `user:${t.tag}` : t.tag));
            const finalTags = [...colorTags, ...prefixedNewTags].sort();
            return { ...image, tags: finalTags.length > 0 ? finalTags : null };
          }
          return image;
        }),
      );
    },
    [setImageList],
  );

  return handleTagsChanged;
}
