import React, { useState, useEffect, useRef, useMemo } from 'react';
import clsx from 'clsx';
import { GLOBAL_KEYS } from './AppProperties';
import Text from './Text';
import { TextColors, TextVariants } from '../../types/typography';

interface SliderProps {
  defaultValue?: number;
  label: string | React.ReactNode;
  max: number;
  min: number;
  step: number;
  value: number;
  onChange(val: number): void;
  onDragStateChange?(state: boolean): void;
  className?: string;
  trackClassName?: string;
  disabled?: boolean;
}

const DOUBLE_CLICK_THRESHOLD_MS = 300;

/**
 * A controlled slider component with integrated numeric input, animated transitions,
 * and scroll-wheel support.
 * @param {SliderProps} props - The properties for the Slider component.
 * @param {number} [props.defaultValue=0] - The value the slider returns to when the label is clicked/double-clicked.
 * @param {string | React.ReactNode} props.label - Display label or icon. If a string, clicking it triggers a reset.
 * @param {number} props.max - Maximum selectable value.
 * @param {number} props.min - Minimum selectable value.
 * @param {(val: number) => void} props.onChange - Callback fired when the value changes via slider, input, or scroll.
 * @param {(state: boolean) => void} [props.onDragStateChange] - Callback fired when dragging begins or ends.
 * @param {number} props.step - The granularity of value increments. Also determines decimal precision in the numeric display.
 * @param {number} props.value - The current controlled value of the slider.
 * @param {string} [props.className] - Optional CSS classes for the container element.
 * @param {string} [props.trackClassName] - Optional CSS classes for the slider track background.
 * @param {boolean} [props.disabled=false] - Disables component.
 * * @remarks
 * - **Reset Behavior:** Clicking or double-clicking the text label or slider resets the slider to `defaultValue`.
 * - **Scroll Support:** When the container is focused, `Shift + Wheel` increments/decrements the value by `step * 5`.
 * - **Precision:** Decimal places in the numeric input are automatically derived from the `step` prop.
 * - **Animation:** Includes an ease-in-out animation when the `value` prop changes programmatically (outside of active dragging).
 * * @example
 * ```tsx
 * <Slider
 * label="Opacity"
 * min={0}
 * max={1}
 * step={0.01}
 * value={opacity}
 * defaultValue={1}
 * onChange={(value) => setOpacity(value)}
 * />
 * ```
 */
