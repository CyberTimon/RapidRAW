import type { Coord } from './adjustments';

export type CurveInterpolation = 'standard' | 'natural';

export function naturalCurveTangents(points: readonly Coord[]): number[] | null {
  const n = points.length;
  if (
    n < 2 ||
    points.some((p, i) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || (i > 0 && p.x <= points[i - 1].x))
  ) {
    return null;
  }
  const h = points.slice(1).map((p, i) => p.x - points[i].x);
  const delta = h.map((width, i) => (points[i + 1].y - points[i].y) / width);
  const diagonal = new Array<number>(n).fill(1);
  const rhs = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    diagonal[i] = 2 * (h[i - 1] + h[i]);
    rhs[i] = 6 * (delta[i] - delta[i - 1]);
  }
  for (let i = 1; i < n - 1; i++) {
    const factor = h[i - 1] / diagonal[i - 1];
    diagonal[i] -= factor * (i === 1 ? 0 : h[i - 1]);
    rhs[i] -= factor * rhs[i - 1];
  }
  const second = new Array<number>(n).fill(0);
  for (let i = n - 2; i > 0; i--) {
    second[i] = (rhs[i] - h[i] * second[i + 1]) / diagonal[i];
  }
  const tangents = h.map((width, i) => delta[i] - (width * (2 * second[i] + second[i + 1])) / 6);
  tangents.push(delta[n - 2] + (h[n - 2] * (second[n - 2] + 2 * second[n - 1])) / 6);
  return tangents.every((m) => Number.isFinite(Math.fround(m))) ? tangents : null;
}

export function evaluateNaturalCurve(points: readonly Coord[], tangents: readonly number[], x: number): number {
  if (x <= points[0].x) return points[0].y;
  if (x >= points[points.length - 1].x) return points[points.length - 1].y;
  const i = points.findIndex((p) => p.x > x) - 1;
  const width = points[i + 1].x - points[i].x;
  const t = (x - points[i].x) / width;
  return (
    (2 * t ** 3 - 3 * t ** 2 + 1) * points[i].y +
    (t ** 3 - 2 * t ** 2 + t) * width * tangents[i] +
    (-2 * t ** 3 + 3 * t ** 2) * points[i + 1].y +
    (t ** 3 - t ** 2) * width * tangents[i + 1]
  );
}

export function naturalCurvePath(points: readonly Coord[]): string | null {
  const tangents = naturalCurveTangents(points);
  if (!tangents) return null;
  const samples = [0, ...points.map((p) => p.x), 255];
  for (let x = 0.5; x < 255; x += 0.5) samples.push(x);
  return [...new Set(samples)]
    .sort((a, b) => a - b)
    .map((x, i) => {
      const y = Math.max(0, Math.min(255, evaluateNaturalCurve(points, tangents, x)));
      return `${i === 0 ? 'M' : 'L'} ${x} ${255 - y}`;
    })
    .join(' ');
}
