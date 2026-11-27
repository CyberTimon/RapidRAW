import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { List, useListCallbackRef } from 'react-window';
import { useDndMonitor, useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import clsx from 'clsx';
import {
  BetweenHorizontalStart,
  FileEdit,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderRoot,
  FolderSearch,
  FlagOff,
  FlagTriangleLeft,
  FlagTriangleRight,
  Gauge,
  Import,
  Plus,
  Replace,
  Trash2,
} from 'lucide-react';
import Button from '../../ui/Button';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { Option, OPTION_SEPARATOR } from '../../../types/ui';
import { MediaRef, Ticks, VideoProject } from '../../../types/video';
import { benefitsFromProxy, createProxies } from '../../../store/videoJobs';
import { useProxyStateMap, useProxyStates } from '../../../store/videoProxies';
import {
  addMediaToProject,
  editProject,
  getVideo,
  isMediaCandidate,
  selectItems,
  useVideoStore,
} from '../../../store/useVideoStore';
import { editMediaAtPlayhead } from '../../../store/videoEditing';
import {
  BinScope,
  binOfMedia,
  binPath,
  binsOf,
  createBin,
  deleteBin,
  findBin,
  moveMediaToBin,
  renameBin,
  uniqueBinName,
} from '../../../utils/video/bins';
import { useFileDropTarget } from '../FileDropTarget';
import { draggedPaths } from '../timeline/drop';
import { EmptyState } from './MediaTile';
import {
  clearMediaRange,
  firstUses,
  locateMedia,
  markMediaRange,
  mediaName,
  removeMedia,
  revealPath,
  usedMediaIds,
  useMissingMedia,
} from './media';
import PoolPath from './PoolPath';
import { BIN_TARGET, dropOnBin, dropOnPool, isPoolMediaDrag } from './poolDrag';
import { buildPoolContent } from './poolEntries';
import { flagMedia, labelMedia, rateMedia, usePoolMetadata } from './poolMetadata';
import { colorLabelMenu, flagMenu, ratingMenu } from '../../../utils/metadataMenus';
import {
  GAP_X,
  GAP_Y,
  NAME_HEIGHT,
  PoolGridRow,
  PoolRow,
  PoolRowContext,
  ROW_PADDING_LEFT,
  ROW_PADDING_RIGHT,
  SCROLLBAR_WIDTH,
  layoutRows,
  poolRowKey,
  rowHeightOf,
} from './PoolRows';
import {
  TILE_WIDTHS,
  currentPoolBin,
  endNewBin,
  openBin,
  setPoolSelection,
  setRenamingBin,
  startNewBin,
  toggleGroup,
  useCurrentBin,
  usePoolSettings,
  usePoolView,
  activePoolSelection,
  selectedMediaIds,
  selectedMediaPaths,
} from './poolView';

interface ProjectMediaProps {
  query: string;
  onImport(): void;
}

const NO_MEDIA: Array<MediaRef> = [];
const PATH_SEPARATOR = ' › ';
const LIST_STYLE = { height: '100%', scrollbarGutter: 'stable' } as const;
const SCROLL_RETRIES = 4;

const rowIndexOf = (rows: Array<PoolRow>, mediaId: string) =>
  rows.findIndex(
    (row) => row.type === 'tiles' && row.tiles.some((tile) => tile.type === 'media' && tile.media.id === mediaId),
  );

const mediaById = (id: string) => getVideo().project?.media.find((media) => media.id === id) ?? null;

const NO_USE: ReadonlySet<string> = new Set();
let usedCache = NO_USE;

const stableUsedMedia = ({ project }: { project: VideoProject | null }) => {
  const next = project ? usedMediaIds(project) : NO_USE;
  if (next !== usedCache && (next.size !== usedCache.size || [...next].some((id) => !usedCache.has(id))))
    usedCache = next;
  return usedCache;
};

const binLabel = (project: BinScope, id: string) =>
  binPath(project, id)
    .map((bin) => bin.name)
    .join(PATH_SEPARATOR);

const editBins = (update: (project: VideoProject) => VideoProject) => editProject(update, undefined, false);

export default function ProjectMedia({ query, onImport }: ProjectMediaProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const media = useVideoStore((state) => state.project?.media ?? NO_MEDIA);
  const bins = useVideoStore((state) => state.project?.bins);
  const used = useVideoStore(stableUsedMedia);
  const library = useMemo(() => ({ media, bins }), [media, bins]);
  const info = useVideoStore((state) => state.media);
  const timelineSelection = useVideoStore((state) => state.selection);
  const timelineMedia = useVideoStore(useShallow((state) => selectedMediaIds(state.project, state.selection)));
  const poolSelection = usePoolView((state) => state.selection);
  const filters = usePoolView((state) => state.filters);
  const collapsed = usePoolView((state) => state.collapsed);
  const draft = usePoolView((state) => state.draft);
  const renaming = usePoolView((state) => state.renaming);
  const view = usePoolSettings();
  const location = useCurrentBin();
  const { files, captured } = usePoolMetadata(media, view.sort === 'date');
  const paths = useMemo(() => media.map((entry) => entry.path), [media]);
  const isMissing = useMissingMedia(paths);
  const isMissingRef = useRef(isMissing);
  isMissingRef.current = isMissing;
  const proxies = useProxyStateMap();
  const pressPlayhead = useRef<Ticks | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [listHandle, setListHandle] = useListCallbackRef();
  const { setNodeRef, isOver, active } = useDroppable({
    id: 'video-media-pool',
    data: { type: 'video-media-pool' },
  });
  const isFileTarget = useFileDropTarget((state) => state.target === 'pool');
  const dragged =
    isOver && active?.data.current?.type === 'library-image' && !isPoolMediaDrag(active) ? active.data.current : null;
  const isDropTarget = isFileTarget || (!!dragged && draggedPaths(dragged.path, dragged.paths).some(isMediaCandidate));
  const searching = query.length > 0;

  const activeSelection = poolSelection && poolSelection.base === timelineSelection ? poolSelection : null;
  const selectedIds = activeSelection ? activeSelection.ids : timelineMedia;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const content = useMemo(
    () =>
      buildPoolContent({
        project: library,
        location,
        query,
        filters,
        view,
        used,
        files,
        captured,
        info,
        collapsed,
        hasDraft: !!draft && !searching,
      }),
    [library, location, query, filters, view, used, files, captured, info, collapsed, draft, searching],
  );

  const visibleMedia = useMemo(
    () => content.blocks.flatMap((block) => block.tiles.flatMap((tile) => (tile.type === 'media' ? [tile.media] : []))),
    [content],
  );
  const visibleOrder = useRef<Array<string>>([]);
  visibleOrder.current = visibleMedia.map((entry) => entry.id);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const dragPaths = useMemo(() => {
    const chosen = visibleMedia.filter((entry) => selected.has(entry.id)).map((entry) => entry.path);
    return chosen.length > 1 ? chosen : undefined;
  }, [visibleMedia, selected]);

  const tooltips = useMemo(() => {
    if (!searching || binsOf(library).length === 0) return null;
    return new Map(
      visibleMedia.flatMap((entry) => {
        const bin = binOfMedia(library, entry);
        return bin ? [[entry.id, `${binLabel(library, bin)}${PATH_SEPARATOR}${mediaName(entry)}`] as const] : [];
      }),
    );
  }, [searching, library, visibleMedia]);

  const draftName = useMemo(
    () => (draft ? uniqueBinName(library, draft.parent, t('video.mediaPool.newBin')) : ''),
    [draft, library, t],
  );

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const tileWidthMin = TILE_WIDTHS[view.size];
  const innerWidth = Math.max(0, width - SCROLLBAR_WIDTH - ROW_PADDING_LEFT - ROW_PADDING_RIGHT);
  const columns = Math.max(1, Math.floor((innerWidth + GAP_X) / (tileWidthMin + GAP_X)));
  const tileWidth = (innerWidth - GAP_X * (columns - 1)) / columns;
  const tileRowHeight = Math.ceil((tileWidth * 9) / 16 + NAME_HEIGHT + GAP_Y);

  const rows = useMemo(() => layoutRows(content.blocks, columns), [content, columns]);
  const rowHeight = useCallback((index: number) => rowHeightOf(rows[index], tileRowHeight), [rows, tileRowHeight]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const focusTarget = timelineMedia[0] ?? null;
  const scrolledTo = useRef<string | null>(null);
  const pendingScroll = useRef<{ id: string; tries: number } | null>(null);
  useEffect(() => {
    if (!focusTarget) scrolledTo.current = null;
    if (!listHandle || !focusTarget || scrolledTo.current === focusTarget) return;
    const index = rowIndexOf(rows, focusTarget);
    if (index < 0) return;
    scrolledTo.current = focusTarget;
    pendingScroll.current = { id: focusTarget, tries: 0 };
    listHandle.scrollToRow({ index, align: 'auto' });
  }, [focusTarget, listHandle, rows]);

  const handleRowsRendered = useCallback(
    ({ startIndex, stopIndex }: { startIndex: number; stopIndex: number }) => {
      const pending = pendingScroll.current;
      if (!pending || !listHandle) return;
      const index = rowIndexOf(rowsRef.current, pending.id);
      if (index < 0 || (index >= startIndex && index <= stopIndex) || pending.tries >= SCROLL_RETRIES) {
        pendingScroll.current = null;
        return;
      }
      pending.tries += 1;
      listHandle.scrollToRow({ index, align: 'auto' });
    },
    [listHandle],
  );

  useEffect(() => {
    if (draft && listHandle) listHandle.scrollToRow({ index: 0 });
  }, [draft, listHandle]);

  useDndMonitor({
    onDragEnd: ({ active: source, over }) => {
      const target = over?.data.current;
      if (target?.type === BIN_TARGET) dropOnBin(source, target.bin);
      else if (target?.type === 'video-media-pool') dropOnPool(source, currentPoolBin());
    },
  });

  const targetsOf = useCallback((id: string) => {
    const chosen = selectedRef.current;
    if (chosen.size < 2 || !chosen.has(id)) return [id];
    const visible = visibleOrder.current.filter((entry) => chosen.has(entry));
    return visible.length > 1 ? visible : [id];
  }, []);

  const handleSelect = useCallback((id: string, event: MouseEvent) => {
    if (event.detail > 1) return;
    const { project: current, selection: base } = getVideo();
    const pool = activePoolSelection();
    const chosen = pool ? pool.ids : selectedMediaIds(current, base);
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      const anchor = pool?.anchor ?? chosen[0] ?? null;
      const order = visibleOrder.current;
      const from = anchor ? order.indexOf(anchor) : -1;
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setPoolSelection({ ids: additive ? [...new Set([...chosen, ...range])] : range, anchor, base });
        return;
      }
    }
    if (additive) {
      const ids = chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id];
      setPoolSelection({ ids, anchor: id, base });
      return;
    }
    pressPlayhead.current = getVideo().playhead;
    const use = current && firstUses(current).get(id);
    if (use) selectItems([use.id]);
    setPoolSelection({ ids: [id], anchor: id, base: getVideo().selection });
  }, []);

  const handleActivate = useCallback((_id: string, path: string) => {
    const time = pressPlayhead.current ?? getVideo().playhead;
    pressPlayhead.current = null;
    void addMediaToProject([path], { time });
  }, []);

  const handleLocate = useCallback((id: string) => {
    const entry = mediaById(id);
    if (entry) void locateMedia(entry);
  }, []);

  const handleAdd = useCallback((path: string) => void addMediaToProject([path]), []);

  const handleOpenBin = useCallback((id: string | null) => openBin(id), []);

  const handleBinName = useCallback(
    (id: string | null, name: string | null) => {
      if (id === null) {
        const pending = usePoolView.getState().draft;
        endNewBin();
        if (!pending || name === null) return;
        editBins((current) => {
          const parent = findBin(current, pending.parent) ? pending.parent : null;
          const [next, bin] = createBin(
            current,
            uniqueBinName(current, parent, name || t('video.mediaPool.newBin')),
            parent,
          );
          return pending.media.length > 0 ? moveMediaToBin(next, pending.media, bin.id) : next;
        });
        return;
      }
      setRenamingBin(null);
      if (name) editBins((current) => renameBin(current, id, name));
    },
    [t],
  );

  const moveToBinMenu = useCallback(
    (ids: Array<string>): Array<Option> => {
      const current = getVideo().project;
      if (!current) return [];
      const moving = current.media.filter((entry) => ids.includes(entry.id));
      const homes = new Set(moving.map((entry) => binOfMedia(current, entry)));
      const home = homes.size === 1 ? [...homes][0] : undefined;
      const move = (bin: string | null) => editBins((next) => moveMediaToBin(next, ids, bin));
      const bins = binsOf(current)
        .map((bin) => ({ id: bin.id, label: binLabel(current, bin.id) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return [
        { label: t('video.project.media'), icon: FolderRoot, disabled: home === null, onClick: () => move(null) },
        ...(bins.length > 0 ? [{ type: OPTION_SEPARATOR }] : []),
        ...bins.map((bin) => ({
          label: bin.label,
          icon: Folder,
          disabled: home === bin.id,
          onClick: () => move(bin.id),
        })),
        ...(searching
          ? []
          : [
              { type: OPTION_SEPARATOR },
              {
                label: t('video.mediaPool.newBin'),
                icon: FolderPlus,
                onClick: () => startNewBin(currentPoolBin(), ids),
              },
            ]),
      ];
    },
    [searching, t],
  );

  const handleMenu = useCallback(
    (event: MouseEvent, id: string, missing: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      const current = getVideo().project;
      const entry = mediaById(id);
      if (!current || !entry) return;
      const targets = targetsOf(id).flatMap((target) => {
        const found = mediaById(target);
        return found ? [found] : [];
      });
      const present = targets.filter((target) => !isMissingRef.current(target.path));
      const rated = present.filter((target) => target.kind !== 'sequence').map((target) => target.path);
      const selectedPaths = new Set(selectedMediaPaths());
      const keysAct = rated.length === selectedPaths.size && rated.every((path) => selectedPaths.has(path));
      const inUse = usedMediaIds(current);
      const removable = targets.filter((target) => !inUse.has(target.id));
      const proxyable = present.filter(
        (target) =>
          target.kind === 'video' &&
          benefitsFromProxy(getVideo().media[target.path]) &&
          (useProxyStates.getState().states[target.path]?.state ?? 'none') === 'none',
      );
      const offersProxies = targets.some(
        (target) => target.kind === 'video' && benefitsFromProxy(getVideo().media[target.path]),
      );
      const rect = event.currentTarget.getBoundingClientRect();
      const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
      showContextMenu(event.clientX, event.clientY, [
        ...(missing
          ? [
              { label: t('video.mediaPool.locate'), icon: FolderSearch, onClick: () => void locateMedia(entry) },
              { type: OPTION_SEPARATOR },
            ]
          : []),
        {
          label: t('video.mediaPool.addToTimeline'),
          icon: Plus,
          disabled: present.length === 0,
          onClick: () => void addMediaToProject(present.map((target) => target.path)),
        },
        {
          label: t('video.mediaPool.insertAtPlayhead'),
          icon: BetweenHorizontalStart,
          disabled: missing,
          onClick: () => void editMediaAtPlayhead(id, 'insert'),
          shortcut: 'video_insert',
        },
        {
          label: t('video.mediaPool.overwriteAtPlayhead'),
          icon: Replace,
          disabled: missing,
          onClick: () => void editMediaAtPlayhead(id, 'overwrite'),
          shortcut: 'video_overwrite',
        },
        ...(entry.kind !== 'image'
          ? [
              { type: OPTION_SEPARATOR },
              {
                icon: FlagTriangleRight,
                label: t('video.timeline.setIn'),
                disabled: missing,
                onClick: () => markMediaRange(entry, 'start', fraction),
                shortcut: 'video_set_in',
              },
              {
                icon: FlagTriangleLeft,
                label: t('video.timeline.setOut'),
                disabled: missing,
                onClick: () => markMediaRange(entry, 'end', fraction),
                shortcut: 'video_set_out',
              },
              {
                icon: FlagOff,
                label: t('video.timeline.clearRange'),
                disabled: !entry.range,
                onClick: () => clearMediaRange(entry),
                shortcut: 'video_clear_range',
              },
            ]
          : []),
        ...(rated.length > 0
          ? [
              { type: OPTION_SEPARATOR },
              ratingMenu(t, (rating) => rateMedia(rated, rating), keysAct),
              flagMenu(t, (flag) => flagMedia(rated, flag), keysAct),
              colorLabelMenu(t, (color) => void labelMedia(rated, color), false),
            ]
          : []),
        { type: OPTION_SEPARATOR },
        {
          label: t('video.mediaPool.moveToBin'),
          icon: FolderInput,
          submenu: moveToBinMenu(targets.map((target) => target.id)),
        },
        { type: OPTION_SEPARATOR },
        ...(offersProxies
          ? [
              {
                label: t('video.proxies.create'),
                icon: Gauge,
                disabled: proxyable.length === 0,
                onClick: () => void createProxies(proxyable.map((target) => target.path)),
              },
            ]
          : []),
        ...(entry.kind === 'sequence'
          ? []
          : [
              {
                label: t('contextMenus.thumbnail.showExplorer'),
                icon: Folder,
                disabled: missing,
                onClick: () => void revealPath(entry.path),
              },
            ]),
        {
          label: t('video.mediaPool.remove'),
          icon: Trash2,
          isDestructive: true,
          disabled: removable.length === 0,
          onClick: () =>
            editProject((next) => removable.reduce((project, target) => removeMedia(project, target.id), next)),
        },
      ]);
    },
    [showContextMenu, t, targetsOf, moveToBinMenu],
  );

  const handleBinMenu = useCallback(
    (event: MouseEvent, id: string) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { label: t('video.mediaPool.openBin'), icon: FolderOpen, onClick: () => openBin(id) },
        { label: t('video.mediaPool.renameBin'), icon: FileEdit, onClick: () => setRenamingBin(id) },
        { type: OPTION_SEPARATOR },
        {
          label: t('video.mediaPool.deleteBin'),
          icon: Trash2,
          isDestructive: true,
          onClick: () => editBins((next) => deleteBin(next, id)),
        },
      ]);
    },
    [showContextMenu, t],
  );

  const handleAreaMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      if (searching || !getVideo().project) return;
      showContextMenu(event.clientX, event.clientY, [
        { label: t('video.mediaPool.newBin'), icon: FolderPlus, onClick: () => startNewBin(currentPoolBin()) },
        { label: t('video.mediaPool.import'), icon: Import, onClick: onImport },
      ]);
    },
    [searching, showContextMenu, t, onImport],
  );

  const context = useMemo<PoolRowContext>(
    () => ({
      columns,
      selected,
      dragPaths,
      used,
      files,
      proxies,
      tooltips,
      renaming,
      draftName,
      isMissing,
      onSelect: handleSelect,
      onActivate: handleActivate,
      onLocate: handleLocate,
      onAdd: handleAdd,
      onMenu: handleMenu,
      onOpenBin: handleOpenBin,
      onBinMenu: handleBinMenu,
      onBinName: handleBinName,
      onRenameBin: setRenamingBin,
      onToggleGroup: toggleGroup,
    }),
    [
      columns,
      selected,
      dragPaths,
      used,
      files,
      proxies,
      tooltips,
      renaming,
      draftName,
      isMissing,
      handleSelect,
      handleActivate,
      handleLocate,
      handleAdd,
      handleMenu,
      handleOpenBin,
      handleBinMenu,
      handleBinName,
    ],
  );
  const rowProps = useMemo(() => ({ rows, context }), [rows, context]);

  const hasNothing = media.length === 0 && binsOf(library).length === 0 && !draft;
  const path = useMemo(() => (location ? binPath(library, location) : []), [library, location]);

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        'grow min-h-0 flex flex-col rounded-md transition-shadow',
        isDropTarget && 'ring-2 ring-inset ring-accent',
      )}
      onContextMenu={handleAreaMenu}
    >
      {location && !searching && <PoolPath path={path} onOpen={handleOpenBin} />}
      <div ref={frameRef} className="grow min-h-0 relative">
        {hasNothing ? (
          <EmptyState message={t('video.mediaPool.emptyProject')}>
            <Button onClick={onImport}>{t('video.mediaPool.import')}</Button>
          </EmptyState>
        ) : content.blocks.length === 0 ? (
          <EmptyState
            message={content.isEmpty && !searching ? t('video.mediaPool.emptyBin') : t('video.mediaPool.noMatches')}
          />
        ) : (
          width > 0 && (
            <List
              key={`${location ?? 'root'}:${searching}`}
              listRef={setListHandle}
              onRowsRendered={handleRowsRendered}
              data-drop-clip
              rowCount={rows.length}
              rowHeight={rowHeight}
              rowComponent={PoolGridRow}
              rowProps={rowProps}
              rowKey={poolRowKey}
              overscanCount={2}
              className="custom-scrollbar"
              style={LIST_STYLE}
            />
          )
        )}
      </div>
    </div>
  );
}
