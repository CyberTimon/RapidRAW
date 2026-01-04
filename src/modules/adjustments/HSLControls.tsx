import { useState, useCallback } from 'react';
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc.js';
import { Slider } from '../../primitives/Slider.js';
import type { HSLData } from '../../types/adjustments.js';

type HSLColorKey = keyof HSLData;

interface ColorSwatchConfig {
  key: HSLColorKey;
  name: string;
  color: string;
}

const HSL_COLORS: ColorSwatchConfig[] = [
  { key: 'red', name: 'Reds', color: '#f87171' },
  { key: 'orange', name: 'Oranges', color: '#fb923c' },
  { key: 'yellow', name: 'Yellows', color: '#facc15' },
  { key: 'green', name: 'Greens', color: '#4ade80' },
  { key: 'aqua', name: 'Aquas', color: '#2dd4bf' },
  { key: 'blue', name: 'Blues', color: '#60a5fa' },
  { key: 'purple', name: 'Purples', color: '#a78bfa' },
  { key: 'magenta', name: 'Magentas', color: '#f472b6' },
];

interface ColorSwatchProps {
  color: string;
  name: string;
  isActive: boolean;
  onClick: () => void;
}

function ColorSwatch({ color, name, isActive, onClick }: ColorSwatchProps) {
  return (
    <button
      type="button"
      aria-label={`Select ${name} color`}
      className={`
        w-6 h-6 rounded-full focus:outline-none transition-transform duration-150
        ${isActive ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg-secondary scale-110' : 'hover:scale-110'}
      `}
      onClick={onClick}
      style={{ backgroundColor: color }}
    />
  );
}

export function HSLControls() {
  const [state, bloc] = useBloc(AdjustmentsBloc);
  const [activeColor, setActiveColor] = useState<HSLColorKey>('red');

  const { hsl } = state.adjustments;
  const currentHsl = hsl[activeColor];

  const handleHueChange = useCallback(
    (value: number) => {
      bloc.setHSLChannel(activeColor, { hue: value });
    },
    [bloc, activeColor]
  );

  const handleSaturationChange = useCallback(
    (value: number) => {
      bloc.setHSLChannel(activeColor, { saturation: value });
    },
    [bloc, activeColor]
  );

  const handleLuminanceChange = useCallback(
    (value: number) => {
      bloc.setHSLChannel(activeColor, { luminance: value });
    },
    [bloc, activeColor]
  );

  const handleReset = useCallback(() => {
    bloc.resetHSL();
  }, [bloc]);

  const handleResetChannel = useCallback(() => {
    bloc.setHSLChannel(activeColor, { hue: 0, saturation: 0, luminance: 0 });
  }, [bloc, activeColor]);

  const activeColorConfig = HSL_COLORS.find((c) => c.key === activeColor);

  return (
    <div className="p-2 bg-surface rounded-md">
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm font-semibold text-text-primary">Color Mixer</p>
        <button
          type="button"
          onClick={handleReset}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Reset All
        </button>
      </div>

      <div className="flex justify-between mb-4 px-1">
        {HSL_COLORS.map(({ key, name, color }) => (
          <ColorSwatch
            key={key}
            color={color}
            name={name}
            isActive={activeColor === key}
            onClick={() => setActiveColor(key)}
          />
        ))}
      </div>

      <div className="flex justify-between items-center mb-2">
        <span className="text-xs text-text-secondary">{activeColorConfig?.name}</span>
        <button
          type="button"
          onClick={handleResetChannel}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Reset
        </button>
      </div>

      <div className="space-y-2">
        <Slider
          label="Hue"
          value={currentHsl.hue}
          min={-100}
          max={100}
          step={1}
          onChange={handleHueChange}
        />
        <Slider
          label="Saturation"
          value={currentHsl.saturation}
          min={-100}
          max={100}
          step={1}
          onChange={handleSaturationChange}
        />
        <Slider
          label="Luminance"
          value={currentHsl.luminance}
          min={-100}
          max={100}
          step={1}
          onChange={handleLuminanceChange}
        />
      </div>
    </div>
  );
}
