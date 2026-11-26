import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Equalizer } from '../../../types/video';
import { hasFineAdjustmentModifier } from '../../../utils/fineAdjustment';
import {
  BAND_HZ,
  EQ_BANDS,
  EqBand,
  MAX_EQ_DB,
  MAX_HZ,
  MAX_LOW_CUT_HZ,
  MIN_HIGH_CUT_HZ,
  MIN_HZ,
  Sound,
  formatDb,
  frequencyToUnit,
  isNeutralSound,
  responseDb,
  soundFilters,
  unitToFrequency,
} from '../../../utils/video/sound';
import {
  OutputFrame,
  canvasColor,
  drawSpectrum,
  redrawOutput,
  useCanvasSize,
  useOutputDraw,
  useThemeChange,
} from './outputMeter';
import { GraphDrag, clamp, draggedPoint, graphPoint, nearestWithin } from '../inspector/CurveEditor';

type EqHandle = 'lowCut' | EqBand | 'highCut';
type SoundPatch = Partial<Pick<Sound, 'eq' | 'lowCut' | 'highCut'>>;

const HANDLES: Array<EqHandle> = ['lowCut', ...EQ_BANDS, 'highCut'];
const WIDTH = 280;
const HEIGHT = 132;
const GUTTER = 22;
const PAD = 6;
const AXIS = 12;
const PLOT_WIDTH = WIDTH - GUTTER - PAD;
const PLOT_HEIGHT = HEIGHT - PAD - AXIS;
const RANGE_DB = 15;
const SAMPLES = 160;
const HANDLE_RADIUS = 5;
const HIT_RADIUS = 11;
const DB_STEP = 0.5;
const FINE_DB_STEP = 0.1;
const LOW_CUT_OFF_HZ = 21;
const HIGH_CUT_OFF_HZ = 19500;
const HIGH_CUT_STEP_HZ = 50;
const KEY_SEMITONE = 2 ** (1 / 12);
const SPECTRUM_FLOOR_DB = -110;
const SPECTRUM_CEILING_DB = -25;
const DB_GRID = [12, 6, 0, -6, -12];
const FREQUENCY_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const FREQUENCY_LABELS: Record<number, string> = { 100: '100', 1000: '1k', 10000: '10k' };

const x = (frequency: number) => GUTTER + frequencyToUnit(clamp(frequency, MIN_HZ, MAX_HZ)) * PLOT_WIDTH;
const y = (db: number) => PAD + (1 - (clamp(db, -RANGE_DB, RANGE_DB) + RANGE_DB) / (2 * RANGE_DB)) * PLOT_HEIGHT;
const frequencyAt = (px: number) => unitToFrequency((px - GUTTER) / PLOT_WIDTH);
const dbAt = (py: number) => (1 - (py - PAD) / PLOT_HEIGHT) * 2 * RANGE_DB - RANGE_DB;
const percent = (value: number, total: number) => `${(value / total) * 100}%`;

const formatHz = (frequency: number) =>
  frequency >= 1000 ? `${(frequency / 1000).toFixed(frequency >= 10000 ? 1 : 2)} kHz` : `${Math.round(frequency)} Hz`;

const eqOf = (sound: Sound): Equalizer => ({ low: 0, mid: 0, high: 0, ...sound.eq });

const isCut = (handle: EqHandle): handle is 'lowCut' | 'highCut' => handle === 'lowCut' || handle === 'highCut';

const cutValue = (handle: 'lowCut' | 'highCut', frequency: number) =>
  handle === 'lowCut'
    ? frequency < LOW_CUT_OFF_HZ
      ? 0
      : Math.round(clamp(frequency, LOW_CUT_OFF_HZ, MAX_LOW_CUT_HZ))
    : frequency > HIGH_CUT_OFF_HZ
      ? 0
      : clamp(Math.round(frequency / HIGH_CUT_STEP_HZ) * HIGH_CUT_STEP_HZ, MIN_HIGH_CUT_HZ, HIGH_CUT_OFF_HZ);

const handleFrequency = (sound: Sound, handle: EqHandle) =>
  handle === 'lowCut'
    ? clamp(sound.lowCut || MIN_HZ, MIN_HZ, MAX_LOW_CUT_HZ)
    : handle === 'highCut'
      ? clamp(sound.highCut || MAX_HZ, MIN_HIGH_CUT_HZ, MAX_HZ)
      : BAND_HZ[handle];

const patchFor = (sound: Sound, handle: EqHandle, value: number): SoundPatch =>
  isCut(handle) ? { [handle]: value } : { eq: { ...eqOf(sound), [handle]: value } };

const valueOf = (sound: Sound, handle: EqHandle) => (isCut(handle) ? (sound[handle] ?? 0) : eqOf(sound)[handle]);

interface Drag extends GraphDrag {
  handle: EqHandle;
  sent: number;
}

