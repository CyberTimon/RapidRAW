import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  Size,
  clampZoomPercent,
  fitPercent,
  percentFromTransform,
  stepZoomIn,
  stepZoomOut,
  transformFromPercent,
  zoomReferenceSize,
} from './zoom';

interface Monitor {
  name: string;
  physical: Size;
  dpr: number;
}

const MONITORS: Monitor[] = [
  { name: 'Laptop HD', physical: { width: 1366, height: 768 }, dpr: 1 },
  { name: 'FHD', physical: { width: 1920, height: 1080 }, dpr: 1 },
  { name: 'FHD Windows 125%', physical: { width: 1920, height: 1080 }, dpr: 1.25 },
  { name: 'QHD 27"', physical: { width: 2560, height: 1440 }, dpr: 1 },
  { name: 'Ultrawide', physical: { width: 3440, height: 1440 }, dpr: 1 },
  { name: '4K 150%', physical: { width: 3840, height: 2160 }, dpr: 1.5 },
  { name: '4K 200%', physical: { width: 3840, height: 2160 }, dpr: 2 },
  { name: '5K Retina', physical: { width: 5120, height: 2880 }, dpr: 2 },
  { name: 'GNOME X11 fractional (render @2)', physical: { width: 3840, height: 2160 }, dpr: 2 },
];

const IMAGES: { name: string; size: Size }[] = [
  { name: 'landscape 6000x4000', size: { width: 6000, height: 4000 } },
  { name: 'portrait scan 8522x12876', size: { width: 8522, height: 12876 } },
  { name: 'square 4000x4000', size: { width: 4000, height: 4000 } },
  { name: 'small 800x600', size: { width: 800, height: 600 } },
];

interface EditState {
  name: string;
  orientationSteps: number;
  crop: (s: Size) => Size | null;
}

const EDITS: EditState[] = [
  { name: 'no edits', orientationSteps: 0, crop: () => null },
  { name: 'rotated 90°', orientationSteps: 1, crop: () => null },
  { name: 'rotated 270°', orientationSteps: 3, crop: () => null },
  { name: 'crop 50%', orientationSteps: 0, crop: (s) => ({ width: s.width / 2, height: s.height / 2 }) },
  // Crop coordinates live in oriented space
  { name: 'crop 50% + rotated', orientationSteps: 1, crop: (s) => ({ width: s.height / 2, height: s.width / 2 }) },
  {
    name: 'portrait crop',
    orientationSteps: 0,
    crop: (s) => ({ width: Math.min(s.width, s.height) * 0.6, height: Math.min(s.width, s.height) * 0.75 }),
  },
];

// Approximate editor container: CSS viewport minus side panel and bottom bar
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 250;

const containerFor = (m: Monitor): Size => ({
  width: m.physical.width / m.dpr - PANEL_WIDTH,
  height: m.physical.height / m.dpr - PANEL_HEIGHT,
});

// Same fit computation as useImageRenderSize
const fitRenderScale = (container: Size, image: Size): number => {
  const imageAspect = image.width / image.height;
  const containerAspect = container.width / container.height;
  return imageAspect > containerAspect ? container.width / image.width : container.height / image.height;
};

const PERCENTS = [MIN_ZOOM_PERCENT, 0.1, 0.25, 0.5, 1, MAX_ZOOM_PERCENT];

const cases = MONITORS.flatMap((monitor) =>
  IMAGES.flatMap((image) =>
    EDITS.map((edit) => {
      const reference = zoomReferenceSize(image.size, edit.orientationSteps, edit.crop(image.size));
      const renderScale = fitRenderScale(containerFor(monitor), reference);
      return { monitor, image, edit, reference, renderScale };
    }),
  ),
);

describe.each(cases)('$monitor.name / $image.name / $edit.name', ({ monitor, image, renderScale }) => {
  const { dpr } = monitor;

  it('100% maps one image pixel to one device pixel', () => {
    const transform = transformFromPercent(1, renderScale, dpr);
    expect(renderScale * transform * dpr).toBeCloseTo(1, 10);
  });

  it.each(PERCENTS)('round-trips %f', (p) => {
    const transform = transformFromPercent(p, renderScale, dpr);
    expect(percentFromTransform(renderScale, transform, dpr)).toBeCloseTo(p, 10);
  });

  it('fit is transform scale 1', () => {
    expect(percentFromTransform(renderScale, 1, dpr)).toBeCloseTo(fitPercent(renderScale, dpr), 10);
    if (image.size.width === 800 && monitor.name === 'QHD 27"') {
      expect(fitPercent(renderScale, dpr)).toBeGreaterThan(1);
    }
  });

  it('clamps to physical limits regardless of DPR', () => {
    expect(percentFromTransform(renderScale, transformFromPercent(10, renderScale, dpr), dpr)).toBeCloseTo(
      MAX_ZOOM_PERCENT,
      10,
    );
    expect(percentFromTransform(renderScale, transformFromPercent(0, renderScale, dpr), dpr)).toBeCloseTo(
      MIN_ZOOM_PERCENT,
      10,
    );
  });
});

