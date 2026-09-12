import ListHeader from './LibraryListHeader';
import { getLibraryColumnWidths, libraryTableWidth } from '../../../utils/libraryColumns';
import { naturalNameCompare } from '../../../utils/librarySorting';
import { requestLibraryExif } from '../../../hooks/libraryExifQueue';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { setVisibleThumbnails } from '../../../utils/thumbnailCache';
import { useLibraryScrollAnchor } from '../../../hooks/useLibraryScrollAnchor';
import { List, useListCallbackRef } from 'react-window';
import debounce from 'lodash.debounce';
import { Row } from './LibraryItems';
import { useShallow } from 'zustand/react/shallow';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { LibraryViewMode, SortDirection, LibraryDisplayMode } from '../../ui/AppProperties';
import { useProcessStore } from '../../../store/useProcessStore';
import { ExifOverlay } from '../../ui/AppProperties';
import { useSettingsStore } from '../../../store/useSettingsStore';

const groupImagesByFolder = (images: any[], baseFolderPath: string | null) => {
  const groups: Record<string, any[]> = {};

  images.forEach((img) => {
    const physicalPath = img.path.split('?vc=')[0];
    const separator = physicalPath.includes('/') ? '/' : '\\';
    const lastSep = physicalPath.lastIndexOf(separator);
    const dir = lastSep > -1 ? physicalPath.substring(0, lastSep) : physicalPath;

    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(img);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    if (a === baseFolderPath) return -1;
    if (b === baseFolderPath) return 1;
    return naturalNameCompare(a, b);
  });

  return sortedKeys.map((dir) => ({
    path: dir,
    images: groups[dir],
  }));
};

