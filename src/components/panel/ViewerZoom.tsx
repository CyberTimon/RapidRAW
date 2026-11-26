import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { GLOBAL_KEYS } from '../../types/ui';
import { getZoomContentSize, getZoomPercent, useEditorStore } from '../../store/useEditorStore';
import { useShortcuts } from '../../hooks/useShortcuts';
import { useProgramCanvas } from '../../store/videoIntegration';

interface ViewerZoomProps {
  className?: string;
  sliderClassName?: string;
  trackClassName?: string;
  fitContent?: boolean;
  isLoading: boolean;
  onZoomChange(zoomValue: number, fitToWindow?: boolean): void;
}

export default function ViewerZoom({
  className,
  sliderClassName,
  trackClassName = 'bg-surface',
  fitContent = false,
  isLoading,
  onZoomChange,
}: ViewerZoomProps) {
  const { t } = useTranslation();
  const shortcut = useShortcuts();
  const canvas = useProgramCanvas();
  const { displayWidth, contentWidth, zoomPercent } = useEditorStore(
    useShallow((state) => ({
      displayWidth: state.displaySize.width,
      contentWidth: getZoomContentSize(state, canvas).width,
      zoomPercent: getZoomPercent(state, canvas),
    })),
  );

  const [isEditingPercent, setIsEditingPercent] = useState(false);
  const [percentInputValue, setPercentInputValue] = useState('');
  const isDraggingSlider = useRef(false);
  const [isZoomActive, setIsZoomActive] = useState(false);

  const percentInputRef = useRef<HTMLInputElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState<number | null>(null);
  const [isZoomLabelHovered, setIsZoomLabelHovered] = useState(false);

  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!fitContent || !label) return;
    const observer = new ResizeObserver(([entry]) => setLabelWidth(Math.ceil(entry.contentRect.width)));
    observer.observe(label);
    return () => observer.disconnect();
  }, [fitContent]);
  const isZoomReady = !isLoading && contentWidth > 0 && displayWidth > 0;

  const currentOriginalPercent = isZoomReady ? zoomPercent : 1.0;

  const [latchedSliderValue, setLatchedSliderValue] = useState(1.0);
  const [latchedDisplayPercent, setLatchedDisplayPercent] = useState(100);

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
    <div className={clsx(className, 'flex items-center gap-2')}>
      <div
        className={clsx(
          'h-full shrink-0 flex items-center justify-end cursor-pointer',
          fitContent ? 'overflow-hidden transition-[width] duration-200 ease-out' : 'relative w-12',
          sliderClassName,
        )}
        style={fitContent && labelWidth !== null ? { width: labelWidth } : undefined}
        onClick={handleResetZoom}
        onMouseEnter={() => setIsZoomLabelHovered(true)}
        onMouseLeave={() => setIsZoomLabelHovered(false)}
        data-tooltip={t('ui.bottomBar.tooltips.resetZoom')}
        {...shortcut('zoom_fit')}
      >
        <span
          ref={labelRef}
          className={clsx(
            'text-xs text-text-secondary select-none text-right w-max transition-colors hover:text-text-primary',
            fitContent ? 'shrink-0 whitespace-nowrap' : 'absolute right-0',
          )}
        >
          {isZoomLabelHovered ? t('ui.bottomBar.zoomLabelReset') : t('ui.bottomBar.zoomLabel')}
        </span>
      </div>

      <div className={clsx('relative h-5', fitContent ? 'w-28 shrink-0' : 'flex-1 min-w-24', sliderClassName)}>
        <div
          className={clsx(
            'absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/2 rounded-full pointer-events-none',
            trackClassName,
          )}
        />
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
          className={`absolute top-1/2 left-0 w-full h-1.5 mt-[-1.5px] appearance-none bg-transparent cursor-pointer p-0 slider-input z-10 ${
            isZoomActive ? 'slider-thumb-active' : ''
          }`}
        />
      </div>

      <div
        className={clsx(
          'relative text-xs text-text-secondary shrink-0 text-right h-5',
          fitContent ? 'grid items-center justify-items-end tabular-nums' : 'w-6 flex items-center justify-end gap-1',
        )}
      >
        {fitContent && (
          <span className="invisible col-start-1 row-start-1 select-none" aria-hidden>
            200%
          </span>
        )}
        {isEditingPercent ? (
          <input
            ref={percentInputRef}
            type="text"
            value={percentInputValue}
            onChange={(e) => setPercentInputValue(e.target.value)}
            onKeyDown={handlePercentKeyDown}
            onBlur={handlePercentSubmit}
            className={clsx(
              'w-full text-xs text-text-primary bg-bg-primary border border-border-color rounded-sm px-1 text-right',
              fitContent && 'absolute inset-x-0 top-1/2 -translate-y-1/2',
            )}
            style={{ fontSize: '12px', height: '18px' }}
          />
        ) : (
          <span
            onClick={handlePercentClick}
            className="col-start-1 row-start-1 cursor-pointer hover:text-text-primary transition-colors select-none"
            data-tooltip={t('ui.bottomBar.tooltips.customZoom')}
          >
            {latchedDisplayPercent}%
          </span>
        )}
      </div>
    </div>
  );
}
