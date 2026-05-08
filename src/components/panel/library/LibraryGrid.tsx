import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { List, useListCallbackRef } from 'react-window';
import { ChevronUp, ChevronDown } from 'lucide-react';
import debounce from 'lodash.debounce';
import { Row } from './LibraryItems';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { LibraryViewMode, SortDirection, ThumbnailSize } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights, TEXT_COLOR_KEYS } from '../../../types/typography';
import { ColumnWidths } from '../MainLibrary';
import { useProcessStore } from '../../../store/useProcessStore';

function ListHeader({
  widths,
  setWidths,
  containerRef,
  sortCriteria,
  onSortChange,
}: {
  widths: ColumnWidths;
  setWidths: React.Dispatch<React.SetStateAction<ColumnWidths>>;
  containerRef: React.RefObject<HTMLDivElement>;
  sortCriteria: any;
  onSortChange: (key: string) => void;
}) {
  const handleResize = (e: React.MouseEvent, leftCol: keyof ColumnWidths, rightCol: keyof ColumnWidths) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startLeftWidth = widths[leftCol];
    const startRightWidth = widths[rightCol];
    const containerWidth = containerRef.current?.clientWidth || 1000;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;

      let newLeft = startLeftWidth + deltaPercent;
      let newRight = startRightWidth - deltaPercent;

      if (newLeft < 1) {
        newRight -= 1 - newLeft;
        newLeft = 1;
      }
      if (newRight < 1) {
        newLeft -= 1 - newRight;
        newRight = 1;
      }

      setWidths((prev) => ({
        ...prev,
        [leftCol]: newLeft,
        [rightCol]: newRight,
      }));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const Column = ({
    title,
    widthKey,
    nextKey,
    sortKey,
  }: {
    title: string;
    widthKey: keyof ColumnWidths;
    nextKey?: keyof ColumnWidths;
    sortKey?: string;
  }) => {
    const isSorted = sortCriteria.key === sortKey;
    const isAsc = sortCriteria.order === SortDirection.Ascending;

    return (
      <div
        style={{ width: `${widths[widthKey]}%` }}
        className={`relative flex items-center px-3 h-full select-none ${
          sortKey ? 'cursor-pointer hover:bg-bg-primary/50 transition-colors' : ''
        }`}
        onClick={() => sortKey && onSortChange(sortKey)}
      >
        <Text
          variant={TextVariants.small}
          weight={TextWeights.semibold}
          color={isSorted ? TextColors.primary : TextColors.secondary}
          className="uppercase tracking-wider text-[11px]"
        >
          {title}
        </Text>
        {isSorted && (
          <span className={`ml-1 flex items-center ${TEXT_COLOR_KEYS[TextColors.primary]}`}>
            {isAsc ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        )}
        {nextKey && (
          <div
            className="absolute right-[-3px] top-1.5 bottom-1.5 w-[6px] cursor-col-resize z-10 group flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => handleResize(e, widthKey, nextKey)}
          >
            <div className="w-px h-full bg-border-color/40 group-hover:bg-accent transition-colors" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex items-center w-full h-9 bg-bg-secondary/80 backdrop-blur-sm border-b border-border-color/50 shrink-0">
      <Column title="" widthKey="thumbnail" nextKey="name" />
      <Column title="Name" widthKey="name" nextKey="date" sortKey="name" />
      <Column title="Modified" widthKey="date" nextKey="rating" sortKey="date" />
      <Column title="Rating" widthKey="rating" nextKey="color" sortKey="rating" />
      <Column title="Label" widthKey="color" />
    </div>
  );
}

const groupImagesByFolder = (images: any[], rootPath: string | null) => {
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
    if (a === rootPath) return -1;
    if (b === rootPath) return 1;
    return a.localeCompare(b);
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
  } = props;

  const { libraryScrollTop, listColumnWidths, setLibrary, sortCriteria, setSortCriteria } = useLibraryStore();
  const [gridSize, setGridSize] = useState({ height: 0, width: 0 });
  const [listHandle, setListHandle] = useListCallbackRef();
  const [collapsedRecursiveFolders, setCollapsedRecursiveFolders] = useState<Set<string>>(new Set());
  const libraryContainerRef = useRef<HTMLDivElement>(null);
  const gridObserverRef = useRef<ResizeObserver | null>(null);
  const loadedThumbnailsRef = useRef(new Set<string>());
  const prevScrollState = useRef({ path: null as string | null, top: -1, folder: null as string | null });
  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);

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
          const { height, width } = entry.contentRect;
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

  const gridData = useMemo(() => {
    if (gridSize.width === 0 || imageList.length === 0) return null;

    const isListView = thumbnailSize === ThumbnailSize.List;
    const OUTER_PADDING = isListView ? 0 : 12;
    const ITEM_GAP = isListView ? 0 : 12;
    const minThumbWidth = thumbnailSizeOptions.find((o: any) => o.id === thumbnailSize)?.size || 240;

    const availableWidth = gridSize.width - OUTER_PADDING * 2;
    const columnCount = isListView
      ? 1
      : Math.max(1, Math.floor((availableWidth + ITEM_GAP) / (minThumbWidth + ITEM_GAP)));
    const itemWidth = isListView ? availableWidth : (availableWidth - ITEM_GAP * (columnCount - 1)) / columnCount;

    const listRowHeight = Math.max(36, Math.min(300, (availableWidth * listColumnWidths.thumbnail) / 100));
    const rowHeight = isListView ? listRowHeight : itemWidth + ITEM_GAP;
    const headerHeight = 40;

    const rows: any[] = [];

    if (libraryViewMode === LibraryViewMode.Recursive) {
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
    gridSize.width,
    imageList,
    libraryViewMode,
    collapsedRecursiveFolders,
    thumbnailSize,
    listColumnWidths.thumbnail,
    currentFolderPath,
    thumbnailSizeOptions,
  ]);

  useEffect(() => {
    if (!listHandle?.element) return;

    const element = listHandle.element;
    const clientHeight = element.clientHeight;

    if (activePath && gridData) {
      const { rows, rowHeight, headerHeight, columnCount, isListView } = gridData;
      let targetTop = 0;
      let found = false;

      if (libraryViewMode === LibraryViewMode.Recursive) {
        const grps = groupImagesByFolder(imageList, currentFolderPath);
        for (const group of grps) {
          if (group.images.length === 0) continue;
          targetTop += headerHeight;
          const idx = group.images.findIndex((img) => img.path === activePath);
          if (idx !== -1) {
            targetTop += Math.floor(idx / columnCount) * rowHeight;
            found = true;
            break;
          }
          targetTop += Math.ceil(group.images.length / columnCount) * rowHeight;
        }
      } else {
        const idx = imageList.findIndex((img) => img.path === activePath);
        if (idx !== -1) {
          targetTop = Math.floor(idx / columnCount) * rowHeight;
          found = true;
        }
      }

      if (found) {
        const itemBottom = targetTop + rowHeight;
        const savedTop = Math.max(0, libraryScrollTop);
        const isVisibleAtSaved = targetTop < savedTop + clientHeight && itemBottom > savedTop;

        if (isVisibleAtSaved && libraryScrollTop > 0) {
          element.scrollTop = libraryScrollTop;
        } else {
          element.scrollTop = Math.max(0, targetTop - clientHeight / 2 + rowHeight / 2);
        }

        prevScrollState.current = {
          path: activePath,
          top: targetTop,
          folder: currentFolderPath,
        };
        return;
      }
    }

    if (libraryScrollTop > 0) {
      element.scrollTop = libraryScrollTop;
    }
  }, [listHandle]);

  useEffect(() => {
    if (!activePath || !gridData || multiSelectedPaths.length > 1) return;

    const { rows, rowHeight, headerHeight, columnCount } = gridData;

    let targetTop = 0;
    let found = false;

    if (libraryViewMode === LibraryViewMode.Recursive) {
      const groups = groupImagesByFolder(imageList, currentFolderPath);
      for (const group of groups) {
        if (group.images.length === 0) continue;

        targetTop += headerHeight;

        const imageIndex = group.images.findIndex((img) => img.path === activePath);
        if (imageIndex !== -1) {
          const rowIndex = Math.floor(imageIndex / columnCount);
          targetTop += rowIndex * rowHeight;
          found = true;
          break;
        }

        const rowsInGroup = Math.ceil(group.images.length / columnCount);
        targetTop += rowsInGroup * rowHeight;
      }
    } else {
      const index = imageList.findIndex((img) => img.path === activePath);
      if (index !== -1) {
        const rowIndex = Math.floor(index / columnCount);
        targetTop = rowIndex * rowHeight;
        found = true;
      }
    }

    if (found && listHandle?.element) {
      const prev = prevScrollState.current;

      const shouldScroll =
        activePath !== prev.path || Math.abs(targetTop - prev.top) > 1 || currentFolderPath !== prev.folder;

      if (shouldScroll) {
        const element = listHandle.element;
        const clientHeight = element.clientHeight;
        const scrollTop = element.scrollTop;
        const itemBottom = targetTop + rowHeight;
        const SCROLL_OFFSET = 120;

        if (itemBottom > scrollTop + clientHeight) {
          element.scrollTo({
            top: itemBottom - clientHeight + SCROLL_OFFSET,
            behavior: 'smooth',
          });
        } else if (targetTop < scrollTop) {
          element.scrollTo({
            top: targetTop - SCROLL_OFFSET,
            behavior: 'smooth',
          });
        }

        prevScrollState.current = {
          path: activePath,
          top: targetTop,
          folder: currentFolderPath,
        };
      }
    }
  }, [activePath, gridData, multiSelectedPaths.length, listHandle, currentFolderPath, imageList, libraryViewMode]);

  if (!gridData) {
    return (
      <div
        ref={libraryContainerRef}
        className="flex-1 w-full h-full"
        onClick={props.onClearSelection}
        onContextMenu={props.onEmptyAreaContextMenu}
      />
    );
  }

  const getItemSize = (index: number) => {
    if (gridData.rows[index].type === 'footer') return gridData.isListView ? 24 : gridData.OUTER_PADDING;
    return gridData.rows[index].type === 'header' ? gridData.headerHeight : gridData.rowHeight;
  };

  const handleHeaderSort = (key: string) => {
    props.onClearSelection();
    setSortCriteria((prev: any) => {
      if (prev.key === key) {
        if (prev.order === SortDirection.Ascending) {
          return { ...prev, order: SortDirection.Descening };
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
      className="flex-1 w-full h-full"
      onClick={props.onClearSelection}
      onContextMenu={props.onEmptyAreaContextMenu}
    >
      <div className="flex flex-col w-full h-full">
        {gridData.isListView && (
          <ListHeader
            widths={listColumnWidths}
            setWidths={(w: any) => setLibrary({ listColumnWidths: typeof w === 'function' ? w(listColumnWidths) : w })}
            containerRef={libraryContainerRef}
            sortCriteria={sortCriteria}
            onSortChange={handleHeaderSort}
          />
        )}
        <div
          key={`${gridSize.width}-${thumbnailSize}-${libraryViewMode}`}
          style={{ height: gridData.isListView ? gridSize.height - 36 : gridSize.height, width: gridSize.width }}
        >
          <List
            listRef={setListHandle}
            rowCount={gridData.rows.length}
            rowHeight={getItemSize}
            onScroll={(e: React.UIEvent<HTMLElement>) => handleScroll(e.currentTarget.scrollTop)}
            className="custom-scrollbar"
            rowComponent={Row}
            rowProps={{
              rows: gridData.rows,
              activePath,
              multiSelectedPaths,
              onContextMenu,
              onImageClick,
              onImageDoubleClick,
              thumbnailAspectRatio,
              loadedThumbnails: loadedThumbnailsRef.current,
              imageRatings,
              rootPath: currentFolderPath,
              itemWidth: gridData.itemWidth,
              itemHeight: gridData.isListView ? gridData.listRowHeight : gridData.itemWidth,
              outerPadding: gridData.OUTER_PADDING,
              gap: gridData.ITEM_GAP,
              isListView: gridData.isListView,
              columnWidths: listColumnWidths,
              queueThumbnailRequest,
              onToggleRecursiveFolder: (path: string) =>
                setCollapsedRecursiveFolders((prev) => {
                  const next = new Set(prev);
                  next.has(path) ? next.delete(path) : next.add(path);
                  return next;
                }),
            }}
          />
        </div>
      </div>
    </div>
  );
}