describe('crop and rotation do not change 1:1 magnification', () => {
  it.each(MONITORS)('$name', (monitor) => {
    for (const image of IMAGES) {
      for (const edit of EDITS) {
        const reference = zoomReferenceSize(image.size, edit.orientationSteps, edit.crop(image.size));
        const renderScale = fitRenderScale(containerFor(monitor), reference);
        const transform = transformFromPercent(1, renderScale, monitor.dpr);
        // CSS px per image px must be 1/dpr for every edit state
        expect(renderScale * transform).toBeCloseTo(1 / monitor.dpr, 10);
      }
    }
  });
});

describe('zoomReferenceSize', () => {
  const original = { width: 6000, height: 4000 };

  it.each([0, 1, 2, 3])('orientation %i', (steps) => {
    const swapped = steps === 1 || steps === 3;
    expect(zoomReferenceSize(original, steps)).toEqual(
      swapped ? { width: 4000, height: 6000 } : { width: 6000, height: 4000 },
    );
  });

  it('prefers the crop', () => {
    expect(zoomReferenceSize(original, 1, { width: 1000, height: 500 })).toEqual({ width: 1000, height: 500 });
  });
});

describe('steps', () => {
  const samples = [MIN_ZOOM_PERCENT, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 1, 1.5, 1.95, MAX_ZOOM_PERCENT];

  it.each(samples)('stay in bounds and are monotonic from %f', (p) => {
    const up = stepZoomIn(p);
    const down = stepZoomOut(p);
    expect(up).toBeGreaterThanOrEqual(p);
    expect(down).toBeLessThanOrEqual(p);
    expect(up).toBeLessThanOrEqual(MAX_ZOOM_PERCENT);
    expect(down).toBeGreaterThanOrEqual(MIN_ZOOM_PERCENT);
  });

  it('steps proportionally below 20%', () => {
    expect(stepZoomIn(0.05)).toBeCloseTo(0.06, 10);
    expect(stepZoomOut(0.06)).toBeCloseTo(0.05, 10);
  });

  it('steps by 10 points above 20%', () => {
    expect(stepZoomIn(0.5)).toBeCloseTo(0.6, 10);
    expect(stepZoomOut(0.6)).toBeCloseTo(0.5, 10);
  });

  // Values within one step of the limits get clamped, so they can't round-trip
  const unclamped = samples.filter((p) => p > MIN_ZOOM_PERCENT && p + 0.1 <= MAX_ZOOM_PERCENT);

  it.each(unclamped)('zoom in then out returns near %f', (p) => {
    expect(stepZoomOut(stepZoomIn(p))).toBeCloseTo(p, 2);
  });

  it('clamp', () => {
    expect(clampZoomPercent(5)).toBe(MAX_ZOOM_PERCENT);
    expect(clampZoomPercent(-1)).toBe(MIN_ZOOM_PERCENT);
  });
});

// The previous implementation measured zoom against the uncropped, unrotated
// original. These document the observed errors so the bug can't come back silently.
describe('regression: old formulas', () => {
  const monitor = MONITORS.find((m) => m.name === 'QHD 27"')!;
  const container = containerFor(monitor);

  const oldTransformFor100 = (original: Size, steps: number, reference: Size, renderScale: number) => {
    const swapped = steps === 1 || steps === 3;
    const effW = swapped ? original.height : original.width;
    const effH = swapped ? original.width : original.height;
    const baseW = reference.width * renderScale;
    const baseH = reference.height * renderScale;
    const target = 1 / monitor.dpr;
    return effW / effH > baseW / baseH ? (target * effW) / baseW : (target * effH) / baseH;
  };
  const oldReadout = (original: Size, reference: Size, renderScale: number, transform: number) =>
    (reference.width * renderScale * transform * monitor.dpr) / original.width;

  it('rotated 3:2 image read ~67% right after typing 100', () => {
    const original = { width: 6000, height: 4000 };
    const reference = zoomReferenceSize(original, 1);
    const renderScale = fitRenderScale(container, reference);
    const transform = oldTransformFor100(original, 1, reference, renderScale);
    expect(oldReadout(original, reference, renderScale, transform)).toBeCloseTo(4000 / 6000, 5);
    expect(percentFromTransform(renderScale, transformFromPercent(1, renderScale, 1), 1)).toBeCloseTo(1, 10);
  });

  it('cropped image was magnified by origW/cropW at "100%"', () => {
    const original = { width: 6000, height: 4000 };
    const crop = { width: 3000, height: 2000 };
    const reference = zoomReferenceSize(original, 0, crop);
    const renderScale = fitRenderScale(container, reference);
    const transform = oldTransformFor100(original, 0, reference, renderScale);
    const actualMagnification = renderScale * transform * monitor.dpr;
    expect(actualMagnification).toBeCloseTo(original.width / crop.width, 5);
    // ...while the old readout claimed 100%
    expect(oldReadout(original, reference, renderScale, transform)).toBeCloseTo(1, 5);
  });
});
