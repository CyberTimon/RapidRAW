import { useRef, useCallback, useState } from 'react';

interface SliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  showValue?: boolean;
  disabled?: boolean;
  className?: string;
  trackClassName?: string;
  onChange: (value: number) => void;
  onChangeEnd?: (value: number) => void;
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  label,
  showValue = true,
  disabled = false,
  className = '',
  trackClassName = '',
  onChange,
  onChangeEnd,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const percentage = ((value - min) / (max - min)) * 100;

  const calculateValue = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return value;

      const rect = trackRef.current.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const rawValue = min + percent * (max - min);
      const steppedValue = Math.round(rawValue / step) * step;
      return Math.max(min, Math.min(max, steppedValue));
    },
    [min, max, step, value]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(true);

      const newValue = calculateValue(e.clientX);
      onChange(newValue);

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const newVal = calculateValue(moveEvent.clientX);
        onChange(newVal);
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        setIsDragging(false);
        const finalValue = calculateValue(upEvent.clientX);
        onChangeEnd?.(finalValue);
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [disabled, calculateValue, onChange, onChangeEnd]
  );

  const handleDoubleClick = useCallback(() => {
    if (disabled) return;
    const defaultValue = min < 0 && max > 0 ? 0 : min;
    onChange(defaultValue);
    onChangeEnd?.(defaultValue);
  }, [disabled, min, max, onChange, onChangeEnd]);

  const formatValue = (val: number): string => {
    if (step < 1) {
      return val.toFixed(2);
    }
    return val.toString();
  };

  return (
    <div className={`space-y-1 ${className}`}>
      {(label || showValue) && (
        <div className="flex justify-between items-center text-sm">
          {label && <span className="text-text-secondary">{label}</span>}
          {showValue && (
            <span className="text-text-primary font-mono text-xs">{formatValue(value)}</span>
          )}
        </div>
      )}
      <div
        ref={trackRef}
        className={`
          relative h-2 rounded-full cursor-pointer
          ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          ${trackClassName || 'bg-surface'}
        `}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="absolute h-full rounded-full bg-accent transition-all duration-75"
          style={{ width: `${percentage}%` }}
        />
        <div
          className={`
            absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full
            bg-white border-2 border-accent shadow-md
            transition-transform duration-75
            ${isDragging ? 'scale-110' : 'hover:scale-105'}
          `}
          style={{ left: `calc(${percentage}% - 8px)` }}
        />
      </div>
    </div>
  );
}
