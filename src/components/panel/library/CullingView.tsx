import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { List } from 'react-window';
import {
  Loader2,
  Star as StarIcon,
  ZoomIn,
  ZoomOut,
  Maximize,
  Link,
  SquarePen,
  Tag,
  X,
  Check,
  Plus,
  SlidersHorizontal,
  Info,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { Invokes, ImageFile } from '../../ui/AppProperties';
import { Thumbnail } from './LibraryItems';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { useProcessStore } from '../../../store/useProcessStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useLibraryActions } from '../../../hooks/useLibraryActions';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';
import { IconAperture, IconFocalLength, IconIso, IconShutter } from '../editor/ExifIcons';

interface SyncViewport {
  isActive: boolean;
  zoom: number;
  pan: { x: number; y: number };
  isDragging: boolean;
}

function CullingPreview({
  image,
  rating,
  isActive,
  isSelected,
  isFullWidth,
  syncViewport,
  setSyncViewport,
  onContextMenu,
  onImageDoubleClick,
  hoveredPath,
  setHoveredCullingPath,
  showRateBar,
  setShowRateBar,
  showInfoBar,
  setShowInfoBar,
}: {
  image: ImageFile;
  rating: number;
  isActive: boolean;
  isSelected: boolean;
  isFullWidth?: boolean;
  syncViewport: SyncViewport;
  setSyncViewport: React.Dispatch<React.SetStateAction<SyncViewport>>;
  onContextMenu: (e: React.MouseEvent, path: string, forceSingleSelection?: boolean) => void;
  onImageDoubleClick: (path: string) => void;
  hoveredPath: string | null;
  setHoveredCullingPath: (path: string | null) => void;
  showRateBar: boolean;
  setShowRateBar: React.Dispatch<React.SetStateAction<boolean>>;
  showInfoBar: boolean;
  setShowInfoBar: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const { t } = useTranslation();
  const thumbUrl = useProcessStore((s) => s.thumbnails[image.path]);
  const initialPreview = useProcessStore((s) => s.previews[image.path]);
  const setPreview = useProcessStore((s) => s.setPreview);
  const safeThumbKey = thumbUrl || '';
  const [highResSrc, setHighResSrc] = useState<string | null>(
    initialPreview?.thumbKey === safeThumbKey ? initialPreview.url : null,
  );
  const [isLoading, setIsLoading] = useState(!highResSrc);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const dragStartPan = useRef({ x: 0, y: 0 });
  const hasDragged = useRef(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const [tagInputValue, setTagInputValue] = useState('');
  const [fitScale, setFitScale] = useState<number | null>(null);
  const { handleRate, handleSetColorLabel, handleTagsChanged } = useLibraryActions();
  const USER_TAG_PREFIX = 'user:';

  const currentColor = useMemo(() => {
    return image.tags?.find((t) => t.startsWith('color:'))?.substring(6) || null;
  }, [image.tags]);

  const colorLabel = useMemo(() => {
    return COLOR_LABELS.find((c: Color) => c.name === currentColor) || null;
  }, [currentColor]);

  const displayEditIcon = useSettingsStore((s) => s.appSettings?.displayEditIcon ?? true);
  const showEditIcon = image.is_edited && displayEditIcon;
  const hasAnyOverlay = showEditIcon || !!colorLabel || rating > 0;

  const currentTags = useMemo(() => {
    return (image.tags || [])
      .filter((t) => !t.startsWith('color:'))
      .map((t) => ({
        tag: t.startsWith(USER_TAG_PREFIX) ? t.substring(USER_TAG_PREFIX.length) : t,
        isUser: t.startsWith(USER_TAG_PREFIX),
      }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [image.tags]);

  const { exifData, hasExif } = useMemo(() => {
    const exif = image.exif || {};

    let fNum = exif.FNumber;
    if (fNum) {
      const fStr = String(fNum);
      fNum = fStr.toLowerCase().startsWith('f') ? fStr : `f/${fStr}`;
    }

    let captureDate = null;
    let captureTime = null;

    if (exif.DateTimeOriginal) {
      const dateTimeParts = exif.DateTimeOriginal.split(' ');
      captureDate = dateTimeParts[0]?.replace(/:/g, '-') || null;
      if (dateTimeParts[1]) {
        const timeParts = dateTimeParts[1].split(':');
        captureTime = `${timeParts[0]}:${timeParts[1]}`;
      }
    }

    const data = {
      iso: exif.PhotographicSensitivity || exif.ISO,
      fNumber: fNum,
      shutter: exif.ExposureTime,
      focal: exif.FocalLengthIn35mmFilm,
      captureDate: captureDate,
      captureTime: captureTime,
    };

    const hasData = !!(data.iso || data.fNumber || data.shutter || data.focal || data.captureDate);

    return {
      exifData: data,
      hasExif: hasData,
    };
  }, [image.exif]);

  const imageWidth = (image as any).width || image.exif?.ExifImageWidth || image.exif?.PixelXDimension;
  const imageHeight = (image as any).height || image.exif?.ExifImageHeight || image.exif?.PixelYDimension;

  const handleAddTag = async (tagToAdd: string) => {
    const newTagValue = tagToAdd.trim().toLowerCase();
    if (newTagValue && !currentTags.some((t) => t.tag === newTagValue)) {
      try {
        const prefixedTag = `${USER_TAG_PREFIX}${newTagValue}`;
        await invoke(Invokes.AddTagForPaths, { paths: [image.path], tag: prefixedTag });
        const newTags = [...currentTags, { tag: newTagValue, isUser: true }];
        handleTagsChanged([image.path], newTags);
        setTagInputValue('');
      } catch (err) {
        console.error(`Failed to add tag: ${err}`);
      }
    }
  };

  const handleRemoveTag = async (tagToRemove: { tag: string; isUser: boolean }) => {
    try {
      const prefixedTag = tagToRemove.isUser ? `${USER_TAG_PREFIX}${tagToRemove.tag}` : tagToRemove.tag;
      await invoke(Invokes.RemoveTagForPaths, { paths: [image.path], tag: prefixedTag });
      const newTags = currentTags.filter((t) => t.tag !== tagToRemove.tag);
      handleTagsChanged([image.path], newTags);
    } catch (err) {
      console.error(`Failed to remove tag: ${err}`);
    }
  };

  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag(tagInputValue);
    }
    e.stopPropagation();
  };

  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
  }, [zoom, pan]);

  const fullFileName = image.path.split(/[\\/]/).pop() || '';
  const parts = fullFileName.split('?vc=');
  const baseName = parts[0];
  const isVirtualCopy = parts.length > 1;

  const updateFitScale = useCallback(() => {
    if (!containerRef.current || !imageRef.current) return;
    const { naturalWidth, naturalHeight } = imageRef.current;
    if (!naturalWidth || !naturalHeight) return;

    const { clientWidth, clientHeight } = containerRef.current;
    const scale = Math.min(clientWidth / naturalWidth, clientHeight / naturalHeight);
    setFitScale(scale);
  }, []);

  useEffect(() => {
    if (imageRef.current && imageRef.current.complete) {
      updateFitScale();
    }
  }, [highResSrc, updateFitScale]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      updateFitScale();
    });
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [updateFitScale]);

  useEffect(() => {
    const currentPreview = useProcessStore.getState().previews[image.path];
    if (currentPreview && currentPreview.thumbKey === safeThumbKey) {
      setHighResSrc(currentPreview.url);
      setIsLoading(false);
      setPreview(image.path, currentPreview.url, safeThumbKey);
      return;
    }

    let active = true;
    setIsLoading(true);
    setHighResSrc(null);

    const fetchPreviewWithAdjustments = async () => {
      try {
        const metadata: any = await invoke(Invokes.LoadMetadata, { path: image.path });
        if (!active) return;

        const adjustments =
          metadata && metadata.adjustments && !metadata.adjustments.is_null ? metadata.adjustments : {};

        const bytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
          path: image.path,
          jsAdjustments: adjustments,
        });
        if (!active) return;

        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
        const localBlobUrl = URL.createObjectURL(blob);

        setPreview(image.path, localBlobUrl, safeThumbKey);

        if (active) {
          setHighResSrc(localBlobUrl);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Error loading culling preview with adjustments:', err);

        if (active) {
          try {
            const fallbackBytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
              path: image.path,
              jsAdjustments: {},
            });
            if (!active) return;
            const blob = new Blob([new Uint8Array(fallbackBytes)], { type: 'image/jpeg' });
            const localBlobUrl = URL.createObjectURL(blob);

            setPreview(image.path, localBlobUrl, safeThumbKey);
            setHighResSrc(localBlobUrl);
          } catch (fallbackErr) {
            console.error('Fallback preview generation also failed:', fallbackErr);
          }
          setIsLoading(false);
        }
      }
    };

    const delayTimeout = setTimeout(() => {
      fetchPreviewWithAdjustments();
    }, 200);

    return () => {
      active = false;
      clearTimeout(delayTimeout);
    };
  }, [image.path, safeThumbKey, setPreview]);

  useEffect(() => {
    if (syncViewport.isActive) {
      setZoom(syncViewport.zoom);
      setPan(syncViewport.pan);
    }
  }, [syncViewport.isActive, syncViewport.zoom, syncViewport.pan]);

  const updateViewport = (newZoom: number, newPan: { x: number; y: number }) => {
    setZoom(newZoom);
    setPan(newPan);
    if (syncViewport.isActive) {
      setSyncViewport((prev) => ({ ...prev, isActive: true, zoom: newZoom, pan: newPan }));
    }
  };

  useEffect(() => {
    if (!isDragging) return;
    const handleWindowMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStartMouse.current.x;
      const dy = e.clientY - dragStartMouse.current.y;

      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        hasDragged.current = true;
      }

      const newPan = {
        x: dragStartPan.current.x + dx,
        y: dragStartPan.current.y + dy,
      };

      updateViewport(zoomRef.current, newPan);
    };

    const handleWindowMouseUp = () => {
      setIsDragging(false);
      setSyncViewport((prev) => (prev.isActive ? { ...prev, isDragging: false } : prev));
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging, setSyncViewport]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    hasDragged.current = false;
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    dragStartPan.current = { x: panRef.current.x, y: panRef.current.y };
    setSyncViewport((prev) => (prev.isActive ? { ...prev, isDragging: true } : prev));
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasDragged.current) return;

    if (showRateBar || showInfoBar) {
      if (showRateBar) setShowRateBar(false);
      if (showInfoBar) setShowInfoBar(false);
      return;
    }

    if (Math.abs(zoom - 1) > 0.01 || pan.x !== 0 || pan.y !== 0) {
      updateViewport(1, { x: 0, y: 0 });
    } else {
      const targetZoom = fitScale ? 1 / fitScale : 2;
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left - rect.width / 2;
        const mouseY = e.clientY - rect.top - rect.height / 2;

        const newPanX = -mouseX * (targetZoom - 1);
        const newPanY = -mouseY * (targetZoom - 1);

        updateViewport(targetZoom, { x: newPanX, y: newPanY });
      } else {
        updateViewport(targetZoom, { x: 0, y: 0 });
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    const zoomFactor = Math.exp(-e.deltaY * 0.002);

    const minCSSScale = fitScale ? 0.01 / fitScale : 0.1;
    const maxCSSScale = fitScale ? 10 / fitScale : 10;

    const newZoom = Math.min(Math.max(minCSSScale, zoom * zoomFactor), maxCSSScale);
    const scaleRatio = newZoom / zoom;

    const mouseFromCenterX = mouseX - pan.x;
    const mouseFromCenterY = mouseY - pan.y;
    const newPanX = mouseX - mouseFromCenterX * scaleRatio;
    const newPanY = mouseY - mouseFromCenterY * scaleRatio;

    updateViewport(newZoom, { x: newPanX, y: newPanY });
  };

  const handleZoomIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    const maxCSSScale = fitScale ? 10 / fitScale : 10;
    const newZoom = Math.min(maxCSSScale, zoom * 1.25);
    const ratio = newZoom / zoom;
    updateViewport(newZoom, { x: pan.x * ratio, y: pan.y * ratio });
  };

  const handleZoomOut = (e: React.MouseEvent) => {
    e.stopPropagation();
    const minCSSScale = fitScale ? 0.01 / fitScale : 0.1;
    const newZoom = Math.max(minCSSScale, zoom / 1.25);
    const ratio = newZoom / zoom;
    updateViewport(newZoom, { x: pan.x * ratio, y: pan.y * ratio });
  };

  const handleToggle1to1 = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!fitScale) return;

    const currentAbsoluteZoom = zoom * fitScale;
    if (Math.abs(currentAbsoluteZoom - 1) < 0.05) {
      updateViewport(1, { x: 0, y: 0 });
    } else {
      updateViewport(1 / fitScale, { x: 0, y: 0 });
    }
  };

  const toggleSync = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncViewport.isActive) {
      setSyncViewport((prev) => ({ ...prev, isActive: false }));
    } else {
      setSyncViewport({ isActive: true, zoom, pan, isDragging: false });
    }
  };

  const ringClass = isActive
    ? 'ring-2 ring-inset ring-accent'
    : isSelected
      ? 'ring-2 ring-inset ring-gray-400'
      : 'group-hover:ring-2 group-hover:ring-inset group-hover:ring-hover-color';

  const effectiveDragging = isDragging || (syncViewport.isActive && syncViewport.isDragging);
  const imageTransformStyle = {
    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
    transition: effectiveDragging ? 'none' : 'transform 0.1s ease-out',
    transformOrigin: 'center center',
    backfaceVisibility: 'hidden' as const,
  };

  const isHovered = hoveredPath === image.path;
  const isActiveFallback = isActive && !hoveredPath;
  const displayMenu = isHovered || isActiveFallback;

  const isRateMenuVisible = showRateBar && displayMenu;
  const isInfoMenuVisible = showInfoBar && displayMenu;

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e, image.path, true);
      }}
      onClick={handleClick}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setHoveredCullingPath(image.path)}
      onMouseLeave={() => setHoveredCullingPath(null)}
      className={clsx(
        'relative flex items-center justify-center w-full h-full overflow-hidden group bg-bg-primary rounded-lg shadow-sm border border-border-color/10 cursor-grab active:cursor-grabbing select-none',
        isFullWidth && 'col-span-2',
      )}
    >
      <div
        className="absolute inset-0 opacity-20 pointer-events-none z-0"
        style={{
          backgroundImage: 'radial-gradient(#444 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />

      <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
        <div className="origin-center w-full h-full flex items-center justify-center" style={imageTransformStyle}>
          {thumbUrl && (
            <img
              src={thumbUrl}
              className="absolute w-full h-full object-contain drop-shadow-lg"
              alt={t('library.culling.altThumbnailLoading')}
              draggable={false}
            />
          )}

          {highResSrc && (
            <motion.img
              ref={imageRef}
              onLoad={updateFitScale}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              src={highResSrc}
              className="absolute w-full h-full object-contain drop-shadow-lg"
              alt={t('library.culling.altCullingPreviewHighRes')}
              draggable={false}
            />
          )}
        </div>
      </div>

      <AnimatePresence>
        {isInfoMenuVisible && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-[4.5rem] left-1/2 -translate-x-1/2 flex flex-col gap-4 bg-bg-primary/70 backdrop-blur-md p-4 rounded-xl border border-white/10 shadow-xl z-30 pointer-events-auto w-64 max-h-[70%] overflow-y-auto custom-scrollbar"
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <Text variant={TextVariants.small} weight={TextWeights.semibold} className="text-white">
                {t('library.culling.metadata')}
              </Text>
              <button
                onClick={() => setShowInfoBar(false)}
                className="text-white/50 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              {imageWidth && imageHeight && (
                <div>
                  <Text
                    variant={TextVariants.small}
                    className="text-white/50 text-[10px] uppercase tracking-wider mb-1.5 block"
                  >
                    {t('library.culling.dimensions')}
                  </Text>
                  <Text variant={TextVariants.small} className="text-white">
                    {imageWidth} × {imageHeight}
                  </Text>
                </div>
              )}

              {hasExif && (
                <div>
                  <Text
                    variant={TextVariants.small}
                    className="text-white/50 text-[10px] uppercase tracking-wider mb-1.5 block"
                  >
                    {t('library.culling.cameraSettings')}
                  </Text>
                  <div className="grid grid-cols-2 gap-3">
                    {exifData.shutter && (
                      <div
                        className="flex items-center gap-1.5 text-white/90"
                        title={t('library.culling.shutterSpeed')}
                      >
                        <span className="opacity-70">
                          <IconShutter />
                        </span>
                        <Text variant={TextVariants.small}>{exifData.shutter}</Text>
                      </div>
                    )}
                    {exifData.fNumber && (
                      <div className="flex items-center gap-1.5 text-white/90" title={t('library.culling.aperture')}>
                        <span className="opacity-70">
                          <IconAperture />
                        </span>
                        <Text variant={TextVariants.small}>{exifData.fNumber}</Text>
                      </div>
                    )}
                    {exifData.iso && (
                      <div className="flex items-center gap-1.5 text-white/90" title={t('library.culling.iso')}>
                        <span className="opacity-70">
                          <IconIso />
                        </span>
                        <Text variant={TextVariants.small}>{exifData.iso}</Text>
                      </div>
                    )}
                    {exifData.focal && (
                      <div className="flex items-center gap-1.5 text-white/90" title={t('library.culling.focalLength')}>
                        <span className="opacity-70">
                          <IconFocalLength />
                        </span>
                        <Text variant={TextVariants.small}>
                          {String(exifData.focal).endsWith('mm') ? exifData.focal : `${exifData.focal}mm`}
                        </Text>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {!hasExif && !imageWidth && !imageHeight && (
                <Text variant={TextVariants.small} className="text-white/50 italic">
                  {t('library.culling.noMetadataAvailable')}
                </Text>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isRateMenuVisible && (
          <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-[4.5rem] left-1/2 -translate-x-1/2 flex flex-col gap-4 bg-bg-primary/70 backdrop-blur-md p-4 rounded-xl border border-white/10 shadow-xl z-30 pointer-events-auto w-64 max-h-[70%] overflow-y-auto custom-scrollbar"
            onMouseDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <Text variant={TextVariants.small} weight={TextWeights.semibold} className="text-white">
                {t('library.culling.rateAndLabel')}
              </Text>
              <button
                onClick={() => setShowRateBar(false)}
                className="text-white/50 hover:text-white transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div>
              <Text
                variant={TextVariants.small}
                className="text-white/50 text-[10px] uppercase tracking-wider mb-1.5 block"
              >
                {t('library.culling.rating')}
              </Text>
              <div className="flex items-center gap-1.5">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    onClick={() => handleRate(star, [image.path])}
                    className="focus:outline-hidden transition-transform active:scale-95 hover:scale-110"
                  >
                    <StarIcon
                      size={18}
                      className={clsx(
                        'transition-colors duration-200',
                        star <= rating
                          ? 'fill-accent text-accent'
                          : 'fill-transparent text-white/30 hover:text-white/80',
                      )}
                    />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Text
                variant={TextVariants.small}
                className="text-white/50 text-[10px] uppercase tracking-wider mb-1.5 block"
              >
                {t('library.culling.colorLabel')}
              </Text>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleSetColorLabel(null, [image.path])}
                  className={clsx(
                    'w-5 h-5 rounded-full flex items-center justify-center transition-all hover:scale-110',
                    currentColor === null
                      ? 'ring-2 ring-white/50 ring-offset-1 ring-offset-bg-primary'
                      : 'opacity-50 hover:opacity-100 hover:ring-2 hover:ring-white/30',
                  )}
                  data-tooltip={t('library.culling.none')}
                >
                  <X size={12} className="text-white/50" />
                </button>
                {COLOR_LABELS.map((color: Color) => (
                  <button
                    key={color.name}
                    onClick={() => handleSetColorLabel(color.name, [image.path])}
                    className={clsx(
                      'w-5 h-5 rounded-full transition-all hover:scale-110',
                      currentColor === color.name
                        ? 'ring-2 ring-white ring-offset-1 ring-offset-bg-primary'
                        : 'hover:ring-2 hover:ring-white/30',
                    )}
                    style={{ backgroundColor: color.color }}
                    data-tooltip={color.name}
                  >
                    {currentColor === color.name && <Check size={12} className="text-black/50 mx-auto" />}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <Text
                variant={TextVariants.small}
                className="text-white/50 text-[10px] uppercase tracking-wider mb-1.5 block"
              >
                {t('library.culling.tags')}
              </Text>
              <div className="flex flex-wrap gap-1 mb-2">
                <AnimatePresence>
                  {currentTags.map((tagItem) => (
                    <motion.div
                      key={tagItem.tag}
                      layout
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="flex items-center gap-1 bg-white/10 px-2 py-0.5 rounded-md group cursor-pointer border border-transparent hover:border-white/20 transition-colors"
                      onClick={() => handleRemoveTag(tagItem)}
                    >
                      <Text as="span" variant={TextVariants.small} className="text-white/90 text-xs">
                        {tagItem.tag}
                      </Text>
                      <X size={10} className="text-white/50 group-hover:text-white" />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {currentTags.length === 0 && (
                  <Text variant={TextVariants.small} className="italic text-white/40 text-xs">
                    {t('library.culling.noTagsAdded')}
                  </Text>
                )}
              </div>
              <div className="flex items-center bg-bg-primary/40 border border-white/10 rounded-md px-2 py-1.5 focus-within:border-accent/50 transition-colors">
                <input
                  type="text"
                  value={tagInputValue}
                  onChange={(e) => setTagInputValue(e.target.value)}
                  onKeyDown={handleTagInputKeyDown}
                  placeholder={t('library.culling.addTagPlaceholder')}
                  className="bg-transparent border-none outline-hidden text-xs w-full text-white placeholder-white/40"
                />
                <button
                  onClick={() => handleAddTag(tagInputValue)}
                  disabled={!tagInputValue.trim()}
                  className="text-white/50 hover:text-white disabled:opacity-30 transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={clsx(
          'absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-bg-primary/70 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 shadow-xl z-20 pointer-events-auto transition-opacity duration-200 max-w-[calc(100%-1.5rem)]',
          isRateMenuVisible || isInfoMenuVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <AnimatePresence>
          {isLoading && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              className="flex items-center justify-center overflow-hidden"
            >
              <Loader2 className="w-4 h-4 animate-spin text-white mr-1" />
            </motion.div>
          )}
        </AnimatePresence>

        <Text
          variant={TextVariants.small}
          className="text-white truncate shrink min-w-0 max-w-20 sm:max-w-28 md:max-w-37.5"
          data-tooltip={baseName}
        >
          {baseName}
        </Text>

        {isVirtualCopy && (
          <div className="bg-white/20 text-white px-1.5 py-0.5 rounded-sm shrink-0 ml-1">
            <Text variant={TextVariants.small} weight={TextWeights.bold} className="text-[9px] leading-none">
              {t('library.culling.vc')}
            </Text>
          </div>
        )}

        {hasAnyOverlay && (
          <div className="rounded-full h-5 px-1.5 flex items-center justify-center gap-0 shadow-md bg-surface/30 pointer-events-auto shrink-0 ml-1">
            {showEditIcon && (
              <div className="text-white flex items-center shrink-0">
                <SlidersHorizontal size={12} />
              </div>
            )}

            {colorLabel && (
              <div className={clsx('flex items-center justify-center shrink-0', showEditIcon && 'ml-1.5')}>
                <div
                  className="w-3 h-3 rounded-full transition-colors duration-200"
                  style={{ backgroundColor: colorLabel.color }}
                />
              </div>
            )}

            {rating > 0 && (
              <div className={clsx('flex items-center gap-0.5 shrink-0', (showEditIcon || colorLabel) && 'ml-1.5')}>
                <Text variant={TextVariants.small} color={TextColors.white}>
                  {rating}
                </Text>
                <StarIcon size={12} className="text-white fill-white" />
              </div>
            )}
          </div>
        )}

        <div className="w-px h-5 bg-white/20 mx-1 shrink-0"></div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onImageDoubleClick(image.path);
          }}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
          data-tooltip={t('library.culling.editImage')}
        >
          <SquarePen size={14} />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowInfoBar((prev) => {
              if (!prev) setShowRateBar(false);
              return !prev;
            });
          }}
          className={clsx(
            'p-1.5 rounded-full transition-colors shrink-0',
            showInfoBar ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
          )}
          data-tooltip={t('library.culling.metadata')}
        >
          <Info size={14} />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowRateBar((prev) => {
              if (!prev) setShowInfoBar(false);
              return !prev;
            });
          }}
          className={clsx(
            'p-1.5 rounded-full transition-colors shrink-0',
            showRateBar ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
          )}
          data-tooltip={t('library.culling.rateAndLabel')}
        >
          <Tag size={14} />
        </button>

        <div className="w-px h-5 bg-white/20 mx-1 shrink-0"></div>

        <button
          onClick={toggleSync}
          className={clsx(
            'p-1.5 rounded-full transition-colors shrink-0',
            syncViewport.isActive ? 'bg-accent text-button-text' : 'text-white/60 hover:bg-white/10 hover:text-white',
          )}
          data-tooltip={t('library.culling.syncZoomAndPan')}
        >
          <Link size={14} />
        </button>

        <button
          onClick={handleZoomOut}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
        >
          <ZoomOut size={16} />
        </button>

        <button
          onClick={handleToggle1to1}
          className="text-xs font-mono text-white/90 w-8 text-center select-none shrink-0 hover:bg-white/10 hover:text-white rounded-md py-1 transition-colors cursor-pointer"
          data-tooltip={t('library.culling.toggleFit')}
        >
          {fitScale ? Math.round(zoom * fitScale * 100) : Math.round(zoom * 100)}%
        </button>

        <button
          onClick={handleZoomIn}
          className="p-1.5 text-white/60 hover:bg-white/10 hover:text-white rounded-full transition-colors shrink-0"
        >
          <ZoomIn size={16} />
        </button>
      </div>

      <div
        className={clsx(
          'absolute inset-0 rounded-lg pointer-events-none z-30 transition-all duration-150 ring-2 ring-inset ring-transparent',
          ringClass,
        )}
      />
    </div>
  );
}

const Row = React.memo(
  ({
    index,
    style,
    imageList,
    multiSelectedPaths,
    activePath,
    onContextMenu,
    onImageDoubleClick,
    thumbnailAspectRatio,
    imageRatings,
    onImageClick,
    queueThumbnailRequest,
    hoveredCullingPath,
  }: any) => {
    const image: ImageFile = imageList[index];
    const isSelected = multiSelectedPaths.includes(image.path);

    useEffect(() => {
      if (!image || !queueThumbnailRequest) return;
      queueThumbnailRequest(image.path);

      if (image.is_cloud_placeholder) {
        const interval = setInterval(() => {
          queueThumbnailRequest(image.path);
        }, 5000);
        return () => clearInterval(interval);
      }
    }, [image, queueThumbnailRequest]);

    return (
      <div style={style} className="p-2 box-border">
        <div className="w-full h-full">
          <Thumbnail
            path={image.path}
            isSelected={isSelected}
            isActive={activePath === image.path}
            isForcedHover={hoveredCullingPath === image.path}
            onImageClick={(path: string, e: any) => onImageClick(path, e)}
            onContextMenu={onContextMenu}
            onImageDoubleClick={onImageDoubleClick}
            onLoad={() => {}}
            rating={imageRatings?.[image.path] || 0}
            tags={image.tags}
            exif={image.exif}
            isEdited={image.is_edited}
            aspectRatio={thumbnailAspectRatio}
            isCloudPlaceholder={image.is_cloud_placeholder}
          />
        </div>
      </div>
    );
  },
);

export default function CullingView(props: any) {
  const { t } = useTranslation();
  const {
    imageList,
    multiSelectedPaths,
    activePath,
    onImageClick,
    imageRatings,
    thumbnailAspectRatio,
    onContextMenu,
    onImageDoubleClick,
    onRequestThumbnails,
    onClearSelection,
    onEmptyAreaContextMenu,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(0);
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const isResizing = useRef(false);

  const requestQueueRef = useRef<Set<string>>(new Set());
  const requestTimeoutRef = useRef<any>(null);

  const [hoveredCullingPath, setHoveredCullingPath] = useState<string | null>(null);

  const [syncViewport, setSyncViewport] = useState<SyncViewport>({
    isActive: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
    isDragging: false,
  });

  const [showRateBar, setShowRateBar] = useState(false);
  const [showInfoBar, setShowInfoBar] = useState(false);

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

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setListHeight(containerRef.current.clientHeight);
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const resize = useCallback((mouseMoveEvent: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - mouseMoveEvent.clientX;
    if (newWidth >= 160 && newWidth <= 450) {
      setSidebarWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.removeEventListener('mousemove', resize);
    document.removeEventListener('mouseup', stopResizing);
  }, [resize]);

  const startResizing = useCallback(
    (mouseDownEvent: React.MouseEvent) => {
      mouseDownEvent.preventDefault();
      isResizing.current = true;
      document.addEventListener('mousemove', resize);
      document.addEventListener('mouseup', stopResizing);
    },
    [resize, stopResizing],
  );

  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', resize);
      document.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  const rowProps = useMemo(
    () => ({
      imageList,
      multiSelectedPaths,
      activePath,
      thumbnailAspectRatio,
      imageRatings,
      onContextMenu,
      onImageDoubleClick,
      onImageClick,
      queueThumbnailRequest,
      sidebarWidth,
      hoveredCullingPath,
    }),
    [
      imageList,
      multiSelectedPaths,
      activePath,
      thumbnailAspectRatio,
      imageRatings,
      onContextMenu,
      onImageDoubleClick,
      onImageClick,
      queueThumbnailRequest,
      sidebarWidth,
      hoveredCullingPath,
    ],
  );

  const displayPaths = multiSelectedPaths.slice(-6);
  const displayImages = displayPaths
    .map((p: string) => imageList.find((img: ImageFile) => img.path === p))
    .filter(Boolean);
  const displayCount = displayImages.length;

  const handleSidebarEmptyClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-bench-id="thumbnail"]') && !target.closest('button')) {
      onClearSelection?.();
    }
  };

  const handleSidebarEmptyContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-bench-id="thumbnail"]') && !target.closest('button')) {
      onEmptyAreaContextMenu?.(e);
    }
  };

  return (
    <div className="flex w-full h-full min-h-0 bg-transparent">
      <div className="flex-1 flex overflow-hidden relative bg-transparent">
        {displayCount === 0 ? (
          <div className="m-auto text-center">
            <Text variant={TextVariants.heading} color={TextColors.secondary}>
              {t('library.culling.selectImagesToCompare')}
            </Text>
            <Text className="mt-2 text-text-secondary">{t('library.culling.clickThumbnailsHint')}</Text>
          </div>
        ) : (
          <div
            className={clsx(
              'grid gap-2 w-full h-full p-2',
              displayCount === 1 && 'grid-cols-1 grid-rows-1',
              displayCount === 2 && 'grid-cols-2 grid-rows-1',
              displayCount === 3 && 'grid-cols-2 grid-rows-2',
              displayCount === 4 && 'grid-cols-2 grid-rows-2',
              displayCount === 5 && 'grid-cols-3 grid-rows-2',
              displayCount === 6 && 'grid-cols-3 grid-rows-2',
            )}
          >
            {displayImages.map((img: ImageFile, index: number) => (
              <CullingPreview
                key={img.path}
                image={img}
                rating={imageRatings?.[img.path] || 0}
                onContextMenu={onContextMenu}
                onImageDoubleClick={onImageDoubleClick}
                isActive={activePath === img.path}
                isSelected={true}
                isFullWidth={(displayCount === 3 && index === 2) || (displayCount === 5 && index === 4)}
                syncViewport={syncViewport}
                setSyncViewport={setSyncViewport}
                hoveredPath={hoveredCullingPath}
                setHoveredCullingPath={setHoveredCullingPath}
                showRateBar={showRateBar}
                setShowRateBar={setShowRateBar}
                showInfoBar={showInfoBar}
                setShowInfoBar={setShowInfoBar}
              />
            ))}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        style={{ width: sidebarWidth }}
        className="relative shrink-0 border-l border-surface/50 bg-bg-secondary/50 flex flex-col"
        onClick={handleSidebarEmptyClick}
        onContextMenu={handleSidebarEmptyContextMenu}
      >
        <div
          onMouseDown={startResizing}
          className="absolute top-0 bottom-0 left-0 w-1 cursor-col-resize hover:bg-surface/50 active:bg-surface transition-colors z-40"
        />
        <div key={`${sidebarWidth}-${thumbnailAspectRatio}`} style={{ height: listHeight, width: '100%' }}>
          <List
            rowCount={imageList.length}
            rowHeight={sidebarWidth - 16}
            rowComponent={Row}
            rowProps={rowProps}
            className="custom-scrollbar"
          />
        </div>
      </div>
    </div>
  );
}
