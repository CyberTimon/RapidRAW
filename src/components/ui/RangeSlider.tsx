import React, { useState, useRef, useEffect, useCallback } from 'react';

interface RangeSliderProps {
  label: React.ReactNode;
  minLimit: number;
  maxLimit: number;
  min: number;
  max: number;
  defaultValue?: { min: number; max: number };
  onChange: (values: { min: number; max: number }) => void;
  onDragStateChange?: (isDragging: boolean) => void;
  step?: number;
  suffix?: string;
  gradientColors?: string[];
  trackClassName?: string;
}

type Handle = 'min' | 'max';

const DOUBLE_CLICK_THRESHOLD_MS = 300;
const FINE_ADJUSTMENT_MULTIPLIER = 0.2;
const TOUCH_DRAG_THRESHOLD_PX = 10;
const TOUCH_THUMB_HIT_RADIUS_PX = 24;

const RangeSlider: React.FC<RangeSliderProps> = ({
  label,
  minLimit,
  maxLimit,
  min: initialMin,
  max: initialMax,
  defaultValue,
  onChange,
  onDragStateChange = () => {},
  step = 1,
  suffix = '',
  gradientColors,
  trackClassName,
}) => {
  // Display values (for animation/live updates)
  const [displayMin, setDisplayMin] = useState(initialMin);
  const [displayMax, setDisplayMax] = useState(initialMax);
  // Actual values (target for animation)
  const [valueMin, setValueMin] = useState(initialMin);
  const [valueMax, setValueMax] = useState(initialMax);
  const [draggingHandle, setDraggingHandle] = useState<Handle | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const [isEditingMin, setIsEditingMin] = useState(false);
  const [isEditingMax, setIsEditingMax] = useState(false);
  const [inputValue, setInputValue] = useState<string>('');
  const minInputRef = useRef<HTMLInputElement | null>(null);
  const maxInputRef = useRef<HTMLInputElement | null>(null);
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpTime = useRef(0);
  const lastPointerXRef = useRef<number>(0);
  const accumulatedValueRef = useRef<number>(0);
  const pendingTouchRef = useRef<{
    startX: number;
    startY: number;
    latestX: number;
    startMin: number;
    startMax: number;
    handle: Handle;
  } | null>(null);
  const suppressTouchChangeRef = useRef(false);

  const defaultMin = defaultValue?.min ?? minLimit;
  const defaultMax = defaultValue?.max ?? maxLimit;

  const stepStr = String(step);
  const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

  const snapToStep = useCallback(
    (val: number): number => {
      const snapped = Math.round((val - minLimit) / step) * step + minLimit;
      const clamped = Math.max(minLimit, Math.min(maxLimit, snapped));
      return parseFloat(clamped.toFixed(decimalPlaces));
    },
    [minLimit, maxLimit, step, decimalPlaces]
  );

  const onChangeRef = useRef(onChange);
  const snapToStepRef = useRef(snapToStep);
  const rangeRef = useRef({ min: minLimit, max: maxLimit });

  onChangeRef.current = onChange;
  snapToStepRef.current = snapToStep;
  rangeRef.current = { min: minLimit, max: maxLimit };

  const isDragging = draggingHandle !== null;

  useEffect(() => {
    onDragStateChange(isDragging);
  }, [isDragging, onDragStateChange]);

  // Update internal state when props change
  useEffect(() => {
    setValueMin(initialMin);
    setValueMax(initialMax);
  }, [initialMin, initialMax]);

  // ANIMATION - EXACT COPY from Slider.tsx
  useEffect(() => {
    if (isDragging) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      return;
    }

    const startMin = displayMin;
    const endMin = valueMin;
    const startMax = displayMax;
    const endMax = valueMax;
    const duration = 300;
    let startTime: number | null = null;

    const easeInOut = (t: number) => t * t * (3 - 2 * t);

    const animate = (timestamp: number) => {
      if (!startTime) {
        startTime = timestamp;
      }

      const progress = timestamp - startTime;
      const linearFraction = Math.min(progress / duration, 1);
      const easedFraction = easeInOut(linearFraction);
      const currentMin = startMin + (endMin - startMin) * easedFraction;
      const currentMax = startMax + (endMax - startMax) * easedFraction;
      setDisplayMin(currentMin);
      setDisplayMax(currentMax);

      if (linearFraction < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [valueMin, valueMax, isDragging]);

  useEffect(() => {
    if (!isEditingMin && !isEditingMax) {
      setInputValue('');
    }
  }, [isEditingMin, isEditingMax]);

  useEffect(() => {
    if (isEditingMin && minInputRef.current) {
      minInputRef.current.focus();
      minInputRef.current.select();
    }
    if (isEditingMax && maxInputRef.current) {
      maxInputRef.current.focus();
      maxInputRef.current.select();
    }
  }, [isEditingMin, isEditingMax]);

  const getPercent = useCallback((value: number) => {
    return ((value - minLimit) / (maxLimit - minLimit)) * 100;
  }, [minLimit, maxLimit]);

  const handleReset = () => {
    setValueMin(defaultMin);
    setValueMax(defaultMax);
    onChange({ min: defaultMin, max: defaultMax });
  };

  // Wheel support with Shift key
  useEffect(() => {
    const sliderElement = containerRef.current;
    if (!sliderElement) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey) {
        return;
      }

      event.preventDefault();
      const direction = -Math.sign(event.deltaY || event.deltaX);
      
      const rect = sliderElement.getBoundingClientRect();
      const mouseX = event.clientX;
      const minX = rect.left + (getPercent(valueMin) * rect.width) / 100;
      const maxX = rect.left + (getPercent(valueMax) * rect.width) / 100;
      
      const distToMin = Math.abs(mouseX - minX);
      const distToMax = Math.abs(mouseX - maxX);
      
      if (distToMin < distToMax) {
        const newMin = snapToStep(valueMin + direction * step * 2);
        const clampedMin = Math.max(minLimit, Math.min(newMin, valueMax - step));
        if (clampedMin !== valueMin) {
          setValueMin(clampedMin);
          onChange({ min: clampedMin, max: valueMax });
        }
      } else {
        const newMax = snapToStep(valueMax + direction * step * 2);
        const clampedMax = Math.min(maxLimit, Math.max(newMax, valueMin + step));
        if (clampedMax !== valueMax) {
          setValueMax(clampedMax);
          onChange({ min: valueMin, max: clampedMax });
        }
      }
    };

    sliderElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      sliderElement.removeEventListener('wheel', handleWheel);
    };
  }, [valueMin, valueMax, minLimit, maxLimit, step, snapToStep, onChange, getPercent]);

  // Drag handling
  useEffect(() => {
    if (!draggingHandle) return;

    const sliderElement = containerRef.current;
    if (!sliderElement) return;
    const sliderWidth = sliderElement.getBoundingClientRect().width || 1;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      let clientX: number;
      let shiftKey: boolean;

      if ('touches' in e) {
        if (e.touches.length === 0) return;
        clientX = e.touches[0].clientX;
        shiftKey = e.shiftKey || e.altKey;
        if (e.cancelable) e.preventDefault();
      } else {
        clientX = (e as MouseEvent).clientX;
        shiftKey = (e as MouseEvent).shiftKey || (e as MouseEvent).altKey;
      }

      const deltaX = clientX - lastPointerXRef.current;
      const multiplier = shiftKey ? FINE_ADJUSTMENT_MULTIPLIER : 1;
      const deltaValue = (deltaX / sliderWidth) * (maxLimit - minLimit) * multiplier;

      const prevAccumulated = accumulatedValueRef.current;
      let newValue = prevAccumulated + deltaValue;

      if (draggingHandle === 'min') {
        newValue = Math.max(minLimit, Math.min(newValue, valueMax - step));
      } else {
        newValue = Math.max(valueMin + step, Math.min(newValue, maxLimit));
      }

      accumulatedValueRef.current = newValue;

      const actualDeltaValue = accumulatedValueRef.current - prevAccumulated;
      if (deltaValue !== 0) {
        lastPointerXRef.current += deltaX * (actualDeltaValue / deltaValue);
      } else {
        lastPointerXRef.current = clientX;
      }

      const snappedValue = snapToStep(accumulatedValueRef.current);

      if (draggingHandle === 'min') {
        setDisplayMin(snappedValue);
        setValueMin(snappedValue);
        onChange({ min: snappedValue, max: valueMax });
      } else {
        setDisplayMax(snappedValue);
        setValueMax(snappedValue);
        onChange({ min: valueMin, max: snappedValue });
      }
    };

    const handlePointerUp = () => {
      lastUpTime.current = Date.now();
      setDraggingHandle(null);
      pendingTouchRef.current = null;
      suppressTouchChangeRef.current = false;
    };

    window.addEventListener('mousemove', handlePointerMove, { passive: false });
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);
    window.addEventListener('touchcancel', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
      window.removeEventListener('touchcancel', handlePointerUp);
    };
  }, [draggingHandle, valueMin, valueMax, minLimit, maxLimit, step, snapToStep, onChange]);

  const handleMinMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastUpTime.current < DOUBLE_CLICK_THRESHOLD_MS) {
      e.preventDefault();
      return;
    }
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      let rawValue = minLimit + fraction * (maxLimit - minLimit);
      rawValue = Math.min(rawValue, valueMax - step);
      const snappedValue = snapToStep(rawValue);
      
      accumulatedValueRef.current = snappedValue;
      lastPointerXRef.current = e.clientX;

      setDraggingHandle('min');
      setDisplayMin(snappedValue);
      setValueMin(snappedValue);
      onChange({ min: snappedValue, max: valueMax });
    }
  };

  const handleMaxMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() - lastUpTime.current < DOUBLE_CLICK_THRESHOLD_MS) {
      e.preventDefault();
      return;
    }
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      let rawValue = minLimit + fraction * (maxLimit - minLimit);
      rawValue = Math.max(rawValue, valueMin + step);
      const snappedValue = snapToStep(rawValue);
      
      accumulatedValueRef.current = snappedValue;
      lastPointerXRef.current = e.clientX;

      setDraggingHandle('max');
      setDisplayMax(snappedValue);
      setValueMax(snappedValue);
      onChange({ min: valueMin, max: snappedValue });
    }
  };

  // Touch support with hit radius detection (same as Slider.tsx)
  const handleMinTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    e.preventDefault();

    const touch = e.touches[0];
    suppressTouchChangeRef.current = true;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const minPercent = getPercent(valueMin);
    const minThumbX = rect.left + (minPercent / 100) * rect.width;

    // Check if touch is within hit radius of the min thumb
    if (Math.abs(touch.clientX - minThumbX) > TOUCH_THUMB_HIT_RADIUS_PX) {
      pendingTouchRef.current = null;
      return;
    }

    pendingTouchRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      latestX: touch.clientX,
      startMin: valueMin,
      startMax: valueMax,
      handle: 'min',
    };
  };

  const handleMaxTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 0) return;
    e.preventDefault();

    const touch = e.touches[0];
    suppressTouchChangeRef.current = true;

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const maxPercent = getPercent(valueMax);
    const maxThumbX = rect.left + (maxPercent / 100) * rect.width;

    // Check if touch is within hit radius of the max thumb
    if (Math.abs(touch.clientX - maxThumbX) > TOUCH_THUMB_HIT_RADIUS_PX) {
      pendingTouchRef.current = null;
      return;
    }

    pendingTouchRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      latestX: touch.clientX,
      startMin: valueMin,
      startMax: valueMax,
      handle: 'max',
    };
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDragging || !pendingTouchRef.current || e.touches.length === 0) return;

    const touch = e.touches[0];
    const pendingTouch = pendingTouchRef.current;
    pendingTouch.latestX = touch.clientX;

    const deltaX = touch.clientX - pendingTouch.startX;
    const deltaY = touch.clientY - pendingTouch.startY;

    if (
      Math.abs(deltaY) > TOUCH_DRAG_THRESHOLD_PX &&
      Math.abs(deltaY) > Math.abs(deltaX)
    ) {
      pendingTouchRef.current = null;
      return;
    }

    if (
      Math.abs(deltaX) < TOUCH_DRAG_THRESHOLD_PX ||
      Math.abs(deltaX) < Math.abs(deltaY)
    ) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const totalWidth = rect.width;
    
    let rawValue;
    if (pendingTouch.handle === 'min') {
      rawValue = pendingTouch.startMin + (deltaX / totalWidth) * (maxLimit - minLimit);
      rawValue = Math.max(minLimit, Math.min(valueMax - step, rawValue));
    } else {
      rawValue = pendingTouch.startMax + (deltaX / totalWidth) * (maxLimit - minLimit);
      rawValue = Math.max(valueMin + step, Math.min(maxLimit, rawValue));
    }
    
    const snappedValue = snapToStep(rawValue);

    lastPointerXRef.current = touch.clientX;
    pendingTouchRef.current = null;

    if (e.cancelable) {
      e.preventDefault();
    }

    setDraggingHandle(pendingTouch.handle);

    if (pendingTouch.handle === 'min') {
      setDisplayMin(snappedValue);
      setValueMin(snappedValue);
      onChange({ min: snappedValue, max: valueMax });
    } else {
      setDisplayMax(snappedValue);
      setValueMax(snappedValue);
      onChange({ min: valueMin, max: snappedValue });
    }
  };

  const handleTouchEnd = () => {
    pendingTouchRef.current = null;
    suppressTouchChangeRef.current = false;
    if (draggingHandle) {
      setDraggingHandle(null);
    }
  };

  const handleMinValueClick = () => {
    setInputValue(String(valueMin));
    setIsEditingMin(true);
  };

  const handleMaxValueClick = () => {
    setInputValue(String(valueMax));
    setIsEditingMax(true);
  };

  const handleMinInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleMaxInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleMinInputCommit = () => {
    let newValue = parseFloat(inputValue);
    if (isNaN(newValue)) {
      newValue = valueMin;
    } else {
      newValue = Math.max(minLimit, Math.min(valueMax - step, newValue));
      newValue = snapToStep(newValue);
    }
    setValueMin(newValue);
    onChange({ min: newValue, max: valueMax });
    setIsEditingMin(false);
  };

  const handleMaxInputCommit = () => {
    let newValue = parseFloat(inputValue);
    if (isNaN(newValue)) {
      newValue = valueMax;
    } else {
      newValue = Math.max(valueMin + step, Math.min(maxLimit, newValue));
      newValue = snapToStep(newValue);
    }
    setValueMax(newValue);
    onChange({ min: valueMin, max: newValue });
    setIsEditingMax(false);
  };

  const handleMinInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleMinInputCommit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setIsEditingMin(false);
      e.currentTarget.blur();
    }
  };

  const handleMaxInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleMaxInputCommit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setIsEditingMax(false);
      e.currentTarget.blur();
    }
  };

  const minPercent = getPercent(displayMin);
  const maxPercent = getPercent(displayMax);
  
  const numericMin = isNaN(Number(valueMin)) ? 0 : Number(valueMin);
  const numericMax = isNaN(Number(valueMax)) ? 0 : Number(valueMax);

  return (
    <div className="mb-4 group" ref={containerRef}>
      <div className="flex justify-between items-center mb-1">
        <div
          className={`grid ${typeof label === 'string' ? 'cursor-pointer' : ''}`}
          onClick={typeof label === 'string' ? handleReset : undefined}
          onDoubleClick={typeof label === 'string' ? handleReset : undefined}
          onMouseEnter={typeof label === 'string' ? () => setIsLabelHovered(true) : undefined}
          onMouseLeave={typeof label === 'string' ? () => setIsLabelHovered(false) : undefined}
        >
          <span
            aria-hidden={isLabelHovered && typeof label === 'string'}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered && typeof label === 'string' ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {label}
          </span>
          {typeof label === 'string' && (
            <span
              aria-hidden={!isLabelHovered}
              className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
                isLabelHovered ? 'opacity-100' : 'opacity-0'
              }`}
            >
              Reset
            </span>
          )}
        </div>
        <div className="flex gap-3">
          <div className="w-12 text-right">
            {isEditingMin ? (
              <input
                ref={minInputRef}
                className="w-full text-sm text-right bg-card-active border border-gray-500 rounded-sm px-1 py-0 outline-none focus:ring-1 focus:ring-blue-500 text-text-primary"
                max={valueMax - step}
                min={minLimit}
                onBlur={handleMinInputCommit}
                onChange={handleMinInputChange}
                onKeyDown={handleMinInputKeyDown}
                step={step}
                type="number"
                value={inputValue}
              />
            ) : (
              <span
                className="text-sm text-text-primary w-full text-right select-none cursor-text"
                onClick={handleMinValueClick}
                onDoubleClick={handleReset}
                data-tooltip="Click to edit"
              >
                {decimalPlaces > 0 && numericMin === 0 ? '0' : numericMin.toFixed(decimalPlaces)}
                {suffix && <span className="text-[10px] align-top inline-block mt-0.5 ml-0.5">{suffix}</span>}
              </span>
            )}
          </div>
          <div className="w-12 text-right">
            {isEditingMax ? (
              <input
                ref={maxInputRef}
                className="w-full text-sm text-right bg-card-active border border-gray-500 rounded-sm px-1 py-0 outline-none focus:ring-1 focus:ring-blue-500 text-text-primary"
                max={maxLimit}
                min={valueMin + step}
                onBlur={handleMaxInputCommit}
                onChange={handleMaxInputChange}
                onKeyDown={handleMaxInputKeyDown}
                step={step}
                type="number"
                value={inputValue}
              />
            ) : (
              <span
                className="text-sm text-text-primary w-full text-right select-none cursor-text"
                onClick={handleMaxValueClick}
                onDoubleClick={handleReset}
                data-tooltip="Click to edit"
              >
                {decimalPlaces > 0 && numericMax === 0 ? '0' : numericMax.toFixed(decimalPlaces)}
                {suffix && <span className="text-[10px] align-top inline-block mt-0.5 ml-0.5">{suffix}</span>}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="relative w-full h-5">
        <div
          className={`absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/4 rounded-full pointer-events-none ${
            trackClassName || 'bg-card-active'
          }`}
          style={{ background: gradientColors?.length ? `linear-gradient(to right, ${gradientColors.join(', ')})` : undefined }}
        />
        
        {/* Unselected range */}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/4 rounded-full pointer-events-none bg-[rgba(0,0,0,0.5)]"
          style={{
            left: 0,
            width: `${minPercent}%`,
          }}
        />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/4 rounded-full pointer-events-none bg-[rgba(0,0,0,0.5)]"
          style={{
            left: `${maxPercent}%`,
            width: `${100 - maxPercent}%`,
          }}
        />
        
        {/* Selected range */}
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/4 rounded-full pointer-events-none bg-accent/25"
          style={{
            left: `${minPercent}%`,
            width: `${maxPercent - minPercent}%`,
          }}
        />
        
        {/* Min Handle */}
        <div
          className={`absolute top-1/2 w-4 h-4 -translate-y-1/2 -translate-x-1/2 rounded-full bg-accent border-2 border-white shadow-md cursor-pointer z-20 ${
            draggingHandle === 'min' ? 'scale-110' : ''
          }`}
          style={{ left: `${minPercent}%` }}
          onMouseDown={handleMinMouseDown}
          onTouchStart={handleMinTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        />
        
        {/* Max Handle */}
        <div
          className={`absolute top-1/2 w-4 h-4 -translate-y-1/2 -translate-x-1/2 rounded-full bg-accent border-2 border-white shadow-md cursor-pointer z-20 ${
            draggingHandle === 'max' ? 'scale-110' : ''
          }`}
          style={{ left: `${maxPercent}%` }}
          onMouseDown={handleMaxMouseDown}
          onTouchStart={handleMaxTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        />
      </div>
    </div>
  );
};

export default RangeSlider;
