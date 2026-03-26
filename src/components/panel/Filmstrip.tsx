import React, { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { Image as ImageIcon, Star } from 'lucide-react';
import { motion } from 'framer-motion';
import clsx from 'clsx';
import { Grid, useGridCallbackRef } from 'react-window';
import { ImageFile, SelectedImage, ThumbnailAspectRatio } from '../ui/AppProperties';
import { Color, COLOR_LABELS } from '../../utils/adjustments';

const VERTICAL_PADDING = 24;
const HORIZONTAL_PADDING = 4;
const ITEM_GAP = 8;

interface ImageLayer {
  id: string;
  url: string;
  opacity: number;
}

interface ItemData {
  imageList: ImageFile[];
  imageRatings: any;
  selectedPath: string | undefined;
  multiSelectedPaths: string[];
  thumbnails: Record<string, string> | undefined;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  onRequestThumbnails?: (paths: string[]) => void;
  onContextMenu?: (event: any, path: string) => void;
  onImageSelect?: (path: string, event: any) => void;
  itemHeight: number;
  setSize: (index: number, width: number) => void;
}

const FilmstripThumbnail = memo(
  ({
    imageFile,
    imageRatings,
    isActive,
    isSelected,
    onContextMenu,
    onImageSelect,
    thumbData,
    thumbnailAspectRatio,
    itemHeight,
    index,
    setSize,
    knownWidth,
  }: {
    imageFile: ImageFile;
    imageRatings: any;
    isActive: boolean;
    isSelected: boolean;
    onContextMenu?: (event: any, path: string) => void;
    onImageSelect?: (path: string, event: any) => void;
    thumbData: string | undefined;
    thumbnailAspectRatio: ThumbnailAspectRatio;
    itemHeight: number;
    index: number;
    setSize: (index: number, width: number) => void;
    knownWidth: number;
  }) => {
    const [layers, setLayers] = useState<ImageLayer[]>(() => {
      return thumbData ? [{ id: thumbData, url: thumbData, opacity: 1 }] : [];
    });

    const latestThumbDataRef = useRef<string | undefined>(thumbData);
    const isInitialLoad = useRef(true);

    const { path, tags } = imageFile;
    const rating = imageRatings?.[path] || 0;
    const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
    const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);
    const isVirtualCopy = path.includes('?vc=');

    const cleanPath = path.split('?')[0];
    const filename = cleanPath.split(/[\\/]/).pop() || '';

    const truncatedTitle =
      filename.length > 40 ? filename.substring(0, 20) + '...' + filename.substring(filename.length - 17) : filename;

    useEffect(() => {
      if (thumbnailAspectRatio === ThumbnailAspectRatio.Contain && thumbData) {
        const img = new Image();
        img.onload = () => {
          const ratio = img.naturalWidth / img.naturalHeight;
          const calculatedWidth = itemHeight * ratio;

          if (Math.abs(calculatedWidth - knownWidth) > 1) {
            setSize(index, calculatedWidth);
          }

          if (isInitialLoad.current) {
            setTimeout(() => {
              isInitialLoad.current = false;
            }, 50);
          }
        };
        img.src = thumbData;
      }
    }, [thumbData, thumbnailAspectRatio, itemHeight, index, setSize, knownWidth]);

    useEffect(() => {
      if (!thumbData) {
        setLayers([]);
        latestThumbDataRef.current = undefined;
        return;
      }

      if (thumbData !== latestThumbDataRef.current) {
        latestThumbDataRef.current = thumbData;

        if (layers.length === 0) {
          setLayers([{ id: thumbData, url: thumbData, opacity: 1 }]);
          return;
        }

        const img = new Image();
        img.src = thumbData;
        img.onload = () => {
          if (img.src === latestThumbDataRef.current) {
            setLayers((prev) => {
              if (prev.some((l) => l.id === img.src)) return prev;
              return [...prev, { id: img.src, url: img.src, opacity: 0 }];
            });
          }
        };
        return () => {
          img.onload = null;
        };
      }
    }, [thumbData, layers.length]);

    useEffect(() => {
      const layerToFadeIn = layers.find((l) => l.opacity === 0);
      if (layerToFadeIn) {
        const timer = setTimeout(() => {
          setLayers((prev) => prev.map((l) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)));
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [layers]);

    const handleTransitionEnd = useCallback((finishedId: string) => {
      setLayers((prev) => {
        const finishedIndex = prev.findIndex((l) => l.id === finishedId);
        if (finishedIndex < 0 || prev.length <= 1) return prev;
        return prev.slice(finishedIndex);
      });
    }, []);

    const ringClass = isActive
      ? 'ring-2 ring-accent shadow-md'
      : isSelected
        ? 'ring-2 ring-gray-400'
        : 'hover:ring-2 hover:ring-hover-color';

    const imageClasses = `w-full h-full group-hover:scale-[1.02] transition-transform duration-300`;

    return (
      <motion.div
        className={clsx(
          'h-full w-full rounded-md overflow-hidden cursor-pointer shrink-0 group relative transition-all duration-150 bg-surface',
          ringClass,
        )}
        onClick={(e: any) => {
          e.stopPropagation();
          onImageSelect?.(path, e);
        }}
        onContextMenu={(e: any) => onContextMenu?.(e, path)}
        style={{
          zIndex: isActive ? 2 : isSelected ? 1 : 'auto',
        }}
        data-tooltip={truncatedTitle}
      >
        {layers.length > 0 ? (
          <div className="absolute inset-0 w-full h-full">
            {layers.map((layer) => (
              <div
                key={layer.id}
                className="absolute inset-0 w-full h-full"
                style={{
                  opacity: layer.opacity,
                  transition: 'opacity 150ms ease-in-out',
                  willChange: 'opacity',
                }}
                onTransitionEnd={() => handleTransitionEnd(layer.id)}
              >
                {thumbnailAspectRatio === ThumbnailAspectRatio.Contain && (
                  <img
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover blur-md scale-110 opacity-50"
                    src={layer.url}
                  />
                )}
                <img
                  alt={truncatedTitle}
                  className={`${imageClasses} ${
                    thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover'
                  } relative`}
                  loading="lazy"
                  decoding="async"
                  src={layer.url}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-surface">
            <ImageIcon size={24} className="text-text-secondary animate-pulse" />
          </div>
        )}

        {(colorLabel || rating > 0) && (
          <div className="absolute top-1 right-1 bg-primary rounded-full px-1.5 py-0.5 text-xs text-white flex items-center gap-1 backdrop-blur-xs shadow-xs z-10">
            {colorLabel && (
              <div
                className="w-3 h-3 rounded-full ring-1 ring-black/20"
                style={{ backgroundColor: colorLabel.color }}
                data-tooltip={`Color: ${colorLabel.name}`}
              />
            )}
            {rating > 0 && (
              <>
                <span>{rating}</span>
                <Star size={10} className="fill-white text-white" />
              </>
            )}
          </div>
        )}
        {isVirtualCopy && (
          <div className="absolute bottom-1 right-1 z-10">
            <div
              data-tooltip="Virtual Copy"
              className="bg-bg-primary/70 text-white text-[10px] font-bold px-1 py-0.5 rounded-full backdrop-blur-xs"
            >
              VC
            </div>
          </div>
        )}
      </motion.div>
    );
  },
);

const FilmstripCell = ({
  columnIndex,
  style,
  imageList,
  imageRatings,
  selectedPath,
  multiSelectedPaths,
  thumbnails,
  thumbnailAspectRatio,
  onContextMenu,
  onImageSelect,
  itemHeight,
  setSize,
}: any) => {
  const imageFile = imageList[columnIndex];
  const fullWidth = style.width as number;
  const contentWidth = fullWidth - ITEM_GAP;

  return (
    <div
      style={{
        ...style,
        height: '100%',
        left: (style.left as number) + HORIZONTAL_PADDING,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-start',
      }}
    >
      <div style={{ width: contentWidth, height: itemHeight }}>
        <FilmstripThumbnail
          imageFile={imageFile}
          imageRatings={imageRatings}
          isActive={selectedPath === imageFile.path}
          isSelected={multiSelectedPaths.includes(imageFile.path)}
          onContextMenu={onContextMenu}
          onImageSelect={onImageSelect}
          thumbData={thumbnails ? thumbnails[imageFile.path] : undefined}
          thumbnailAspectRatio={thumbnailAspectRatio}
          itemHeight={itemHeight}
          index={columnIndex}
          setSize={setSize}
          knownWidth={contentWidth}
        />
      </div>
    </div>
  );
};

const FilmstripList = ({
  height,
  width,
  data,
}: {
  height: number;
  width: number;
  data: Omit<ItemData, 'itemHeight' | 'setSize'> & { clickTriggeredScroll: React.RefObject<boolean> };
}) => {
  const [gridHandle, setGridHandle] = useGridCallbackRef();
  const sizeMapRef = useRef<Record<number, number>>({});
  const [sizeMapVersion, setSizeMapVersion] = useState(0);
  const visibleRange = useRef({ start: 0, stop: 0 });
  const prevSelectedPath = useRef<string | null>(null);
  const isReadyForSmooth = useRef(false);
  const resizeEndTimer = useRef<number | null>(null);
  const currentDataRef = useRef(data);
  currentDataRef.current = data;
  const pendingResizeRef = useRef<number | null>(null);
  const lowestPendingIndexRef = useRef<number>(Infinity);
  const isAnimatingScroll = useRef(false);
  const scrollAnimationTimeout = useRef<any>(null);
  const pendingScrollTarget = useRef<number | null>(null);
  const hasCompletedInitialScroll = useRef(false);
  const itemHeight = Math.max(20, height - VERTICAL_PADDING);

  const getColumnWidth = useCallback(
    (index: number) => {
      let w;
      if (data.thumbnailAspectRatio === ThumbnailAspectRatio.Cover) {
        w = itemHeight;
      } else {
        w = sizeMapRef.current[index] || itemHeight * 1.5;
      }
      return w + ITEM_GAP;
    },
    // sizeMapVersion ensures a new function reference when sizes change
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.thumbnailAspectRatio, itemHeight, sizeMapVersion],
  );

  useEffect(() => {
    isReadyForSmooth.current = false;
    const timer = setTimeout(() => {
      isReadyForSmooth.current = true;
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isReadyForSmooth.current) {
      return;
    }

    if (resizeEndTimer.current) clearTimeout(resizeEndTimer.current);

    resizeEndTimer.current = window.setTimeout(() => {
      const { selectedPath, imageList, multiSelectedPaths } = currentDataRef.current;

      if (selectedPath && gridHandle && multiSelectedPaths.length <= 1) {
        const index = imageList.findIndex((img) => img.path === selectedPath);
        if (index !== -1) {
          gridHandle.scrollToColumn({ index, align: 'center', behavior: 'smooth' });
        }
      }
    }, 500);

    return () => {
      if (resizeEndTimer.current) clearTimeout(resizeEndTimer.current);
    };
  }, [height, gridHandle]);

  useEffect(() => {
    return () => {
      if (pendingResizeRef.current !== null) {
        cancelAnimationFrame(pendingResizeRef.current);
      }
      if (scrollAnimationTimeout.current) {
        clearTimeout(scrollAnimationTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    sizeMapRef.current = {};
    setSizeMapVersion((v) => v + 1);
  }, [height, data.thumbnailAspectRatio]);

  const onCellsRendered = useCallback(
    (
      visibleCells: { columnStartIndex: number; columnStopIndex: number; rowStartIndex: number; rowStopIndex: number },
      allCells: { columnStartIndex: number; columnStopIndex: number; rowStartIndex: number; rowStopIndex: number },
    ) => {
      visibleRange.current = {
        start: visibleCells.columnStartIndex,
        stop: visibleCells.columnStopIndex,
      };

      const currentData = currentDataRef.current;
      if (currentData.onRequestThumbnails) {
        const pathsToRequest: string[] = [];

        for (let i = allCells.columnStartIndex; i <= allCells.columnStopIndex; i++) {
          const img = currentData.imageList[i];
          if (img && (!currentData.thumbnails || !currentData.thumbnails[img.path])) {
            pathsToRequest.push(img.path);
          }
        }

        if (pathsToRequest.length > 0) {
          currentData.onRequestThumbnails(pathsToRequest);
        }
      }
    },
    [],
  );

  const isItemVisible = useCallback((index: number) => {
    const { start, stop } = visibleRange.current;
    return index > start && index < stop;
  }, []);

  const performSafeScroll = useCallback(
    (index: number, bypassLock = false) => {
      if (!gridHandle) return;

      if (!bypassLock && isAnimatingScroll.current) {
        pendingScrollTarget.current = index;
        return;
      }

      isAnimatingScroll.current = true;
      pendingScrollTarget.current = null;

      gridHandle.scrollToColumn({
        index,
        align: 'center',
        behavior: isReadyForSmooth.current ? 'smooth' : 'instant',
      });

      if (scrollAnimationTimeout.current) clearTimeout(scrollAnimationTimeout.current);

      scrollAnimationTimeout.current = setTimeout(() => {
        isAnimatingScroll.current = false;

        if (pendingScrollTarget.current !== null && pendingScrollTarget.current !== index) {
          const nextTarget = pendingScrollTarget.current;
          if (!isItemVisible(nextTarget)) {
            performSafeScroll(nextTarget);
          } else {
            pendingScrollTarget.current = null;
          }
        }
      }, 250);
    },
    [gridHandle, isItemVisible],
  );

  useEffect(() => {
    const currentPath = data.selectedPath;

    if (currentPath && gridHandle) {
      if (data.multiSelectedPaths.length > 1) {
        prevSelectedPath.current = currentPath;
        if (data.clickTriggeredScroll.current) {
          data.clickTriggeredScroll.current = false;
        }
        return;
      }

      const index = data.imageList.findIndex((img) => img.path === currentPath);

      if (index !== -1) {
        if (currentPath !== prevSelectedPath.current) {
          const isVisible = isItemVisible(index);

          if (data.clickTriggeredScroll.current) {
            data.clickTriggeredScroll.current = false;
            performSafeScroll(index, true);
          } else if (!isVisible) {
            performSafeScroll(index);
          }
          prevSelectedPath.current = currentPath;
        } else {
          if (!hasCompletedInitialScroll.current && !isItemVisible(index)) {
            performSafeScroll(index, true);
          }
          hasCompletedInitialScroll.current = true;
        }
      }
    }
  }, [
    data.selectedPath,
    data.multiSelectedPaths,
    data.imageList,
    isItemVisible,
    data.clickTriggeredScroll,
    performSafeScroll,
    gridHandle,
  ]);

  const setSize = useCallback((index: number, width: number) => {
    if (sizeMapRef.current[index] !== width) {
      sizeMapRef.current[index] = width;

      if (index < lowestPendingIndexRef.current) {
        lowestPendingIndexRef.current = index;
      }

      if (pendingResizeRef.current === null) {
        pendingResizeRef.current = requestAnimationFrame(() => {
          setSizeMapVersion((v) => v + 1);
          lowestPendingIndexRef.current = Infinity;
          pendingResizeRef.current = null;
        });
      }
    }
  }, []);

  const cellProps = useMemo(
    () => ({
      ...data,
      itemHeight,
      setSize,
    }),
    [data, itemHeight, setSize],
  );

  return (
    <div style={{ height, width }}>
      <Grid
        gridRef={setGridHandle}
        defaultWidth={width}
        rowCount={1}
        rowHeight={height}
        columnCount={data.imageList.length}
        columnWidth={getColumnWidth}
        cellComponent={FilmstripCell}
        cellProps={cellProps}
        className="custom-scrollbar"
        style={{ overflowY: 'hidden' }}
        onWheel={(e: React.WheelEvent<HTMLDivElement>) => {
          if (e.deltaY !== 0 && Math.abs(e.deltaX) < Math.abs(e.deltaY)) {
            e.currentTarget.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
        onCellsRendered={onCellsRendered}
        overscanCount={16}
      />
    </div>
  );
};

interface FilmStripProps {
  imageList: Array<ImageFile>;
  imageRatings: any;
  isLoading: boolean;
  multiSelectedPaths: Array<string>;
  onClearSelection?(): void;
  onContextMenu?(event: any, path: string): void;
  onImageSelect?(path: string, event: any): void;
  onRequestThumbnails?(paths: string[]): void;
  selectedImage?: SelectedImage;
  thumbnails: Record<string, string> | undefined;
  thumbnailAspectRatio: ThumbnailAspectRatio;
}

export default function Filmstrip({
  imageList,
  imageRatings,
  isLoading: _isLoading,
  multiSelectedPaths,
  onClearSelection,
  onContextMenu,
  onImageSelect,
  onRequestThumbnails,
  selectedImage,
  thumbnails,
  thumbnailAspectRatio,
}: FilmStripProps) {
  const clickTriggeredScroll = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { height, width } = entry.contentRect;
        setSize((prev) => (prev.height === height && prev.width === width ? prev : { height, width }));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleImageSelect = (path: string, event: any) => {
    if (path !== selectedImage?.path) {
      clickTriggeredScroll.current = true;
    }
    onImageSelect?.(path, event);
  };

  return (
    <div ref={containerRef} className="h-full w-full" onClick={onClearSelection}>
      {size.height > 0 && size.width > 0 && (
        <FilmstripList
          height={size.height}
          width={size.width}
          data={{
            imageList,
            imageRatings,
            selectedPath: selectedImage?.path,
            multiSelectedPaths,
            thumbnails,
            thumbnailAspectRatio,
            onContextMenu,
            onRequestThumbnails,
            onImageSelect: handleImageSelect,
            clickTriggeredScroll,
          }}
        />
      )}
    </div>
  );
}
