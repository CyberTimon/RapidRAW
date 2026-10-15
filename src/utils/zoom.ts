// Zoom percentages are physical: 1.0 means one image pixel per device pixel.
// The editor draws the (cropped, oriented) image fitted to its container at
// `renderScale` CSS px per image px, then applies a transform scale on top.

// Lowest editor zoom, as a fraction of the original image's physical pixels.
export const MIN_ZOOM_PERCENT = 0.01;
export const MAX_ZOOM_PERCENT = 2.0;

export interface Size {
  width: number;
  height: number;
}

export const getDpr = (): number => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

export const clampZoomPercent = (percent: number): number =>
  Math.max(MIN_ZOOM_PERCENT, Math.min(MAX_ZOOM_PERCENT, percent));

export const percentFromTransform = (renderScale: number, transformScale: number, dpr: number): number =>
  renderScale * transformScale * dpr;

export const transformFromPercent = (percent: number, renderScale: number, dpr: number): number =>
  clampZoomPercent(percent) / (renderScale * dpr);

export const fitPercent = (renderScale: number, dpr: number): number => renderScale * dpr;

// Below 20%, fixed 10% steps would overshoot, so step proportionally
export const stepZoomIn = (percent: number): number => clampZoomPercent(percent < 0.2 ? percent * 1.2 : percent + 0.1);

export const stepZoomOut = (percent: number): number =>
  clampZoomPercent(percent <= 0.2 ? percent / 1.2 : percent - 0.1);

// The image size the editor actually displays: the crop if set, otherwise the
// original with width/height swapped for 90° orientation steps.
export const zoomReferenceSize = (originalSize: Size, orientationSteps: number, crop?: Size | null): Size => {
  if (crop) {
    return { width: crop.width, height: crop.height };
  }
  const isSwapped = orientationSteps === 1 || orientationSteps === 3;
  return isSwapped
    ? { width: originalSize.height, height: originalSize.width }
    : { width: originalSize.width, height: originalSize.height };
};
