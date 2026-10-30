import React, { useRef } from 'react';
import { RotateCw } from 'lucide-react';
import clsx from 'clsx';
import { MAX_FINE_ROTATION } from '../../../../utils/cropUtils';
import { FINE_ADJUSTMENT_MULTIPLIER, hasFineAdjustmentModifier } from '../../../ui/Slider';

const HANDLE_INSET = 10;
const MIN_CROP_SIZE = 96;

const CORNERS: Array<React.CSSProperties> = [
  { top: HANDLE_INSET, left: HANDLE_INSET },
  { top: HANDLE_INSET, right: HANDLE_INSET },
  { bottom: HANDLE_INSET, right: HANDLE_INSET },
  { bottom: HANDLE_INSET, left: HANDLE_INSET },
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
    <div
      ref={containerRef}
      className={clsx('absolute inset-0 pointer-events-none', isTooSmall && 'invisible')}
      style={{ zIndex: 60 }}
    >
      {CORNERS.map((position, index) => (
        <div
          key={index}
          className="absolute w-6 h-6 rounded-full flex items-center justify-center bg-black/50 border border-white/70 text-white opacity-70 hover:opacity-100 transition-opacity pointer-events-auto cursor-grab active:cursor-grabbing touch-none"
          style={position}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          <RotateCw size={12} />
        </div>
      ))}
    </div>
  );
}
