import { ReactNode, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import {
  Album as AlbumIcon,
  ChevronDown,
  ChevronRight,
  CloudOff,
  CloudUpload,
  Inbox,
  Library,
  RefreshCw,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import Text from '../ui/Text';
import { FolderTreeSort, SortDirection } from '../ui/AppProperties';
import { useSettingsStore } from '../../store/useSettingsStore';
import { TextVariants, TextWeights } from '../../types/typography';
import { IMMICH_UNASSIGNED_ID, ImmichAlbum, toImmichAlbumId } from './immichApi';
import ImmichRow from './ImmichRow';
import ImmichTimeline from './ImmichTimeline';
import { useImmichStore } from './useImmichStore';

interface ImmichSectionProps {
  header: ReactNode;
  isOpen: boolean;
  onSelectAlbum(albumId: string, albumName: string, images: string[]): void;
  searchQuery: string;
  selectedAlbumId: string | null;
  showImageCounts: boolean;
}

const ALBUMS_SECTION = 'immich-albums';

const sortAlbums = (albums: ImmichAlbum[], sort: FolderTreeSort): ImmichAlbum[] =>
  [...albums].sort((a, b) => {
    let comparison = 0;
    if (sort.key === 'name') comparison = a.albumName.localeCompare(b.albumName);
    else if (sort.key === 'created') comparison = (a.startDate || '').localeCompare(b.startDate || '');
    else if (sort.key === 'modified') comparison = (a.endDate || '').localeCompare(b.endDate || '');
    else if (sort.key === 'imageCount') comparison = a.assetCount - b.assetCount;
    return sort.order === SortDirection.Ascending ? comparison : -comparison;
  });

export default function ImmichSection({
  header,
  isOpen,
  onSelectAlbum,
  searchQuery,
  selectedAlbumId,
  showImageCounts,
}: ImmichSectionProps) {
  const { t } = useTranslation();
  const { isConfigured, albums, isLoading, error, syncStatus, loadAlbums } = useImmichStore(
    useShallow((state) => ({
      isConfigured: state.isConfigured,
      syncStatus: state.syncStatus,
      albums: state.albums,
      isLoading: state.isLoading,
      error: state.error,
      loadAlbums: state.loadAlbums,
    })),
  );
  const appSettings = useSettingsStore((state) => state.appSettings);
  const handleSettingsChange = useSettingsStore((state) => state.handleSettingsChange);
  const sort = appSettings?.folderTreeSort;
  const openSections = appSettings?.openTreeSections ?? ['current'];
  const isAlbumsOpen = openSections.includes(ALBUMS_SECTION);

  const toggleAlbums = () => {
    if (!appSettings) return;
    const newSections = isAlbumsOpen
      ? openSections.filter((s) => s !== ALBUMS_SECTION)
      : [...openSections, ALBUMS_SECTION];
    handleSettingsChange({ ...appSettings, openTreeSections: newSections });
  };

  const query = searchQuery.trim().toLowerCase();
  const visibleAlbums = useMemo(() => {
    const matching = query ? albums.filter((a) => a.albumName.toLowerCase().includes(query)) : albums;
    return sortAlbums(matching, sort || { key: 'name', order: SortDirection.Ascending });
  }, [albums, query, sort]);

  if (!isConfigured || (query && visibleAlbums.length === 0)) {
    return null;
  }

  return (
    <>
      <div>{header}</div>
      {(syncStatus.offline || syncStatus.pending > 0) && (
        <Text variant={TextVariants.small} className="flex items-center gap-2 px-3 pb-1">
          {syncStatus.offline ? (
            <CloudOff size={14} className="shrink-0" />
          ) : (
            <CloudUpload size={14} className="shrink-0" />
          )}
          {syncStatus.offline ? t('immich.sync.offline') : null}
          {syncStatus.offline && syncStatus.pending > 0 ? ' · ' : null}
          {syncStatus.pending > 0 ? t('immich.sync.pending', { number: syncStatus.pending }) : null}
        </Text>
      )}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pt-1 pb-2">
              {!query && (
                <>
                  <ImmichTimeline selectedAlbumId={selectedAlbumId} onSelectAlbum={onSelectAlbum} />
                  <ImmichRow
                    icon={Library}
                    label={t('immich.section.albums')}
                    count={albums.length}
                    showCount
                    isSelected={false}
                    onSelect={toggleAlbums}
                    trailing={isAlbumsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  />
                </>
              )}

              {(query || isAlbumsOpen) && (
                <div className={clsx(!query && 'pl-4')}>
                  {!query && (
                    <>
                      <ImmichRow
                        icon={Inbox}
                        label={t('immich.section.unassigned')}
                        dropId={IMMICH_UNASSIGNED_ID}
                        isSelected={selectedAlbumId === IMMICH_UNASSIGNED_ID}
                        onSelect={() => onSelectAlbum(IMMICH_UNASSIGNED_ID, t('immich.section.unassigned'), [])}
                        tooltip={t('immich.section.unassignedHint')}
                      />
                      <div className="my-1 mx-2 h-px bg-surface" />
                    </>
                  )}
                  {visibleAlbums.map((album) => (
                    <ImmichRow
                      key={album.id}
                      icon={album.shared ? Users : AlbumIcon}
                      label={album.albumName}
                      count={album.assetCount}
                      showCount={showImageCounts}
                      dropId={toImmichAlbumId(album.id)}
                      isSelected={toImmichAlbumId(album.id) === selectedAlbumId}
                      onSelect={() => onSelectAlbum(toImmichAlbumId(album.id), album.albumName, [])}
                    />
                  ))}
                </div>
              )}

              {error && (
                <Text variant={TextVariants.small} className="p-2 text-center" data-tooltip={error}>
                  {t('immich.section.error')}
                </Text>
              )}
              {!error && !isLoading && albums.length === 0 && (
                <Text variant={TextVariants.small} className="p-2 text-center">
                  {t('immich.section.empty')}
                </Text>
              )}

              {!query && (
                <Text
                  as="div"
                  weight={TextWeights.medium}
                  className="flex items-center gap-2 p-2 mt-1 rounded-md transition-opacity opacity-70 hover:opacity-100 hover:bg-card-active cursor-pointer hover:text-text-primary"
                  onClick={() => !isLoading && loadAlbums()}
                >
                  <div className="relative w-4 h-4 ml-1 shrink-0 flex items-center justify-center">
                    <RefreshCw size={14} className={clsx(isLoading && 'animate-spin')} />
                  </div>
                  <span className="select-none">
                    {isLoading ? t('immich.section.loading') : t('immich.section.refresh')}
                  </span>
                </Text>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
