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
  onDragStateChange?: (isDragging: boolean) => void;
}

const ColorWheel = ({
  defaultValue = { hue: 0, saturation: 0, luminance: 0 },
  label,
  onChange,
  value,
  onDragStateChange,
}: ColorWheelProps) => {
  const effectiveValue = value || defaultValue;
  const { hue, saturation, luminance } = effectiveValue;
  const sizerRef = useRef<HTMLDivElement>(null);
  const [wheelSize, setWheelSize] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isWheelDragging, setIsWheelDragging] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

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
      onDragStateChange?.(isSliderDragging);
    };
    if (isWheelDragging) {
      window.addEventListener('mouseup', handleInteractionEnd);
      window.addEventListener('touchend', handleInteractionEnd);
    }
    return () => {
      window.removeEventListener('mouseup', handleInteractionEnd);
      window.removeEventListener('touchend', handleInteractionEnd);
    };
  }, [isWheelDragging, isSliderDragging, onDragStateChange]);

  useEffect(() => {
    onDragStateChange?.(isDragging);
  }, [isDragging, onDragStateChange]);

  const handleWheelChange = (color: ColorResult) => {
    onChange({ ...effectiveValue, hue: color.hsva.h, saturation: color.hsva.s });
  };

  const handleLumChange = (value: number) => {
    onChange({ ...effectiveValue, luminance: value });
  };

  const handleReset = () => {
    onChange(defaultValue);
  };

  const handleDragStart = () => {
    onDragStateChange?.(true);
    setIsWheelDragging(true);
  };

  const hsva: HsvaColor = { h: hue, s: saturation, v: 100, a: 1 };
  const hexColor = hsvaToHex(hsva);

  const pointerSize = isWheelDragging ? 14 : 12;
  const pointerOffset = pointerSize / 2;

  return (
    <div className="relative flex flex-col items-center gap-2" ref={containerRef}>
      <div
        className="relative cursor-pointer h-5 w-full overflow-hidden"
        onClick={handleReset}
        onDoubleClick={handleReset}
        onMouseEnter={() => setIsLabelHovered(true)}
        onMouseLeave={() => setIsLabelHovered(false)}
      >
        <span
          className={`absolute inset-0 flex items-center justify-center text-sm font-medium text-text-secondary whitespace-nowrap select-none transition-opacity duration-200 ease-in-out ${
            !isDragging && !isLabelHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {label}
        </span>

        <span
          className={`absolute inset-0 flex items-center justify-center text-sm font-medium text-text-primary whitespace-nowrap select-none transition-opacity duration-200 ease-in-out ${
            !isDragging && isLabelHovered ? 'opacity-100' : 'opacity-0'
          }`}
        >
          Reset
        </span>

        <div
          className={`absolute inset-0 flex items-center justify-center gap-2 text-sm font-medium text-text-secondary whitespace-nowrap select-none transition-opacity duration-200 ease-in-out ${
            isDragging ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className="flex items-center tabular-nums">
            <span className="font-bold">H:</span>
            <span className="w-8 text-right">{Math.round(hue)}&deg;</span>
          </div>

          <div className="flex items-center tabular-nums">
            <span className="font-bold">S:</span>
            <span className="w-6 text-right">{Math.round(saturation)}</span>
          </div>
        </div>
      </div>

      <div ref={sizerRef} className="relative w-full aspect-square">
        {wheelSize > 0 && (
          <div
            className="absolute inset-0 cursor-pointer"
            onDoubleClick={handleReset}
            onMouseDownCapture={handleDragStart}
            onTouchStartCapture={handleDragStart}
          >
            <Wheel
              color={hsva}
              height={wheelSize}
              onChange={handleWheelChange}
              angle={0}
              pointer={({ style }) => (
                <div style={{ ...style, zIndex: 1 }}>
                  <div
                    style={{
                      backgroundColor: saturation > 5 ? hexColor : 'transparent',
                      border: '2px solid white',
                      borderRadius: '50%',
                      boxShadow: '0 0 2px rgba(0,0,0,0.5)',
                      height: pointerSize,
                      width: pointerSize,
                      transform: `translate(-${pointerOffset}px, -${pointerOffset}px)`,
                      transition: 'width 150ms ease-out, height 150ms ease-out, transform 150ms ease-out',
                    }}
                  />
                </div>
              )}
              width={wheelSize}
            />
          </div>
        )}
      </div>

      <Slider
        defaultValue={defaultValue.luminance}
        label={<Sun size={16} className="text-text-secondary" />}
        max={100}
        min={-100}
        onChange={handleLumChange}
        onDragStateChange={setIsSliderDragging}
        step={1}
        value={luminance}
        className="w-full"
      />
    </div>
  );
};

export default ColorWheel;
