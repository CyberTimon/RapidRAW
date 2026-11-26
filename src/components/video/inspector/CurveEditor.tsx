import {
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TFunction } from 'i18next';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import { Animated, Keyframe, Ticks } from '../../../types/video';
import { getVideo, useVideoStore } from '../../../store/useVideoStore';
import { FINE_ADJUSTMENT_MULTIPLIER } from '../../../utils/fineAdjustment';
import { frameTicks } from '../../../utils/video/time';
import { alignHaptic } from '../../../utils/haptics';
import {
  EASE_PRESETS,
  EaseChoice,
  EasePreset,
  HandleSide,
  segmentHandles,
  valueAt,
  withHandle,
} from '../../../utils/video/animation';

export interface CurveScale {
  toUnit(value: number): number;
  fromUnit(unit: number): number;
  grid: Array<{ value: number; label: string; strong?: boolean }>;
  snaps?: Array<number>;
}

export interface PointEditing {
  step: Ticks;
  add(keys: Array<Keyframe>, time: Ticks): { keys: Array<Keyframe>; index: number };
  remove(index: number): void;
}

interface Target {
  index: number;
  side: HandleSide | null;
}

interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphDrag {
  origin: GraphPoint;
  anchor: GraphPoint;
}

interface Drag extends GraphDrag {
  target: Target;
  keys: Array<Keyframe>;
  from: Ticks;
  to: Ticks;
  scale: CurveScale;
  sent: string;
}

const WIDTH = 280;
const HEIGHT = 150;
const PAD = 8;
const GUTTER = 30;
const PLOT_WIDTH = WIDTH - GUTTER - PAD;
const PLOT_HEIGHT = HEIGHT - 2 * PAD;
const POINT_RADIUS = 5;
const HANDLE_RADIUS = 3.5;
const HIT_RADIUS = 9;
const SNAP_DISTANCE = 5;
const SAMPLES = 120;
const RANGE_PAD = 0.15;

export const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export const graphPoint = (
  svg: SVGSVGElement,
  event: { clientX: number; clientY: number },
  width: number,
  height: number,
): GraphPoint => {
  const rect = svg.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * width,
    y: ((event.clientY - rect.top) / rect.height) * height,
  };
};

export const draggedPoint = (drag: GraphDrag, pointer: GraphPoint, fine: boolean): GraphPoint => {
  const factor = fine ? FINE_ADJUSTMENT_MULTIPLIER : 1;
  const point = {
    x: drag.anchor.x + (pointer.x - drag.origin.x) * factor,
    y: drag.anchor.y + (pointer.y - drag.origin.y) * factor,
  };
  if (fine) {
    drag.origin = pointer;
    drag.anchor = point;
  }
  return point;
};

export const nearestWithin = <T,>(candidates: Array<{ target: T; distance: number }>, radius: number): T | null =>
  candidates.filter((entry) => entry.distance <= radius).sort((a, b) => a.distance - b.distance)[0]?.target ?? null;

const geometry = (from: Ticks, to: Ticks, scale: CurveScale) => {
  const span = Math.max(1, to - from);
  return {
    x: (time: Ticks) => GUTTER + ((time - from) / span) * PLOT_WIDTH,
    y: (value: number) => PAD + (1 - scale.toUnit(value)) * PLOT_HEIGHT,
    time: (x: number) => from + ((x - GUTTER) / PLOT_WIDTH) * span,
    value: (y: number) => scale.fromUnit(clamp(1 - (y - PAD) / PLOT_HEIGHT, 0, 1)),
  };
};

const segmentOf = (keys: Array<Keyframe>, index: number, side: HandleSide) => {
  const [from, to] = side === 'out' ? [keys[index], keys[index + 1]] : [keys[index - 1], keys[index]];
  return from && to && from.ease !== 'hold' ? { from, to } : null;
};

const handlePoint = (keys: Array<Keyframe>, index: number, side: HandleSide) => {
  const segment = segmentOf(keys, index, side);
  if (!segment) return null;
  const { from, to } = segment;
  const [outgoing, incoming] = segmentHandles(from, to);
  const span = to.time - from.time;
  const delta = to.value - from.value;
  return side === 'out'
    ? { time: from.time + outgoing[0] * span, value: from.value + outgoing[1] * delta }
    : { time: to.time - incoming[0] * span, value: to.value - incoming[1] * delta };
};

