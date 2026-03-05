import { useCallback } from 'react';
import { useAppState } from '../../context/ContextProviders';

export function useGetCommonTags() {
  const { imageList } = useAppState();

  const getCommonTags = useCallback(
    (paths: string[]): { tag: string; isUser: boolean }[] => {
      if (paths.length === 0) return [];
      const imageFiles = imageList.filter((img) => paths.includes(img.path));
      if (imageFiles.length === 0) return [];

      const allTagsSets = imageFiles.map((img) => {
        const tagsWithPrefix = (img.tags || []).filter((t) => !t.startsWith('color:'));
        return new Set(tagsWithPrefix);
      });

      if (allTagsSets.length === 0) return [];

      const commonTagsWithPrefix = allTagsSets.reduce((intersection, currentSet) => {
        return new Set([...intersection].filter((tag) => currentSet.has(tag)));
      });

      return Array.from(commonTagsWithPrefix)
        .map((tag) => ({
          tag: tag.startsWith('user:') ? tag.substring(5) : tag,
          isUser: tag.startsWith('user:'),
        }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
    },
    [imageList],
  );

  return getCommonTags;
}
