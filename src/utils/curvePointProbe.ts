import type { Coord } from './adjustments';
/** Keep coverage independent of the dragged ordinate, but follow its input position. */
export function curvePointProbe(points: readonly Coord[] | undefined, index: number) {
  if (
    !points ||
    points.length < 2 ||
    points.length > 16 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= points.length
  )
    return null;
  const baseline = points.map((p) => ({ ...p }));
  const point = baseline[index],
    left = baseline[index - 1],
    right = baseline[index + 1];
  const neutral =
    left && right
      ? left.y + ((right.y - left.y) * (point.x - left.x)) / Math.max(right.x - left.x, 0.01)
      : index === 0
        ? 0
        : 255;
  point.y = Math.max(0, Math.min(255, neutral));
  const coverage = baseline.map((p) => ({ ...p }));
  coverage[index].y = Math.max(0, Math.min(255, point.y + (point.y > 127.5 ? -40 : 40)));
  return { baseline, coverage };
}
