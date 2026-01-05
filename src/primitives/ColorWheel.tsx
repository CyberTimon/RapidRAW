import { useState, useRef, useEffect, useCallback } from 'react';
import { Sun } from 'lucide-react';
import { Slider } from './Slider';

export interface HueSatLum {
  hue: number;
  saturation: number;
  luminance: number;
}

interface ColorWheelProps {
  value: HueSatLum;
  defaultValue?: HueSatLum;
  label: string;
  onChange: (hsl: HueSatLum) => void;
}

const DEFAULT_VALUE: HueSatLum = { hue: 0, saturation: 0, luminance: 0 };

function hslToHex(h: number, s: number, l: number): string {
  l = l / 100;
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function ColorWheel({
  value,
  defaultValue = DEFAULT_VALUE,
  label,
  onChange,
}: ColorWheelProps) {
  const effectiveValue = value || defaultValue;
  const { hue, saturation, luminance } = effectiveValue;
  
  const wheelRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [wheelSize, setWheelSize] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        const width = entries[0].contentRect.width;
        if (width > 0) {
          setWheelSize(width);
        }
      }
    });

    const currentWheel = wheelRef.current;
    if (currentWheel) {
      observer.observe(currentWheel);
    }

    return () => {
      if (currentWheel) {
        observer.unobserve(currentWheel);
      }
    };
  }, []);

  const calculateHueSat = useCallback(
    (clientX: number, clientY: number) => {
      if (!wheelRef.current) return;

      const rect = wheelRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const radius = rect.width / 2;

      const dx = clientX - centerX;
      const dy = clientY - centerY;

      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      angle = (angle + 90 + 360) % 360;

      const distance = Math.min(Math.sqrt(dx * dx + dy * dy), radius);
      const newSaturation = Math.round((distance / radius) * 100);

      onChange({
        ...effectiveValue,
        hue: Math.round(angle),
        saturation: newSaturation,
      });
    },
    [effectiveValue, onChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      calculateHueSat(e.clientX, e.clientY);
    },
    [calculateHueSat]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging) {
        calculateHueSat(e.clientX, e.clientY);
      }
    },
    [isDragging, calculateHueSat]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleReset = () => {
    onChange(defaultValue);
  };

  const handleLumChange = (newValue: number) => {
    onChange({ ...effectiveValue, luminance: newValue });
  };

  const pointerAngle = ((hue - 90) * Math.PI) / 180;
  const pointerRadius = (saturation / 100) * (wheelSize / 2);
  const pointerX = wheelSize / 2 + Math.cos(pointerAngle) * pointerRadius;
  const pointerY = wheelSize / 2 + Math.sin(pointerAngle) * pointerRadius;

  const hexColor = hslToHex(hue, saturation, 50);
  const anyDragging = isDragging || isSliderDragging;

  return (
    <div
      className="relative flex flex-col items-center gap-2"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        if (!anyDragging) {
          setIsHovered(false);
        }
      }}
    >
      <div
        className="flex items-center justify-center cursor-pointer"
        onDoubleClick={handleReset}
        title={`Double-click to reset ${label.toLowerCase()}`}
      >
        <p className="text-sm font-medium text-text-secondary select-none">{label}</p>
      </div>

      <button
        className={`absolute top-0 right-0 p-0.5 rounded hover:bg-card-active cursor-pointer active:scale-95 ${
          isHovered && !anyDragging ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={handleReset}
        title={`Reset ${label.toLowerCase()}`}
        type="button"
      >
        <svg
          className="text-text-secondary hover:text-text-primary"
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="14"
        >
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>

      <div
        ref={wheelRef}
        className="relative w-full aspect-square cursor-crosshair select-none"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleReset}
        title="Double-click to reset"
      >
        {wheelSize > 0 && (
          <>
            <svg
              width={wheelSize}
              height={wheelSize}
              className="absolute inset-0"
            >
              <defs>
                <radialGradient id="saturation-gradient">
                  <stop offset="0%" stopColor="white" />
                  <stop offset="100%" stopColor="white" stopOpacity="0" />
                </radialGradient>
              </defs>
              <foreignObject width={wheelSize} height={wheelSize}>
                <div
                  style={{
                    width: '100%',
                    height: '100%',
                    borderRadius: '50%',
                    background: `conic-gradient(
                      from 0deg,
                      hsl(0, 100%, 50%),
                      hsl(30, 100%, 50%),
                      hsl(60, 100%, 50%),
                      hsl(90, 100%, 50%),
                      hsl(120, 100%, 50%),
                      hsl(150, 100%, 50%),
                      hsl(180, 100%, 50%),
                      hsl(210, 100%, 50%),
                      hsl(240, 100%, 50%),
                      hsl(270, 100%, 50%),
                      hsl(300, 100%, 50%),
                      hsl(330, 100%, 50%),
                      hsl(360, 100%, 50%)
                    )`,
                  }}
                />
              </foreignObject>
              <circle
                cx={wheelSize / 2}
                cy={wheelSize / 2}
                r={wheelSize / 2}
                fill="url(#saturation-gradient)"
              />
            </svg>

            <div
              className="absolute pointer-events-none"
              style={{
                left: pointerX - 6,
                top: pointerY - 6,
                width: 12,
                height: 12,
                backgroundColor: saturation > 5 ? hexColor : 'transparent',
                border: '2px solid white',
                borderRadius: '50%',
                boxShadow: '0 0 2px rgba(0,0,0,0.5)',
              }}
            />
          </>
        )}
      </div>

      <div className="w-full">
        <Slider
          defaultValue={defaultValue.luminance}
          label={<Sun size={16} className="text-text-secondary" />}
          max={100}
          min={-100}
          onChange={handleLumChange}
          onDragStateChange={setIsSliderDragging}
          step={1}
          value={luminance}
        />
      </div>
    </div>
  );
}

export default ColorWheel;
