import { AppSettings, TransformState } from '../components/ui/AppProperties';

const SHARPNESS_FACTOR = 1.25;

export interface ViewportImageSize {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  containerWidth: number;
  containerHeight: number;
}

export const getVisibleImageRegion = (
  { positionX, positionY, scale }: TransformState,
  { width, height, offsetX, offsetY, containerWidth, containerHeight }: ViewportImageSize,
  padding: number = 0,
): [number, number, number, number] | null => {
  if (!width || !height || !containerWidth || !containerHeight || !scale) return null;

  const visibleLeft = -positionX / scale;
  const visibleTop = -positionY / scale;
  const left = Math.max(visibleLeft - padding, offsetX);
  const top = Math.max(visibleTop - padding, offsetY);
  const right = Math.min(visibleLeft + containerWidth / scale + padding, offsetX + width);
  const bottom = Math.min(visibleTop + containerHeight / scale + padding, offsetY + height);

  if (left >= right || top >= bottom) return null;

  return [(left - offsetX) / width, (top - offsetY) / height, (right - left) / width, (bottom - top) / height];
};

export const calculateTargetResolution = (
  settings: AppSettings | null | undefined,
  displayMax: number,
  effectiveDpr: number,
  originalMax: number,
) => {
  const baseTargetRes = settings?.editorPreviewResolution || 1920;
  if (!(settings?.enableZoomHifi ?? true) || displayMax === 0) {
    return baseTargetRes;
  }

  const zoomMultiplier = settings?.highResZoomMultiplier || 1.0;
  let targetRes = Math.max(displayMax * effectiveDpr * SHARPNESS_FACTOR * zoomMultiplier, 512);

  if (originalMax > 0) {
    targetRes = Math.min(targetRes, originalMax);
    if (targetRes >= originalMax * 0.8) {
      targetRes = originalMax;
    }
  }

  if (targetRes !== originalMax) {
    targetRes = Math.ceil(targetRes / 256) * 256;
  }

  return Math.round(targetRes);
};
