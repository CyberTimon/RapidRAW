import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, useListCallbackRef } from 'react-window';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { Captions, Filter } from 'lucide-react';
import clsx from 'clsx';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { ImageFile } from '../../types/library';
import { ThumbnailAspectRatio } from '../../types/settings';
import { GroupBadgeInfo, GroupId } from '../../utils/imageGrouping';
import { useEditorStore } from '../../store/useEditorStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { MAX_FILMSTRIP_COLUMNS, useUIStore } from '../../store/useUIStore';
import { useAspectRatioMap } from '../../hooks/useAspectRatioMap';
import { useThumbnailRequestQueue } from '../../hooks/useThumbnailRequestQueue';
import { buildJustifiedRows } from './library/LibraryGrid';
import { Row } from './library/LibraryItems';
import { useFilmstripActivePath } from './Filmstrip';
import { QuickFilterControls, useQuickFilterToggle } from './QuickFilter';

const OUTER_PADDING = 12;
const ITEM_GAP = 12;
const SCROLLBAR_SIZE = 10;
const ZOOM_WHEEL_THRESHOLD = 40;

const noop = () => {};

interface GridRow {
  type: 'images' | 'footer';
  images?: ImageFile[];
  rowHeight?: number;
  justifiedWidths?: number[];
}

interface DockedFilmstripProps {
  imageList: ImageFile[];
  groupBadgeInfo: Map<GroupId, GroupBadgeInfo> | null;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  onClearSelection(): void;
  onContextMenu(event: React.MouseEvent, path: string): void;
  onEmptyAreaContextMenu(event: React.MouseEvent): void;
  onImageSelect(path: string, event: React.MouseEvent): void;
  onRequestThumbnails(paths: string[]): void;
}

function HeaderToggleButton({
  isActive,
  onClick,
  tooltip,
  children,
}: {
  isActive: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={clsx(
        'p-2 rounded-full transition-colors',
        isActive ? 'bg-surface text-text-primary' : 'hover:bg-surface',
      )}
      onClick={onClick}
      data-tooltip={tooltip}
      aria-label={tooltip}
      aria-pressed={isActive}
    >
      {children}
    </button>
  );
}

