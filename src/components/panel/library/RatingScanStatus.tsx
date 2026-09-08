import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { requestLibraryExif } from '../../../hooks/libraryExifQueue';
import { requiresLibraryExif } from '../../../hooks/useSortedLibrary';

export default function RatingScanStatus() {
  const { t } = useTranslation();
  const progress = useLibraryStore((state) => state.ratingProgress);
  const sortKey = useLibraryStore((state) => state.sortCriteria.key);
  const search = useLibraryStore((state) => state.searchCriteria);
  const images = useLibraryStore((state) => state.imageList);
  useEffect(() => {
    if (requiresLibraryExif(sortKey, search.tags)) requestLibraryExif(images.map((image) => image.path));
  }, [sortKey, search.tags, images]);
  if (!progress || (progress.done && progress.failed === 0)) return null;
  return (
    <div className="px-2 text-xs text-text-secondary" role="status">
      {progress.done
        ? t('library.ratingScan.failed', {
            count: progress.failed,
            defaultValue: '{{count}} ratings could not be read',
          })
        : t('library.ratingScan.progress', {
            checked: progress.checked,
            total: progress.total,
            defaultValue: 'Checking ratings: {{checked}}/{{total}}',
          })}
    </div>
  );
}