export default function LibraryGrid(props: any) {
  const {
    imageList,
    libraryViewMode,
    thumbnailSize,
    libraryDisplayMode,
    currentFolderPath,
    activePath,
    multiSelectedPaths,
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
    thumbnailAspectRatio,
    imageRatings,
    onRequestThumbnails,
    thumbnailSizeOptions,
    onThumbnailSizeChange,
    groupBadgeInfo,
  } = props;
  const { listColumnWidths, setLibrary, sortCriteria, setSortCriteria } = useLibraryStore(
    useShallow((state) => ({
      listColumnWidths: state.listColumnWidths,
      setLibrary: state.setLibrary,
      sortCriteria: state.sortCriteria,
      setSortCriteria: state.setSortCriteria,
    })),
  );

  const groupRecursiveFolders = useLibraryStore((state) => state.groupRecursiveFolders);
  const [gridSize, setGridSize] = useState({ height: 0, width: 0 });
  const [listHandle, setListHandle] = useListCallbackRef();
  const [collapsedRecursiveFolders, setCollapsedRecursiveFolders] = useState<Set<string>>(new Set());
  const libraryContainerRef = useRef<HTMLDivElement>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);
  const loadedThumbnailsRef = useRef(new Set<string>());
  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);
  const exifOverlay = useSettingsStore((s) => s.appSettings?.exifOverlay || ExifOverlay.Off);
  const showExifCols = exifOverlay !== ExifOverlay.Off;

  useEffect(() => {
    const el = libraryContainerRef.current;
    if (gridObserverRef.current) {
      gridObserverRef.current.disconnect();
      gridObserverRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const height = Math.round(entry.contentRect.height);
          const width = Math.round(entry.contentRect.width);

          setGridSize((prev) => (prev.height === height && prev.width === width ? prev : { height, width }));
        }
      });
      ro.observe(el);
      gridObserverRef.current = ro;
    }
    return () => gridObserverRef.current?.disconnect();
  }, [libraryContainerRef]);

  useEffect(() => {
    const handleWheel = (event: any) => {
      const container = libraryContainerRef.current;
      if (!container || !container.contains(event.target)) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const currentIndex = thumbnailSizeOptions.findIndex((o: any) => o.id === thumbnailSize);
        if (currentIndex === -1) {
          return;
        }

        const nextIndex =
          event.deltaY < 0
            ? Math.min(currentIndex + 1, thumbnailSizeOptions.length - 1)
            : Math.max(currentIndex - 1, 0);
        if (nextIndex !== currentIndex) {
          onThumbnailSizeChange(thumbnailSizeOptions[nextIndex].id);
        }
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheel);
    };
  }, [thumbnailSize, onThumbnailSizeChange, thumbnailSizeOptions]);

  const handleScroll = useMemo(
    () =>
      debounce((top: number) => {
        setLibrary({ libraryScrollTop: top });
      }, 200),
    [setLibrary],
  );

  useEffect(() => () => handleScroll.cancel(), [handleScroll]);

  const queueThumbnailRequest = useCallback(
    (path: string) => {
      requestLibraryExif([path]);
      if (!onRequestThumbnails) return;
      if (useProcessStore.getState().thumbnails[path]) return;
      requestQueueRef.current.add(path);
      if (!requestTimeoutRef.current) {
        requestTimeoutRef.current = setTimeout(() => {
          const paths = Array.from(requestQueueRef.current);
          if (paths.length > 0) {
            onRequestThumbnails(paths);
            requestQueueRef.current.clear();
          }
          requestTimeoutRef.current = null;
        }, 50);
      }
    },
    [onRequestThumbnails],
  );

  const handleToggleRecursiveFolder = useCallback((path: string) => {
    setCollapsedRecursiveFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handleImageLoad = useCallback((path: string) => {
    loadedThumbnailsRef.current.add(path);
  }, []);

  const gridData = useMemo(() => {
    if (gridSize.width === 0 || imageList.length === 0) return null;

    const isListView = libraryDisplayMode === LibraryDisplayMode.List;
    const OUTER_PADDING = isListView ? 0 : 12;
    const ITEM_GAP = isListView ? 0 : 12;
    const minThumbWidth = thumbnailSizeOptions.find((o: any) => o.id === thumbnailSize)?.size || 240;

    const availableWidth = gridSize.width - OUTER_PADDING * 2;
    const columnCount = isListView
      ? 1
      : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
    const itemWidth = isListView ? availableWidth : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;

    const columns = getLibraryColumnWidths(listColumnWidths);
    const contentWidth = isListView ? Math.max(availableWidth, libraryTableWidth(columns, showExifCols) + 16) : availableWidth;
    const listRowHeight = Math.max(36, Math.min(300, columns.thumbnail));
    const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
    const headerHeight = 40;

    const rows: any[] = [];

    if (libraryViewMode === LibraryViewMode.Recursive && groupRecursiveFolders) {
      const groups = groupImagesByFolder(imageList, currentFolderPath);
      groups.forEach((group) => {
        if (group.images.length === 0) return;

        const isExpanded = !collapsedRecursiveFolders.has(group.path);
        rows.push({ type: 'header', path: group.path, count: group.images.length, isExpanded });

        if (isExpanded) {
          for (let i = 0; i < group.images.length; i += columnCount) {
            rows.push({
              type: 'images',
              images: group.images.slice(i, i + columnCount),
              startIndex: i,
            });
          }
        }
      });
    } else {
      for (let i = 0; i < imageList.length; i += columnCount) {
        rows.push({
          type: 'images',
          images: imageList.slice(i, i + columnCount),
          startIndex: i,
        });
      }
    }

    rows.push({ type: 'footer' });

    return {
      rows,
      contentWidth,
      itemWidth,
      rowHeight,
      listRowHeight,
      OUTER_PADDING,
      ITEM_GAP,
      columnCount,
      isListView,
      headerHeight,
    };
  }, [
    groupRecursiveFolders,
    gridSize.width,
    imageList,
    libraryViewMode,
    libraryDisplayMode,
    collapsedRecursiveFolders,
    thumbnailSize,
    listColumnWidths,
    showExifCols,
    currentFolderPath,
    thumbnailSizeOptions,
  ]);

  useEffect(() => {
    if (!listHandle?.element || !gridData) return;

    const savedTop = useLibraryStore.getState().libraryScrollTop;
    const element = listHandle.element as HTMLElement;

    if (savedTop > 0) {
      element.scrollTop = savedTop;
    }
  }, [listHandle, currentFolderPath]);

  const prevGrouping = useRef(groupRecursiveFolders);
  const prevActivePath = useRef<string | null>(null);
  const prevDisplayMode = useRef<LibraryDisplayMode | null>(null);
  const prevListElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!listHandle?.element || !gridData || multiSelectedPaths.length > 1) {
      prevActivePath.current = activePath;
      prevDisplayMode.current = libraryDisplayMode;
      if (listHandle?.element) prevListElement.current = listHandle.element as HTMLElement;
      return;
    }

    const element = listHandle.element as HTMLElement;
    const isPathSame = activePath === prevActivePath.current;
    const isModeSame = libraryDisplayMode === prevDisplayMode.current;
    const isElementSame = element === prevListElement.current;

    const isGroupingSame = prevGrouping.current === groupRecursiveFolders;
    prevGrouping.current = groupRecursiveFolders;
    if (isPathSame && isModeSame && isElementSame && isGroupingSame) return;

    prevActivePath.current = activePath;
    prevDisplayMode.current = libraryDisplayMode;
    prevListElement.current = element;

    const { rows, rowHeight, headerHeight } = gridData;
    let targetTop = gridData.OUTER_PADDING;
    let found = false;
    for (const row of rows) {
      if (row.images?.some((image: { path: string }) => image.path === activePath)) {
        found = true;
        break;
      }
      targetTop += row.type === 'header' ? headerHeight : rowHeight;
    }

    if (found) {
      const clientHeight = element.clientHeight;
      const scrollTop = element.scrollTop;
      const itemBottom = targetTop + rowHeight;
      const SCROLL_OFFSET = 120;

      if (!isModeSame || !isElementSame || !isGroupingSame) {
        element.scrollTo({
          top: Math.max(0, targetTop - clientHeight / 2 + rowHeight / 2),
          behavior: 'instant',
        });
      } else if (itemBottom > scrollTop + clientHeight) {
        element.scrollTo({
          top: itemBottom - clientHeight + SCROLL_OFFSET,
          behavior: 'smooth',
        });
      } else if (targetTop < scrollTop) {
        element.scrollTo({
          top: Math.max(0, targetTop - SCROLL_OFFSET),
          behavior: 'smooth',
        });
      }
    }
  }, [
    activePath,
    gridData,
    multiSelectedPaths.length,
    listHandle,
    currentFolderPath,
    imageList,
    libraryViewMode,
    groupRecursiveFolders,
    libraryDisplayMode,
  ]);

  const memoizedRowProps = useMemo(() => {
    if (!gridData) return {};

    return {
      rows: gridData.rows,
      activePath,
      multiSelectedSet: new Set(multiSelectedPaths),
      onContextMenu,
      onImageClick,
      onImageDoubleClick,
      thumbnailAspectRatio,
      onImageLoad: handleImageLoad,
      imageRatings,
      baseFolderPath: currentFolderPath,
      itemWidth: gridData.itemWidth,
      itemHeight: gridData.isListView ? gridData.listRowHeight : gridData.itemWidth,
      outerPadding: gridData.OUTER_PADDING,
      gap: gridData.ITEM_GAP,
      isListView: gridData.isListView,
      columnWidths: getLibraryColumnWidths(listColumnWidths),
      queueThumbnailRequest,
      onToggleRecursiveFolder: handleToggleRecursiveFolder,
      groupBadgeInfo,
    };
  }, [
    gridData,
    activePath,
    multiSelectedPaths,
    onContextMenu,
    onImageClick,
    onImageDoubleClick,
    thumbnailAspectRatio,
    handleImageLoad,
    imageRatings,
    currentFolderPath,
    listColumnWidths,
    queueThumbnailRequest,
    handleToggleRecursiveFolder,
    groupBadgeInfo,
  ]);

  const getItemSize = useCallback(
    (index: number) => {
      if (!gridData) return 0;
      if (gridData.rows[index].type === 'footer') return gridData.isListView ? 24 : gridData.OUTER_PADDING;
      return gridData.rows[index].type === 'header' ? gridData.headerHeight : gridData.rowHeight;
    },
    [gridData],
  );

  const visiblePaths = useRef<string[]>([]);
  useLibraryScrollAnchor(listHandle?.element, gridData, currentFolderPath);
  const onRowsRendered = useCallback(
    ({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) => {
      const paths =
        gridData?.rows
          .slice(startIndex, stopIndex + 1)
          .flatMap((row: { images?: { path: string }[] }) => row.images?.map((image) => image.path) ?? []) ?? [];
      visiblePaths.current = paths;
      setVisibleThumbnails(paths);
      onRequestThumbnails?.(paths);
    },
    [gridData, onRequestThumbnails],
  );
  useEffect(() => {
    const timer = setInterval(() => {
      if (libraryContainerRef.current?.getBoundingClientRect().height) {
        const missing = visiblePaths.current.filter((path) => !useProcessStore.getState().thumbnails[path]);
        if (missing.length) onRequestThumbnails?.(missing);
      }
    }, 6000);
    return () => {
      clearInterval(timer);
      clearTimeout(requestTimeoutRef.current);
    };
  }, [onRequestThumbnails]);

  if (!gridData) {
    return (
      <div
        ref={libraryContainerRef}
        className="flex-1 min-w-0 w-full h-full overflow-hidden"
        onClick={props.onClearSelection}
        onContextMenu={props.onEmptyAreaContextMenu}
      />
    );
  }

  const handleHeaderSort = (key: string) => {
    props.onClearSelection();
    setSortCriteria((prev: any) => {
      if (prev.key === key) {
        if (prev.order === SortDirection.Ascending) {
          return { ...prev, order: SortDirection.Descending };
        } else {
          return { key: 'name', order: SortDirection.Ascending };
        }
      }
      return { key, order: SortDirection.Ascending };
    });
  };

  return (
    <div
      ref={libraryContainerRef}
      className="flex-1 min-w-0 w-full h-full overflow-hidden"
      onClick={props.onClearSelection}
      onContextMenu={props.onEmptyAreaContextMenu}
    >
      <div className="w-full h-full overflow-x-auto overflow-y-hidden custom-scrollbar">
      <div className="flex flex-col h-full" style={{ width: gridData.contentWidth }}>
        {gridData.isListView && (
          <ListHeader
            widths={listColumnWidths}
            setWidths={(w: any) => setLibrary({ listColumnWidths: typeof w === 'function' ? w(listColumnWidths) : w })}
            sortCriteria={sortCriteria}
            onSortChange={handleHeaderSort}
          />
        )}
        <div className="flex-1 min-h-0" style={{ width: gridData.contentWidth }}>
          <List
            onRowsRendered={onRowsRendered}
            overscanCount={2}
            listRef={setListHandle}
            rowCount={gridData.rows.length}
            rowHeight={getItemSize}
            onScroll={(e: React.UIEvent<HTMLElement>) => handleScroll(e.currentTarget.scrollTop)}
            className="custom-scrollbar"
            style={{ height: '100%', overflowX: 'hidden' }}
            rowComponent={Row}
            rowProps={memoizedRowProps}
          />
        </div>
      </div>
      </div>
    </div>
  );
}
