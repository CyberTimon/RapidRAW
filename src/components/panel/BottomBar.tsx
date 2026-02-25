import { useState, useEffect, useRef } from 'react';
import { Star, Copy, ClipboardPaste, RotateCcw, ChevronUp, ChevronDown, Check, Save, Loader2, Settings } from 'lucide-react';
import clsx from 'clsx';
import Filmstrip from './Filmstrip';
import { GLOBAL_KEYS, ImageFile, SelectedImage, ThumbnailAspectRatio } from '../ui/AppProperties';

interface BottomBarProps {
  filmstripHeight?: number;
  imageList?: Array<ImageFile>;
  imageRatings?: Record<string, number> | null;
  isCopied: boolean;
  isCopyDisabled: boolean;
  isExportDisabled?: boolean;
  isFilmstripVisible?: boolean;
  isLibraryView?: boolean;
  isLoading?: boolean;
  isPasted: boolean;
  isPasteDisabled: boolean;
  isRatingDisabled?: boolean;
  isResetDisabled?: boolean;
  isResizing?: boolean;
  multiSelectedPaths?: Array<string>;
  onClearSelection?(): void;
  onContextMenu?(event: any, path: string): void;
  onCopy(): void;
  onExportClick?(): void;
  onImageSelect?(path: string, event: any): void;
  onOpenCopyPasteSettings?(): void;
  onPaste(): void;
  onRate(rate: number): void;
  onReset?(): void;
  onZoomChange?(zoomValue: number, fitToWindow?: boolean): void;
  rating: number;
  selectedImage?: SelectedImage;
  setIsFilmstripVisible?(isVisible: boolean): void;
  thumbnails?: Record<string, string>;
  thumbnailAspectRatio: ThumbnailAspectRatio;
  zoom?: number;
  displaySize?: { width: number; height: number };
  originalSize?: { width: number; height: number };
  baseRenderSize?: { width: number; height: number };
  totalImages?: number;
}

interface StarRatingProps {
  disabled: boolean;
  onRate(rate: number): void;
  rating: number;
}

const StarRating = ({ rating, onRate, disabled }: StarRatingProps) => {
  return (
    <div className={clsx('flex items-center gap-1', disabled && 'cursor-not-allowed')}>
      {[...Array(5)].map((_, index: number) => {
        const starValue = index + 1;
        return (
          <button
            className="disabled:cursor-not-allowed"
            disabled={disabled}
            key={starValue}
            onClick={() => !disabled && onRate(starValue === rating ? 0 : starValue)}
            data-tooltip={disabled ? 'Select an image to rate' : `Rate ${starValue} star${starValue > 1 ? 's' : ''}`}
          >
            <Star
              size={18}
              className={clsx(
                'transition-colors duration-150',
                disabled
                  ? 'text-text-secondary opacity-40'
                  : starValue <= rating
                  ? 'fill-accent text-accent'
                  : 'text-text-secondary hover:text-accent',
              )}
            />
          </button>
        );
      })}
    </div>
  );
};

