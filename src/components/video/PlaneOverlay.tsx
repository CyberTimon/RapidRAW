import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import clsx from 'clsx';
import { Quad } from '../../types/video';
import { isConvex, snapCorner } from '../../utils/video/planar';
import { alignHaptic } from '../../utils/haptics';

const HANDLE = 10;

interface Canvas {
  width: number;
  height: number;
}

interface Drag {
  corner: number | null;
  pointerX: number;
  pointerY: number;
  start: Quad;
  shown: Quad;
}

const points = (quad: Quad) => quad.map(([x, y]) => `${x},${y}`).join(' ');

function Surface({ canvas, unit, children }: { canvas: Canvas; unit: number; children: ReactNode }) {
  return (
    <svg
      className="absolute left-0 top-0 overflow-visible pointer-events-none"
      width={canvas.width * unit}
      height={canvas.height * unit}
      viewBox={`0 0 ${canvas.width} ${canvas.height}`}
    >
      {children}
    </svg>
  );
}

export function PlaneOutline({ quad, canvas, unit, zoom }: { quad: Quad; canvas: Canvas; unit: number; zoom: number }) {
  return (
    <Surface canvas={canvas} unit={unit}>
      <polygon
        points={points(quad)}
        fill="none"
        className="stroke-accent"
        strokeWidth={1.5 / zoom}
        strokeDasharray={`${6 / zoom} ${4 / zoom}`}
        vectorEffect="non-scaling-stroke"
      />
    </Surface>
  );
}

export function QuadEditor({
  quad,
  canvas,
  unit,
  zoom,
  snaps = [],
  variant = 'selected',
  disabled = false,
  onBegin,
  onChange,
}: {
  quad: Quad;
  canvas: Canvas;
  unit: number;
  zoom: number;
  snaps?: Array<[number, number]>;
  variant?: 'placing' | 'selected' | 'idle';
  disabled?: boolean;
  onBegin?(event: ReactPointerEvent): void;
  onChange(quad: Quad): void;
}) {
  const dragRef = useRef<Drag | null>(null);
  const handleSize = HANDLE / zoom;

  const begin = (event: ReactPointerEvent, corner: number | null) => {
    if (event.button !== 0 || disabled) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { corner, pointerX: event.clientX, pointerY: event.clientY, start: quad, shown: quad };
    alignHaptic(dragRef.current);
    onBegin?.(event);
  };

  const move = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (event.clientX - drag.pointerX) / (unit * zoom);
    const dy = (event.clientY - drag.pointerY) / (unit * zoom);
    const next = drag.start.map(([x, y], index) =>
      drag.corner === null || index === drag.corner ? [x + dx, y + dy] : [x, y],
    ) as Quad;
    if (drag.corner !== null && !isConvex(next)) return;
    drag.shown = next;
    onChange(next);
  };

  const snapEnd = (drag: Drag, corner: number) => {
    if (drag.shown === drag.start) return;
    const snapped = snapCorner(drag.shown, corner, snaps, unit * zoom);
    if (!snapped) return;
    alignHaptic(drag, snapped[corner]);
    onChange(snapped);
  };

  const end = (event: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (drag.corner !== null && event.type === 'pointerup' && !event.shiftKey) snapEnd(drag, drag.corner);
  };

  const pointer = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  return (
    <>
      <Surface canvas={canvas} unit={unit}>
        <polygon
          points={points(quad)}
          className={clsx(
            variant === 'idle' ? 'stroke-transparent hover:stroke-white/50' : 'stroke-accent',
            variant === 'placing' ? 'fill-accent/15' : 'fill-transparent',
            !disabled && 'cursor-move',
          )}
          strokeWidth={2 / zoom}
          strokeDasharray={variant === 'placing' ? `${6 / zoom} ${4 / zoom}` : undefined}
          vectorEffect="non-scaling-stroke"
          pointerEvents={disabled ? 'none' : 'all'}
          onPointerDown={(event) => begin(event, null)}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          {...pointer}
        />
      </Surface>
      {!disabled &&
        variant !== 'idle' &&
        quad.map(([x, y], index) => (
          <div
            key={index}
            className="absolute pointer-events-auto rounded-full border border-accent bg-white cursor-crosshair"
            style={{
              left: x * unit - handleSize / 2,
              top: y * unit - handleSize / 2,
              width: handleSize,
              height: handleSize,
            }}
            onPointerDown={(event) => begin(event, index)}
            onMouseDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            {...pointer}
          />
        ))}
    </>
  );
}
