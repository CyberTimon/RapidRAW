import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../../store/useLibraryStore';
import Switch from '../../ui/Switch';

export default function RecursiveFolderGrouping() {
  const { t } = useTranslation();
  const grouped = useLibraryStore((state) => state.groupRecursiveFolders);
  const setLibrary = useLibraryStore((state) => state.setLibrary);

  return (
    <Switch
      checked={grouped}
      className="px-3 pt-2 text-sm"
      label={t('library.header.viewOptions.groupByFolder', { defaultValue: 'Group by folder' })}
      onChange={(checked) => setLibrary({ groupRecursiveFolders: checked })}
    />
  );
}
