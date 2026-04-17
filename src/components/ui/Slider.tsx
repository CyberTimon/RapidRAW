import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GLOBAL_KEYS } from './AppProperties';

interface SliderProps {
  defaultValue?: number;
  label: any;
  max: number;
  min: number;
  onChange(event: any): void;
  onDragStateChange?(state: boolean): void;
  step: number;
  value: number;
  trackClassName?: string;
  fillOrigin?: 'min' | 'default';
  suffix?: string;
}

const DOUBLE_CLICK_THRESHOLD_MS = 300;
const FINE_ADJUSTMENT_MULTIPLIER = 0.2;

const Slider = ({
  defaultValue = 0,
  label,
  max,
  min,
  onChange,
  onDragStateChange = () => {},
  step = 1,
  value,
  trackClassName,
  fillOrigin = 'default',
  suffix = '',
}: SliderProps) => {
  const [displayValue, setDisplayValue] = useState<number>(value);
  const [isDragging, setIsDragging] = useState(false);
  const animationFrameRef = useRef<any>(undefined);
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rangeInputRef = useRef<HTMLInputElement | null>(null);
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpTime = useRef(0);

  const lastPointerXRef = useRef<number>(0);
  const accumulatedValueRef = useRef<number>(0);

  const fillPercentage = max !== min ? ((displayValue - min) / (max - min)) * 100 : 0;

  const originPercentage = useMemo(() => {
    if (fillOrigin === 'min') {
      return 0;
    }
    return max !== min ? ((defaultValue - min) / (max - min)) * 100 : 0;
  }, [fillOrigin, defaultValue, min, max]);

  const stepStr = String(step);
  const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

  const snapToStep = useCallback(
    (val: number): number => {
      const snapped = Math.round((val - min) / step) * step + min;
      const clamped = Math.max(min, Math.min(max, snapped));
      return parseFloat(clamped.toFixed(decimalPlaces));
    },
    [min, max, step, decimalPlaces],
  );

  const onChangeRef = useRef(onChange);
  const snapToStepRef = useRef(snapToStep);
  const rangeRef = useRef({ min, max });
  onChangeRef.current = onChange;
  snapToStepRef.current = snapToStep;
  rangeRef.current = { min, max };

  const pendingDispatchRef = useRef<number | null>(null);
  const dispatchRafRef = useRef<number | null>(null);

  useEffect(() => {
    onDragStateChange(isDragging);
  }, [isDragging, onDragStateChange]);

  useEffect(() => {
    const sliderElement = containerRef.current;
    if (!sliderElement) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey) {
        return;
      }

      event.preventDefault();
      const direction = -Math.sign(event.deltaY);
      const newValue = value + direction * step * 2;
      const roundedNewValue = parseFloat(newValue.toFixed(decimalPlaces));

      const clampedValue = Math.max(min, Math.min(max, roundedNewValue));

      if (clampedValue !== value && !isNaN(clampedValue)) {
        const syntheticEvent = {
          target: {
            value: clampedValue,
          },
        };
        onChange(syntheticEvent);
      }
    };

    sliderElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      sliderElement.removeEventListener('wheel', handleWheel);
    };
  }, [value, min, max, step, onChange, decimalPlaces]);

  useEffect(() => {
    if (!isDragging) return;

    const inputEl = rangeInputRef.current;
    if (!inputEl) return;
    const sliderWidth = inputEl.getBoundingClientRect().width || 1;

    const handlePointerMove = (e: MouseEvent | TouchEvent) => {
      let clientX: number;
      let shiftKey: boolean;

      if ('touches' in e) {
        if (e.touches.length === 0) return;
        clientX = e.touches[0].clientX;
        shiftKey = e.shiftKey || e.altKey;
      } else {
        clientX = e.clientX;
        shiftKey = e.shiftKey || e.altKey;
      }

      const deltaX = clientX - lastPointerXRef.current;
      const { min: curMin, max: curMax } = rangeRef.current;

      const multiplier = shiftKey ? FINE_ADJUSTMENT_MULTIPLIER : 1;
      const deltaValue = (deltaX / sliderWidth) * (curMax - curMin) * multiplier;

      const prevAccumulated = accumulatedValueRef.current;
      accumulatedValueRef.current = Math.max(curMin, Math.min(curMax, prevAccumulated + deltaValue));

      const actualDeltaValue = accumulatedValueRef.current - prevAccumulated;
      if (deltaValue !== 0) {
        lastPointerXRef.current += deltaX * (actualDeltaValue / deltaValue);
      }

      const snappedValue = snapToStepRef.current(accumulatedValueRef.current);

      setDisplayValue(snappedValue);
      pendingDispatchRef.current = snappedValue;
      if (dispatchRafRef.current === null) {
        dispatchRafRef.current = requestAnimationFrame(() => {
          if (pendingDispatchRef.current !== null) {
            onChangeRef.current({ target: { value: pendingDispatchRef.current } });
          }
          dispatchRafRef.current = null;
        });
      }
    };

    const handlePointerUp = () => {
      // Flush any pending dispatch immediately on release
      if (dispatchRafRef.current !== null) {
        cancelAnimationFrame(dispatchRafRef.current);
        dispatchRafRef.current = null;
      }
      if (pendingDispatchRef.current !== null) {
        onChangeRef.current({ target: { value: pendingDispatchRef.current } });
        pendingDispatchRef.current = null;
      }
      lastUpTime.current = Date.now();
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove);
    window.addEventListener('touchend', handlePointerUp);

    return () => {
      window.removeEventListener('mousemove', handlePointerMove);
      window.removeEventListener('mouseup', handlePointerUp);
      window.removeEventListener('touchmove', handlePointerMove);
      window.removeEventListener('touchend', handlePointerUp);
      if (dispatchRafRef.current !== null) {
        cancelAnimationFrame(dispatchRafRef.current);
        dispatchRafRef.current = null;
      }
    };
  }, [isDragging]);

  useEffect(() => {
    if (isDragging) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      return;
    }

    const startValue = displayValue;
    const endValue = value;
    const duration = 300;
    let startTime: any = null;

    const easeInOut = (t: number) => t * t * (3 - 2 * t);

    const animate = (timestamp: any) => {
      if (!startTime) {
        startTime = timestamp;
      }

      const progress = timestamp - startTime;
      const linearFraction = Math.min(progress / duration, 1);
      const easedFraction = easeInOut(linearFraction);
      const currentValue = startValue + (endValue - startValue) * easedFraction;
      setDisplayValue(currentValue);

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
  }, [value, isDragging]);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(String(value));
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleReset = () => {
    const syntheticEvent = {
      target: {
        value: defaultValue,
      },
    };
    onChange(syntheticEvent);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isDragging) {
      setDisplayValue(Number(e.target.value));
      onChange(e);
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLInputElement>) => {
    if (Date.now() - lastUpTime.current < DOUBLE_CLICK_THRESHOLD_MS) {
      e.preventDefault();
      return;
    }

    e.preventDefault();

    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const rawValue = min + fraction * (max - min);
    const snappedValue = snapToStep(rawValue);

    accumulatedValueRef.current = snappedValue;
    lastPointerXRef.current = e.clientX;

    setIsDragging(true);
    setDisplayValue(snappedValue);
    onChange({ target: { value: snappedValue } });
  };

  const handleTouchStart = (e: React.TouchEvent<HTMLInputElement>) => {
    if (e.touches.length === 0) return;

    const touch = e.touches[0];
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    const rawValue = min + fraction * (max - min);
    const snappedValue = snapToStep(rawValue);

    accumulatedValueRef.current = snappedValue;
    lastPointerXRef.current = touch.clientX;

    setIsDragging(true);
    setDisplayValue(snappedValue);
    onChange({ target: { value: snappedValue } });
  };

  const handleValueClick = () => {
    setIsEditing(true);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleInputCommit = () => {
    let newValue = parseFloat(inputValue);
    if (isNaN(newValue)) {
      newValue = value;
    } else {
      newValue = Math.max(min, Math.min(max, newValue));
    }

    const syntheticEvent = {
      target: {
        value: newValue,
      },
    };
    onChange(syntheticEvent);
    setIsEditing(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleInputCommit();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      setInputValue(String(value));
      setIsEditing(false);
      e.currentTarget.blur();
    }
  };

  const handleRangeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.currentTarget.blur();
      return;
    }

    if (GLOBAL_KEYS.includes(e.key)) {
      e.currentTarget.blur();
    }
  };

  const numericValue = isNaN(Number(value)) ? 0 : Number(value);

  return (
    <div className="mb-2 group" ref={containerRef}>
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
        <div className="w-12 text-right">
          {isEditing ? (
            <input
              className="w-full text-sm text-right bg-card-active border border-gray-500 rounded-sm px-1 py-0 outline-hidden focus:ring-1 focus:ring-blue-500 text-text-primary"
              max={max}
              min={min}
              onBlur={handleInputCommit}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              ref={inputRef}
              step={step}
              type="number"
              value={inputValue}
            />
          ) : (
            <span
              className="text-sm text-text-primary w-full text-right select-none cursor-text"
              onClick={handleValueClick}
              onDoubleClick={handleReset}
              data-tooltip={`Click to edit`}
            >
              {decimalPlaces > 0 && numericValue === 0 ? '0' : numericValue.toFixed(decimalPlaces)}
              {suffix && <span className="text-[10px] align-top inline-block mt-0.5 ml-0.5">{suffix}</span>}
            </span>
          )}
        </div>
      </div>

      <div className="relative w-full h-5">
        <div
          className={`absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/4 rounded-full pointer-events-none ${
            trackClassName || 'bg-card-active'
          }`}
        />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/4 rounded-full pointer-events-none bg-accent/25"
          style={{
            left: `${Math.min(fillPercentage, originPercentage)}%`,
            width: `${Math.abs(fillPercentage - originPercentage)}%`,
          }}
        />
        <input
          ref={rangeInputRef}
          className={`absolute top-1/2 left-0 w-full h-1.5 appearance-none bg-transparent cursor-pointer m-0 p-0 slider-input z-10 ${
            isDragging ? 'slider-thumb-active' : ''
          }`}
          style={{ margin: 0 }}
          max={String(max)}
          min={String(min)}
          onChange={handleChange}
          onDoubleClick={handleReset}
          onKeyDown={handleRangeKeyDown}
          onMouseDown={handleMouseDown}
          onTouchStart={handleTouchStart}
          step={String(step)}
          type="range"
          value={displayValue}
        />
      </div>
    </div>
  );
};

export default Slider;