export default function EqualizerGraph({
  sound,
  item,
  disabled,
  onChange,
}: {
  sound: Sound;
  item: string;
  disabled: boolean;
  onChange(patch: SoundPatch, mergeKey: string | null): void;
}) {
  const { t } = useTranslation();
  const svgRef = useRef<SVGSVGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const color = useRef<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<EqHandle | null>(null);
  const [hovered, setHovered] = useState<EqHandle | null>(null);
  const filters = useMemo(() => soundFilters(sound), [sound]);
  const response = useCallback((frequency: number) => responseDb(filters, frequency), [filters]);
  const curve = useMemo(
    () =>
      Array.from({ length: SAMPLES + 1 }, (_, index) => {
        const frequency = unitToFrequency(index / SAMPLES);
        return `${x(frequency).toFixed(1)},${y(response(frequency)).toFixed(1)}`;
      }),
    [response],
  );
  const labels: Record<EqHandle, string> = {
    lowCut: t('video.inspector.lowCut'),
    low: t('video.inspector.eq.low'),
    mid: t('video.inspector.eq.mid'),
    high: t('video.inspector.eq.high'),
    highCut: t('video.inspector.highCut'),
  };
  const display = (handle: EqHandle) => {
    const value = valueOf(sound, handle);
    return isCut(handle) ? (value > 0 ? formatHz(value) : t('video.audio.off')) : formatDb(value);
  };
  const point = (handle: EqHandle) => {
    const frequency = handleFrequency(sound, handle);
    return { x: x(frequency), y: y(isCut(handle) ? response(frequency) : eqOf(sound)[handle]) };
  };

  const draw = useCallback(({ spectrum, fresh }: OutputFrame) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !fresh) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!spectrum) return;
    color.current ??= canvasColor(canvas, 0.3);
    drawSpectrum(context, spectrum, canvas.width, canvas.height, SPECTRUM_FLOOR_DB, SPECTRUM_CEILING_DB, color.current);
  }, []);
  const redraw = useCallback(() => {
    color.current = null;
    redrawOutput(draw);
  }, [draw]);
  useOutputDraw(draw, item, canvasRef);
  useCanvasSize(canvasRef, redraw);
  useThemeChange(redraw);

  const send = (handle: EqHandle, value: number, merge: boolean) => {
    if (value === valueOf(sound, handle)) return;
    onChange(patchFor(sound, handle, value), merge ? (isCut(handle) ? handle : `eq:${handle}`) : null);
  };

  const local = (event: { clientX: number; clientY: number }) => graphPoint(svgRef.current!, event, WIDTH, HEIGHT);

  const hitAt = (px: number, py: number) =>
    nearestWithin(
      HANDLES.map((handle) => ({ target: handle, distance: Math.hypot(point(handle).x - px, point(handle).y - py) })),
      HIT_RADIUS,
    );

  const valueAt = (handle: EqHandle, px: number, py: number, fine: boolean) => {
    if (isCut(handle)) return cutValue(handle, frequencyAt(px));
    const step = fine ? FINE_DB_STEP : DB_STEP;
    return clamp(Math.round(dbAt(py) / step) * step, -MAX_EQ_DB, MAX_EQ_DB);
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    const pointer = local(event);
    const handle = hitAt(pointer.x, pointer.y);
    if (!handle) return;
    event.preventDefault();
    svgRef.current?.querySelector<SVGCircleElement>(`[data-handle="${handle}"]`)?.focus();
    svgRef.current?.setPointerCapture(event.pointerId);
    drag.current = { handle, origin: pointer, anchor: point(handle), sent: valueOf(sound, handle) };
    setActive(handle);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pointer = local(event);
    const current = drag.current;
    if (!current) {
      if (!disabled) setHovered(hitAt(pointer.x, pointer.y));
      return;
    }
    const fine = hasFineAdjustmentModifier(event);
    const { x: px, y: py } = draggedPoint(current, pointer, fine);
    const value = valueAt(current.handle, px, py, fine);
    if (value === current.sent) return;
    current.sent = value;
    send(current.handle, value, true);
  };

  const handlePointerUp = () => {
    drag.current = null;
    setActive(null);
  };

  const handleDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const pointer = local(event);
    const handle = disabled ? null : hitAt(pointer.x, pointer.y);
    if (handle) send(handle, 0, false);
  };

  const handleKeyDown = (handle: EqHandle) => (event: ReactKeyboardEvent<SVGCircleElement>) => {
    const value = valueOf(sound, handle);
    const direction = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (event.key === 'Delete' || event.key === 'Backspace') {
      send(handle, 0, false);
    } else if (direction !== undefined && isCut(handle)) {
      const frequency = value > 0 ? value : handle === 'lowCut' ? LOW_CUT_OFF_HZ : HIGH_CUT_OFF_HZ;
      send(handle, cutValue(handle, frequency * KEY_SEMITONE ** direction), true);
    } else if (direction !== undefined) {
      const step = event.shiftKey ? FINE_DB_STEP : DB_STEP;
      send(
        handle,
        clamp(Math.round((value + direction * step) / FINE_DB_STEP) * FINE_DB_STEP, -MAX_EQ_DB, MAX_EQ_DB),
        true,
      );
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const focus = active ?? hovered;
  const zero = y(0);
  const fill = `M${GUTTER},${zero} L${curve.join(' L')} L${WIDTH - PAD},${zero} Z`;

  return (
    <div className={clsx('mb-2', disabled && 'opacity-50')}>
      <div className="relative bg-bg-primary rounded-md p-1">
        <div className="relative">
          <canvas
            ref={canvasRef}
            className="absolute text-text-secondary pointer-events-none"
            style={{
              left: percent(GUTTER, WIDTH),
              top: percent(PAD, HEIGHT),
              width: percent(PLOT_WIDTH, WIDTH),
              height: percent(PLOT_HEIGHT, HEIGHT),
            }}
          />
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className={clsx(
              'relative block w-full h-auto touch-none select-none',
              disabled ? 'pointer-events-none' : focus ? 'cursor-grab' : 'cursor-default',
              active && 'cursor-grabbing',
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => setHovered(null)}
            onDoubleClick={handleDoubleClick}
            data-equalizer
          >
            <g className="text-text-secondary" pointerEvents="none">
              {DB_GRID.map((db) => (
                <g key={db}>
                  <line
                    x1={GUTTER}
                    x2={WIDTH - PAD}
                    y1={y(db)}
                    y2={y(db)}
                    stroke="currentColor"
                    strokeOpacity={db === 0 ? 0.4 : 0.12}
                    strokeWidth={db === 0 ? 0.75 : 0.5}
                  />
                  <text x={GUTTER - 4} y={y(db) + 3} textAnchor="end" fontSize={8} fill="currentColor">
                    {db > 0 ? `+${db}` : db < 0 ? `−${-db}` : '0'}
                  </text>
                </g>
              ))}
              {FREQUENCY_GRID.map((frequency) => (
                <g key={frequency}>
                  <line
                    x1={x(frequency)}
                    x2={x(frequency)}
                    y1={PAD}
                    y2={PAD + PLOT_HEIGHT}
                    stroke="currentColor"
                    strokeOpacity={FREQUENCY_LABELS[frequency] ? 0.18 : 0.08}
                    strokeWidth={0.5}
                  />
                  {FREQUENCY_LABELS[frequency] && (
                    <text x={x(frequency)} y={HEIGHT - 2} textAnchor="middle" fontSize={8} fill="currentColor">
                      {FREQUENCY_LABELS[frequency]}
                    </text>
                  )}
                </g>
              ))}
            </g>
            <path d={fill} className="text-accent" fill="currentColor" fillOpacity={0.12} pointerEvents="none" />
            <path
              d={`M${curve.join(' L')}`}
              fill="none"
              stroke="currentColor"
              className="text-accent"
              strokeWidth={2}
              strokeLinejoin="round"
              pointerEvents="none"
            />
            {HANDLES.map((handle) => {
              const { x: cx, y: cy } = point(handle);
              const on = valueOf(sound, handle) !== 0;
              const highlighted = focus === handle;
              return (
                <circle
                  key={handle}
                  data-handle={handle}
                  cx={cx}
                  cy={cy}
                  r={HANDLE_RADIUS}
                  tabIndex={disabled ? -1 : 0}
                  role="slider"
                  aria-label={labels[handle]}
                  aria-valuetext={display(handle)}
                  className={clsx('outline-none', highlighted ? 'text-white' : 'text-accent')}
                  fill={on || highlighted ? 'currentColor' : '#1e1e1e'}
                  stroke={on || highlighted ? '#1e1e1e' : 'currentColor'}
                  strokeWidth={1.5}
                  onFocus={() => setHovered(handle)}
                  onBlur={() => setHovered(null)}
                  onKeyDown={handleKeyDown(handle)}
                />
              );
            })}
            {focus && (
              <text
                x={clamp(point(focus).x, GUTTER + 30, WIDTH - PAD - 30)}
                y={point(focus).y > PAD + 22 ? point(focus).y - HANDLE_RADIUS - 5 : point(focus).y + HANDLE_RADIUS + 11}
                textAnchor="middle"
                fontSize={9}
                fill="currentColor"
                className="text-text-primary"
                pointerEvents="none"
              >
                {`${labels[focus]} ${display(focus)}`}
              </text>
            )}
          </svg>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1 mt-2">
        {HANDLES.map((handle) => (
          <div
            key={handle}
            className="min-w-0 flex flex-col items-center select-none"
            onMouseEnter={() => setHovered(handle)}
            onMouseLeave={() => setHovered(null)}
            onDoubleClick={() => !disabled && send(handle, 0, false)}
          >
            <span
              className={clsx(
                'max-w-full text-[10px] truncate',
                focus === handle ? 'text-accent' : 'text-text-secondary',
              )}
            >
              {labels[handle]}
            </span>
            <span className="max-w-full text-xs tabular-nums text-text-primary truncate">{display(handle)}</span>
          </div>
        ))}
      </div>
      {!isNeutralSound(sound) && !disabled && (
        <div className="flex justify-end mt-1">
          <button
            type="button"
            className="text-sm text-accent hover:underline"
            onClick={() => onChange({ eq: null, lowCut: 0, highCut: 0 }, null)}
          >
            {t('video.audio.resetEqualizer')}
          </button>
        </div>
      )}
    </div>
  );
}
