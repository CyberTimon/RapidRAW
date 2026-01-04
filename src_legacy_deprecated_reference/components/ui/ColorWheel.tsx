import { useState, useRef, useEffect } from 'react';
import Slider from './Slider';
import Wheel from '@uiw/react-color-wheel';
import { ColorResult, HsvaColor, hsvaToHex } from '@uiw/color-convert';
import { Sun } from 'lucide-react';
import { HueSatLum } from '../../utils/adjustments';

interface ColorWheelProps {
  defaultValue: HueSatLum;
  label: string;
  onChange(hsl: HueSatLum): void;
  value: HueSatLum;
}

const ResetIcon = () => (
  <svg
    className="text-text-secondary hover:text-text-primary transition-colors duration-150"
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
);

const ColorWheel = ({
  defaultValue = { hue: 0, saturation: 0, luminance: 0 },
  label,
  onChange,
  value,
}: ColorWheelProps) => {
  const effectiveValue = value || defaultValue;
  const { hue, saturation, luminance } = effectiveValue;
  const sizerRef = useRef<any>(null);
  const [wheelSize, setWheelSize] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isWheelDragging, setIsWheelDragging] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);

  const isDragging = isWheelDragging || isSliderDragging;

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) {
        const width = entries[0].contentRect.width;
        if (width > 0) {
          setWheelSize(width);
        }
      }
    });

    const currentSizer = sizerRef.current;
    if (currentSizer) {
      observer.observe(currentSizer);
    }

    return () => {
      if (currentSizer) {
        observer.unobserve(currentSizer);
      }
    };
  }, []);

  useEffect(() => {
    const handleInteractionEnd = () => {
      setIsWheelDragging(false);
      if (containerRef.current && !containerRef.current.matches(':hover')) {
        setIsHovered(false);
      }
    };
    if (isWheelDragging) {
      window.addEventListener('mouseup', handleInteractionEnd);
      window.addEventListener('touchend', handleInteractionEnd);
    }
    return () => {
      window.removeEventListener('mouseup', handleInteractionEnd);
      window.removeEventListener('touchend', handleInteractionEnd);
    };
  }, [isWheelDragging]);

  const handleWheelChange = (color: ColorResult) => {
    onChange({ ...effectiveValue, hue: color.hsva.h, saturation: color.hsva.s });
  };

  const handleLumChange = (e: any) => {
    onChange({ ...effectiveValue, luminance: parseFloat(e.target.value) });
  };

  const handleReset = () => {
    onChange(defaultValue);
  };

  const hsva: HsvaColor = { h: hue, s: saturation, v: 100, a: 1 };
  const hexColor = hsvaToHex(hsva);

  return (
    <div
      className="relative flex flex-col items-center gap-2"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        if (!isDragging) {
          setIsHovered(false);
        }
      }}
      ref={containerRef}
    >
      <div
        className="flex items-center justify-center cursor-pointer"
        onDoubleClick={handleReset}
        title={`Double-click to reset ${label.toLowerCase()}`}
      >
        <p className="text-sm font-medium text-text-secondary select-none">{label}</p>
      </div>
      <button
        className={`absolute top-0 right-0 p-0.5 rounded hover:bg-card-active transition-all duration-200 cursor-pointer active:scale-95 ${
          isHovered && !isDragging ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={handleReset}
        title={`Reset ${label.toLowerCase()}`}
        type="button"
      >
        <ResetIcon />
      </button>

      <div ref={sizerRef} className="relative w-full aspect-square">
        {wheelSize > 0 && (
          <div className="absolute inset-0 cursor-pointer" onDoubleClick={handleReset} title="Double-click to reset">
            <Wheel
              color={hsva}
              height={wheelSize}
              onChange={handleWheelChange}
              onMouseDown={() => setIsWheelDragging(true)}
              onTouchStart={() => setIsWheelDragging(true)}
              pointer={({ style }) => (
                <div style={{ ...style, zIndex: 1 }}>
                  <div
                    style={{
                      backgroundColor: saturation > 5 ? hexColor : 'transparent',
                      border: '2px solid white',
                      borderRadius: '50%',
                      boxShadow: '0 0 2px rgba(0,0,0,0.5)',
                      height: 12,
                      transform: 'translate(-6px, -6px)',
                      width: 12,
                    }}
                  />
                </div>
              )}
              width={wheelSize}
            />
          </div>
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
};

export default ColorWheel;