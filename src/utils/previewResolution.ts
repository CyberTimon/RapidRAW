import { AppSettings } from '../components/ui/AppProperties';

const SHARPNESS_FACTOR = 1.25;

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
