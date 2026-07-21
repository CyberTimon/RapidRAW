import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Image as ImageIcon,
  Loader2,
  PanelBottom,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useShallow } from 'zustand/react/shallow';
import { setCullingFlagForPaths } from '../../../hooks/useCullingActions';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useUIStore } from '../../../store/useUIStore';
import { CullingFlag, isArchiveDirectory, joinPath, parentDirectory } from '../../../utils/cullingFlags';
import { ensureCullingPreview, prefetchCullingPreviews } from '../../../utils/cullingPreview';
import { ImageFile, Invokes } from '../../ui/AppProperties';
import Switch from '../../ui/Switch';

type CullingFilter = 'all' | 'unflagged' | 'pick' | 'reject';

interface CullingLoupeViewProps {
  activePath: string | null;
  currentFolderPath: string | null;
  imageList: ImageFile[];
  imageRatings: Record<string, number>;
  onEnterCompare(): void;
  onExit(): void;
  onRate(rating: number, paths?: string[]): void;
  onRefresh(): Promise<void> | void;
  onRequestThumbnails?(paths: string[]): void;
}

interface FlagHistoryEntry {
  path: string;
  previous: CullingFlag;
}

interface Point {
  x: number;
  y: number;
}

interface LoupeZoomState {
  percentage: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
}

interface LoupeCanvasHandle {
  reset(): void;
  toggleActualSize(): void;
  zoomIn(): void;
  zoomOut(): void;
}

interface LoupeCanvasProps {
  image: ImageFile;
  previewUrl: string | null;
  thumbnailUrl: string | undefined;
  isLoading: boolean;
  onZoomChange(state: LoupeZoomState): void;
}

const ARCHIVE_FOLDER_NAME = '_archived';
const MAX_ABSOLUTE_ZOOM = 4;
const ZOOM_STEP = 1.25;
const ZOOM_EPSILON = 0.001;

function physicalPath(path: string): string {
  return path.split('?vc=')[0];
}

function uniquePhysicalPaths(images: ImageFile[]): string[] {
  return Array.from(new Set(images.filter((image) => !image.is_virtual_copy).map((image) => physicalPath(image.path))));
}

