import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import { AlertOctagon } from 'lucide-react';
import { WaveformData } from '../../ui/AppProperties';
import { DisplayMode } from '../../../utils/adjustments';

interface WaveformProps {
  waveformData: WaveformData | null;
  histogram?: any;
  displayMode: string;
  setDisplayMode: (mode: string) => void;
  showClipping?: boolean;
  onToggleClipping?: () => void;
  theme?: string;
}

const modeButtons = [
  { mode: DisplayMode.Luma, label: 'L', tooltip: 'Luma', bgClass: 'bg-accent', textActiveClass: 'text-button-text' },
  {
    mode: DisplayMode.Rgb,
    label: 'RGB',
    tooltip: 'RGB Overlay',
    bgClass: 'bg-accent',
    textActiveClass: 'text-button-text',
  },
  {
    mode: DisplayMode.Parade,
    label: 'P',
    tooltip: 'Parade',
    bgClass: 'bg-accent',
    textActiveClass: 'text-button-text',
  },
  {
    mode: DisplayMode.Vectorscope,
    label: 'V',
    tooltip: 'Vectorscope',
    bgClass: 'bg-accent',
    textActiveClass: 'text-button-text',
  },
  {
    mode: DisplayMode.Histogram,
    label: 'H',
    tooltip: 'Histogram',
    bgClass: 'bg-accent',
    textActiveClass: 'text-button-text',
  },
];

const HistogramView = memo(({ histogram }: { histogram: any }) => {
  const channels = useMemo(() => {
    if (!histogram?.red || !histogram?.green || !histogram?.blue) return null;

    const getSafeMax = (arr: number[]) => {
      let max = 0;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] > max) max = arr[i];
      }
      return max || 1;
    };

    const redMax = getSafeMax(histogram.red);
    const greenMax = getSafeMax(histogram.green);
    const blueMax = getSafeMax(histogram.blue);
    const globalMax = Math.max(redMax, greenMax, blueMax);

    const generatePaths = (data: number[]) => {
      if (!data.length) return { fill: '', line: '' };

      let pathPoints = '';
      const len = data.length;
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * 255;
        const y = 255 - (data[i] / globalMax) * 255;
        pathPoints += (i === 0 ? '' : ' L') + `${x},${y}`;
      }

      return {
        fill: `M0,255 L${pathPoints} L255,255 Z`,
        line: `M${pathPoints}`,
      };
    };

    return [
      { key: 'red', color: '#FF6B6B', ...generatePaths(histogram.red) },
      { key: 'green', color: '#6BCB77', ...generatePaths(histogram.green) },
      { key: 'blue', color: '#4D96FF', ...generatePaths(histogram.blue) },
    ];
  }, [histogram]);

  if (!channels) return null;

  return (
    <svg
      viewBox="0 0 255 255"
      className="w-full h-full overflow-visible pointer-events-none"
      preserveAspectRatio="none"
    >
      {channels.map((ch) => (
        <g key={ch.key} style={{ mixBlendMode: 'lighten' }}>
          <path d={ch.fill} fill={ch.color} fillOpacity={0.4} />
          <path
            d={ch.line}
            fill="none"
            stroke={ch.color}
            strokeWidth={1.5}
            strokeOpacity={0.8}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        </g>
      ))}
    </svg>
  );
});

const FakeHistogramLoader = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;
    let lastTime = 0;

    const ANIMATION_SPEED = 1.0;

    const render = (currentTime: number) => {
      if (lastTime === 0) lastTime = currentTime;

      let dt = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      if (dt > 0.05) dt = 0.05;

      time += dt * ANIMATION_SPEED;

      ctx.clearRect(0, 0, 256, 256);
      ctx.globalCompositeOperation = 'screen';

      const drawChannel = (
        color: string,
        strokeColor: string,
        offset: number,
        amplitude: number,
        phaseSpeed: number,
      ) => {
        ctx.beginPath();
        ctx.moveTo(0, 256);
        for (let x = 0; x <= 256; x += 4) {
          const noise = Math.sin(x * 0.2 + time * phaseSpeed * 2) * 0.5;
          const wave = Math.sin(x * 0.03 + time * phaseSpeed + offset) * amplitude;

          const baseHeight = 1;

          const y = 256 - baseHeight - Math.max(0, wave + noise);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(256, 256);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1;
        ctx.stroke();
      };

      drawChannel('rgba(255, 107, 107, 0.55)', 'rgba(255, 107, 107, 0.3)', 0, 5, 0.8);
      drawChannel('rgba(107, 203, 119, 0.55)', 'rgba(107, 203, 119, 0.3)', 2, 4, -1.0);
      drawChannel('rgba(77, 150, 255, 0.55)', 'rgba(77, 150, 255, 0.3)', 4, 6, 0.6);

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  return <canvas ref={canvasRef} width={256} height={256} className="w-full h-full opacity-60" />;
};

const useRawRgbaCanvas = (
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  base64Data: string,
  width: number,
  height: number,
) => {
  useEffect(() => {
    if (!base64Data || !canvasRef.current || !width || !height) return;

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;

    const binary = atob(base64Data);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const imageData = new ImageData(bytes, width, height);
    ctx.putImageData(imageData, 0, 0);
  }, [base64Data, width, height, canvasRef]);
};

const WaveformCanvas = ({
  base64Data,
  width,
  height,
  isVectorscope,
}: {
  base64Data: string;
  width: number;
  height: number;
  isVectorscope: boolean;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useRawRgbaCanvas(canvasRef, base64Data, width, height);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`w-full h-full ${isVectorscope ? 'object-contain' : ''}`}
    />
  );
};

