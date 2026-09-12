import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../../store/useLibraryStore';

export default function RecursiveFolderGrouping() {
  const { t } = useTranslation();
  const grouped = useLibraryStore(state => state.groupRecursiveFolders);
  const setLibrary = useLibraryStore(state => state.setLibrary);
  return (
    <label className="flex items-center gap-2 px-3 pt-2 text-sm cursor-pointer">
      <input type="checkbox" checked={grouped}
        onChange={event => setLibrary({ groupRecursiveFolders: event.target.checked })} />
      {t('library.header.viewOptions.groupByFolder', { defaultValue: 'Group by folder' })}
    </label>
  );
}
