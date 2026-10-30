import React, { useRef } from 'react';
import clsx from 'clsx';
import { MAX_FINE_ROTATION } from '../../../../utils/cropUtils';
import { FINE_ADJUSTMENT_MULTIPLIER, hasFineAdjustmentModifier } from '../../../../utils/keyboardUtils';

const ZONE_SIZE = 56;
const ZONE_OFFSET = -ZONE_SIZE / 2;
const MIN_CROP_SIZE = 96;

const rotateCursor = (angle: number) => {
  const arrow = 'M6 17A11 11 0 0 1 17 6M3 14L6 18L9 14M14 3L18 6L14 9';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${angle} 12 12)"><path d="${arrow}" stroke="black" stroke-width="4"/><path d="${arrow}" stroke="white" stroke-width="2"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
};

const CORNERS: Array<React.CSSProperties> = [
  { top: ZONE_OFFSET, left: ZONE_OFFSET, cursor: rotateCursor(0) },
  { top: ZONE_OFFSET, right: ZONE_OFFSET, cursor: rotateCursor(90) },
  { bottom: ZONE_OFFSET, right: ZONE_OFFSET, cursor: rotateCursor(180) },
  { bottom: ZONE_OFFSET, left: ZONE_OFFSET, cursor: rotateCursor(270) },
];

interface CropRotateHandlesProps {
  width: number;
  height: number;
  rotation: number;
  onRotate(rotation: number): void;
  onRotateEnd(rotation: number | null): void;
}

interface RotateDrag {
  centerX: number;
  centerY: number;
  lastAngle: number;
  angleDelta: number;
  startRotation: number;
  rotation: number | null;
}

const pointerAngle = (e: React.PointerEvent, centerX: number, centerY: number) =>
  (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;

export default function CropRotateHandles({ width, height, rotation, onRotate, onRotateEnd }: CropRotateHandlesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<RotateDrag | null>(null);
  const isTooSmall = width < MIN_CROP_SIZE || height < MIN_CROP_SIZE;

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !containerRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    dragRef.current = {
      centerX,
      centerY,
      lastAngle: pointerAngle(e, centerX, centerY),
      angleDelta: 0,
      startRotation: rotation,
      rotation: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;

    const angle = pointerAngle(e, drag.centerX, drag.centerY);
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
    if (!drag) return;

    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onRotateEnd(drag.rotation);
  };

  return (
    <div ref={containerRef} className={clsx('absolute inset-0 pointer-events-none', isTooSmall && 'invisible')}>
      {CORNERS.map((position, index) => (
        <div
          key={index}
          className="absolute pointer-events-auto touch-none"
          style={{ ...position, width: ZONE_SIZE, height: ZONE_SIZE }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      ))}
    </div>
  );
}