export default function BottomBar({
  filmstripHeight,
  imageList = [],
  imageRatings,
  isCopied,
  isCopyDisabled,
  isExportDisabled,
  isFilmstripVisible,
  isLibraryView = false,
  isLoading = false,
  isPasted,
  isPasteDisabled,
  isRatingDisabled = false,
  isResetDisabled = false,
  isResizing,
  multiSelectedPaths = [],
  onClearSelection,
  onContextMenu,
  onCopy,
  onExportClick,
  onImageSelect,
  onOpenCopyPasteSettings,
  onPaste,
  onRate,
  onReset,
  onZoomChange = () => {},
  rating,
  selectedImage,
  setIsFilmstripVisible,
  thumbnails,
  thumbnailAspectRatio,
  zoom = 0,
  displaySize,
  originalSize,
  baseRenderSize,
  totalImages,
}: BottomBarProps) {
  const [isEditingPercent, setIsEditingPercent] = useState(false);
  const [percentInputValue, setPercentInputValue] = useState('');
  const isDraggingSlider = useRef(false);
  const [isZoomActive, setIsZoomActive] = useState(false);

  const percentInputRef = useRef<HTMLInputElement>(null);
  const [isZoomLabelHovered, setIsZoomLabelHovered] = useState(false);

  const isZoomReady = !isLoading && originalSize && originalSize.width > 0 && displaySize && displaySize.width > 0;
  const currentOriginalPercent = isZoomReady ? displaySize.width / originalSize.width : 1.0;

  const [latchedSliderValue, setLatchedSliderValue] = useState(1.0);
  const [latchedDisplayPercent, setLatchedDisplayPercent] = useState(100);

  const numSelected = multiSelectedPaths.length;
  const total = totalImages ?? 0;
  const showSelectionCounter = numSelected > 1;


  useEffect(() => {
    if (isZoomReady && !isDraggingSlider.current) {
      setLatchedSliderValue(currentOriginalPercent);
      setLatchedDisplayPercent(Math.round(currentOriginalPercent * 100));
    }
  }, [currentOriginalPercent, isZoomReady]);

  useEffect(() => {
    const handleDragEndGlobal = () => {
      if (isZoomActive) {
        setIsZoomActive(false);
        isDraggingSlider.current = false;
        if (isZoomReady) {
          setLatchedDisplayPercent(Math.round(currentOriginalPercent * 100));
        }
      }
    };

    if (isZoomActive) {
      window.addEventListener('mouseup', handleDragEndGlobal);
      window.addEventListener('touchend', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('mouseup', handleDragEndGlobal);
      window.removeEventListener('touchend', handleDragEndGlobal);
    };
  }, [isZoomActive, isZoomReady, currentOriginalPercent]);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = parseFloat(e.target.value);
    setLatchedSliderValue(newZoom);
    setLatchedDisplayPercent(Math.round(newZoom * 100));
    onZoomChange(newZoom);
  };

  const handleMouseDown = () => {
    isDraggingSlider.current = true;
    setIsZoomActive(true);
  };

  const handleMouseUp = () => {
    isDraggingSlider.current = false;
    setIsZoomActive(false);
    if (isZoomReady) {
      setLatchedDisplayPercent(Math.round(currentOriginalPercent * 100));
    }
  };

  const handleZoomKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
      (e.target as HTMLElement).blur();
      return;
    }
    if (GLOBAL_KEYS.includes(e.key)) {
      (e.target as HTMLElement).blur();
    }
  };

  const handleResetZoom = () => {
    onZoomChange(0, true);
  };

  const handlePercentClick = () => {
    if (!isZoomReady) return;
    setIsEditingPercent(true);
    setPercentInputValue(latchedDisplayPercent.toString());
    setTimeout(() => {
      percentInputRef.current?.focus();
      percentInputRef.current?.select();
    }, 0);
  };

  const handlePercentSubmit = () => {
    const value = parseFloat(percentInputValue);
    if (!isNaN(value)) {
      const originalPercent = value / 100;
      const clampedPercent = Math.max(0.1, Math.min(2.0, originalPercent));
      onZoomChange(clampedPercent);
    }
    setIsEditingPercent(false);
    setPercentInputValue('');
  };

  const handlePercentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handlePercentSubmit();
    else if (e.key === 'Escape') {
      setIsEditingPercent(false);
      setPercentInputValue('');
    }
    e.stopPropagation();
  };

  return (
    <div className="flex-shrink-0 bg-bg-secondary rounded-lg flex flex-col">
      {!isLibraryView && (
        <div
          className={clsx(
            'overflow-hidden',
            !isResizing && 'transition-all duration-300 ease-in-out',
          )}
          style={{ height: isFilmstripVisible ? `${filmstripHeight}px` : '0px' }}
        >
          <div className="w-full p-2" style={{ height: `${filmstripHeight}px` }}>
            <Filmstrip
              imageList={imageList}
              imageRatings={imageRatings}
              isLoading={isLoading}
              multiSelectedPaths={multiSelectedPaths}
              onClearSelection={onClearSelection}
              onContextMenu={onContextMenu}
              onImageSelect={onImageSelect}
              selectedImage={selectedImage}
              thumbnails={thumbnails}
              thumbnailAspectRatio={thumbnailAspectRatio}
              totalImages={imageList.length}
            />
          </div>
        </div>
      )}

      <div
        className={clsx(
          'flex-shrink-0 h-10 flex items-center justify-between px-3',
          !isLibraryView && 'border-t', 
          (!isLibraryView && isFilmstripVisible) ? 'border-surface' : 'border-transparent'
        )}
      >
        <div className="flex items-center gap-4">
          <StarRating rating={rating} onRate={onRate} disabled={isRatingDisabled} />
          <div className="h-5 w-px bg-surface"></div>
          <div className="flex items-center gap-2">
            <button
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              disabled={isCopyDisabled}
              onClick={onCopy}
              data-tooltip="Copy Settings"
            >
              {isCopied ? <Check size={18} className="text-green-500 animate-pop-in" /> : <Copy size={18} />}
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              disabled={isPasteDisabled}
              onClick={onPaste}
              data-tooltip="Paste Settings"
            >
              {isPasted ? <Check size={18} className="text-green-500 animate-pop-in" /> : <ClipboardPaste size={18} />}
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              onClick={onOpenCopyPasteSettings}
              data-tooltip="Copy & Paste Settings"
            >
              <Settings size={18} />
            </button>
          </div>
          <div
            className={clsx(
              'flex items-center transition-all duration-300 ease-out overflow-hidden',
              showSelectionCounter ? 'max-w-xs opacity-100' : 'max-w-0 opacity-0',
            )}
          >
            <div className="h-5 w-px bg-surface mr-4"></div>
            <span className="text-sm text-text-secondary whitespace-nowrap">{numSelected} of {total} images selected</span>
          </div>
        </div>
        <div className="flex-grow" />
        {isLibraryView ? (
          <div className="flex items-center gap-2">
            <button
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              disabled={isResetDisabled}
              onClick={onReset}
              data-tooltip="Reset All Adjustments"
            >
              <RotateCcw size={18} />
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              disabled={isExportDisabled}
              onClick={onExportClick}
              data-tooltip="Export"
            >
              <Save size={18} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 w-56">
              <div
                className="relative w-12 h-full flex items-center justify-end cursor-pointer"
                onClick={handleResetZoom}
                onMouseEnter={() => setIsZoomLabelHovered(true)}
                onMouseLeave={() => setIsZoomLabelHovered(false)}
                data-tooltip="Reset Zoom to Fit Window"
              >
                <span className="absolute right-0 text-xs text-text-secondary select-none text-right w-max transition-colors hover:text-text-primary">
                  {isZoomLabelHovered ? 'Reset Zoom' : 'Zoom'}
                </span>
              </div>
              
              <div className="relative flex-1 h-5">
                <div className="absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/2 bg-surface rounded-full pointer-events-none" />
                <input
                  type="range"
                  min={0.1}
                  max={2.0}
                  step="0.05"
                  value={latchedSliderValue}
                  onChange={handleSliderChange}
                  onKeyDown={handleZoomKeyDown}
                  onMouseDown={handleMouseDown}
                  onMouseUp={handleMouseUp}
                  onTouchStart={handleMouseDown}
                  onTouchEnd={handleMouseUp}
                  onDoubleClick={handleResetZoom}
                  className={`absolute top-1/2 left-0 w-full h-1.5 -mt-[1.5px] appearance-none bg-transparent cursor-pointer p-0 slider-input z-10 ${
                    isZoomActive ? 'slider-thumb-active' : ''
                  }`}
                />
              </div>

              <div className="relative text-xs text-text-secondary w-6 text-right flex items-center justify-end h-5 gap-1">
                {isEditingPercent ? (
                  <input
                    ref={percentInputRef}
                    type="text"
                    value={percentInputValue}
                    onChange={(e) => setPercentInputValue(e.target.value)}
                    onKeyDown={handlePercentKeyDown}
                    onBlur={handlePercentSubmit}
                    className="w-full text-xs text-text-primary bg-bg-primary border border-border-color rounded px-1 text-right"
                    style={{ fontSize: '12px', height: '18px' }}
                  />
                ) : (
                  <span
                    onClick={handlePercentClick}
                    className="cursor-pointer hover:text-text-primary transition-colors select-none"
                    data-tooltip="Click to enter custom zoom percentage"
                  >
                    {latchedDisplayPercent}%
                  </span>
                )}
              </div>
            </div>
            <div className="h-5 w-px bg-surface"></div>
            <button
              className="p-1.5 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              onClick={() => setIsFilmstripVisible?.(!isFilmstripVisible)}
              data-tooltip={isFilmstripVisible ? 'Collapse Filmstrip' : 'Expand Filmstrip'}
            >
              {isFilmstripVisible ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
