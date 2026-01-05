import { useState, useEffect, useRef } from 'react';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label?: React.ReactNode;
  defaultValue?: number;
  disabled?: boolean;
  trackClassName?: string;
  onChange: (value: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

export function Slider({
  value,
  min,
  max,
  step,
  label,
  defaultValue = 0,
  disabled = false,
  trackClassName,
  onChange,
  onDragStateChange,
}: SliderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [inputValue, setInputValue] = useState<string>(String(value));
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onDragStateChange?.(isDragging);
  }, [isDragging, onDragStateChange]);

  useEffect(() => {
    const sliderElement = containerRef.current;
    if (!sliderElement) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey) return;

      event.preventDefault();
      const direction = -Math.sign(event.deltaY);
      const newValue = value + direction * step * 2;
      const stepStr = String(step);
      const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
      const roundedNewValue = parseFloat(newValue.toFixed(decimalPlaces));
      const clampedValue = Math.max(min, Math.min(max, roundedNewValue));

      if (clampedValue !== value && !isNaN(clampedValue)) {
        onChange(clampedValue);
      }
    };

    sliderElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => sliderElement.removeEventListener('wheel', handleWheel);
  }, [value, min, max, step, onChange]);

  useEffect(() => {
    const handleDragEndGlobal = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mouseup', handleDragEndGlobal);
      window.addEventListener('touchend', handleDragEndGlobal);
    }

    return () => {
      window.removeEventListener('mouseup', handleDragEndGlobal);
      window.removeEventListener('touchend', handleDragEndGlobal);
    };
  }, [isDragging]);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(String(value));
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleReset = () => {
    onChange(defaultValue);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  };

  const handleDragStart = () => setIsDragging(true);
  const handleDragEnd = () => setIsDragging(false);

  const handleValueClick = () => setIsEditing(true);

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
    onChange(newValue);
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

  const stepStr = String(step);
  const decimalPlaces = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;
  const numericValue = isNaN(Number(value)) ? 0 : Number(value);

  return (
    <div className={`mb-2 group ${disabled ? 'opacity-50 pointer-events-none' : ''}`} ref={containerRef}>
      <div className="flex justify-between items-center mb-1">
        <div
          className={`grid ${typeof label === 'string' ? 'cursor-pointer' : ''}`}
          onClick={typeof label === 'string' ? handleReset : undefined}
          onDoubleClick={typeof label === 'string' ? handleReset : undefined}
          onMouseEnter={typeof label === 'string' ? () => setIsLabelHovered(true) : undefined}
          onMouseLeave={typeof label === 'string' ? () => setIsLabelHovered(false) : undefined}
          title={
            typeof label === 'string' && label
              ? `Click or double-click to reset ${label.toLowerCase()} to ${defaultValue}`
              : ''
          }
        >
          <span
            aria-hidden={isLabelHovered && typeof label === 'string'}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none ${
              isLabelHovered && typeof label === 'string' ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {label}
          </span>

          {typeof label === 'string' && (
            <span
              aria-hidden={!isLabelHovered}
              className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none pointer-events-none ${
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
              title={`Click to edit, double-click to reset to ${defaultValue}`}
            >
              {decimalPlaces > 0 && numericValue === 0 ? '0' : numericValue.toFixed(decimalPlaces)}
            </span>
          )}
        </div>
      </div>
      <input
        className={`w-full h-1.5 ${trackClassName || 'bg-card-active'} rounded-full appearance-none cursor-pointer slider-input ${isDragging ? 'slider-thumb-active' : ''}`}
        max={String(max)}
        min={String(min)}
        onChange={handleChange}
        onDoubleClick={handleReset}
        onMouseDown={handleDragStart}
        onMouseUp={handleDragEnd}
        onTouchEnd={handleDragEnd}
        onTouchStart={handleDragStart}
        step={String(step)}
        type="range"
        value={value}
        disabled={disabled}
      />
    </div>
  );
}

export default Slider;