const FakeWaveformLoader = ({ mode }: { mode: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTimeRef = useRef<number>(0);
  const spawnAccumulatorRef = useRef<number>(0);

  const MAX_PARTICLES = 10000;
  const particles = useRef(
    Array.from({ length: MAX_PARTICLES }, () => ({
      x: 0,
      y: 0,
      targetX: 0,
      targetY: 0,
      life: 0,
      maxLife: 1,
      r: 255,
      g: 255,
      b: 255,
      active: false,
    })),
  ).current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const WIDTH = 256;
    const HEIGHT = 256;
    canvas.width = WIDTH;
    canvas.height = HEIGHT;

    particles.forEach((p) => (p.active = false));
    lastTimeRef.current = 0;
    spawnAccumulatorRef.current = 0;
    let isPrewarmed = false;

    const imgData = ctx.createImageData(WIDTH, HEIGHT);
    const data = imgData.data;

    const gridBuffer = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    if (mode === DisplayMode.Vectorscope) {
      for (let py = 0; py < HEIGHT; py++) {
        for (let px = 0; px < WIDTH; px++) {
          const dx = px - 128.0;
          const dy = 128.0 - py;
          const min_d = Math.min(Math.abs(dx), Math.abs(dy));
          const dist = Math.sqrt(dx * dx + dy * dy);
          const off = (py * WIDTH + px) * 4;

          if (min_d <= 1.0) {
            const alpha = Math.max(0, 40.0 - min_d * 30.0);
            gridBuffer[off] = 255;
            gridBuffer[off + 1] = 255;
            gridBuffer[off + 2] = 255;
            gridBuffer[off + 3] = alpha;
          } else if (Math.abs(dist - 127.0) < 0.8 || Math.abs(dist - 64.0) < 0.8) {
            gridBuffer[off] = 255;
            gridBuffer[off + 1] = 255;
            gridBuffer[off + 2] = 255;
            gridBuffer[off + 3] = 15;
          } else if (dx < 0.0 && dy > 0.0 && Math.abs(dy + 1.53 * dx) < 1.0) {
            gridBuffer[off] = 255;
            gridBuffer[off + 1] = 200;
            gridBuffer[off + 2] = 150;
            gridBuffer[off + 3] = 120;
          }
        }
      }
    }

    let animationFrameId: number;

    const render = (time: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = time;
      let dt = (time - lastTimeRef.current) / 1000;
      lastTimeRef.current = time;

      if (dt > 0.05) dt = 0.05;

      let frameDt = dt;

      if (!isPrewarmed) {
        frameDt = 0.5;
        isPrewarmed = true;
      }

      data.set(gridBuffer);

      const SPAWN_RATE = 1000;
      spawnAccumulatorRef.current += SPAWN_RATE * frameDt;

      const dotsToSpawn = Math.floor(spawnAccumulatorRef.current);
      if (dotsToSpawn > 0) {
        spawnAccumulatorRef.current -= dotsToSpawn;
        let spawnedCount = 0;

        for (let i = 0; i < MAX_PARTICLES && spawnedCount < dotsToSpawn; i++) {
          const p = particles[i];
          if (!p.active) {
            p.active = true;

            if (mode !== DisplayMode.Vectorscope) {
              p.x = Math.random() * WIDTH;
              p.targetX = p.x;

              p.y = HEIGHT - Math.random() * 2;

              const isPot = Math.random() < 0.4;

              if (isPot) {
                p.targetY = HEIGHT - Math.random() * 6;
              } else {
                const randomCurve = Math.pow(Math.random(), 1.2);
                p.targetY = HEIGHT - randomCurve * HEIGHT;
              }

              if (mode === DisplayMode.Parade) {
                const section = Math.floor((p.x / WIDTH) * 3);
                if (section === 0) {
                  p.r = 255;
                  p.g = 70;
                  p.b = 70;
                } else if (section === 1) {
                  p.r = 70;
                  p.g = 255;
                  p.b = 70;
                } else {
                  p.r = 70;
                  p.g = 150;
                  p.b = 255;
                }
              } else if (mode === DisplayMode.Rgb) {
                const rand = Math.random();
                if (rand > 0.85) {
                  p.r = 255;
                  p.g = 80;
                  p.b = 80;
                } else if (rand > 0.7) {
                  p.r = 80;
                  p.g = 255;
                  p.b = 80;
                } else if (rand > 0.55) {
                  p.r = 80;
                  p.g = 150;
                  p.b = 255;
                } else {
                  p.r = 255;
                  p.g = 255;
                  p.b = 255;
                }
              } else {
                p.r = 255;
                p.g = 255;
                p.b = 255;
              }
            }

            const life = Math.random() * 5.0 + 8.0;
            p.life = life;
            p.maxLife = life;

            spawnedCount++;
          }
        }
      }

      const speedMultiplier = 1;
      const interpolation = 1 - Math.exp(-speedMultiplier * frameDt);

      for (let i = 0; i < MAX_PARTICLES; i++) {
        const p = particles[i];
        if (p.active) {
          p.life -= frameDt;

          if (p.life <= 0) {
            p.active = false;
            continue;
          }

          p.x += (p.targetX - p.x) * interpolation;
          p.y += (p.targetY - p.y) * interpolation;

          const lifeRatio = p.life / p.maxLife;

          let opacity = 1.0;
          if (lifeRatio > 0.8) {
            opacity = (1 - lifeRatio) / 0.12;
          } else if (lifeRatio < 0.2) {
            opacity = lifeRatio / 0.2;
          }

          const alpha = opacity * 0.18;

          const px = Math.floor(p.x);
          const py = Math.floor(p.y);

          for (let dy = 0; dy < 3; dy++) {
            for (let dx = 0; dx < 1.5; dx++) {
              const cx = px + dx;
              const cy = py + dy;

              if (cx >= 0 && cx < WIDTH && cy >= 0 && cy < HEIGHT) {
                const idx = (cy * WIDTH + cx) * 4;
                data[idx] = Math.min(255, data[idx] + p.r * alpha);
                data[idx + 1] = Math.min(255, data[idx + 1] + p.g * alpha);
                data[idx + 2] = Math.min(255, data[idx + 2] + p.b * alpha);
                data[idx + 3] = Math.min(255, data[idx + 3] + alpha * 255);
              }
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);
      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => cancelAnimationFrame(animationFrameId);
  }, [mode, particles]);

  return (
    <canvas ref={canvasRef} className={`w-full h-full ${mode === DisplayMode.Vectorscope ? 'object-contain' : ''}`} />
  );
};

export default function Waveform({
  waveformData,
  histogram,
  displayMode,
  setDisplayMode,
  showClipping,
  onToggleClipping,
  theme,
}: WaveformProps) {
  const [isHovered, setIsHovered] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLightTheme = theme ? ['light', 'snow', 'arctic'].includes(theme) : false;
  const isHistogram = displayMode === DisplayMode.Histogram;
  const isVectorscope = displayMode === DisplayMode.Vectorscope;
  const isReady = isHistogram ? !!(histogram && histogram.red) : !!waveformData;
  const hadDataOnMount = useRef(isReady);
  const width = waveformData?.width || 256;
  const height = waveformData?.height || 256;

  const activeData = waveformData
    ? {
        [DisplayMode.Rgb]: waveformData.rgb,
        [DisplayMode.Luma]: waveformData.luma,
        [DisplayMode.Parade]: waveformData.parade,
        [DisplayMode.Vectorscope]: waveformData.vectorscope,
        [DisplayMode.Histogram]: undefined,
      }[displayMode as DisplayMode]
    : '';

  const handleMouseEnter = () => {
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHovered(true);
    }, 250);
  };

  const handleMouseLeave = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsHovered(false);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  const baseButtonClass =
    'relative grow text-center px-1.5 py-1 text-xs rounded-lg font-medium transition-colors duration-150';
  const inactiveButtonClass = 'text-text-primary hover:bg-bg-tertiary';

  const isLoaderMode = [
    DisplayMode.Luma,
    DisplayMode.Rgb,
    DisplayMode.Parade,
    DisplayMode.Vectorscope,
    DisplayMode.Histogram,
  ].includes(displayMode as DisplayMode);

  return (
    <div
      className="relative w-full h-full bg-surface rounded-lg overflow-hidden border-border-color shadow-inner"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          isolation: 'isolate',
          filter: isLightTheme ? 'invert(1) hue-rotate(180deg)' : 'none',
          transition: 'filter 0.3s ease',
        }}
      >
        <AnimatePresence initial={!hadDataOnMount.current} mode="sync">
          {isReady ? (
            isHistogram ? (
              <motion.div
                key="waveform-histogram"
                initial={{ opacity: 0, scaleY: 0 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={{ opacity: 0, scaleY: 0 }}
                transition={{
                  duration: 0.5,
                  ease: [0.22, 1, 0.36, 1],
                  opacity: { duration: 0.4 },
                }}
                style={{ transformOrigin: 'bottom' }}
                className="absolute inset-0 z-10"
              >
                <HistogramView histogram={histogram} />
              </motion.div>
            ) : (
              <motion.div
                key={`waveform-canvas-${displayMode}`}
                initial={{ opacity: 0, ...(isVectorscope ? {} : { scaleY: 0 }) }}
                animate={{ opacity: 1, ...(isVectorscope ? {} : { scaleY: 1 }) }}
                exit={{ opacity: 0, ...(isVectorscope ? {} : { scaleY: 0 }) }}
                transition={{
                  duration: 0.5,
                  ease: [0.22, 1, 0.36, 1],
                  opacity: { duration: 0.4 },
                }}
                style={{ transformOrigin: 'bottom' }}
                className="absolute inset-0 z-10"
              >
                <WaveformCanvas
                  base64Data={activeData || ''}
                  width={width}
                  height={height}
                  isVectorscope={isVectorscope}
                />
              </motion.div>
            )
          ) : isLoaderMode ? (
            <motion.div
              key={`waveform-loader-${displayMode}`}
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                transition: { duration: 0.6, ease: 'easeOut' },
              }}
              exit={{
                opacity: 0,
                transition: { duration: 0.2, ease: 'easeIn' },
              }}
              className="absolute inset-0 pointer-events-none z-0"
            >
              {isHistogram ? <FakeHistogramLoader /> : <FakeWaveformLoader mode={displayMode} />}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {isHovered && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute inset-x-0 bottom-0 p-2 pt-6 bg-linear-to-t from-black/80 to-transparent flex justify-center z-20"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.1, ease: 'easeOut', delay: 0.05 }}
              className="flex items-center justify-center gap-1 p-1 bg-surface/90 backdrop-blur-md rounded-lg w-full shadow-lg border border-white/5"
            >
              {onToggleClipping && (
                <>
                  <button
                    onClick={onToggleClipping}
                    data-tooltip={showClipping ? 'Hide Clipping Warnings' : 'Show Clipping Warnings'}
                    className={`relative flex items-center justify-center w-7 h-7 shrink-0 rounded-lg transition-colors duration-150 ${
                      showClipping ? 'bg-accent text-button-text' : 'text-text-primary hover:bg-bg-tertiary'
                    }`}
                  >
                    <AlertOctagon size={14} />
                  </button>
                  <div className="w-px h-5 bg-white/20 mx-1 shrink-0"></div>
                </>
              )}

              <LayoutGroup>
                {modeButtons.map(({ mode, label, tooltip, bgClass, textActiveClass }) => (
                  <button
                    key={mode}
                    onClick={() => setDisplayMode(mode)}
                    data-tooltip={tooltip}
                    className={`${baseButtonClass} ${displayMode === mode ? textActiveClass : inactiveButtonClass}`}
                  >
                    {displayMode === mode && (
                      <motion.div
                        layoutId="waveform-mode-indicator"
                        className={`absolute inset-0 ${bgClass} rounded-lg`}
                        transition={{ type: 'spring', bounce: 0.2, duration: 0.4 }}
                      />
                    )}
                    <span className="relative z-10">{label}</span>
                  </button>
                ))}
              </LayoutGroup>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