const visibleHandles = (keys: Array<Keyframe>, selected: number | null): Array<Target> =>
  selected === null
    ? []
    : [
        { index: selected - 1, side: 'out' as const },
        { index: selected, side: 'in' as const },
        { index: selected, side: 'out' as const },
        { index: selected + 1, side: 'in' as const },
      ].filter((target) => segmentOf(keys, target.index, target.side));

const sampleTimes = (keys: Array<Keyframe>, from: Ticks, to: Ticks) =>
  [
    ...Array.from({ length: SAMPLES + 1 }, (_, index) => from + ((to - from) * index) / SAMPLES),
    ...keys.flatMap((key) => (key.time > from && key.time < to ? [key.time - 1, key.time] : [])),
  ].sort((a, b) => a - b);

const autoScale = (
  value: Animated,
  from: Ticks,
  to: Ticks,
  handles: Array<Target>,
  format: (value: number) => string,
): CurveScale => {
  const keys = value.keys ?? [];
  const levels = [
    ...sampleTimes(keys, from, to).map((time) => valueAt(value, time)),
    ...handles.map((target) => handlePoint(keys, target.index, target.side!)!.value),
  ];
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  const spread = high - low;
  const pad = spread > 1e-9 ? spread * RANGE_PAD : Math.max(Math.abs(high) * 0.1, 0.01);
  const bottom = low - pad;
  const top = high + pad;
  return {
    toUnit: (level) => (level - bottom) / (top - bottom),
    fromUnit: (unit) => bottom + unit * (top - bottom),
    grid: (spread > 1e-9 ? [low, (low + high) / 2, high] : [low]).map((level) => ({
      value: level,
      label: format(level),
    })),
  };
};

export const easeOptions = (t: TFunction, current: EaseChoice | null, apply: (preset: EasePreset) => void) =>
  EASE_PRESETS.map((preset) => ({
    icon: preset === current ? Check : undefined,
    label: t(`video.keyframes.ease.${preset}`),
    onClick: () => apply(preset),
  }));

export const subscribeShownFrame = (onChange: () => void) =>
  useVideoStore.subscribe((state, previous) => {
    if (state.playhead === previous.playhead) return;
    const frame = state.project ? frameTicks(state.project.settings.fps) : 1;
    if (!state.isPlaying || Math.floor(state.playhead / frame) !== Math.floor(previous.playhead / frame)) onChange();
  });

function CurvePlayhead({ timeOf, from, to }: { timeOf(playhead: Ticks): Ticks | null; from: Ticks; to: Ticks }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const line = ref.current;
      if (!line) return;
      const time = timeOf(getVideo().playhead);
      const visible = time !== null && time >= from && time <= to;
      line.style.display = visible ? '' : 'none';
      if (!visible) return;
      const x = GUTTER + ((time - from) / Math.max(1, to - from)) * PLOT_WIDTH;
      line.style.left = `${(x / WIDTH) * 100}%`;
    };
    place();
    return subscribeShownFrame(place);
  }, [timeOf, from, to]);
  return (
    <div
      ref={ref}
      className="absolute w-px bg-accent/60 pointer-events-none"
      style={{ top: `${(PAD / 2 / HEIGHT) * 100}%`, bottom: `${(PAD / 2 / HEIGHT) * 100}%` }}
    />
  );
}

