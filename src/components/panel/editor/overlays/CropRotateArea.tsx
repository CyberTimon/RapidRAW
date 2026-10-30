import React, { useRef } from 'react';
import { Crop } from 'react-image-crop';
import { MAX_FINE_ROTATION } from '../../../../utils/cropUtils';
import { FINE_ADJUSTMENT_MULTIPLIER, hasFineAdjustmentModifier } from '../../../ui/Slider';

export const CROP_ROTATE_MARGIN = 40;

const BAND_EXTENT = 10000;
const CURSOR_STEP = 45;

const rotateCursor = (angle: number) => {
  const arrow = 'M6 17A11 11 0 0 1 17 6M3 14L6 18L9 14M14 3L18 6L14 9';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(${angle} 12 12)"><path d="${arrow}" stroke="black" stroke-width="4"/><path d="${arrow}" stroke="white" stroke-width="2"/></g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, grab`;
};

const ROTATE_CURSORS = Array.from({ length: 360 / CURSOR_STEP }, (_, i) => rotateCursor(i * CURSOR_STEP));

const BANDS: Array<React.CSSProperties> = [
  { left: -BAND_EXTENT, right: -BAND_EXTENT, bottom: '100%', height: BAND_EXTENT, cursor: ROTATE_CURSORS[1] },
  { left: -BAND_EXTENT, right: -BAND_EXTENT, top: '100%', height: BAND_EXTENT, cursor: ROTATE_CURSORS[5] },
  { top: 0, bottom: 0, right: '100%', width: BAND_EXTENT, cursor: ROTATE_CURSORS[7] },
  { top: 0, bottom: 0, left: '100%', width: BAND_EXTENT, cursor: ROTATE_CURSORS[3] },
];

interface CropRotateAreaProps {
  crop: Crop | null;
  rotation: number;
  onRotate(rotation: number): void;
  onRotateEnd(rotation: number | null): void;
}

interface RotateDrag {
  lastAngle: number;
  angleDelta: number;
  startRotation: number;
  rotation: number | null;
}

export default function CropRotateArea({ crop, rotation, onRotate, onRotateEnd }: CropRotateAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<RotateDrag | null>(null);

  const pointerAngle = (e: React.PointerEvent, container: HTMLDivElement) => {
    const rect = container.getBoundingClientRect();
    const scaleX = crop?.unit === '%' ? rect.width / 100 : 1;
    const scaleY = crop?.unit === '%' ? rect.height / 100 : 1;
    const centerX = crop ? (crop.x + crop.width / 2) * scaleX : rect.width / 2;
    const centerY = crop ? (crop.y + crop.height / 2) * scaleY : rect.height / 2;
    const dx = e.clientX - (rect.left + centerX);
    const dy = e.clientY - (rect.top + centerY);
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  };

  const updateCursor = (e: React.PointerEvent<HTMLDivElement>, angle: number) => {
    const index = Math.round((angle + 135) / CURSOR_STEP);
    const cursor = ROTATE_CURSORS[((index % ROTATE_CURSORS.length) + ROTATE_CURSORS.length) % ROTATE_CURSORS.length];
    if (e.currentTarget.style.cursor !== cursor) {
      e.currentTarget.style.cursor = cursor;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !containerRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      lastAngle: pointerAngle(e, containerRef.current),
      angleDelta: 0,
      startRotation: rotation,
      rotation: null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const angle = pointerAngle(e, containerRef.current);
    updateCursor(e, angle);

    const drag = dragRef.current;
    if (!drag) return;

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
    <div ref={containerRef} className="absolute inset-0 pointer-events-none">
      {BANDS.map((position, index) => (
        <div
          key={index}
          className="absolute pointer-events-auto touch-none"
          style={position}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      ))}
    </div>
  );
}
