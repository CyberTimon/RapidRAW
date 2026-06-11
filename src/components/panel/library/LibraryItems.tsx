import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Image as ImageIcon, Folder, FolderOpen, Star as StarIcon, SlidersHorizontal } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { COLOR_LABELS, Color } from '../../../utils/adjustments';
import { ThumbnailAspectRatio, ImageFile, ExifOverlay } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights, TEXT_COLOR_KEYS } from '../../../types/typography';
import { ColumnWidths } from '../MainLibrary';
import { useProcessStore } from '../../../store/useProcessStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { IconAperture, IconFocalLength, IconIso, IconShutter } from '../editor/ExifIcons';

interface ImageLayer {
  id: string;
  url: string;
  opacity: number;
}

const ThumbnailComponent = ({
  isActive,
  isSelected,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onLoad,
  path,
  rating,
  tags,
  aspectRatio: thumbnailAspectRatio,
  isEdited,
  exif,
}: any) => {
  const { t } = useTranslation();
  const data = useProcessStore((s) => s.thumbnails[path]);
  const exifOverlay = useSettingsStore((s) => s.appSettings?.exifOverlay || ExifOverlay.Off);
  const displayEditIcon = useSettingsStore((s) => s.appSettings?.displayEditIcon ?? true);
  const showEditIcon = isEdited && displayEditIcon;

  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [layers, setLayers] = useState<ImageLayer[]>([]);

  const [currentPath, setCurrentPath] = useState(path);
  if (currentPath !== path) {
    setCurrentPath(path);
    setLayers([]);
  }

  const pathRef = useRef(path);
  const hadDataOnPathChange = useRef(!!data);

  if (pathRef.current !== path) {
    pathRef.current = path;
    hadDataOnPathChange.current = !!data;
  }

  const { baseName, isVirtualCopy } = useMemo(() => {
    const fullFileName = path.split(/[\\/]/).pop() || '';
    const parts = fullFileName.split('?vc=');
    return {
      baseName: parts[0],
      isVirtualCopy: parts.length > 1,
    };
  }, [path]);

  const { shutter, fNumber, iso, focal } = useMemo(() => {
    const e = exif || {};
    let fNum = e.FNumber ? String(e.FNumber) : '';
    if (fNum && !fNum.toLowerCase().startsWith('f')) fNum = `f/${fNum}`;
    return {
      shutter: e.ExposureTime || '',
      fNumber: fNum,
      iso: e.PhotographicSensitivity || e.ISOSpeedRatings || '',
      focal: e.FocalLengthIn35mmFilm || e.FocalLength || '',
    };
  }, [exif]);

  useEffect(() => {
    if (data) {
      setShowPlaceholder(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowPlaceholder(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (!data) {
      setLayers([]);
      return;
    }

    setLayers((prev) => {
      if (prev.some((l) => l.id === data)) return prev;

      if (prev.length === 0) {
        if (hadDataOnPathChange.current) {
          return [{ id: data, url: data, opacity: 1 }];
        } else {
          return [{ id: data, url: data, opacity: 0 }];
        }
      }

      return [...prev, { id: data, url: data, opacity: 0 }];
    });
  }, [data, path]);

  useEffect(() => {
    const layerToFadeIn = layers.find((l) => l.opacity === 0);
    if (layerToFadeIn) {
      const frame = requestAnimationFrame(() => {
        setLayers((prev) => prev.map((l) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)));
      });
      return () => cancelAnimationFrame(frame);
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
    ? 'ring-2 ring-inset ring-accent'
    : isSelected
      ? 'ring-2 ring-inset ring-gray-400'
      : 'group-hover:ring-2 group-hover:ring-inset group-hover:ring-hover-color';

  const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);

  const isAlways = exifOverlay === ExifOverlay.Always;
  const isHover = exifOverlay === ExifOverlay.Hover;

  const hasEditIcon = !!showEditIcon;
  const hasColorLabel = !!colorLabel;
  const hasRating = rating > 0;
  const hasAnyOverlay = hasEditIcon || hasColorLabel || hasRating;

  return (
    <div
      className="aspect-square bg-surface rounded-md overflow-hidden cursor-pointer group relative flex flex-col transition-all duration-150 transform-gpu [-webkit-mask-image:-webkit-radial-gradient(white,black)]"
      onClick={(e: any) => {
        e.stopPropagation();
        onImageClick(path, e);
      }}
      onContextMenu={(e: any) => onContextMenu(e, path)}
      onDoubleClick={() => onImageDoubleClick(path)}
    >
      <div className="relative w-full flex-1 min-h-0 z-0 bg-surface">
        {layers.length > 0 && (
          <div className="absolute inset-0 w-full h-full">
            {layers.map((layer) => (
              <div
                key={layer.id}
                className="absolute inset-0 w-full h-full"
                style={{
                  opacity: layer.opacity,
                  transition: 'opacity 300ms ease-in-out',
                }}
                onTransitionEnd={() => handleTransitionEnd(layer.id)}
              >
                <img
                  alt={path.split(/[\\/]/).pop()}
                  className={`w-full h-full group-hover:scale-[1.02] transition-transform duration-300 will-change-transform ${
                    thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover'
                  } relative`}
                  decoding="async"
                  loading="lazy"
                  src={layer.url}
                  onLoad={() => onLoad(path)}
                />
              </div>
            ))}
          </div>
        )}

        {layers.length === 0 && showPlaceholder && (
          <div className="absolute inset-0 w-full h-full flex items-center justify-center bg-surface">
            <ImageIcon className="text-text-secondary animate-pulse" />
          </div>
        )}
      </div>

      <div
        className={clsx(
          'absolute top-0 right-0 w-1/2 h-1/2 bg-linear-to-bl from-black/20 via-black/0 to-transparent pointer-events-none z-0 transition-opacity duration-200 ease-in-out',
          hasAnyOverlay ? 'opacity-100' : 'opacity-0',
        )}
      />

      <div className="absolute top-1.5 right-1.5 flex items-center justify-end z-10 pointer-events-none">
        <div
          className={clsx(
            'rounded-full h-5 px-1.5 flex items-center justify-center gap-0 shadow-md bg-black/30 pointer-events-auto transition-all duration-200 ease-out origin-top-right',
            hasAnyOverlay ? 'opacity-100 scale-100' : 'opacity-0 scale-90 pointer-events-none',
          )}
        >
          <div
            className={clsx(
              'text-white flex items-center transition-all duration-200 ease-out overflow-hidden',
              hasEditIcon ? 'max-w-3 opacity-100 scale-100' : 'max-w-0 opacity-0 scale-75 pointer-events-none',
            )}
          >
            <SlidersHorizontal size={12} />
          </div>

          <div
            className={clsx(
              'flex items-center justify-center shrink-0 transition-all duration-200 ease-out overflow-hidden',
              hasColorLabel ? 'max-w-3 opacity-100 scale-100' : 'max-w-0 opacity-0 scale-75 pointer-events-none',
              hasColorLabel && hasEditIcon ? 'ml-1.5' : 'ml-0',
            )}
          >
            <div
              className="w-3 h-3 rounded-full transition-colors duration-200"
              style={{ backgroundColor: colorLabel ? colorLabel.color : 'transparent' }}
            />
          </div>

          <div
            className={clsx(
              'flex items-center gap-0.5 shrink-0 transition-all duration-200 ease-out overflow-hidden',
              hasRating ? 'max-w-7 opacity-100 scale-100' : 'max-w-0 opacity-0 scale-75 pointer-events-none',
              hasRating && (hasEditIcon || hasColorLabel) ? 'ml-1.5' : 'ml-0',
            )}
          >
            <Text variant={TextVariants.small} color={TextColors.white}>
              {rating}
            </Text>
            <StarIcon size={12} className="text-white fill-white" />
          </div>
        </div>
      </div>

      <div
        className={clsx(
          'absolute bottom-0 left-0 right-0 h-16 transition-opacity duration-300 pointer-events-none z-10',
          'bg-linear-to-t from-black/70 to-transparent',
          isAlways ? 'opacity-0' : isHover ? 'opacity-100 group-hover:opacity-0' : 'opacity-100',
        )}
      />

      <div
        className={clsx(
          'w-full transition-[grid-template-rows] duration-300 ease-in-out grid shrink-0 z-0',
          isAlways ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        aria-hidden="true"
      >
        <div className="min-h-0 overflow-hidden pointer-events-none invisible">
          <div className="flex flex-col p-2 pb-1.5">
            <div className="flex items-end justify-between shrink-0">
              <Text variant={TextVariants.small} className="truncate pr-2">
                {baseName}
              </Text>
              {isVirtualCopy && (
                <Text variant={TextVariants.small} className="px-1.5 py-0.5 font-bold">
                  VC
                </Text>
              )}
            </div>
            <div className="pt-1.5 pb-0.5 flex flex-wrap items-center gap-x-2.5 shrink-0">
              <div className="flex items-center gap-1">
                <IconShutter className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {shutter || '-'}
                </Text>
              </div>
              <div className="flex items-center gap-1">
                <IconAperture className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {fNumber || '-'}
                </Text>
              </div>
              <div className="flex items-center gap-1">
                <IconIso className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {iso || '-'}
                </Text>
              </div>
              <div className="flex items-center gap-1">
                <IconFocalLength className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {focal ? (String(focal).endsWith('mm') ? focal : `${focal}mm`) : '-'}
                </Text>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={clsx(
          'absolute bottom-0 left-0 right-0 flex flex-col p-2 pb-1.5 transition-all duration-300 ease-in-out z-20',
          isAlways
            ? 'bg-surface border-t border-border-color/50 pointer-events-auto'
            : isHover
              ? 'bg-transparent group-hover:bg-surface/60 backdrop-blur-none group-hover:backdrop-blur-md border-t border-transparent group-hover:border-border-color/50 pointer-events-none group-hover:pointer-events-auto'
              : 'bg-transparent border-t border-transparent pointer-events-none',
        )}
      >
        <div className="flex items-end justify-between shrink-0">
          <Text
            variant={TextVariants.small}
            className={clsx(
              'truncate pr-2 transition-colors duration-300',
              isAlways ? 'text-white' : isHover ? 'text-white group-hover:text-white' : 'text-white',
            )}
          >
            {baseName}
          </Text>
          {isVirtualCopy && (
            <Text
              as="div"
              variant={TextVariants.small}
              weight={TextWeights.bold}
              className={clsx(
                'shrink-0 px-1.5 py-0.5 rounded-full transition-colors duration-300 font-bold pointer-events-auto',
                isAlways
                  ? 'bg-border-color/30 text-text-primary shadow-none'
                  : isHover
                    ? 'bg-black/30 text-white backdrop-blur-xs shadow-md group-hover:bg-border-color/30 group-hover:text-text-primary group-hover:shadow-none group-hover:backdrop-blur-none'
                    : 'bg-black/30 text-white backdrop-blur-xs shadow-md',
              )}
              data-tooltip={t('library.items.tooltipVirtualCopy')}
            >
              VC
            </Text>
          )}
        </div>

        <div
          className={clsx(
            'grid transition-[grid-template-rows,opacity] duration-300 ease-in-out shrink-0',
            isAlways
              ? 'grid-rows-[1fr] opacity-100'
              : isHover
                ? 'grid-rows-[0fr] opacity-0 group-hover:grid-rows-[1fr] group-hover:opacity-100'
                : 'grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden min-h-0">
            <div
              className={clsx(
                'pt-1.5 pb-0.5 flex flex-wrap items-center gap-x-2.5 shrink-0 transition-transform duration-300 ease-in-out',
                isAlways ? 'translate-y-0' : isHover ? 'translate-y-3 group-hover:translate-y-0' : 'translate-y-3',
              )}
            >
              <div
                className="flex items-center gap-1 text-text-secondary"
                data-tooltip={t('library.items.tooltipShutterSpeed')}
              >
                <IconShutter className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {shutter || '-'}
                </Text>
              </div>
              <div
                className="flex items-center gap-1 text-text-secondary"
                data-tooltip={t('library.items.tooltipAperture')}
              >
                <IconAperture className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {fNumber || '-'}
                </Text>
              </div>
              <div className="flex items-center gap-1 text-text-secondary" data-tooltip={t('library.items.tooltipIso')}>
                <IconIso className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {iso || '-'}
                </Text>
              </div>
              <div
                className="flex items-center gap-1 text-text-secondary"
                data-tooltip={t('library.items.tooltipFocalLength')}
              >
                <IconFocalLength className="w-2.5 h-2.5" />
                <Text variant={TextVariants.small} className="text-[9px] font-medium tracking-wide">
                  {focal ? (String(focal).endsWith('mm') ? focal : `${focal}mm`) : '-'}
                </Text>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={clsx('absolute inset-0 rounded-md pointer-events-none z-30 transition-all duration-150', ringClass)}
      />
    </div>
  );
};

const ListItemComponent = ({
  isActive,
  isSelected,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  onLoad,
  path,
  rating,
  tags,
  modified,
  aspectRatio: thumbnailAspectRatio,
  columnWidths,
  exif,
}: any) => {
  const { t } = useTranslation();
  const data = useProcessStore((s) => s.thumbnails[path]);
  const exifOverlay = useSettingsStore((s) => s.appSettings?.exifOverlay || ExifOverlay.Off);

  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [layers, setLayers] = useState<ImageLayer[]>([]);

  const [currentPath, setCurrentPath] = useState(path);
  if (currentPath !== path) {
    setCurrentPath(path);
    setLayers([]);
  }

  const pathRef = useRef(path);
  const hadDataOnPathChange = useRef(!!data);

  if (pathRef.current !== path) {
    pathRef.current = path;
    hadDataOnPathChange.current = !!data;
  }

  const { baseName, isVirtualCopy } = useMemo(() => {
    const fullFileName = path.split(/[\\/]/).pop() || '';
    const parts = fullFileName.split('?vc=');
    return {
      baseName: parts[0],
      isVirtualCopy: parts.length > 1,
    };
  }, [path]);

  const { shutter, fNumber, iso, focal } = useMemo(() => {
    const e = exif || {};
    let fNum = e.FNumber ? String(e.FNumber) : '';
    if (fNum && !fNum.toLowerCase().startsWith('f')) fNum = `f/${fNum}`;
    return {
      shutter: e.ExposureTime || '',
      fNumber: fNum,
      iso: e.PhotographicSensitivity || e.ISOSpeedRatings || '',
      focal: e.FocalLengthIn35mmFilm || e.FocalLength || '',
    };
  }, [exif]);

  const showExifCols = exifOverlay !== ExifOverlay.Off;
  const totalBase =
    columnWidths.thumbnail +
    columnWidths.name +
    columnWidths.date +
    columnWidths.rating +
    columnWidths.color +
    (showExifCols ? columnWidths.shutter + columnWidths.aperture + columnWidths.iso + columnWidths.focal : 0);
  const getW = (key: keyof ColumnWidths) => `${(columnWidths[key] / totalBase) * 100}%`;

  useEffect(() => {
    if (data) {
      setShowPlaceholder(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowPlaceholder(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [data]);

  useEffect(() => {
    if (!data) {
      setLayers([]);
      return;
    }

    setLayers((prev) => {
      if (prev.some((l) => l.id === data)) return prev;

      if (prev.length === 0) {
        if (hadDataOnPathChange.current) {
          return [{ id: data, url: data, opacity: 1 }];
        } else {
          return [{ id: data, url: data, opacity: 0 }];
        }
      }

      return [...prev, { id: data, url: data, opacity: 0 }];
    });
  }, [data, path]);

  useEffect(() => {
    const layerToFadeIn = layers.find((l) => l.opacity === 0);
    if (layerToFadeIn) {
      const frame = requestAnimationFrame(() => {
        setLayers((prev) => prev.map((l) => (l.id === layerToFadeIn.id ? { ...l, opacity: 1 } : l)));
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [layers]);

  const handleTransitionEnd = useCallback((finishedId: string) => {
    setLayers((prev) => {
      const finishedIndex = prev.findIndex((l) => l.id === finishedId);
      if (finishedIndex < 0 || prev.length <= 1) return prev;
      return prev.slice(finishedIndex);
    });
  }, []);

  const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);

  const dateObj = new Date(modified > 1e11 ? modified : modified * 1000);
  const dateStr =
    dateObj.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' +
    dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const stateClass = isActive
    ? 'ring-1 ring-inset ring-accent bg-accent/10'
    : isSelected
      ? 'ring-1 ring-inset ring-accent/50 bg-accent/5'
      : 'hover:bg-surface/80';

  return (
    <div
      className={`flex items-center w-full h-full border-b border-border-color/30 cursor-pointer transition-colors duration-150 ${stateClass}`}
      onClick={(e: any) => {
        e.stopPropagation();
        onImageClick(path, e);
      }}
      onContextMenu={(e: any) => onContextMenu(e, path)}
      onDoubleClick={() => onImageDoubleClick(path)}
    >
      <div
        style={{ width: getW('thumbnail') }}
        className="flex items-center justify-center p-1.5 h-full overflow-hidden"
      >
        <div className="w-full h-full relative overflow-hidden rounded-sm bg-surface flex items-center justify-center">
          {layers.length > 0 && (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center">
              {layers.map((layer) => (
                <div
                  key={layer.id}
                  className="absolute inset-0 w-full h-full"
                  style={{ opacity: layer.opacity, transition: 'opacity 300ms ease-in-out' }}
                  onTransitionEnd={() => handleTransitionEnd(layer.id)}
                >
                  <img
                    alt={baseName}
                    className={`w-full h-full relative ${
                      thumbnailAspectRatio === ThumbnailAspectRatio.Contain ? 'object-contain' : 'object-cover'
                    }`}
                    decoding="async"
                    loading="lazy"
                    src={layer.url}
                    onLoad={() => onLoad(path)}
                  />
                </div>
              ))}
            </div>
          )}

          {layers.length === 0 && showPlaceholder && (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center">
              <ImageIcon size={14} className="text-text-secondary animate-pulse" />
            </div>
          )}
        </div>
      </div>

      <div style={{ width: getW('name') }} className="flex items-center gap-2 px-3 h-full overflow-hidden">
        <Text variant={TextVariants.small} className="truncate" weight={TextWeights.medium} color={TextColors.primary}>
          {baseName}
        </Text>
        {isVirtualCopy && (
          <Text
            as="div"
            variant={TextVariants.small}
            color={TextColors.secondary}
            weight={TextWeights.bold}
            className="shrink-0 bg-bg-primary px-1.5 py-0.5 rounded-full leading-none border border-border-color"
            data-tooltip={t('library.items.tooltipVirtualCopy')}
          >
            VC
          </Text>
        )}
      </div>

      <div style={{ width: getW('date') }} className="flex items-center px-3 h-full overflow-hidden">
        <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
          {dateStr}
        </Text>
      </div>

      <div style={{ width: getW('rating') }} className="flex items-center px-3 h-full overflow-hidden">
        {rating > 0 && (
          <div className="flex items-center gap-1">
            <StarIcon size={12} className="text-accent fill-accent" />
            <Text variant={TextVariants.small} color={TextColors.primary} weight={TextWeights.medium}>
              {rating}
            </Text>
          </div>
        )}
      </div>

      <div style={{ width: getW('color') }} className="flex items-center px-3 h-full overflow-hidden">
        {colorLabel && (
          <div className="flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/20"
              style={{ backgroundColor: colorLabel.color }}
            />
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
              {t(`contextMenus.colors.${colorLabel.name}`, {
                defaultValue: colorLabel.name.charAt(0).toUpperCase() + colorLabel.name.slice(1),
              })}
            </Text>
          </div>
        )}
      </div>

      {showExifCols && (
        <>
          <div style={{ width: getW('shutter') }} className="flex items-center px-3 h-full overflow-hidden">
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
              {shutter}
            </Text>
          </div>
          <div style={{ width: getW('aperture') }} className="flex items-center px-3 h-full overflow-hidden">
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
              {fNumber}
            </Text>
          </div>
          <div style={{ width: getW('iso') }} className="flex items-center px-3 h-full overflow-hidden">
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
              {iso}
            </Text>
          </div>
          <div style={{ width: getW('focal') }} className="flex items-center px-3 h-full overflow-hidden">
            <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate">
              {focal ? (String(focal).endsWith('mm') ? focal : `${focal}mm`) : ''}
            </Text>
          </div>
        </>
      )}
    </div>
  );
};

export const Thumbnail = React.memo(ThumbnailComponent);
export const ListItem = React.memo(ListItemComponent);

const RowComponent = ({
  index,
  style,
  rows,
  activePath,
  multiSelectedSet,
  onContextMenu,
  onImageClick,
  onImageDoubleClick,
  thumbnailAspectRatio,
  onImageLoad,
  imageRatings,
  baseFolderPath,
  itemWidth,
  itemHeight,
  outerPadding,
  gap,
  isListView,
  columnWidths,
  queueThumbnailRequest,
  onToggleRecursiveFolder,
}: any) => {
  const { t } = useTranslation();
  const row = rows[index];

  useEffect(() => {
    if (row && row.type === 'images') {
      row.images.forEach((img: ImageFile) => {
        queueThumbnailRequest(img.path);
      });
    }
  }, [row, queueThumbnailRequest]);

  if (row.type === 'footer') return null;
  const shiftedStyle = {
    ...style,
    transform: (style.transform as string).replace(
      /translateY\(([^)]+)\)/,
      (_: string, y: string) => `translateY(${parseFloat(y) + outerPadding}px)`,
    ),
  };

  if (row.type === 'header') {
    let displayPath = row.path;
    if (baseFolderPath && row.path.startsWith(baseFolderPath)) {
      displayPath = row.path.substring(baseFolderPath.length);
      if (displayPath.startsWith('/') || displayPath.startsWith('\\')) {
        displayPath = displayPath.substring(1);
      }
    }
    if (!displayPath) displayPath = t('library.items.currentFolder');

    return (
      <div
        style={{
          ...shiftedStyle,
          left: 0,
          width: '100%',
          paddingLeft: outerPadding === 0 ? 12 : outerPadding,
          paddingRight: outerPadding === 0 ? 12 : outerPadding,
          boxSizing: 'border-box',
        }}
        className="flex items-end pb-2 pt-2"
      >
        <div className="flex items-center gap-2 w-full border-b border-border-color/50 pb-1">
          <button
            type="button"
            className={`${TEXT_COLOR_KEYS[TextColors.secondary]} p-0.5 rounded transition-colors hover:bg-surface-hover cursor-pointer`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleRecursiveFolder(row.path);
            }}
            data-tooltip={row.isExpanded ? t('library.items.collapseFolder') : t('library.items.expandFolder')}
          >
            {row.isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
          </button>
          <Text variant={TextVariants.label} weight={TextWeights.semibold} className="truncate" data-tooltip={row.path}>
            {displayPath}
          </Text>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="ml-auto">
            {t('library.items.imagesCount', { count: row.count })}
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...shiftedStyle,
        left: outerPadding,
        right: outerPadding,
        width: isListView ? '100%' : 'auto',
        display: 'flex',
        gap: gap,
      }}
    >
      {row.images.map((imageFile: ImageFile) => (
        <div
          key={imageFile.path}
          style={{
            width: isListView ? '100%' : itemWidth,
            height: itemHeight,
          }}
        >
          {isListView ? (
            <ListItem
              isActive={activePath === imageFile.path}
              isSelected={multiSelectedSet.has(imageFile.path)}
              onContextMenu={onContextMenu}
              onImageClick={onImageClick}
              onImageDoubleClick={onImageDoubleClick}
              onLoad={onImageLoad}
              path={imageFile.path}
              rating={imageRatings?.[imageFile.path] || 0}
              tags={imageFile.tags}
              exif={imageFile.exif}
              aspectRatio={thumbnailAspectRatio}
              modified={imageFile.modified}
              columnWidths={columnWidths}
            />
          ) : (
            <Thumbnail
              isActive={activePath === imageFile.path}
              isSelected={multiSelectedSet.has(imageFile.path)}
              onContextMenu={onContextMenu}
              onImageClick={onImageClick}
              onImageDoubleClick={onImageDoubleClick}
              onLoad={onImageLoad}
              path={imageFile.path}
              rating={imageRatings?.[imageFile.path] || 0}
              tags={imageFile.tags}
              exif={imageFile.exif}
              isEdited={imageFile.is_edited}
              aspectRatio={thumbnailAspectRatio}
            />
          )}
        </div>
      ))}
    </div>
  );
};

export const Row = React.memo(RowComponent);
