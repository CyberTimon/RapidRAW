import { AppSettings } from '../components/ui/AppProperties';

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const TRACKPAD_ZOOM_BOOST = 5;

export const wheelZoomFactor = (
  event: WheelEvent,
  zoomSpeedMultiplier: number | undefined,
  canvasInputMode: AppSettings['canvasInputMode'],
) => {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  const inputBoost = canvasInputMode === 'trackpad' ? TRACKPAD_ZOOM_BOOST : 1;
  return Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY * (zoomSpeedMultiplier ?? 1) * inputBoost);
};
