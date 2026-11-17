import { Coord } from './adjustments';

const MIN_FULCRUM = 16;
const MAX_FULCRUM = 239;
const MEDIAN_BAND = 25;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const isIdentityCurve = (points: Array<Coord> | undefined): boolean => {
  if (!points || points.length < 2) return false;
  const first = points[0];
  const last = points[points.length - 1];
  if (first.x > 0.5 || first.y > 0.5 || last.x < 254.5 || last.y < 254.5) return false;
  return points.every((point) => Math.abs(point.x - point.y) <= 0.5);
};

export const contrastFulcrum = (median: number) => clamp(median, MIN_FULCRUM, MAX_FULCRUM);

export const toneMedian = (median: number | null | undefined): number | null => {
  if (typeof median !== 'number' || Number.isNaN(median)) return null;
  return median;
};

const selectionPivots = new Map<string, number>();

/** Keep the selection median from the render where this mask's contrast is still zero. */
export const selectionContrastPivot = (
  key: string,
  contrast: number,
  maskMedian: number | null,
): number | null => {
  const previous = selectionPivots.get(key) ?? null;
  if (contrast !== 0 || maskMedian == null) return previous;
  const next = contrastFulcrum(maskMedian);
  if (previous === next) return previous;
  selectionPivots.set(key, next);
  return next;
};

/** Midtone at the median. The dark and light ranges keep the default width of 25. */
export const medianBandSplits = (median: number) => {
  const split2 = clamp(Math.round((contrastFulcrum(median) / 255) * 100), 20, 80);
  const split1 = clamp(split2 - MEDIAN_BAND, 10, split2 - 10);
  const split3 = clamp(split2 + MEDIAN_BAND, split2 + 10, 90);
  return { split1, split2, split3 };
};

const onDiagonal = (split: number): Coord => {
  const x = (split / 100) * 255;
  return { x, y: x };
};

export const medianBandPoints = (median: number): Array<Coord> => {
  const { split1, split2, split3 } = medianBandSplits(median);
  return [{ x: 0, y: 0 }, onDiagonal(split1), onDiagonal(split2), onDiagonal(split3), { x: 255, y: 255 }];
};

export const medianAnchorPoints = (median: number): Array<Coord> => {
  const x = contrastFulcrum(median);
  return [
    { x: 0, y: 0 },
    { x, y: x },
    { x: 255, y: 255 },
  ];
};
