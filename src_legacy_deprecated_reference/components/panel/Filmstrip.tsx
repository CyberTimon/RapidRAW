import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Image as ImageIcon, Star } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { ImageFile, SelectedImage, ThumbnailAspectRatio } from '../ui/AppProperties';
import { Color, COLOR_LABELS } from '../../utils/adjustments';

interface ImageLayer {
  id: string;
  url: string;
  opacity: number;
}

interface FilmstripThumbnailProps {
  imageFile: ImageFile;
  imageRatings: any;
  isActive: boolean;
  isSelected: boolean;
  onContextMenu?(event: any, path: string): void;
  onImageSelect?(path: string, event: any): void;
  thumbData: string | undefined;
  thumbnailAspectRatio: ThumbnailAspectRatio;
}

const FilmstripThumbnail = ({
  imageFile,
  imageRatings,
  isActive,
  isSelected,
  onContextMenu,
  onImageSelect,
  thumbData,
  thumbnailAspectRatio,
}: FilmstripThumbnailProps) => {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [layers, setLayers] = useState<ImageLayer[]>([]);
  const latestThumbDataRef = useRef<string | undefined>(undefined);

  const { path, tags } = imageFile;
  const rating = imageRatings?.[path] || 0;
  const colorTag = tags?.find((t: string) => t.startsWith('color:'))?.substring(6);
  const colorLabel = COLOR_LABELS.find((c: Color) => c.name === colorTag);

  const isVirtualCopy = useMemo(() => {
    return path.includes('?vc=');
  }, [path]);

  useEffect(() => {
    if (thumbnailAspectRatio === ThumbnailAspectRatio.Contain && thumbData) {
      const img = new Image();
      img.onload = () => {
        setAspectRatio(img.naturalWidth / img.naturalHeight);
      };
      img.src = thumbData;
    } else {
      setAspectRatio(null);
    }
  }, [thumbData, thumbnailAspectRatio]);

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
            if (prev.some((l) => l.id === img.src)) {
              return prev;
            }
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
      if (finishedIndex < 0 || prev.length <= 1) {
        return prev;
      }
      return prev.slice(finishedIndex);
    });
  }, []);

  const ringClass = isActive
    ? 'ring-2 ring-accent'
    : isSelected
    ? 'ring-2 ring-gray-400'
    : 'hover:ring-2 hover:ring-hover-color';

  const imageClasses = `w-full h-full group-hover:scale-[1.02] transition-transform duration-300`;

  return (
    <motion.div
      className={clsx(
        'h-full rounded-md overflow-hidden cursor-pointer flex-shrink-0 group relative transition-all duration-150',
        thumbnailAspectRatio === ThumbnailAspectRatio.Cover && 'aspect-square',
        ringClass,
      )}
      data-path={path}
      layout
      onClick={(e: any) => {
        e.stopPropagation();
        if (onImageSelect) {
          onImageSelect(path, e);
        }
      }}
      onContextMenu={(e: any) => {
        if (onContextMenu) {
          onContextMenu(e, path);
        }
      }}
      style={{
        aspectRatio: aspectRatio ?? undefined,
        zIndex: isActive ? 2 : isSelected ? 1 : 'auto',
      }}
      title={path.split(/[\\/]/).pop()}
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
                transform: 'translateZ(0)',
                backfaceVisibility: 'hidden',
              }}
              onTransitionEnd={() => handleTransitionEnd(layer.id)}
            >
              {thumbnailAspectRatio === ThumbnailAspectRatio.Contain && (
                <img alt="" className="absolute inset-0 w-full h-full object-cover blur-md scale-110" src={layer.url} />
              )}
              <img
                alt={path.split(/[\\/]/).pop()}
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
        <div className="absolute top-1 right-1 bg-primary rounded-full px-1.5 py-0.5 text-xs text-white flex items-center gap-1 backdrop-blur-sm">
          {colorLabel && (
            <div
              className="w-3 h-3 rounded-full ring-1 ring-black/20"
              style={{ backgroundColor: colorLabel.color }}
              title={`Color: ${colorLabel.name}`}
            ></div>
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
        <div className="absolute bottom-1 right-1">
          <div
            className="flex-shrink-0 bg-bg-primary/50 text-white text-[9px] font-bold px-1 py-0.5 rounded-full backdrop-blur-sm"
            title="Virtual Copy"
          >
            VC
          </div>
        </div>
      )}
    </motion.div>
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
  selectedImage?: SelectedImage;
  thumbnails: Record<string, string> | undefined;
  thumbnailAspectRatio: ThumbnailAspectRatio;
}

export default function Filmstrip({
  imageList,
  imageRatings,
  isLoading,
  multiSelectedPaths,
  onClearSelection,
  onContextMenu,
  onImageSelect,
  selectedImage,
  thumbnails,
  thumbnailAspectRatio,
}: FilmStripProps) {
  const filmstripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = filmstripRef.current;
    if (!element) {
      return;
    }

    const onWheel = (e: any) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        return;
      }
      e.preventDefault();
      element.scrollLeft += e.deltaY;
    };

    element.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      if (element) {
        element.removeEventListener('wheel', onWheel);
      }
    };
  }, []);

  useEffect(() => {
    if (selectedImage && filmstripRef.current) {
      const selectedIndex = imageList.findIndex((img: ImageFile) => img.path === selectedImage.path);

      if (selectedIndex !== -1) {
        const activeElement = filmstripRef.current.querySelector(`[data-path="${CSS.escape(selectedImage.path)}"]`);

        if (activeElement) {
          setTimeout(() => {
            activeElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
              inline: 'center',
            });
          }, 320);
        }
      }
    }
  }, [selectedImage, imageList]);

  return (
    <div ref={filmstripRef} className="h-full overflow-x-auto overflow-y-hidden p-1" onClick={onClearSelection}>
      <motion.div className="flex h-full gap-2">
        <AnimatePresence>
          {imageList.map((imageFile: ImageFile) => (
            <FilmstripThumbnail
              key={imageFile.path}
              imageFile={imageFile}
              imageRatings={imageRatings}
              isActive={selectedImage?.path === imageFile.path}
              isSelected={multiSelectedPaths.includes(imageFile.path)}
              onContextMenu={onContextMenu}
              onImageSelect={onImageSelect}
              thumbData={thumbnails ? thumbnails[imageFile.path] : undefined}
              thumbnailAspectRatio={thumbnailAspectRatio}
            />
          ))}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}