const LoupeCanvas = forwardRef<LoupeCanvasHandle, LoupeCanvasProps>(function LoupeCanvas(
  { image, previewUrl, thumbnailUrl, isLoading, onZoomChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const dragOriginRef = useRef({ x: 0, y: 0 });
  const panOriginRef = useRef({ x: 0, y: 0 });
  const fitScaleRef = useRef(1);
  const zoomRef = useRef(1);
  const panRef = useRef<Point>({ x: 0, y: 0 });
  const loadedImagePathRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const reportZoom = useCallback(
    (nextZoom: number, fitScale = fitScaleRef.current) => {
      const maxZoom = Math.max(1, MAX_ABSOLUTE_ZOOM / fitScale);
      onZoomChange({
        percentage: Math.round(nextZoom * fitScale * 100),
        canZoomIn: nextZoom < maxZoom - ZOOM_EPSILON,
        canZoomOut: nextZoom > 1 + ZOOM_EPSILON,
      });
    },
    [onZoomChange],
  );

  const clampPan = useCallback((nextPan: Point, nextZoom: number): Point => {
    const container = containerRef.current;
    const element = imageRef.current;
    if (!container || !element?.naturalWidth || !element.naturalHeight) return { x: 0, y: 0 };

    const scaledWidth = element.naturalWidth * fitScaleRef.current * nextZoom;
    const scaledHeight = element.naturalHeight * fitScaleRef.current * nextZoom;
    const maxX = Math.max(0, (scaledWidth - container.clientWidth) / 2);
    const maxY = Math.max(0, (scaledHeight - container.clientHeight) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, nextPan.x)),
      y: Math.min(maxY, Math.max(-maxY, nextPan.y)),
    };
  }, []);

  const updatePan = useCallback(
    (nextPan: Point, nextZoom = zoomRef.current) => {
      const clampedPan = clampPan(nextPan, nextZoom);
      panRef.current = clampedPan;
      setPan(clampedPan);
    },
    [clampPan],
  );

  const updateViewport = useCallback(
    (nextZoom: number, nextPan: Point) => {
      const maxZoom = Math.max(1, MAX_ABSOLUTE_ZOOM / fitScaleRef.current);
      const clampedZoom = Math.min(maxZoom, Math.max(1, nextZoom));
      zoomRef.current = clampedZoom;
      setZoom(clampedZoom);
      updatePan(nextPan, clampedZoom);
      reportZoom(clampedZoom);
    },
    [reportZoom, updatePan],
  );

  const zoomTo = useCallback(
    (nextZoom: number, anchor: Point = { x: 0, y: 0 }) => {
      const currentZoom = zoomRef.current;
      const maxZoom = Math.max(1, MAX_ABSOLUTE_ZOOM / fitScaleRef.current);
      const clampedZoom = Math.min(maxZoom, Math.max(1, nextZoom));
      const ratio = clampedZoom / currentZoom;
      updateViewport(clampedZoom, {
        x: anchor.x - (anchor.x - panRef.current.x) * ratio,
        y: anchor.y - (anchor.y - panRef.current.y) * ratio,
      });
    },
    [updateViewport],
  );

  const reset = useCallback(() => updateViewport(1, { x: 0, y: 0 }), [updateViewport]);

  const zoomIn = useCallback(() => zoomTo(zoomRef.current * ZOOM_STEP), [zoomTo]);
  const zoomOut = useCallback(() => zoomTo(zoomRef.current / ZOOM_STEP), [zoomTo]);

  const toggleActualSize = useCallback(
    (anchor: Point = { x: 0, y: 0 }) => {
      const absoluteZoom = zoomRef.current * fitScaleRef.current;
      const nextZoom = Math.abs(absoluteZoom - 1) < 0.01 ? 1 : 1 / fitScaleRef.current;
      zoomTo(nextZoom, anchor);
    },
    [zoomTo],
  );

  useImperativeHandle(ref, () => ({ reset, toggleActualSize, zoomIn, zoomOut }), [
    reset,
    toggleActualSize,
    zoomIn,
    zoomOut,
  ]);

  const measureFitScale = useCallback(() => {
    const container = containerRef.current;
    const element = imageRef.current;
    if (!container || !element?.naturalWidth || !element.naturalHeight) return null;
    return Math.min(1, container.clientWidth / element.naturalWidth, container.clientHeight / element.naturalHeight);
  }, []);

  const handleImageLoad = useCallback(() => {
    const nextFitScale = measureFitScale();
    if (!nextFitScale || nextFitScale <= 0) return;
    const shouldReset = loadedImagePathRef.current !== image.path;
    loadedImagePathRef.current = image.path;
    fitScaleRef.current = nextFitScale;
    if (shouldReset) reset();
    else updateViewport(zoomRef.current, panRef.current);
  }, [image.path, measureFitScale, reset, updateViewport]);

  const handleResize = useCallback(() => {
    const nextFitScale = measureFitScale();
    if (!nextFitScale || nextFitScale <= 0) return;
    const previousFitScale = fitScaleRef.current;
    const wasFit = zoomRef.current <= 1 + ZOOM_EPSILON;
    const absoluteZoom = zoomRef.current * previousFitScale;
    fitScaleRef.current = nextFitScale;
    updateViewport(wasFit ? 1 : absoluteZoom / nextFitScale, panRef.current);
  }, [measureFitScale, updateViewport]);

  useEffect(() => {
    loadedImagePathRef.current = null;
    fitScaleRef.current = 1;
    pointerIdRef.current = null;
    setIsDragging(false);
    reset();
  }, [image.path, reset]);

  useEffect(() => {
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [handleResize]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (zoomRef.current <= 1 + ZOOM_EPSILON || pointerIdRef.current !== null || event.button !== 0) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    dragOriginRef.current = { x: event.clientX, y: event.clientY };
    panOriginRef.current = panRef.current;
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    updatePan({
      x: panOriginRef.current.x + event.clientX - dragOriginRef.current.x,
      y: panOriginRef.current.y + event.clientY - dragOriginRef.current.y,
    });
  };

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    pointerIdRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.preventDefault();
    toggleActualSize({
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const looksLikeTrackpadScroll =
      !event.ctrlKey && event.deltaMode === 0 && (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 40);
    if (looksLikeTrackpadScroll) {
      if (zoomRef.current > 1 + ZOOM_EPSILON) {
        updatePan({ x: panRef.current.x - event.deltaX, y: panRef.current.y - event.deltaY });
      }
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const intensity = event.ctrlKey ? 0.01 : 0.002;
    zoomTo(zoomRef.current * Math.exp(-event.deltaY * intensity), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  };

  return (
    <div
      ref={containerRef}
      className={clsx(
        'relative h-full w-full overflow-hidden bg-[#0a0b0d] touch-none',
        zoom > 1 + ZOOM_EPSILON ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
      )}
      onDoubleClick={handleDoubleClick}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onWheel={handleWheel}
    >
      {(previewUrl || thumbnailUrl) && (
        <img
          ref={imageRef}
          alt={physicalPath(image.path).split(/[\\/]/).pop() || ''}
          className="pointer-events-none absolute inset-0 m-auto max-h-full max-w-full select-none object-contain will-change-transform"
          draggable={false}
          onLoad={handleImageLoad}
          src={previewUrl || thumbnailUrl}
          style={{
            filter: previewUrl ? 'none' : 'blur(1px)',
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
            transformOrigin: 'center',
          }}
        />
      )}
      {isLoading && (
        <div className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md bg-black/55 text-white/80 backdrop-blur-sm">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
    </div>
  );
});

function ToolButton({
  children,
  className,
  tooltip,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip: string }) {
  return (
    <button
      className={clsx(
        'flex h-9 min-w-9 items-center justify-center gap-2 rounded-md px-2.5 text-sm font-medium',
        'text-white/75 hover:bg-white/10 hover:text-white active:scale-[0.97]',
        'transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'disabled:pointer-events-none disabled:opacity-35 motion-reduce:transition-none',
        className,
      )}
      data-tooltip={tooltip}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

function ShortcutKey({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden="true"
      className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-white/10 bg-black/20 px-1 text-[10px] font-semibold leading-none text-white/55"
    >
      {children}
    </kbd>
  );
}

export default function CullingLoupeView({
  activePath,
  currentFolderPath,
  imageList,
  imageRatings,
  onEnterCompare,
  onExit,
  onRate,
  onRefresh,
  onRequestThumbnails,
}: CullingLoupeViewProps) {
  const { t } = useTranslation();
  const { cullingFlags, cullingCounts, multiSelectedPaths, setLibrary } = useLibraryStore(
    useShallow((state) => ({
      cullingFlags: state.cullingFlags,
      cullingCounts: state.cullingCounts,
      multiSelectedPaths: state.multiSelectedPaths,
      setLibrary: state.setLibrary,
    })),
  );
  const thumbnails = useProcessStore((state) => state.thumbnails);
  const setUI = useUIStore((state) => state.setUI);
  const [filter, setFilter] = useState<CullingFilter>('all');
  const [currentPath, setCurrentPath] = useState(() =>
    activePath && imageList.some((image) => image.path === activePath) ? activePath : imageList[0]?.path || '',
  );
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [showFilmstrip, setShowFilmstrip] = useState(true);
  const [zoomState, setZoomState] = useState<LoupeZoomState>({
    percentage: 100,
    canZoomIn: true,
    canZoomOut: false,
  });
  const [comparePaths, setComparePaths] = useState<Set<string>>(() => new Set(multiSelectedPaths.slice(0, 4)));
  const [isFileActionRunning, setIsFileActionRunning] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const loupeCanvasRef = useRef<LoupeCanvasHandle>(null);
  const undoStackRef = useRef<FlagHistoryEntry[]>([]);
  const filmstripRefs = useRef(new Map<string, HTMLButtonElement>());

  const filteredImages = useMemo(
    () =>
      imageList.filter((image) => {
        const flag = cullingFlags[image.path] ?? null;
        if (filter === 'all') return true;
        if (filter === 'unflagged') return flag === null;
        return flag === filter;
      }),
    [cullingFlags, filter, imageList],
  );

  const currentIndex = filteredImages.findIndex((image) => image.path === currentPath);
  const currentImage = currentIndex >= 0 ? filteredImages[currentIndex] : filteredImages[0];
  const cachedPreviewUrl = useProcessStore((state) =>
    currentImage ? state.previews[currentImage.path]?.url : undefined,
  );
  const cachedPreviewThumbKey = useProcessStore((state) =>
    currentImage ? state.previews[currentImage.path]?.thumbKey : undefined,
  );
  const currentThumbnail = currentImage ? thumbnails[currentImage.path] : undefined;
  const overallIndex = currentImage ? imageList.findIndex((image) => image.path === currentImage.path) : -1;
  const currentFlag = currentImage ? (cullingFlags[currentImage.path] ?? null) : null;
  const currentRating = currentImage ? imageRatings[currentImage.path] || 0 : 0;
  const isArchivedFolder = isArchiveDirectory(currentFolderPath);

  const rejectedImages = useMemo(
    () => imageList.filter((image) => cullingFlags[image.path] === 'reject' && !image.is_virtual_copy),
    [cullingFlags, imageList],
  );
  const pickedImages = useMemo(
    () => imageList.filter((image) => cullingFlags[image.path] === 'pick' && !image.is_virtual_copy),
    [cullingFlags, imageList],
  );
  const clearablePaths = useMemo(() => uniquePhysicalPaths(imageList), [imageList]);

  useLayoutEffect(() => {
    const previous = useUIStore.getState();
    setUI({ isFullScreen: true, isInstantTransition: true });
    const frame = requestAnimationFrame(() => setUI({ isInstantTransition: previous.isInstantTransition }));
    return () => {
      cancelAnimationFrame(frame);
      setUI((state) => ({
        ...(state.isFullScreen ? { isFullScreen: previous.isFullScreen } : {}),
        ...(state.isInstantTransition ? { isInstantTransition: previous.isInstantTransition } : {}),
      }));
    };
  }, [setUI]);

  useEffect(() => {
    if (filteredImages.length === 0) {
      setCurrentPath('');
      return;
    }
    if (!filteredImages.some((image) => image.path === currentPath)) setCurrentPath(filteredImages[0].path);
  }, [currentPath, filteredImages]);

  useEffect(() => {
    if (!currentImage) return;
    setLibrary({ libraryActivePath: currentImage.path });
    filmstripRefs.current.get(currentImage.path)?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [currentImage, setLibrary]);

  useEffect(() => {
    if (!currentImage) {
      setPreviewUrl(null);
      return;
    }

    const thumbKey = currentThumbnail || '';
    if (cachedPreviewUrl && cachedPreviewThumbKey === thumbKey) {
      useProcessStore.getState().setPreview(currentImage.path, cachedPreviewUrl, thumbKey);
      setPreviewUrl(cachedPreviewUrl);
      setIsPreviewLoading(false);
      return;
    }

    let active = true;
    setPreviewUrl(null);
    setIsPreviewLoading(true);
    void ensureCullingPreview(currentImage)
      .then((url) => {
        if (active) setPreviewUrl(url);
      })
      .catch((error) => {
        if (active) {
          toast.error(
            t('library.loupe.previewLoadFailed', {
              error: String(error),
              defaultValue: `Failed to load preview: ${error}`,
            }),
          );
        }
      })
      .finally(() => {
        if (active) setIsPreviewLoading(false);
      });

    return () => {
      active = false;
    };
  }, [cachedPreviewThumbKey, cachedPreviewUrl, currentImage, currentThumbnail, t]);

  useEffect(() => {
    if (!currentImage) return;
    const index = imageList.findIndex((image) => image.path === currentImage.path);
    const neighbors = imageList.slice(Math.max(0, index - 3), Math.min(imageList.length, index + 4));
    prefetchCullingPreviews(neighbors.filter((image) => image.path !== currentImage.path));
    onRequestThumbnails?.(
      imageList.slice(Math.max(0, index - 10), Math.min(imageList.length, index + 11)).map((image) => image.path),
    );
  }, [currentImage, imageList, onRequestThumbnails]);

  const goToRelative = useCallback(
    (offset: number) => {
      if (filteredImages.length === 0) return;
      const index = Math.max(0, currentIndex);
      const nextIndex = Math.min(filteredImages.length - 1, Math.max(0, index + offset));
      setCurrentPath(filteredImages[nextIndex].path);
    },
    [currentIndex, filteredImages],
  );

  const applyFlag = useCallback(
    (flag: CullingFlag, options: { recordHistory?: boolean; advance?: boolean } = {}) => {
      if (!currentImage) return;
      const previous = cullingFlags[currentImage.path] ?? null;
      if (previous === flag) {
        if (options.advance ?? autoAdvance) goToRelative(1);
        return;
      }

      const nextPath =
        filteredImages[currentIndex + 1]?.path || filteredImages[currentIndex - 1]?.path || currentImage.path;
      if (options.recordHistory !== false) {
        undoStackRef.current.push({ path: currentImage.path, previous });
        if (undoStackRef.current.length > 100) undoStackRef.current.shift();
      }
      void setCullingFlagForPaths([currentImage.path], flag).catch(() => undefined);
      if ((options.advance ?? autoAdvance) && nextPath !== currentImage.path) {
        setCurrentPath(nextPath);
      }
    },
    [autoAdvance, cullingFlags, currentImage, currentIndex, filteredImages, goToRelative],
  );

  const undoLastFlag = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    setCurrentPath(entry.path);
    void setCullingFlagForPaths([entry.path], entry.previous).catch(() => undefined);
  }, []);

  const toggleComparePath = useCallback(() => {
    if (!currentImage) return;
    setComparePaths((previous) => {
      const next = new Set(previous);
      if (next.has(currentImage.path)) next.delete(currentImage.path);
      else if (next.size < 4) next.add(currentImage.path);
      else toast.info(t('library.loupe.compareLimit', { defaultValue: 'You can compare up to 4 photos.' }));
      return next;
    });
  }, [currentImage, t]);

  const enterCompare = useCallback(() => {
    const paths = comparePaths.size > 0 ? Array.from(comparePaths) : currentImage ? [currentImage.path] : [];
    if (paths.length === 0) return;
    setLibrary({ multiSelectedPaths: paths, libraryActivePath: paths[0] });
    onEnterCompare();
  }, [comparePaths, currentImage, onEnterCompare, setLibrary]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;

      const key = event.key.toLowerCase();
      const isUndo = key === 'z' && (event.ctrlKey || event.metaKey);
      const isZoomIn = key === '+' || key === '=';
      const isZoomOut = key === '-' || key === '_';
      const handled =
        isUndo ||
        isZoomIn ||
        isZoomOut ||
        ['p', 'x', 'u', 'c', 'escape', 'arrowleft', 'arrowright', ' ', 'enter', '0'].includes(key) ||
        /^[1-5]$/.test(key);
      if (!handled) return;
      if (event.repeat && !['arrowleft', 'arrowright', '+', '=', '-', '_'].includes(key)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (isUndo) undoLastFlag();
      else if (key === 'p') applyFlag('pick');
      else if (key === 'x') applyFlag('reject');
      else if (key === 'u') applyFlag(null);
      else if (key === 'arrowleft') goToRelative(-1);
      else if (key === 'arrowright') goToRelative(1);
      else if (key === ' ') loupeCanvasRef.current?.toggleActualSize();
      else if (isZoomIn) loupeCanvasRef.current?.zoomIn();
      else if (isZoomOut) loupeCanvasRef.current?.zoomOut();
      else if (key === '0') loupeCanvasRef.current?.reset();
      else if (key === 'c') toggleComparePath();
      else if (key === 'enter' && comparePaths.size > 0) enterCompare();
      else if (key === 'escape') onExit();
      else if (/^[1-5]$/.test(key) && currentImage) onRate(Number(key), [currentImage.path]);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    applyFlag,
    comparePaths.size,
    currentImage,
    enterCompare,
    goToRelative,
    onExit,
    onRate,
    toggleComparePath,
    undoLastFlag,
  ]);

  const runFileAction = useCallback(
    async (action: () => Promise<void>, successMessage: string) => {
      setIsFileActionRunning(true);
      try {
        await action();
        toast.success(successMessage);
        await onRefresh();
      } catch (error) {
        toast.error(String(error));
      } finally {
        setIsFileActionRunning(false);
      }
    },
    [onRefresh],
  );

  const archiveRejected = useCallback(() => {
    const paths = uniquePhysicalPaths(rejectedImages);
    if (paths.length === 0) return;
    void runFileAction(
      async () => {
        const grouped = new Map<string, string[]>();
        paths.forEach((path) => {
          const parent = parentDirectory(path);
          if (!parent || isArchiveDirectory(parent)) return;
          grouped.set(parent, [...(grouped.get(parent) || []), path]);
        });
        for (const [parent, sourcePaths] of grouped) {
          const destinationFolder = joinPath(parent, ARCHIVE_FOLDER_NAME);
          try {
            await invoke(Invokes.CreateFolder, { path: destinationFolder });
          } catch {
            // An existing archive folder is the normal case after the first round.
          }
          await invoke(Invokes.MoveFiles, { sourcePaths, destinationFolder });
        }
      },
      t('library.loupe.archiveComplete', { count: paths.length, defaultValue: `${paths.length} photos archived.` }),
    );
  }, [rejectedImages, runFileAction, t]);

  const restorePicked = useCallback(() => {
    if (!currentFolderPath || !isArchivedFolder) return;
    const paths = uniquePhysicalPaths(pickedImages);
    const destinationFolder = parentDirectory(currentFolderPath);
    if (paths.length === 0 || !destinationFolder) return;
    void runFileAction(
      () => invoke(Invokes.MoveFiles, { sourcePaths: paths, destinationFolder }),
      t('library.loupe.restoreComplete', { count: paths.length, defaultValue: `${paths.length} photos restored.` }),
    );
  }, [currentFolderPath, isArchivedFolder, pickedImages, runFileAction, t]);

  const confirmEmptyArchive = useCallback(() => {
    if (clearablePaths.length === 0) return;
    setUI({
      confirmModalState: {
        isOpen: true,
        title: t('library.loupe.emptyArchiveTitle', { defaultValue: 'Empty archive?' }),
        message: t('library.loupe.emptyArchiveMessage', {
          count: clearablePaths.length,
          defaultValue: `${clearablePaths.length} photos and their sidecars will be moved to the system Trash.`,
        }),
        confirmText: t('library.loupe.moveToTrash', { defaultValue: 'Move to Trash' }),
        confirmVariant: 'danger',
        onConfirm: () => {
          void runFileAction(
            () => invoke(Invokes.DeleteFilesFromDisk, { paths: clearablePaths }),
            t('library.loupe.emptyArchiveComplete', { defaultValue: 'Archive moved to the system Trash.' }),
          );
        },
      },
    });
  }, [clearablePaths, runFileAction, setUI, t]);

  const openAiSuggestions = () => {
    setUI({
      cullingModalState: {
        isOpen: true,
        progress: null,
        suggestions: null,
        error: null,
        pathsToCull: imageList.filter((image) => !image.is_virtual_copy).map((image) => image.path),
      },
    });
  };

  const filterOptions: Array<{ id: CullingFilter; label: string; count: number }> = [
    { id: 'all', label: t('library.loupe.all', { defaultValue: 'All' }), count: cullingCounts.total },
    {
      id: 'unflagged',
      label: t('library.loupe.unflagged', { defaultValue: 'Unflagged' }),
      count: cullingCounts.unflagged,
    },
    { id: 'pick', label: t('library.loupe.picks', { defaultValue: 'Picks' }), count: cullingCounts.pick },
    { id: 'reject', label: t('library.loupe.rejects', { defaultValue: 'Rejects' }), count: cullingCounts.reject },
  ];

  const fileName = currentImage ? physicalPath(currentImage.path).split(/[\\/]/).pop() || '' : '';

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#0a0b0d] text-white"
      aria-label={t('library.loupe.title', { defaultValue: 'Photo review' })}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#111316] px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">
            {fileName || t('library.loupe.noPhoto', { defaultValue: 'No photo' })}
          </div>
          <div className="truncate text-xs text-white/45">{currentFolderPath}</div>
        </div>

        <div className="shrink-0 tabular-nums text-sm text-white/55">
          {overallIndex >= 0 ? overallIndex + 1 : 0} / {imageList.length}
        </div>

        <div className="flex flex-1 items-center justify-end gap-1">
          <ToolButton
            onClick={openAiSuggestions}
            tooltip={t('library.loupe.aiSuggestions', { defaultValue: 'AI culling suggestions' })}
          >
            <Sparkles size={17} />
          </ToolButton>
          <ToolButton
            className={comparePaths.size > 0 ? 'bg-white/12 text-white' : undefined}
            onClick={enterCompare}
            tooltip={t('library.loupe.compare', { defaultValue: 'Open comparison view' })}
          >
            <Columns3 size={17} />
            {comparePaths.size > 0 && <span className="tabular-nums">{comparePaths.size}</span>}
          </ToolButton>
          <ToolButton
            className={showFilmstrip ? 'bg-white/12 text-white' : undefined}
            onClick={() => setShowFilmstrip((value) => !value)}
            tooltip={t('library.loupe.toggleFilmstrip', { defaultValue: 'Toggle filmstrip' })}
          >
            <PanelBottom size={17} />
          </ToolButton>
          <ToolButton onClick={onExit} tooltip={t('library.loupe.exit', { defaultValue: 'Exit review' })}>
            <X size={18} />
          </ToolButton>
        </div>
      </header>

      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-[#111316] px-3">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {filterOptions.map((option) => (
            <button
              key={option.id}
              aria-pressed={filter === option.id}
              className={clsx(
                'flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium active:scale-[0.97]',
                'transition-[transform,background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
                filter === option.id ? 'bg-white text-black' : 'text-white/55 hover:bg-white/8 hover:text-white',
              )}
              onClick={() => setFilter(option.id)}
              type="button"
            >
              {option.label}
              <span className={clsx('tabular-nums', filter === option.id ? 'text-black/55' : 'text-white/35')}>
                {option.count}
              </span>
            </button>
          ))}
        </div>
        <Switch
          checked={autoAdvance}
          className="w-36 shrink-0 gap-3 text-white [&_span]:text-white/65"
          label={t('library.loupe.autoAdvance', { defaultValue: 'Auto advance' })}
          onChange={setAutoAdvance}
          trackClassName="bg-white/12"
        />
      </div>

      <div className="relative min-h-0 flex-1">
        {currentImage ? (
          <>
            <LoupeCanvas
              ref={loupeCanvasRef}
              key={currentImage.path}
              image={currentImage}
              isLoading={isPreviewLoading}
              onZoomChange={setZoomState}
              previewUrl={previewUrl}
              thumbnailUrl={currentThumbnail}
            />
            <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
              {currentFlag && (
                <span
                  className={clsx(
                    'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm',
                    currentFlag === 'pick' ? 'bg-emerald-600/90' : 'bg-red-600/90',
                  )}
                >
                  {currentFlag === 'pick' ? <Check size={15} /> : <X size={15} />}
                  {currentFlag === 'pick'
                    ? t('library.loupe.pick', { defaultValue: 'Pick' })
                    : t('library.loupe.reject', { defaultValue: 'Reject' })}
                </span>
              )}
              {currentRating > 0 && (
                <span className="flex items-center gap-1 rounded-md bg-black/60 px-2.5 py-1.5 text-xs font-medium text-amber-300 backdrop-blur-sm">
                  {currentRating}
                  <Star aria-hidden="true" fill="currentColor" size={12} />
                </span>
              )}
            </div>
            <div className="absolute bottom-4 right-4 flex items-center gap-1 rounded-md bg-black/55 p-1 backdrop-blur-sm">
              <ToolButton
                onClick={() => goToRelative(-1)}
                tooltip={t('library.loupe.previous', { defaultValue: 'Previous photo' })}
              >
                <ChevronLeft size={18} />
              </ToolButton>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
              <ToolButton
                aria-label={t('modals.transform.zoomOutTooltip', { defaultValue: 'Zoom out' })}
                className="!min-w-9 !px-0"
                disabled={!zoomState.canZoomOut}
                onClick={() => loupeCanvasRef.current?.zoomOut()}
                tooltip={t('modals.transform.zoomOutTooltip', { defaultValue: 'Zoom out' })}
              >
                <ZoomOut size={18} />
              </ToolButton>
              <button
                aria-label={t('modals.transform.resetZoomTooltip', { defaultValue: 'Fit photo to view' })}
                className="h-9 w-14 shrink-0 rounded-md font-mono text-xs tabular-nums text-white/85 hover:bg-white/10 hover:text-white active:scale-[0.97]"
                data-tooltip={t('modals.transform.resetZoomTooltip', { defaultValue: 'Fit photo to view' })}
                onClick={() => loupeCanvasRef.current?.reset()}
                type="button"
              >
                {zoomState.percentage}%
              </button>
              <ToolButton
                aria-label={t('modals.transform.zoomInTooltip', { defaultValue: 'Zoom in' })}
                className="!min-w-9 !px-0"
                disabled={!zoomState.canZoomIn}
                onClick={() => loupeCanvasRef.current?.zoomIn()}
                tooltip={t('modals.transform.zoomInTooltip', { defaultValue: 'Zoom in' })}
              >
                <ZoomIn size={18} />
              </ToolButton>
              <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
              <ToolButton
                onClick={() => goToRelative(1)}
                tooltip={t('library.loupe.next', { defaultValue: 'Next photo' })}
              >
                <ChevronRight size={18} />
              </ToolButton>
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white/35">
            <ImageIcon size={32} />
            <span className="text-sm">
              {t('library.loupe.noPhotosInFilter', { defaultValue: 'No photos in this view' })}
            </span>
          </div>
        )}
      </div>

      {showFilmstrip && (
        <div className="flex h-24 shrink-0 items-center gap-2 overflow-x-auto border-t border-white/10 bg-[#111316] px-3 py-2">
          {filteredImages.map((image) => {
            const flag = cullingFlags[image.path] ?? null;
            const isCurrent = currentImage?.path === image.path;
            const isCompared = comparePaths.has(image.path);
            return (
              <button
                key={image.path}
                ref={(element) => {
                  if (element) filmstripRefs.current.set(image.path, element);
                  else filmstripRefs.current.delete(image.path);
                }}
                aria-current={isCurrent ? 'true' : undefined}
                className={clsx(
                  'relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-white/5 active:scale-[0.97]',
                  'transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
                  isCurrent ? 'ring-2 ring-white ring-offset-2 ring-offset-[#111316]' : 'opacity-70 hover:opacity-100',
                )}
                onClick={() => {
                  setCurrentPath(image.path);
                }}
                type="button"
              >
                {thumbnails[image.path] && (
                  <img alt="" className="h-full w-full object-cover" draggable={false} src={thumbnails[image.path]} />
                )}
                {flag && (
                  <span
                    className={clsx(
                      'absolute inset-x-0 bottom-0 h-1',
                      flag === 'pick' ? 'bg-emerald-500' : 'bg-red-500',
                    )}
                  />
                )}
                {isCompared && (
                  <span className="absolute right-1 top-1 flex h-5 min-w-5 items-center justify-center rounded bg-black/75 px-1 text-[10px] font-semibold text-white">
                    C
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <footer className="flex min-h-14 shrink-0 items-center gap-3 border-t border-white/10 bg-[#111316] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3 text-xs tabular-nums text-white/50">
          <span className="text-emerald-400">
            {t('library.loupe.pickCount', { count: cullingCounts.pick, defaultValue: `Picks ${cullingCounts.pick}` })}
          </span>
          <span className="text-red-400">
            {t('library.loupe.rejectCount', {
              count: cullingCounts.reject,
              defaultValue: `Rejects ${cullingCounts.reject}`,
            })}
          </span>
          <span>
            {t('library.loupe.unflaggedCount', {
              count: cullingCounts.unflagged,
              defaultValue: `Unflagged ${cullingCounts.unflagged}`,
            })}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1 rounded-md bg-white/5 p-1">
          <ToolButton
            className={currentFlag === 'pick' ? 'bg-emerald-600 text-white hover:bg-emerald-600' : undefined}
            onClick={() => applyFlag('pick')}
            tooltip={t('library.loupe.pick', { defaultValue: 'Pick' })}
          >
            <Check size={17} />
            <span className="hidden md:inline">{t('library.loupe.pick', { defaultValue: 'Pick' })}</span>
            <ShortcutKey>P</ShortcutKey>
          </ToolButton>
          <ToolButton
            className={currentFlag === 'reject' ? 'bg-red-600 text-white hover:bg-red-600' : undefined}
            onClick={() => applyFlag('reject')}
            tooltip={t('library.loupe.reject', { defaultValue: 'Reject' })}
          >
            <X size={17} />
            <span className="hidden md:inline">{t('library.loupe.reject', { defaultValue: 'Reject' })}</span>
            <ShortcutKey>X</ShortcutKey>
          </ToolButton>
          <ToolButton
            onClick={() => applyFlag(null)}
            tooltip={t('library.loupe.unflag', { defaultValue: 'Clear flag' })}
          >
            <RotateCcw size={16} />
            <ShortcutKey>U</ShortcutKey>
          </ToolButton>
        </div>

        <div className="flex flex-1 justify-end">
          {isArchivedFolder ? (
            <div className="flex items-center gap-1">
              <ToolButton
                disabled={pickedImages.length === 0 || isFileActionRunning}
                onClick={restorePicked}
                tooltip={t('library.loupe.restorePicks', { count: pickedImages.length, defaultValue: 'Restore picks' })}
              >
                {isFileActionRunning ? <Loader2 size={17} className="animate-spin" /> : <ArchiveRestore size={17} />}
                <span className="hidden lg:inline">
                  {t('library.loupe.restorePicks', {
                    count: pickedImages.length,
                    defaultValue: `Restore picks (${pickedImages.length})`,
                  })}
                </span>
              </ToolButton>
              <ToolButton
                className="text-red-300 hover:bg-red-500/15 hover:text-red-200"
                disabled={clearablePaths.length === 0 || isFileActionRunning}
                onClick={confirmEmptyArchive}
                tooltip={t('library.loupe.emptyArchive', {
                  count: clearablePaths.length,
                  defaultValue: 'Empty archive',
                })}
              >
                <Trash2 size={17} />
                <span className="hidden lg:inline">
                  {t('library.loupe.emptyArchive', {
                    count: clearablePaths.length,
                    defaultValue: `Empty archive (${clearablePaths.length})`,
                  })}
                </span>
              </ToolButton>
            </div>
          ) : (
            <ToolButton
              className="bg-white/8 text-white hover:bg-white/12"
              disabled={rejectedImages.length === 0 || isFileActionRunning}
              onClick={archiveRejected}
              tooltip={t('library.loupe.archiveRejects', {
                count: rejectedImages.length,
                defaultValue: 'Archive rejects',
              })}
            >
              {isFileActionRunning ? <Loader2 size={17} className="animate-spin" /> : <Archive size={17} />}
              <span className="hidden lg:inline">
                {t('library.loupe.archiveRejects', {
                  count: rejectedImages.length,
                  defaultValue: `Archive rejects (${rejectedImages.length})`,
                })}
              </span>
            </ToolButton>
          )}
        </div>
      </footer>
    </section>
  );
}
