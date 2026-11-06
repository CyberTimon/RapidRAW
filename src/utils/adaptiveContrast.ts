import { Coord, ParametricCurveSettings } from './adjustments';

export const ADAPTIVE_CONTRAST_STRENGTH = 0.25;
const SHOULDER_GAIN = 0.22;
const MIN_FULCRUM = 16;
const MAX_FULCRUM = 239;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const isIdentityCurve = (points: Array<Coord> | undefined): boolean => {
  if (!points || points.length < 2) return false;
  const first = points[0];
  const last = points[points.length - 1];
  if (first.x > 0.5 || first.y > 0.5 || last.x < 254.5 || last.y < 254.5) return false;
  return points.every((point) => Math.abs(point.x - point.y) <= 0.5);
};

export const contrastFulcrum = (median: number) => clamp(median, MIN_FULCRUM, MAX_FULCRUM);

export const buildAdaptivePointCurve = (median: number, strength = ADAPTIVE_CONTRAST_STRENGTH): Array<Coord> => {
  const fulcrum = contrastFulcrum(median);
  const shadowX = fulcrum * 0.5;
  const highlightX = fulcrum + (255 - fulcrum) * 0.5;
  const shadowY = shadowX - strength * SHOULDER_GAIN * fulcrum;
  const highlightY = highlightX + strength * SHOULDER_GAIN * (255 - fulcrum);
  return [
    { x: 0, y: 0 },
    { x: shadowX, y: clamp(shadowY, 0, fulcrum) },
    { x: fulcrum, y: fulcrum },
    { x: highlightX, y: clamp(highlightY, fulcrum, 255) },
    { x: 255, y: 255 },
  ];
};

export const buildAnchoredPointCurve = (median: number): Array<Coord> => {
  const fulcrum = contrastFulcrum(median);
  return [
    { x: 0, y: 0 },
    { x: fulcrum, y: fulcrum },
    { x: 255, y: 255 },
  ];
};

const medianSplits = (median: number) => {
  const split2 = clamp(Math.round((contrastFulcrum(median) / 255) * 100), 20, 80);
  const split1 = Math.max(10, Math.min(split2 - 10, Math.round(split2 / 2)));
  const split3 = Math.min(90, Math.max(split2 + 10, Math.round((split2 + 100) / 2)));
  return { split1, split2, split3 };
};

export const adaptiveParametricSettings = (
  current: ParametricCurveSettings,
  median: number,
  amount = 25,
): ParametricCurveSettings => ({
  ...current,
  ...medianSplits(median),
  lights: amount,
  darks: -amount,
});

export const anchorParametricSettings = (
  current: ParametricCurveSettings,
  median: number,
): ParametricCurveSettings => ({
  ...current,
  ...medianSplits(median),
});
