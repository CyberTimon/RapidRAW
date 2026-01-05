import { useRef, useEffect, useState, useCallback } from 'react';
import { useBloc } from '@blac/react';
import { PreviewBloc } from '../../blocs/editor/PreviewBloc.js';
import type { WaveformDisplayMode } from '../../types/editor.js';

interface LumaWaveformProps {
  data: number[];
  width: number;
  height: number;
  maxVal: number;
  color: [number, number, number];
}

function LumaWaveformCanvas({ data, width, height, maxVal, color }: LumaWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!data || !canvasRef.current || !width || !height) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    const scale = maxVal > 0 ? 255 / Math.log(1 + maxVal) : 0;

    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) {
        const intensity = Math.log(1 + data[i]) * scale;
        const pixelIndex = i * 4;
        pixels[pixelIndex] = color[0];
        pixels[pixelIndex + 1] = color[1];
        pixels[pixelIndex + 2] = color[2];
        pixels[pixelIndex + 3] = intensity;
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, [data, width, height, maxVal, color]);

  return <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0" />;
}

interface RgbWaveformProps {
  redData: number[];
  greenData: number[];
  blueData: number[];
  width: number;
  height: number;
  maxVals: { red: number; green: number; blue: number };
}

function RgbWaveformCanvas({ redData, greenData, blueData, width, height, maxVals }: RgbWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!redData || !canvasRef.current || !width || !height) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);

    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;

    const scaleR = maxVals.red > 0 ? 255 / Math.log(1 + maxVals.red) : 0;
    const scaleG = maxVals.green > 0 ? 255 / Math.log(1 + maxVals.green) : 0;
    const scaleB = maxVals.blue > 0 ? 255 / Math.log(1 + maxVals.blue) : 0;

    for (let i = 0; i < redData.length; i++) {
      const pixelIndex = i * 4;
      const r = redData[i] > 0 ? Math.log(1 + redData[i]) * scaleR : 0;
      const g = greenData[i] > 0 ? Math.log(1 + greenData[i]) * scaleG : 0;
      const b = blueData[i] > 0 ? Math.log(1 + blueData[i]) * scaleB : 0;

      pixels[pixelIndex] = r;
      pixels[pixelIndex + 1] = g;
      pixels[pixelIndex + 2] = b;
      pixels[pixelIndex + 3] = Math.max(r, g, b);
    }

    ctx.putImageData(imageData, 0, 0);
  }, [redData, greenData, blueData, width, height, maxVals]);

  return <canvas ref={canvasRef} width={width} height={height} className="absolute inset-0" />;
}

interface ModeButtonProps {
  mode: WaveformDisplayMode;
  label: string;
  current: WaveformDisplayMode;
  activeClass: string;
  onClick: (mode: WaveformDisplayMode) => void;
}

function ModeButton({ mode, label, current, activeClass, onClick }: ModeButtonProps) {
  const isActive = current === mode;
  const baseClass = 'flex-1 text-center px-2 py-1 text-xs rounded font-medium';
  const inactiveClass = 'text-text-secondary hover:bg-bg-tertiary';

  return (
    <button
      onClick={() => onClick(mode)}
      className={`${baseClass} ${isActive ? activeClass : inactiveClass}`}
    >
      {label}
    </button>
  );
}

export function ImageWaveform() {
  const [preview, previewBloc] = useBloc(PreviewBloc);
  const { waveformData, isWaveformLoading } = preview;
  const [displayMode, setDisplayMode] = useState<WaveformDisplayMode>('rgb');

  const handleModeChange = useCallback((mode: WaveformDisplayMode) => {
    setDisplayMode(mode);
  }, []);

  if (isWaveformLoading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-bg-secondary p-4">
        <div className="rounded-full h-6 w-6 border-2 border-accent border-t-transparent" style={{ animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (!waveformData) {
    return (
      <div className="h-full w-full flex flex-col bg-bg-secondary p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
            Waveform
          </span>
          <button
            className="text-xs text-accent hover:underline"
            onClick={() => previewBloc.requestWaveform()}
          >
            Load
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center bg-surface rounded">
          <span className="text-xs text-text-secondary">No data</span>
        </div>
      </div>
    );
  }

  const { red, green, blue, luma, width, height } = waveformData;

  const maxVals = {
    luma: Math.max(...luma),
    red: Math.max(...red),
    green: Math.max(...green),
    blue: Math.max(...blue),
  };

  return (
    <div className="h-full w-full flex flex-col bg-bg-secondary p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-secondary uppercase tracking-wide">
          Waveform
        </span>
        <button
          className="p-1 rounded hover:bg-surface"
          onClick={() => previewBloc.requestWaveform()}
          title="Refresh"
        >
          <svg className="w-3 h-3 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div className="flex-1 relative bg-black/50 rounded overflow-hidden" style={{ aspectRatio: '1/1', maxHeight: '256px' }}>
        {displayMode === 'rgb' && (
          <RgbWaveformCanvas
            redData={red}
            greenData={green}
            blueData={blue}
            width={width}
            height={height}
            maxVals={maxVals}
          />
        )}
        {displayMode === 'luma' && (
          <LumaWaveformCanvas
            data={luma}
            width={width}
            height={height}
            maxVal={maxVals.luma}
            color={[255, 255, 255]}
          />
        )}
        {displayMode === 'red' && (
          <LumaWaveformCanvas
            data={red}
            width={width}
            height={height}
            maxVal={maxVals.red}
            color={[255, 0, 0]}
          />
        )}
        {displayMode === 'green' && (
          <LumaWaveformCanvas
            data={green}
            width={width}
            height={height}
            maxVal={maxVals.green}
            color={[0, 255, 0]}
          />
        )}
        {displayMode === 'blue' && (
          <LumaWaveformCanvas
            data={blue}
            width={width}
            height={height}
            maxVal={maxVals.blue}
            color={[0, 0, 255]}
          />
        )}
      </div>

      <div className="flex gap-1 mt-2 p-1 bg-surface rounded">
        <ModeButton
          mode="luma"
          label="Luma"
          current={displayMode}
          activeClass="bg-accent text-black"
          onClick={handleModeChange}
        />
        <ModeButton
          mode="rgb"
          label="RGB"
          current={displayMode}
          activeClass="bg-accent text-black"
          onClick={handleModeChange}
        />
        <ModeButton
          mode="red"
          label="R"
          current={displayMode}
          activeClass="bg-red-500 text-white"
          onClick={handleModeChange}
        />
        <ModeButton
          mode="green"
          label="G"
          current={displayMode}
          activeClass="bg-green-500 text-white"
          onClick={handleModeChange}
        />
        <ModeButton
          mode="blue"
          label="B"
          current={displayMode}
          activeClass="bg-blue-500 text-white"
          onClick={handleModeChange}
        />
      </div>
    </div>
  );
}
