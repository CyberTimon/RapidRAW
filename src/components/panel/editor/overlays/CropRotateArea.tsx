import React, { useEffect, useRef } from 'react';
import { MAX_FINE_ROTATION } from '../../../../utils/cropUtils';
import { FINE_ADJUSTMENT_MULTIPLIER, hasFineAdjustmentModifier } from '../../../../utils/fineAdjustment';

const CURSOR_STEP = 45;
const ROTATE_BAND = 40;
const CROP_SELECTION_SELECTOR = '.ReactCrop__crop-selection';

const rotateCursor = (angle: number) => {
  const arrow = 'M6 17A11 11 0 0 1 17 6M3 14L6 18L9 14M14 3L18 6L14 9';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${angle} 12 12)"><path d="${arrow}" stroke="black" stroke-width="4"/><path d="${arrow}" stroke="white" stroke-width="2"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
};

const ROTATE_CURSORS = Array.from({ length: 360 / CURSOR_STEP }, (_, i) => rotateCursor(i * CURSOR_STEP));

interface CropRotateAreaProps {
  enabled: boolean;
  rotation: number;
  onRotate(rotation: number): void;
  onRotateEnd(rotation: number | null): void;
  children: React.ReactNode;
}

interface Point {
  x: number;
  y: number;
}

interface RotateDrag {
  pointerId: number;
  pivot: Point;
  lastAngle: number;
  angleDelta: number;
  startRotation: number;
  rotation: number | null;
}

const isOnCropSelection = (target: EventTarget) =>
  target instanceof Element && !!target.closest(CROP_SELECTION_SELECTOR);

const angleAround = (pivot: Point, e: React.PointerEvent) =>
  (Math.atan2(e.clientY - pivot.y, e.clientX - pivot.x) * 180) / Math.PI;

const centerOf = (rect: DOMRect): Point => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

const isInRotateZone = (e: React.PointerEvent, selection: DOMRect) => {
  if (!(e.target instanceof Element) || !e.target.closest('.ReactCrop')) return true;
  const dx = Math.max(selection.left - e.clientX, 0, e.clientX - selection.right);
  const dy = Math.max(selection.top - e.clientY, 0, e.clientY - selection.bottom);
  return Math.hypot(dx, dy) <= ROTATE_BAND;
};

export default function CropRotateArea({ enabled, rotation, onRotate, onRotateEnd, children }: CropRotateAreaProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<RotateDrag | null>(null);

  const getSelectionRect = () =>
    areaRef.current?.querySelector(CROP_SELECTION_SELECTOR)?.getBoundingClientRect() ?? null;

  const setCursor = (cursor: string) => {
    if (areaRef.current && areaRef.current.style.cursor !== cursor) {
      areaRef.current.style.cursor = cursor;
    }
  };

  const setRotateCursor = (e: React.PointerEvent<HTMLDivElement>, pivot: Point) => {
    const index = Math.round((angleAround(pivot, e) + 135) / CURSOR_STEP);
    setCursor(ROTATE_CURSORS[((index % ROTATE_CURSORS.length) + ROTATE_CURSORS.length) % ROTATE_CURSORS.length]);
  };

  useEffect(() => {
    if (!enabled) return;
    const area = areaRef.current;
    return () => {
      if (area) area.style.cursor = '';
      if (!dragRef.current) return;
      dragRef.current = null;
      onRotateEnd(null);
    };
  }, [enabled, onRotateEnd]);

  const handlePointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || e.button !== 0) return;
    if (dragRef.current) {
      e.stopPropagation();
      return;
    }
    if (isOnCropSelection(e.target)) return;
    const selection = getSelectionRect();
    if (!selection || !isInRotateZone(e, selection)) return;
    const pivot = centerOf(selection);
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      pivot,
      lastAngle: angleAround(pivot, e),
      angleDelta: 0,
      startRotation: rotation,
      rotation: null,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const drag = dragRef.current;
    if (!drag) {
      if (e.buttons !== 0) return;
      const selection = isOnCropSelection(e.target) ? null : getSelectionRect();
      if (!selection) setCursor('');
      else if (isInRotateZone(e, selection)) setRotateCursor(e, centerOf(selection));
      else setCursor('crosshair');
      return;
    }
    if (drag.pointerId !== e.pointerId) return;
    setRotateCursor(e, drag.pivot);

    const angle = angleAround(drag.pivot, e);
    let step = angle - drag.lastAngle;
    if (step > 180) step -= 360;
    if (step < -180) step += 360;
    drag.lastAngle = angle;
    drag.angleDelta += hasFineAdjustmentModifier(e) ? step * FINE_ADJUSTMENT_MULTIPLIER : step;

    const next = Math.max(-MAX_FINE_ROTATION, Math.min(MAX_FINE_ROTATION, drag.startRotation + drag.angleDelta));
    const rounded = Math.round(next * 10) / 10;
    if (rounded === (drag.rotation ?? drag.startRotation)) return;

    drag.rotation = rounded;
    onRotate(rounded);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    onRotateEnd(drag.rotation);
  };

  return (
    <div
      ref={areaRef}
      className="absolute inset-0 touch-none select-none"
      data-crop-rotate={enabled || undefined}
      style={{ pointerEvents: enabled ? 'auto' : 'none' }}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
    >
      {children}
    </div>
  );
}
