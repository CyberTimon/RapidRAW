import { useMemo, useRef, useEffect, useState } from 'react';
import Draggable from 'react-draggable';
import { X, BarChart3 } from 'lucide-react';
import { motion } from 'framer-motion';
import { DisplayMode } from '../../../utils/adjustments';
import type { ChannelConfig } from '../../adjustments/Curves';

type HistogramChannel = number[] | { data?: number[] } | undefined;

interface HistogramProps {
  histogramData: ChannelConfig | Record<string, HistogramChannel>;
  onClose(): void;
}

interface ChannelCanvasProps {
  bins: number[];
  color: [number, number, number];
}

interface RgbCanvasProps {
  red: number[];
  green: number[];
  blue: number[];
}

const WIDTH = 256;
const HEIGHT = 170;

const drawChannel = (
  ctx: CanvasRenderingContext2D,
  bins: number[],
  color: [number, number, number],
  clear = true,
) => {
  if (clear) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
  }
  const [r, g, b] = color;
  const len = Math.min(WIDTH, bins.length);
  for (let x = 0; x < len; x += 1) {
    const v = Math.max(0, Math.min(1, bins[x] ?? 0));
    const h = Math.round(v * HEIGHT);
    if (h <= 0) continue;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.75)`;
    ctx.fillRect(x, HEIGHT - h, 1, h);
  }
};

const ChannelCanvas = ({ bins, color }: ChannelCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bins) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawChannel(ctx, bins, color, true);
  }, [bins, color]);

  return <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="absolute inset-0" />;
};

const RgbCanvas = ({ red, green, blue }: RgbCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    drawChannel(ctx, red || [], [255, 80, 80], false);
    drawChannel(ctx, green || [], [80, 255, 120], false);
    drawChannel(ctx, blue || [], [80, 140, 255], false);
  }, [red, green, blue]);

  return <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} className="absolute inset-0" />;
};

export default function Histogram({ histogramData, onClose }: HistogramProps) {
  const nodeRef = useRef<any>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.Rgb);

  const readChannel = (channel: HistogramChannel): number[] => {
    if (!channel) return [];
    if (Array.isArray(channel)) return channel;
    if (Array.isArray(channel.data)) return channel.data;
    return [];
  };

  const data = useMemo(
    () => ({
      luma: readChannel(histogramData?.luma),
      red: readChannel(histogramData?.red),
      green: readChannel(histogramData?.green),
      blue: readChannel(histogramData?.blue),
    }),
    [histogramData],
  );

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
          key="histogram-content"
          style={{ transformOrigin: 'top left' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="handle flex items-center justify-between p-2 cursor-move">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} className="text-text-secondary" />
              <h3 className="text-sm font-semibold text-text-primary [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
                Histogram
              </h3>
            </div>
            <button
              className="p-1 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>

          <div className="p-2 pt-0">
            <div className="relative w-[256px] h-[170px] bg-black/50 rounded">
              {displayMode === DisplayMode.Rgb && <RgbCanvas red={data.red} green={data.green} blue={data.blue} />}
              {displayMode === DisplayMode.Luma && <ChannelCanvas bins={data.luma} color={[255, 255, 255]} />}
              {displayMode === DisplayMode.Red && <ChannelCanvas bins={data.red} color={[255, 80, 80]} />}
              {displayMode === DisplayMode.Green && <ChannelCanvas bins={data.green} color={[80, 255, 120]} />}
              {displayMode === DisplayMode.Blue && <ChannelCanvas bins={data.blue} color={[80, 140, 255]} />}
            </div>

            <div className="flex justify-center gap-1 mt-2 p-1 bg-surface rounded-lg">
              <button
                onClick={() => setDisplayMode(DisplayMode.Luma)}
                className={`${baseButtonClass} ${displayMode === DisplayMode.Luma ? 'bg-accent text-black' : inactiveButtonClass}`}
              >
                Luma
              </button>
              <button
                onClick={() => setDisplayMode(DisplayMode.Rgb)}
                className={`${baseButtonClass} ${displayMode === DisplayMode.Rgb ? 'bg-accent text-black' : inactiveButtonClass}`}
              >
                RGB
              </button>
              <button
                onClick={() => setDisplayMode(DisplayMode.Red)}
                className={`${baseButtonClass} ${displayMode === DisplayMode.Red ? 'bg-red-500 text-white' : inactiveButtonClass}`}
              >
                Red
              </button>
              <button
                onClick={() => setDisplayMode(DisplayMode.Green)}
                className={`${baseButtonClass} ${displayMode === DisplayMode.Green ? 'bg-green-500 text-white' : inactiveButtonClass}`}
              >
                Green
              </button>
              <button
                onClick={() => setDisplayMode(DisplayMode.Blue)}
                className={`${baseButtonClass} ${displayMode === DisplayMode.Blue ? 'bg-blue-500 text-white' : inactiveButtonClass}`}
              >
                Blue
              </button>
            </div>
          </div>
        </motion.div>
      </div>
    </Draggable>
  );
}
