import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Coord } from '../../../../utils/adjustments';
import { getStrokeCenter } from '../../../../utils/maskUtils';
import { ToolType } from '../../right/Masks';

interface CloneLine {
  brushSize: number;
  points: Array<Coord>;
  tool: ToolType | string;
}

interface CloneSourceOverlayProps {
  lines: Array<CloneLine>;
  source: Coord | null;
  isDrawing: boolean;
  isLoading: boolean;
  imageScale: number;
  zoom: number;
  toScreen(point: Coord): Coord;
  onSourceDrag(source: Coord): void;
  onSourceDragEnd(source: Coord): void;
  onDragStateChange(isDragging: boolean): void;
  tooltip: string;
}

const toPath = (points: Array<Coord>, toScreen: (point: Coord) => Coord) => {
  const screen = points.map(toScreen);
  if (screen.length === 1) {
    return `M ${screen[0].x} ${screen[0].y} l 0.01 0`;
  }
  return screen.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
};

export default function CloneSourceOverlay({
  lines,
  source,
  isDrawing,
  isLoading,
  imageScale,
  zoom,
  toScreen,
  onSourceDrag,
  onSourceDragEnd,
  onDragStateChange,
  tooltip,
}: CloneSourceOverlayProps) {
  const maskId = `clone-outline-${useId().replace(/:/g, '')}`;
  const [dragSource, setDragSource] = useState<Coord | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origin: Coord; current: Coord } | null>(null);
  const callbacksRef = useRef({ onSourceDrag, onSourceDragEnd, onDragStateChange, zoom, imageScale });
  callbacksRef.current = { onSourceDrag, onSourceDragEnd, onDragStateChange, zoom, imageScale };

  const brushLines = useMemo(() => lines.filter((l) => l.tool !== ToolType.Eraser && l.points.length > 0), [lines]);
  const center = useMemo(() => getStrokeCenter(lines), [lines]);
  const activeSource = dragSource ?? source;

  const paths = useMemo(
    () => brushLines.map((l) => ({ d: toPath(l.points, toScreen), width: Math.max(1, l.brushSize * imageScale) })),
    [brushLines, toScreen, imageScale],
  );

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { zoom: z, imageScale: s, onSourceDrag: onDrag } = callbacksRef.current;
    const factor = Math.max(z * s, 1e-6);
    const next = {
      x: drag.origin.x + (e.clientX - drag.startX) / factor,
      y: drag.origin.y + (e.clientY - drag.startY) / factor,
    };
    drag.current = next;
    setDragSource(next);
    onDrag(next);
  }, []);

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
    dragRef.current = null;
    if (drag) {
      callbacksRef.current.onDragStateChange(false);
    }
    if (drag && (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y)) {
      callbacksRef.current.onSourceDragEnd(drag.current);
    }
    setDragSource(null);
  }, [handlePointerMove]);

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    },
    [handlePointerMove, handlePointerUp],
  );

  const handlePointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !activeSource) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: activeSource, current: activeSource };
    onDragStateChange(true);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  if (paths.length === 0 || !center) return null;

  const ring = 1.5 / zoom;
  const shadow = 1.5 / zoom;
  const centerScreen = toScreen(center);
  const offset = activeSource
    ? { x: (activeSource.x - center.x) * imageScale, y: (activeSource.y - center.y) * imageScale }
    : null;

  if (isDrawing) {
    return (
      <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
        <g opacity={0.35}>
          {paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke="white"
              strokeWidth={p.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </g>
        {offset && (
          <g transform={`translate(${offset.x} ${offset.y})`} opacity={0.6}>
            {paths.map((p, i) => (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke="white"
                strokeWidth={ring}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={`${4 / zoom} ${4 / zoom}`}
              />
            ))}
          </g>
        )}
      </svg>
    );
  }

  const maxRadius = Math.max(...paths.map((p) => p.width)) / 2;
  const outline = (
    <g mask={`url(#${maskId})`}>
      {paths.map((p, i) => (
        <path
          key={`s${i}`}
          d={p.d}
          fill="none"
          stroke="rgba(0,0,0,0.45)"
          strokeWidth={p.width + 2 * (ring + shadow)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {paths.map((p, i) => (
        <path
          key={`r${i}`}
          d={p.d}
          fill="none"
          stroke="white"
          strokeWidth={p.width + 2 * ring}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </g>
  );

  let arrow = null;
  if (offset) {
    const length = Math.hypot(offset.x, offset.y);
    const gap = Math.min(maxRadius, length / 2) + 3 / zoom;
    if (length > 2 * gap + 10 / zoom) {
      const ux = -offset.x / length;
      const uy = -offset.y / length;
      const start = { x: centerScreen.x + offset.x + ux * gap, y: centerScreen.y + offset.y + uy * gap };
      const end = { x: centerScreen.x - ux * gap, y: centerScreen.y - uy * gap };
      const head = 8 / zoom;
      const left = { x: end.x - ux * head - uy * head * 0.55, y: end.y - uy * head + ux * head * 0.55 };
      const right = { x: end.x - ux * head + uy * head * 0.55, y: end.y - uy * head - ux * head * 0.55 };
      const shaft = `M ${start.x} ${start.y} L ${end.x - ux * head * 0.6} ${end.y - uy * head * 0.6}`;
      const tip = `M ${left.x} ${left.y} L ${end.x} ${end.y} L ${right.x} ${right.y} Z`;
      arrow = (
        <g>
          <path d={shaft} stroke="rgba(0,0,0,0.45)" strokeWidth={3.5 / zoom} strokeLinecap="round" />
          <path
            d={tip}
            fill="rgba(0,0,0,0.45)"
            stroke="rgba(0,0,0,0.45)"
            strokeWidth={2 / zoom}
            strokeLinejoin="round"
          />
          <path d={shaft} stroke="white" strokeWidth={1.5 / zoom} strokeLinecap="round" />
          <path d={tip} fill="white" />
        </g>
      );
    }
  }

  return (
    <svg className="absolute inset-0 w-full h-full overflow-visible pointer-events-none">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">
          <rect x="-100000" y="-100000" width="200000" height="200000" fill="white" />
          {paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke="black"
              strokeWidth={p.width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </mask>
      </defs>
      {outline}
      {arrow}
      {offset && (
        <g
          transform={`translate(${offset.x} ${offset.y})`}
          className="pointer-events-auto"
          style={{ cursor: dragSource ? 'grabbing' : 'move' }}
          onPointerDown={handlePointerDown}
          data-tooltip={dragSource ? undefined : tooltip}
          opacity={isLoading && !dragSource ? 0.7 : 1}
        >
          {outline}
          {paths.map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill="none"
              stroke="transparent"
              strokeWidth={Math.max(p.width, 16 / zoom)}
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="stroke"
            />
          ))}
        </g>
      )}
    </svg>
  );
}
