import React, { useState, useEffect, useRef, useCallback } from 'react';
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
}

const DOUBLE_CLICK_THRESHOLD_MS = 300;
const FINE_MODE_FACTOR = 0.2;

const Slider = ({
  defaultValue = 0,
  label,
  max,
  min,
  onChange,
  onDragStateChange = () => {},
  step,
  value,
  trackClassName,
}: SliderProps) => {
  const [displayValue, setDisplayValue] = useState<number>(value);
  const [isDragging, setIsDragging] = useState(false);
  const animationFrameRef = useRef<any>(undefined);
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpTime = useRef(0);
  const fineDragStateRef = useRef<{ startValue: number; startX: number; trackWidth: number } | null>(null);
  const fillPercentage = max !== min ? ((displayValue - min) / (max - min)) * 100 : 0;
  const defaultPercentage = max !== min ? ((defaultValue - min) / (max - min)) * 100 : 0;

  const stepStr = String(step);
  const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
  const numericValue = isNaN(Number(value)) ? 0 : Number(value);

  const emitValueChange = useCallback((nextValue: number) => {
    const clampedValue = Math.max(min, Math.min(max, nextValue));
    const roundedValue = parseFloat(clampedValue.toFixed(decimalPlaces));

    if (roundedValue === value || isNaN(roundedValue)) {
      return;
    }

    setDisplayValue(roundedValue);
    onChange({
      target: {
        value: roundedValue,
      },
    });
  }, [decimalPlaces, max, min, onChange, value]);

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
      const fineStep = step * 2 * FINE_MODE_FACTOR;
      emitValueChange(value + direction * fineStep);
    };

    sliderElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      sliderElement.removeEventListener('wheel', handleWheel);
    };
  }, [value, step, emitValueChange]);

  useEffect(() => {
    const handleFineDragMove = (event: MouseEvent) => {
      const fineDragState = fineDragStateRef.current;
      if (!fineDragState) {
        return;
      }

      event.preventDefault();

      if (fineDragState.trackWidth <= 0) {
        return;
      }

      const deltaX = event.clientX - fineDragState.startX;
      const range = max - min;
      const nextValue = fineDragState.startValue + (deltaX / fineDragState.trackWidth) * range * FINE_MODE_FACTOR;
      emitValueChange(nextValue);
    };

    const handleDragEndGlobal = () => {
      fineDragStateRef.current = null;
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleFineDragMove, { passive: false });
      window.addEventListener('mouseup', handleDragEndGlobal);
      window.addEventListener('touchend', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('mousemove', handleFineDragMove);
      window.removeEventListener('mouseup', handleDragEndGlobal);
      window.removeEventListener('touchend', handleDragEndGlobal);
    };
  }, [emitValueChange, isDragging, max, min]);

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
    emitValueChange(defaultValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayValue(Number(e.target.value));
    onChange(e);
  };

  const handleDragStart = (e: React.MouseEvent<HTMLInputElement>) => {
    if (Date.now() - lastUpTime.current < DOUBLE_CLICK_THRESHOLD_MS) {
      e.preventDefault();
      return;
    }

    if (e.shiftKey || e.altKey) {
      const trackWidth = e.currentTarget.getBoundingClientRect().width;
      fineDragStateRef.current = {
        startValue: value,
        startX: e.clientX,
        trackWidth,
      };
      e.preventDefault();
    }

    setIsDragging(true);
  };

  const handleDragEnd = () => {
    lastUpTime.current = Date.now();
    fineDragStateRef.current = null;
    setIsDragging(false);
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

    emitValueChange(newValue);
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

    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const direction = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
      emitValueChange(value + direction * step * FINE_MODE_FACTOR);
      return;
    }

    if (GLOBAL_KEYS.includes(e.key)) {
      e.currentTarget.blur();
    }
  };

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
              className="w-full text-sm text-right bg-card-active border border-gray-500 rounded px-1 py-0 outline-none focus:ring-1 focus:ring-blue-500 text-text-primary"
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
              data-tooltip={`Click to edit. Hold Shift or Alt for fine adjustments.`}
            >
              {decimalPlaces > 0 && numericValue === 0 ? '0' : numericValue.toFixed(decimalPlaces)}
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
            left: `${Math.min(fillPercentage, defaultPercentage)}%`,
            width: `${Math.abs(fillPercentage - defaultPercentage)}%`,
          }}
        />
        <input
          className={`absolute top-1/2 left-0 w-full h-1.5 appearance-none bg-transparent cursor-pointer m-0 p-0 slider-input z-10 ${
            isDragging ? 'slider-thumb-active' : ''
          }`}
          style={{ margin: 0 }}
          max={String(max)}
          min={String(min)}
          onChange={handleChange}
          onDoubleClick={handleReset}
          onKeyDown={handleRangeKeyDown}
          onMouseDown={handleDragStart}
          onMouseUp={handleDragEnd}
          onTouchEnd={handleDragEnd}
          onTouchStart={handleDragStart}
          step={String(step)}
          type="range"
          value={displayValue}
        />
      </div>
    </div>
  );
};

export default Slider;
