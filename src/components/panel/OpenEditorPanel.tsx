import { useTranslation } from 'react-i18next';
import { useLibraryStore } from '../../store/useLibraryStore';

/** Editing controls require an explicit editor session, not gallery selection. */
export default function OpenEditorPanel({ onOpen }: { onOpen: (path: string) => void }) {
  const { t } = useTranslation();
  const path = useLibraryStore((s) => s.libraryActivePath);
  if (!path) return null;
  return (
    <div className="flex h-full items-center justify-center p-3">
      <button className="rounded-md px-3 py-2 text-sm text-text-primary hover:bg-surface" onClick={() => onOpen(path)}>
        {t('library.culling.editImage')}
      </button>
    </div>
  );
}
