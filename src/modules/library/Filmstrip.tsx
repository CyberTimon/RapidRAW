import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBloc } from '@blac/react';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { ThumbnailBloc } from '../../blocs/library/ThumbnailBloc';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import type { ImageFile } from '../../types/library';

const FILMSTRIP_THUMBNAIL_SIZE = 80;
const FILMSTRIP_GAP = 8;

interface FilmstripItemProps {
  image: ImageFile;
  isSelected: boolean;
  isActive: boolean;
  thumbnailUrl?: string;
  isPending: boolean;
  rating: number;
  onClick: (e: React.MouseEvent) => void;
}

function FilmstripItem({
  image,
  isSelected,
  isActive,
  thumbnailUrl,
  isPending,
  rating,
  onClick,
}: FilmstripItemProps) {
  return (
    <button
      className={`
        relative flex-shrink-0 rounded overflow-hidden transition-all duration-150
        ${isSelected ? 'ring-2 ring-accent' : ''}
        ${isActive ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-secondary' : ''}
        hover:opacity-90
      `}
      style={{ width: FILMSTRIP_THUMBNAIL_SIZE, height: FILMSTRIP_THUMBNAIL_SIZE }}
      onClick={onClick}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={image.name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full bg-surface flex items-center justify-center">
          {isPending ? (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent border-t-transparent" />
          ) : (
            <svg
              className="w-6 h-6 text-text-secondary"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          )}
        </div>
      )}

      {rating > 0 && (
        <div className="absolute bottom-0.5 left-0.5 flex">
          {[1, 2, 3, 4, 5].map((star) => (
            <svg
              key={star}
              className={`w-2 h-2 ${star <= rating ? 'text-yellow-400' : 'hidden'}`}
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
          ))}
        </div>
      )}

      {isSelected && (
        <div className="absolute top-0.5 right-0.5 w-4 h-4 bg-accent rounded-full flex items-center justify-center">
          <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
          </svg>
        </div>
      )}
    </button>
  );
}

export function Filmstrip() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [library] = useBloc(LibraryBloc);
  const [selection, selectionBloc] = useBloc(SelectionBloc);
  const [thumbnail, thumbnailBloc] = useBloc(ThumbnailBloc);
  const [ratings] = useBloc(RatingsBloc);

  const images = library.images;
  const allPaths = useMemo(() => images.map((img) => img.path), [images]);

  const virtualizer = useVirtualizer({
    count: images.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => FILMSTRIP_THUMBNAIL_SIZE + FILMSTRIP_GAP,
    horizontal: true,
    overscan: 5,
    useFlushSync: false,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const visiblePaths = useMemo(() => {
    return virtualItems.map((item) => images[item.index].path);
  }, [virtualItems, images]);

  useEffect(() => {
    if (visiblePaths.length > 0) {
      thumbnailBloc.requestThumbnails(visiblePaths);
    }
  }, [visiblePaths, thumbnailBloc]);

  useEffect(() => {
    if (selection.activePath) {
      const activeIndex = allPaths.indexOf(selection.activePath);
      if (activeIndex !== -1) {
        virtualizer.scrollToIndex(activeIndex, { align: 'center', behavior: 'smooth' });
      }
    }
  }, [selection.activePath, allPaths, virtualizer]);

  const handleClick = useCallback(
    (path: string, e: React.MouseEvent) => {
      selectionBloc.handleClick(
        path,
        { ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey },
        allPaths
      );
    },
    [selectionBloc, allPaths]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!selection.activePath || allPaths.length === 0) return;

      const currentIndex = allPaths.indexOf(selection.activePath);
      if (currentIndex === -1) return;

      let newIndex = currentIndex;

      switch (e.key) {
        case 'ArrowRight':
          newIndex = Math.min(currentIndex + 1, allPaths.length - 1);
          break;
        case 'ArrowLeft':
          newIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'Home':
          newIndex = 0;
          break;
        case 'End':
          newIndex = allPaths.length - 1;
          break;
        default:
          return;
      }

      if (newIndex !== currentIndex) {
        e.preventDefault();
        selectionBloc.handleClick(
          allPaths[newIndex],
          { ctrlKey: false, metaKey: false, shiftKey: e.shiftKey },
          allPaths
        );
      }
    },
    [selection.activePath, allPaths, selectionBloc]
  );

  if (images.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-secondary">
        <p className="text-xs text-text-secondary">No images</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-x-auto overflow-y-hidden bg-bg-secondary px-2 py-2 focus:outline-none"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        className="relative h-full flex items-center"
        style={{ width: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const image = images[virtualItem.index];
          return (
            <div
              key={image.path}
              style={{
                position: 'absolute',
                top: '50%',
                left: 0,
                width: `${FILMSTRIP_THUMBNAIL_SIZE}px`,
                transform: `translateX(${virtualItem.start}px) translateY(-50%)`,
              }}
            >
              <FilmstripItem
                image={image}
                isSelected={selection.selectedPaths.includes(image.path)}
                isActive={selection.activePath === image.path}
                thumbnailUrl={thumbnail.thumbnails[image.path]}
                isPending={thumbnail.pending.includes(image.path)}
                rating={ratings.ratings[image.path] || 0}
                onClick={(e) => handleClick(image.path, e)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
