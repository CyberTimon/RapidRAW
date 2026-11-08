import { AppSettings } from '../components/ui/AppProperties';

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const TRACKPAD_ZOOM_BOOST = 5;
const MIN_CLICK_ZOOM = 1.05;
const CLICK_SLOP_PX = 5;

export type WheelGesture = { kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number };

export const interpretWheel = (
  event: WheelEvent,
  zoomSpeedMultiplier: number | undefined,
  canvasInputMode: AppSettings['canvasInputMode'],
): WheelGesture => {
  const isTrackpad = canvasInputMode === 'trackpad';
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (event.ctrlKey || (!isTrackpad && !event.shiftKey && !event.altKey)) {
    const inputBoost = isTrackpad ? TRACKPAD_ZOOM_BOOST : 1;
    return {
      kind: 'zoom',
      factor: Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY * (zoomSpeedMultiplier ?? 1) * inputBoost),
    };
  }
  if (isTrackpad) {
    return { kind: 'pan', dx: event.deltaX, dy: event.deltaY };
  }
  return { kind: 'pan', dx: event.shiftKey ? delta : 0, dy: event.altKey ? delta : 0 };
};

export const clickZoomTarget = (
  currentScale: number,
  maxScale: number,
  actualPixelsScale: number,
  savedScale: number | null,
  zoomToActualPixels: boolean | undefined,
) =>
  zoomToActualPixels
    ? Math.max(MIN_CLICK_ZOOM, Math.min(actualPixelsScale, maxScale))
    : (savedScale ?? Math.min(currentScale * 2, maxScale));

export const movedBeyondClick = (start: { x: number; y: number }, x: number, y: number) =>
  Math.abs(x - start.x) > CLICK_SLOP_PX || Math.abs(y - start.y) > CLICK_SLOP_PX;
