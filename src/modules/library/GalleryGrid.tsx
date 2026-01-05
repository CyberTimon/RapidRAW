import { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBloc } from '@blac/react';
import { LibraryBloc } from '../../blocs/library/LibraryBloc';
import { SelectionBloc } from '../../blocs/library/SelectionBloc';
import { ThumbnailBloc } from '../../blocs/library/ThumbnailBloc';
import { FilterBloc } from '../../blocs/library/FilterBloc';
import { SortBloc } from '../../blocs/library/SortBloc';
import { RatingsBloc } from '../../blocs/library/RatingsBloc';
import { SettingsBloc } from '../../blocs/app/SettingsBloc';
import { AppBloc } from '../../blocs/app/AppBloc';
import { ImageCard } from './ImageCard';
import { THUMBNAIL_SIZES } from '../../types/library';
import type { ImageFile } from '../../types/library';

function useFilteredAndSortedImages(
  images: ImageFile[],
  minRating: number,
  colors: string[],
  rawStatus: 'all' | 'raw' | 'nonRaw',
  sortKey: string,
  sortDirection: 'asc' | 'desc',
  ratings: Record<string, number>,
  colorLabels: Record<string, string>
) {
  return useMemo(() => {
    let filtered = images;

    if (minRating > 0) {
      filtered = filtered.filter((img) => (ratings[img.path] || 0) >= minRating);
    }

    if (colors.length > 0) {
      filtered = filtered.filter((img) => colors.includes(colorLabels[img.path] || ''));
    }

    if (rawStatus !== 'all') {
      filtered = filtered.filter((img) =>
        rawStatus === 'raw' ? img.isRaw : !img.isRaw
      );
    }

    const sorted = [...filtered].sort((a, b) => {
      let comparison = 0;

      switch (sortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (ratings[a.path] || 0) - (ratings[b.path] || 0);
          break;
        case 'date_taken':
          comparison = (a.exif?.DateTimeOriginal || '').localeCompare(
            b.exif?.DateTimeOriginal || ''
          );
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        default:
          comparison = 0;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [images, minRating, colors, rawStatus, sortKey, sortDirection, ratings, colorLabels]);
}

function useContainerWidth(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    setWidth(container.clientWidth);

    return () => observer.disconnect();
  }, [containerRef]);

  return width;
}

export function GalleryGrid() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [library] = useBloc(LibraryBloc);
  const [selection, selectionBloc] = useBloc(SelectionBloc);
  const [, thumbnailBloc] = useBloc(ThumbnailBloc);
  const [filter] = useBloc(FilterBloc);
  const [sort] = useBloc(SortBloc);
  const [ratings] = useBloc(RatingsBloc);
  const [settings] = useBloc(SettingsBloc);
  const [, appBloc] = useBloc(AppBloc);

  const thumbnailSize = THUMBNAIL_SIZES[settings.settings.thumbnailSize];
  const aspectRatio = settings.settings.thumbnailAspectRatio;
  const showFilename = true;
  const itemHeight = thumbnailSize + (showFilename ? 24 : 0);
  const gap = 12;
  const padding = 16;

  const containerWidth = useContainerWidth(containerRef);

  const filteredImages = useFilteredAndSortedImages(
    library.images,
    filter.minRating,
    filter.colors,
    filter.rawStatus,
    sort.key,
    sort.direction,
    ratings.ratings,
    ratings.colorLabels
  );

  const allPaths = useMemo(
    () => filteredImages.map((img) => img.path),
    [filteredImages]
  );

  const columnCount = useMemo(() => {
    if (containerWidth === 0) return 1;
    const availableWidth = containerWidth - padding * 2;
    return Math.max(1, Math.floor((availableWidth + gap) / (thumbnailSize + gap)));
  }, [containerWidth, thumbnailSize]);

  const rowCount = useMemo(
    () => Math.ceil(filteredImages.length / columnCount),
    [filteredImages.length, columnCount]
  );

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => itemHeight + gap,
    overscan: 3,
    useFlushSync: false,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const visiblePaths = useMemo(() => {
    const paths: string[] = [];
    for (const virtualRow of virtualItems) {
      const startIndex = virtualRow.index * columnCount;
      for (let col = 0; col < columnCount; col++) {
        const imageIndex = startIndex + col;
        if (imageIndex < filteredImages.length) {
          paths.push(filteredImages[imageIndex].path);
        }
      }
    }
    return paths;
  }, [virtualItems, columnCount, filteredImages]);

  useEffect(() => {
    if (visiblePaths.length > 0) {
      thumbnailBloc.requestThumbnails(visiblePaths);
    }
  }, [visiblePaths, thumbnailBloc]);

  const handleImageDoubleClick = useCallback(
    (path: string) => {
      selectionBloc.selectSingle(path);
      appBloc.navigateToEditor();
    },
    [selectionBloc, appBloc]
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      const rowIndex = Math.floor(index / columnCount);
      rowVirtualizer.scrollToIndex(rowIndex, { align: 'auto' });
    },
    [columnCount, rowVirtualizer]
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
        case 'ArrowDown':
          newIndex = Math.min(currentIndex + columnCount, allPaths.length - 1);
          break;
        case 'ArrowUp':
          newIndex = Math.max(currentIndex - columnCount, 0);
          break;
        case 'a':
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            selectionBloc.selectAll(allPaths);
            return;
          }
          break;
        case 'Escape':
          selectionBloc.clearSelection();
          return;
        case 'Enter':
          if (selection.activePath) {
            handleImageDoubleClick(selection.activePath);
          }
          return;
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
        scrollToIndex(newIndex);
      }
    },
    [selection.activePath, allPaths, columnCount, selectionBloc, handleImageDoubleClick, scrollToIndex]
  );

  if (library.isLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-accent border-t-transparent" />
          <p className="text-sm text-text-secondary">Loading images...</p>
        </div>
      </div>
    );
  }

  if (library.error) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center p-4">
          <svg
            className="w-12 h-12 text-red-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p className="text-sm text-text-secondary">{library.error}</p>
        </div>
      </div>
    );
  }

  if (filteredImages.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center p-4">
          <svg
            className="w-12 h-12 text-text-secondary"
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
          <p className="text-sm text-text-secondary">
            {library.images.length === 0
              ? 'No images in this folder'
              : 'No images match the current filters'}
          </p>
        </div>
      </div>
    );
  }

  const _gridWidth = columnCount * thumbnailSize + (columnCount - 1) * gap;

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-auto focus:outline-none"
      style={{ padding }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualRow) => {
          const startIndex = virtualRow.index * columnCount;
          const rowImages = filteredImages.slice(startIndex, startIndex + columnCount);

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: `${gap}px`,
                  justifyContent: 'flex-start',
                }}
              >
                {rowImages.map((image) => (
                  <ImageCard
                    key={image.path}
                    image={image}
                    size={thumbnailSize}
                    aspectRatio={aspectRatio}
                    allPaths={allPaths}
                    onDoubleClick={handleImageDoubleClick}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 pb-4 text-center text-xs text-text-secondary">
        {selection.selectedPaths.length > 0 ? (
          <span>
            {selection.selectedPaths.length} of {filteredImages.length} selected
          </span>
        ) : (
          <span>{filteredImages.length} images</span>
        )}
      </div>
    </div>
  );
}