const Slider = ({
  defaultValue = 0,
  label,
  max,
  min,
  step,
  value,
  onChange,
  onDragStateChange = () => {},
  className = '',
  trackClassName,
  disabled = false,
}: SliderProps) => {
  const [displayValue, setDisplayValue] = useState<number>(value);
  const [isDragging, setIsDragging] = useState(false);
  const animationFrameRef = useRef<number>(undefined);
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>(String(value));
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUpTime = useRef(0);

  const decimalPlaces = useMemo(() => {
    const stepStr = String(step);
    return stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
  }, [step]);

  useEffect(() => {
    onDragStateChange(isDragging);
  }, [isDragging]);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(String(value));
    }
  }, [value, isEditing, decimalPlaces]);

  // Handle scroll
  useEffect(() => {
    const sliderElement = containerRef.current;
    if (!sliderElement) return;

    const handleWheel = (event: WheelEvent) => {
      if (disabled || !event.shiftKey) return;

      event.preventDefault();
      const direction = -Math.sign(event.deltaY + event.deltaX);
      const newValue = value + direction * step * 5;
      const clampedValue = Math.max(min, Math.min(max, parseFloat(newValue.toFixed(decimalPlaces))));

      if (clampedValue !== value && !isNaN(clampedValue)) {
        onChange(clampedValue);
      }
    };

    sliderElement.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      sliderElement.removeEventListener('wheel', handleWheel);
    };
  }, [value, min, max, step, onChange, decimalPlaces]);

  // Handle dragging
  useEffect(() => {
    const handleDragEndGlobal = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('pointerup', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('pointerup', handleDragEndGlobal);
    };
  }, [isDragging]);

  // Handle animation
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
    let startTime: number | null = null;

    const easeInOut = (t: number) => t * t * (3 - 2 * t);

    const animate = (timestamp: number) => {
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

  const handleReset = () => {
    onChange(defaultValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.valueAsNumber;
    setDisplayValue(val);
    onChange(val);
  };

  const handleDragStart = (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    if (Date.now() - lastUpTime.current < DOUBLE_CLICK_THRESHOLD_MS) {
      e.preventDefault();
      return;
    }
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    lastUpTime.current = Date.now();
    setIsDragging(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleInputCommit = () => {
    let newValue = parseFloat(inputValue);
    if (isNaN(newValue)) {
      newValue = value;
    } else {
      newValue = Math.max(min, Math.min(max, parseFloat(newValue.toFixed(decimalPlaces))));
    }

    onChange(newValue);
    setIsEditing(false);
    setInputValue(String(value));
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

  const handleInputFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    if (!disabled) {
      setIsEditing(true);
      const target = e.currentTarget;
      setTimeout(() => target.select(), 0);
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

  const textLabel = typeof label === 'string';

  return (
    <div className={clsx('mb-2', className, { 'opacity-50': disabled })} ref={containerRef}>
      <div className="flex justify-between items-center mb-1">
        <button
          type="button"
          className={clsx('grid group/label justify-items-start', {
            'cursor-pointer disabled:cursor-not-allowed': textLabel,
            'cursor-default': !textLabel,
          })}
          aria-label={textLabel ? `Reset ${label}` : undefined}
          aria-hidden={!textLabel}
          disabled={disabled || !textLabel}
          onClick={handleReset}
        >
          <Text
            variant={TextVariants.label}
            aria-hidden={true}
            className={clsx(
              'col-start-1 row-start-1 select-none transition-opacity duration-200 ease-in-out opacity-100',
              {
                'group-hover/label:opacity-0': !disabled && textLabel,
              },
            )}
          >
            {label}
          </Text>
          <Text
            variant={TextVariants.label}
            color={TextColors.primary}
            aria-hidden={true}
            className={clsx(
              'col-start-1 row-start-1 select-none transition-opacity duration-200 ease-in-out opacity-0',
              {
                'group-hover/label:opacity-100': !disabled && textLabel,
              },
            )}
          >
            Reset
          </Text>
        </button>
        <div className="w-12 text-right">
          <input
            className={clsx(
              'w-full px-1 py-0 text-sm text-text-primary border rounded transition-all duration-200 disabled:cursor-not-allowed',
              '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
              'text-right bg-transparent border-transparent select-none',
              'focus:text-center focus:bg-card-active focus:border-gray-500 focus:select-auto focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
            max={max}
            min={min}
            onBlur={handleInputCommit}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            onFocus={handleInputFocus}
            step={step}
            type="number"
            value={isEditing ? inputValue : decimalPlaces > 0 && value === 0 ? '0' : value.toFixed(decimalPlaces)}
            disabled={disabled}
            data-tooltip={disabled ? null : `Click to edit`}
          />
        </div>
      </div>

      <div className="relative w-full h-5">
        <div
          className={`absolute top-1/2 left-0 w-full h-1.5 -translate-y-1/4 rounded-full pointer-events-none ${
            trackClassName || 'bg-card-active'
          }`}
        />
        <input
          className={clsx(
            'absolute top-1/2 left-0 w-full h-1.5 m-0 p-0 z-10 appearance-none bg-transparent slider-input cursor-pointer disabled:cursor-not-allowed',
            {
              'slider-thumb-active': isDragging,
            },
          )}
          style={{ margin: 0 }}
          max={String(max)}
          min={String(min)}
          onChange={handleChange}
          onKeyDown={handleRangeKeyDown}
          onDoubleClick={handleReset}
          onPointerDown={handleDragStart}
          onPointerUp={handleDragEnd}
          step={String(step)}
          type="range"
          value={isDragging ? value : displayValue}
          disabled={disabled}
        />
      </div>
    </div>
  );
};

export default Slider;