export default function DockedFilmstrip({
  imageList,
  groupBadgeInfo,
  thumbnailAspectRatio,
  onClearSelection,
  onContextMenu,
  onEmptyAreaContextMenu,
  onImageSelect,
  onRequestThumbnails,
}: DockedFilmstripProps) {
  const { t } = useTranslation();
  const selectedPath = useEditorStore((s) => s.selectedImage?.path);
  const { imageRatings, multiSelectedPaths } = useLibraryStore(
    useShallow((s) => ({ imageRatings: s.imageRatings, multiSelectedPaths: s.multiSelectedPaths })),
  );
  const activePath = useFilmstripActivePath(selectedPath, imageList);
  const { ratioMapRef, ratioMapVersion, onAspectRatioLoaded } = useAspectRatioMap();
  const { queueThumbnailRequest } = useThumbnailRequestQueue(onRequestThumbnails);
  const columns = useUIStore((s) => s.filmstripColumns);
  const showFileInfo = useUIStore((s) => s.filmstripShowFileInfo);
  const setUI = useUIStore((s) => s.setUI);
  const { isExpanded: isFilterExpanded, toggle: toggleQuickFilter } = useQuickFilterToggle('dockedQuickFilter');
  const [listHandle, setListHandle] = useListCallbackRef();
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let accumulatedDelta = 0;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      accumulatedDelta += event.deltaY;
      if (Math.abs(accumulatedDelta) < ZOOM_WHEEL_THRESHOLD) return;
      const step = Math.sign(accumulatedDelta);
      accumulatedDelta = 0;
      setUI((s) => ({
        filmstripColumns: Math.min(MAX_FILMSTRIP_COLUMNS, Math.max(1, s.filmstripColumns + step)),
      }));
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [setUI]);

  const layout = useMemo(() => {
    if (size.width === 0 || imageList.length === 0) return null;
    const isJustified = thumbnailAspectRatio === ThumbnailAspectRatio.Justified;

    const buildLayout = (width: number) => {
      const availableWidth = width - OUTER_PADDING * 2;
      const itemWidth = (availableWidth - ITEM_GAP * (columns - 1)) / columns;
      const rows: GridRow[] = isJustified
        ? buildJustifiedRows(imageList, ratioMapRef.current, availableWidth, itemWidth, ITEM_GAP)
        : Array.from({ length: Math.ceil(imageList.length / columns) }, (_, i) => ({
            type: 'images',
            images: imageList.slice(i * columns, (i + 1) * columns),
          }));
      const contentHeight = rows.reduce(
        (total, row) => total + (row.rowHeight || itemWidth) + ITEM_GAP,
        OUTER_PADDING * 2,
      );
      return { rows, itemWidth, contentHeight };
    };

    const fitted = buildLayout(size.width);
    const { rows, itemWidth } = fitted.contentHeight > size.height ? buildLayout(size.width - SCROLLBAR_SIZE) : fitted;
    return { rows: [...rows, { type: 'footer' } as GridRow], itemWidth };
  }, [size, imageList, thumbnailAspectRatio, columns, ratioMapRef, ratioMapVersion]);

  const activeRowIndex = useMemo(
    () => layout?.rows.findIndex((row) => row.images?.some((image) => image.path === activePath)) ?? -1,
    [layout, activePath],
  );

  const scrolledPathRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!listHandle || activeRowIndex < 0 || scrolledPathRef.current === activePath) return;
    listHandle.scrollToRow({
      index: activeRowIndex,
      align: 'smart',
      behavior: scrolledPathRef.current === undefined ? 'instant' : 'smooth',
    });
    scrolledPathRef.current = activePath;
  }, [listHandle, activeRowIndex, activePath]);

  const rowProps = useMemo(
    () => ({
      rows: layout?.rows ?? [],
      activePath,
      multiSelectedSet: new Set(multiSelectedPaths),
      onContextMenu,
      onImageClick: onImageSelect,
      onImageDoubleClick: noop,
      selectionModeActive: false,
      thumbnailAspectRatio,
      onImageLoad: noop,
      imageRatings,
      itemWidth: layout?.itemWidth ?? 0,
      itemHeight: layout?.itemWidth ?? 0,
      outerPadding: OUTER_PADDING,
      gap: ITEM_GAP,
      isListView: false,
      queueThumbnailRequest,
      onToggleRecursiveFolder: noop,
      groupBadgeInfo,
      onAspectRatioLoaded,
      showFileInfo,
    }),
    [
      layout,
      activePath,
      multiSelectedPaths,
      onContextMenu,
      onImageSelect,
      thumbnailAspectRatio,
      imageRatings,
      queueThumbnailRequest,
      groupBadgeInfo,
      onAspectRatioLoaded,
      showFileInfo,
    ],
  );

  const getRowHeight = useCallback(
    (index: number) => {
      const row = layout?.rows[index];
      if (!row || !layout) return 0;
      if (row.type === 'footer') return OUTER_PADDING;
      return (row.rowHeight || layout.itemWidth) + ITEM_GAP;
    },
    [layout],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.switcher.tooltips.filmstrip')}</Text>
        <div className="flex items-center gap-1">
          <HeaderToggleButton
            isActive={showFileInfo}
            onClick={() => setUI((s) => ({ filmstripShowFileInfo: !s.filmstripShowFileInfo }))}
            tooltip={t('library.sort.fileName')}
          >
            <Captions size={18} />
          </HeaderToggleButton>
          <HeaderToggleButton
            isActive={isFilterExpanded}
            onClick={toggleQuickFilter}
            tooltip={t('ui.bottomBar.tooltips.quickFilter')}
          >
            <Filter size={18} />
          </HeaderToggleButton>
        </div>
      </div>
      <div
        className={clsx(
          'grid shrink-0 transition-[grid-template-rows] duration-300 ease-in-out',
          isFilterExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <QuickFilterControls className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 border-b border-surface" />
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden"
        onClick={onClearSelection}
        onContextMenu={onEmptyAreaContextMenu}
      >
        {layout && (
          <div style={{ width: size.width, height: size.height }}>
            <List
              listRef={setListHandle}
              rowCount={layout.rows.length}
              rowHeight={getRowHeight}
              rowComponent={Row}
              rowProps={rowProps}
              className="custom-scrollbar"
              style={{ overflowX: 'hidden' }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