export default function CurveEditor({
  value,
  from,
  to,
  scale: fixedScale,
  selected,
  format,
  playhead,
  points,
  onSelect,
  onChange,
  onMenu,
}: {
  value: Animated;
  from: Ticks;
  to: Ticks;
  scale?: CurveScale;
  selected: number | null;
  format(value: number): string;
  playhead?(playhead: Ticks): Ticks | null;
  points?: PointEditing;
  onSelect(index: number): void;
  onChange(keys: Array<Keyframe>, index: number): void;
  onMenu(event: ReactMouseEvent, index: number): void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<{ target: Target; scale: CurveScale } | null>(null);
  const keys = value.keys ?? [];
  const handles = visibleHandles(keys, selected);
  const scale = fixedScale ?? autoScale(value, from, to, handles, format);
  const shown = geometry(from, to, active?.scale ?? scale);

  const local = (event: { clientX: number; clientY: number }) => graphPoint(svgRef.current!, event, WIDTH, HEIGHT);

  const hitAt = (x: number, y: number): Target | null => {
    const distance = (point: { time: Ticks; value: number } | null) =>
      point ? Math.hypot(shown.x(point.time) - x, shown.y(point.value) - y) : Number.POSITIVE_INFINITY;
    const handle = nearestWithin(
      handles.map((target) => ({ target, distance: distance(handlePoint(keys, target.index, target.side!)) })),
      HIT_RADIUS,
    );
    if (handle) return handle;
    const index = nearestWithin(
      keys.flatMap((key, at) => (key.time >= from && key.time <= to ? [{ target: at, distance: distance(key) }] : [])),
      HIT_RADIUS,
    );
    return index === null ? null : { index, side: null };
  };

  const begin = (event: ReactPointerEvent<SVGSVGElement>, target: Target, current: Array<Keyframe>) => {
    const pointer = local(event);
    const anchor = target.side ? handlePoint(current, target.index, target.side) : current[target.index];
    if (!anchor) return;
    svgRef.current?.setPointerCapture(event.pointerId);
    drag.current = {
      target,
      keys: current,
      from,
      to,
      scale,
      origin: pointer,
      anchor: { x: shown.x(anchor.time), y: shown.y(anchor.value) },
      sent: JSON.stringify(current),
    };
    setActive({ target, scale });
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    const hit = hitAt(x, y);
    if (hit?.side) {
      begin(event, hit, keys);
      return;
    }
    if (hit) {
      onSelect(hit.index);
      if (points) begin(event, hit, keys);
      return;
    }
    if (!points || x < GUTTER) return;
    const added = points.add(keys, clamp(Math.round(shown.time(x)), from, to));
    begin(event, { index: added.index, side: null }, added.keys);
    onChange(added.keys, added.index);
  };

  const movedPoint = (current: Drag, x: number, y: number, free: boolean) => {
    const place = geometry(current.from, current.to, current.scale);
    const { index } = current.target;
    const step = points?.step ?? 1;
    const previous = current.keys[index - 1];
    const next = current.keys[index + 1];
    const low = previous ? previous.time + step : current.from;
    const high = next ? next.time - step : current.to;
    const snapped = current.from + Math.round((place.time(x) - current.from) / step) * step;
    const time = low <= high ? clamp(snapped, low, high) : current.keys[index].time;
    const candidates = free
      ? []
      : [...(current.scale.snaps ?? []), ...current.keys.filter((_, other) => other !== index).map((key) => key.value)];
    const snap = candidates
      .map((candidate) => ({ candidate, distance: Math.abs(place.y(candidate) - y) }))
      .filter((entry) => entry.distance <= SNAP_DISTANCE)
      .sort((a, b) => a.distance - b.distance)[0];
    alignHaptic(current, snap?.candidate);
    return current.keys.map((key, other) =>
      other === index ? { ...key, time, value: snap ? snap.candidate : place.value(y) } : key,
    );
  };

  const movedHandle = (current: Drag, x: number, y: number) => {
    const place = geometry(current.from, current.to, current.scale);
    const { index, side } = current.target;
    const segment = segmentOf(current.keys, index, side!);
    if (!segment) return current.keys;
    const { from: start, to: end } = segment;
    const span = Math.max(1, end.time - start.time);
    const delta = end.value - start.value;
    const time = place.time(x);
    const level = place.value(y);
    const previous = segmentHandles(start, end)[side === 'out' ? 0 : 1];
    const handle: [number, number] =
      side === 'out'
        ? [(time - start.time) / span, Math.abs(delta) > 1e-9 ? (level - start.value) / delta : previous[1]]
        : [(end.time - time) / span, Math.abs(delta) > 1e-9 ? (end.value - level) / delta : previous[1]];
    return withHandle(current.keys, index, side!, handle);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current) return;
    const { x, y } = draggedPoint(current, local(event), event.shiftKey);
    const moved = current.target.side ? movedHandle(current, x, y) : movedPoint(current, x, y, event.altKey);
    const sent = JSON.stringify(moved);
    if (sent === current.sent) return;
    current.sent = sent;
    const ratio = (to - from) / Math.max(1, current.to - current.from);
    onChange(
      ratio === 1
        ? moved
        : moved.map((key) => ({ ...key, time: Math.round(from + (key.time - current.from) * ratio) })),
      current.target.index,
    );
  };

  const handlePointerUp = () => {
    drag.current = null;
    setActive(null);
  };

  const pointAt = (event: ReactMouseEvent<SVGSVGElement>) => {
    const { x, y } = local(event);
    const hit = hitAt(x, y);
    return hit && !hit.side ? hit.index : null;
  };

  const handleContextMenu = (event: ReactMouseEvent<SVGSVGElement>) => {
    const index = pointAt(event);
    if (index === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(index);
    onMenu(event, index);
  };

  const handleDoubleClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const index = pointAt(event);
    if (index !== null) points?.remove(index);
  };

  const path = sampleTimes(keys, from, to)
    .map(
      (time, index) =>
        `${index === 0 ? 'M' : 'L'}${shown.x(time).toFixed(1)},${shown.y(valueAt(value, time)).toFixed(1)}`,
    )
    .join(' ');
  const labelled = active && !active.target.side ? active.target.index : selected;
  const label = labelled !== null ? keys[labelled] : undefined;

  return (
    <div className="relative bg-bg-primary rounded-md p-1">
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className={clsx(
            'relative block w-full h-auto touch-none select-none overflow-visible',
            points ? 'cursor-crosshair' : 'cursor-default',
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          data-curve-editor
        >
          {(active?.scale ?? scale).grid.map((line) => (
            <g key={line.value} className="text-text-secondary" pointerEvents="none">
              <line
                x1={GUTTER}
                x2={WIDTH - PAD}
                y1={shown.y(line.value)}
                y2={shown.y(line.value)}
                stroke="currentColor"
                strokeOpacity={line.strong ? 0.45 : 0.15}
                strokeWidth={line.strong ? 0.75 : 0.5}
                strokeDasharray={line.strong ? '3 3' : undefined}
              />
              <text x={GUTTER - 5} y={shown.y(line.value) + 3} textAnchor="end" fontSize={8} fill="currentColor">
                {line.label}
              </text>
            </g>
          ))}
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            className="text-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            pointerEvents="none"
          />
          {handles.map((target) => {
            const point = handlePoint(keys, target.index, target.side!)!;
            const key = keys[target.index];
            const isActive = active?.target.index === target.index && active.target.side === target.side;
            return (
              <g key={`${target.index}${target.side}`} className="text-text-secondary">
                <line
                  x1={shown.x(key.time)}
                  y1={shown.y(key.value)}
                  x2={shown.x(point.time)}
                  y2={shown.y(point.value)}
                  stroke="currentColor"
                  strokeWidth={1}
                  pointerEvents="none"
                />
                <circle
                  cx={shown.x(point.time)}
                  cy={shown.y(point.value)}
                  r={HANDLE_RADIUS}
                  fill={isActive ? '#ffffff' : 'currentColor'}
                  stroke="currentColor"
                  className={clsx('cursor-move', isActive ? 'text-white' : 'text-text-primary')}
                  strokeWidth={1}
                />
              </g>
            );
          })}
          {keys.map((key, index) =>
            key.time < from || key.time > to ? null : (
              <circle
                key={index}
                cx={shown.x(key.time)}
                cy={shown.y(key.value)}
                r={POINT_RADIUS}
                fill={index === selected ? '#ffffff' : 'currentColor'}
                className={clsx('text-accent', points ? 'cursor-grab' : 'cursor-pointer')}
                stroke="#1e1e1e"
                strokeWidth={1.5}
              />
            ),
          )}
          {label && (
            <text
              x={clamp(shown.x(label.time), GUTTER + 14, WIDTH - PAD - 14)}
              y={Math.max(PAD + 6, shown.y(label.value) - POINT_RADIUS - 5)}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              className="text-text-primary"
              pointerEvents="none"
            >
              {format(label.value)}
            </text>
          )}
        </svg>
        {playhead && <CurvePlayhead timeOf={playhead} from={from} to={to} />}
      </div>
    </div>
  );
}
