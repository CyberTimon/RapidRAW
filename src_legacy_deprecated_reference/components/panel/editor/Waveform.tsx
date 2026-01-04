import { useState, useEffect, useRef } from 'react';
import Draggable from 'react-draggable';
import { X, Waves } from 'lucide-react';
import { motion } from 'framer-motion';
import { WaveformData } from '../../ui/AppProperties';
import { DisplayMode } from '../../../utils/adjustments';

interface LumaWaveformProps {
  color: Array<number>;
  data: Array<number>;
  height: number;
  maxVal: number;
  width: number;
}

interface MaxValues {
  blue: number;
  green: number;
  height: number;
  luma: number;
  red: number;
  width: number;
}

interface RgbWaveformProps {
  blueData: Array<number>;
  greenData: Array<number>;
  height: number;
  maxVals: MaxValues;
  redData: Array<number>;
  width: number;
}

interface WaveformProps {
  onClose(): void;
  waveformData: WaveformData;
}

const LumaWaveformDisplay = ({ data, width, height, maxVal, color }: LumaWaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!data || !canvasRef.current || !width || !height) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
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
};

const RgbWaveformDisplay = ({ redData, greenData, blueData, width, height, maxVals }: RgbWaveformProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!redData || !canvasRef.current || !width || !height) {
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
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
};

export default function Waveform({ waveformData, onClose }: WaveformProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.Rgb);
  const nodeRef = useRef<any>(null);

  const { red, green, blue, luma, width, height } = waveformData || {};

  const maxVals: any = waveformData
    ? {
        luma: Math.max(...(luma || [])),
        red: Math.max(...(red || [])),
        green: Math.max(...(green || [])),
        blue: Math.max(...(blue || [])),
      }
    : {};

  const baseButtonClass = 'flex-grow text-center px-2 py-1 text-xs rounded font-medium transition-colors duration-150';
  const inactiveButtonClass = 'text-text-secondary hover:bg-bg-tertiary';

  return (
    <Draggable nodeRef={nodeRef} handle=".handle" bounds="parent">
      <div ref={nodeRef} className="absolute top-20 left-20 w-[280px] z-50">
        <motion.div
          animate={{ opacity: 1, scale: 1 }}
          className="bg-bg-secondary/80 backdrop-blur-sm rounded-lg shadow-lg text-text-secondary border border-surface/40 overflow-hidden"
          exit={{ opacity: 0, scale: 0.95 }}
          initial={{ opacity: 0, scale: 0.95 }}
          key="waveform-content"
          style={{ transformOrigin: 'top left' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="handle flex items-center justify-between p-2 cursor-move">
            <div className="flex items-center gap-2">
              <Waves size={16} className="text-text-secondary" />
              <h3 className="text-sm font-semibold text-text-primary [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
                Waveform
              </h3>
            </div>
            <button
              className="p-1 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          {waveformData && (
            <div className="p-2 pt-0">
              <div className="relative w-[256px] h-[256px] bg-black/50 rounded">
                {displayMode === DisplayMode.Rgb && (
                  <RgbWaveformDisplay
                    blueData={blue}
                    greenData={green}
                    height={height}
                    maxVals={maxVals}
                    redData={red}
                    width={width}
                  />
                )}
                {displayMode === DisplayMode.Luma && (
                  <LumaWaveformDisplay
                    color={[255, 255, 255]}
                    data={luma}
                    height={height}
                    maxVal={maxVals.luma}
                    width={width}
                  />
                )}
                {displayMode === DisplayMode.Red && (
                  <LumaWaveformDisplay
                    color={[255, 0, 0]}
                    data={red}
                    height={height}
                    maxVal={maxVals.red}
                    width={width}
                  />
                )}
                {displayMode === DisplayMode.Green && (
                  <LumaWaveformDisplay
                    color={[0, 255, 0]}
                    data={green}
                    height={height}
                    maxVal={maxVals.green}
                    width={width}
                  />
                )}
                {displayMode === DisplayMode.Blue && (
                  <LumaWaveformDisplay
                    color={[0, 0, 255]}
                    data={blue}
                    height={height}
                    maxVal={maxVals.blue}
                    width={width}
                  />
                )}
              </div>
              <div className="flex justify-center gap-1 mt-2 p-1 bg-surface rounded-lg">
                <button
                  onClick={() => setDisplayMode(DisplayMode.Luma)}
                  className={`${baseButtonClass} ${
                    displayMode === DisplayMode.Luma ? 'bg-accent text-black' : inactiveButtonClass
                  }`}
                >
                  Luma
                </button>
                <button
                  onClick={() => setDisplayMode(DisplayMode.Rgb)}
                  className={`${baseButtonClass} ${
                    displayMode === DisplayMode.Rgb ? 'bg-accent text-black' : inactiveButtonClass
                  }`}
                >
                  RGB
                </button>
                <button
                  onClick={() => setDisplayMode(DisplayMode.Red)}
                  className={`${baseButtonClass} ${
                    displayMode === DisplayMode.Red ? 'bg-red-500 text-white' : inactiveButtonClass
                  }`}
                >
                  R
                </button>
                <button
                  onClick={() => setDisplayMode(DisplayMode.Green)}
                  className={`${baseButtonClass} ${
                    displayMode === DisplayMode.Green ? 'bg-green-500 text-white' : inactiveButtonClass
                  }`}
                >
                  G
                </button>
                <button
                  onClick={() => setDisplayMode(DisplayMode.Blue)}
                  className={`${baseButtonClass} ${
                    displayMode === DisplayMode.Blue ? 'bg-blue-500 text-white' : inactiveButtonClass
                  }`}
                >
                  B
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </Draggable>
  );
}