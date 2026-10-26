import { ReactNode, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import clsx from 'clsx';
import { Album as AlbumIcon, CloudOff, CloudUpload, RefreshCw, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import Text from '../ui/Text';
import { TextVariants, TextWeights } from '../../types/typography';
import { toImmichAlbumId } from './immichApi';
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
  const query = searchQuery.trim().toLowerCase();
  const visibleAlbums = useMemo(
    () => (query ? albums.filter((a) => a.albumName.toLowerCase().includes(query)) : albums),
    [albums, query],
  );

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
                  isSelected={toImmichAlbumId(album.id) === selectedAlbumId}
                  onSelect={() => onSelectAlbum(toImmichAlbumId(album.id), album.albumName, [])}
                />
              ))}

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
