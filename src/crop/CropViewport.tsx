import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Crop, PercentCrop } from 'react-image-crop';
import { useTranslation } from 'react-i18next';
import { HANDLES, type Handle } from './geometry';
import { useCropGesture } from './useCropGesture';
import { executeCommand } from '../shortcuts/runtime';
import CompositionOverlays from '../components/panel/editor/overlays/CompositionOverlays';
import type { OverlayMode } from './overlays';

interface Props {
  crop: Crop | null;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  rotation: number;
  aspect: number | null;
  movePhoto: boolean;
  onChange(pixel: Crop, percent: PercentCrop): void;
  onComplete(pixel: Crop, percent: PercentCrop): void;
  children: ReactNode;
  overlay: OverlayMode;
  overlayRotation: number;
  dense: boolean;
  disabled: boolean;
}
export default function CropViewport(props: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const crop: PercentCrop = !props.crop
    ? { unit: '%', x: 0, y: 0, width: 100, height: 100 }
    : props.crop.unit === '%'
      ? (props.crop as PercentCrop)
      : {
          unit: '%',
          x: (props.crop.x / props.sourceWidth) * 100,
          y: (props.crop.y / props.sourceHeight) * 100,
          width: (props.crop.width / props.sourceWidth) * 100,
          height: (props.crop.height / props.sourceHeight) * 100,
        };
  const gestures = useCropGesture({ ...props, crop });
  const box = {
    x: (crop.x * props.width) / 100,
    y: (crop.y * props.height) / 100,
    width: (crop.width * props.width) / 100,
    height: (crop.height * props.height) / 100,
  };
  const offset = props.disabled ? { x: 0, y: 0 } : gestures.offset;
  const handlePosition = (handle: Handle): CSSProperties => ({
    left: handle.includes('w') ? 0 : handle.includes('e') ? '100%' : '50%',
    top: handle.includes('n') ? 0 : handle.includes('s') ? '100%' : '50%',
    cursor: `${handle}-resize`,
  });
  return (
    <div
      ref={ref}
      className="relative select-none"
      style={{ width: props.width, height: props.height, touchAction: 'none' }}
      onPointerDown={(event) => {
        if (props.disabled) return;
        const target = event.target as HTMLElement;
        const handle = target.closest<HTMLElement>('[data-crop-handle]')?.dataset.cropHandle as Handle | undefined;
        gestures.begin(event, handle || (target.closest('[data-crop-interior]') ? 'move' : 'rotate'));
      }}
      onPointerMove={gestures.move}
      onPointerUp={gestures.end}
      onPointerCancel={gestures.cancel}
      onLostPointerCapture={gestures.cancel}
    >
      <div
        className="absolute -inset-6"
        style={{ cursor: props.disabled ? undefined : ROTATE_CURSOR }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        {props.children}
      </div>
      <div
        data-crop-interior
        className="absolute"
        style={{
          left: box.x + offset.x,
          top: box.y + offset.y,
          width: box.width,
          height: box.height,
          cursor: props.movePhoto ? 'grab' : 'move',
          outline: '1px solid white',
          boxShadow: '0 0 0 200vmax rgb(0 0 0 / 0.45)',
          pointerEvents: props.disabled ? 'none' : 'auto',
        }}
      >
        <div className="pointer-events-none">
          <CompositionOverlays
            width={box.width}
            height={box.height}
            mode={props.dense ? 'none' : props.overlay}
            rotation={props.overlayRotation}
            denseVisible={props.dense}
          />
        </div>
        {!props.disabled &&
          HANDLES.map((handle) => (
            <button
              key={handle}
              type="button"
              data-crop-handle={handle}
              aria-label={t('shortcuts.cropHandle', { handle })}
              className="absolute z-10 size-5 -translate-x-1/2 -translate-y-1/2 focus-visible:outline-2 focus-visible:outline-white"
              style={handlePosition(handle)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  executeCommand('crop_accept');
                  return;
                }
                if (!event.key.startsWith('Arrow')) return;
                event.stopPropagation();
                event.preventDefault();
                // Handle resizing uses the same geometry as pointer gestures.
                const step = event.shiftKey ? 10 : 1;
                const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
                const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
                resizeFromKeyboard(props, crop, handle, dx, dy, event.altKey);
              }}
            >
              <span className="block mx-auto size-2 bg-white shadow-[0_0_2px_black]" />
            </button>
          ))}
      </div>
    </div>
  );
}

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M7 10a8 8 0 1 1 0 9M7 5v5h5" fill="none" stroke="black" stroke-width="4"/><path d="M7 10a8 8 0 1 1 0 9M7 5v5h5" fill="none" stroke="white" stroke-width="2"/></svg>')}") 14 14, crosshair`;

import { constrainRect, resizeRect } from './geometry';
function resizeFromKeyboard(
  props: Props,
  crop: PercentCrop,
  handle: Handle,
  dx: number,
  dy: number,
  centered: boolean,
) {
  const start = {
    x: (crop.x * props.sourceWidth) / 100,
    y: (crop.y * props.sourceHeight) / 100,
    width: (crop.width * props.sourceWidth) / 100,
    height: (crop.height * props.sourceHeight) / 100,
  };
  const rect = constrainRect(start, resizeRect(start, handle, dx, dy, props.aspect, centered), {
    width: props.sourceWidth,
    height: props.sourceHeight,
    rotation: props.rotation,
    minimum: 64,
  });
  const percent: PercentCrop = {
    unit: '%',
    x: (rect.x / props.sourceWidth) * 100,
    y: (rect.y / props.sourceHeight) * 100,
    width: (rect.width / props.sourceWidth) * 100,
    height: (rect.height / props.sourceHeight) * 100,
  };
  props.onChange({ unit: 'px', ...rect }, percent);
  props.onComplete({ unit: 'px', ...rect }, percent);
}
