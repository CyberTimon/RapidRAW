import { Quad } from '../../types/video';

export type Homography = [number, number, number, number, number, number, number, number, number];

const SINGULAR = 1e-12;
const SNAP_PX = 10;
const SNAP_REACH = 8;

const squareToQuad = ([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]: Quad): Homography | null => {
  const [dx1, dy1, dx2, dy2] = [x1 - x2, y1 - y2, x3 - x2, y3 - y2];
  const [dx3, dy3] = [x0 - x1 + x2 - x3, y0 - y1 + y2 - y3];
  const determinant = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(determinant) < SINGULAR) return null;
  const g = (dx3 * dy2 - dx2 * dy3) / determinant;
  const h = (dx1 * dy3 - dx3 * dy1) / determinant;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
};

const chain = (first: Homography, next: Homography): Homography =>
  Array.from({ length: 9 }, (_, index) => {
    const [row, column] = [Math.floor(index / 3), index % 3];
    return [0, 1, 2].reduce((sum, k) => sum + next[row * 3 + k] * first[k * 3 + column], 0);
  }) as Homography;

const determinantOf = (m: Homography) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);

export const invert = (m: Homography): Homography | null => {
  const cofactors = [
    m[4] * m[8] - m[5] * m[7],
    m[2] * m[7] - m[1] * m[8],
    m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8],
    m[0] * m[8] - m[2] * m[6],
    m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6],
    m[1] * m[6] - m[0] * m[7],
    m[0] * m[4] - m[1] * m[3],
  ];
  const determinant = determinantOf(m);
  return Math.abs(determinant) < SINGULAR ? null : (cofactors.map((value) => value / determinant) as Homography);
};

export const project = (m: Homography, x: number, y: number): [number, number] | null => {
  const depth = m[6] * x + m[7] * y + m[8];
  if (Math.abs(depth) < SINGULAR) return null;
  return [(m[0] * x + m[1] * y + m[2]) / depth, (m[3] * x + m[4] * y + m[5]) / depth];
};

export const localScale = (m: Homography, x: number, y: number) => {
  const depth = Math.abs(m[6] * x + m[7] * y + m[8]);
  return depth < SINGULAR ? 1 : Math.sqrt(Math.abs(determinantOf(m)) / depth ** 3);
};

export const mapQuad = (m: Homography, quad: Quad): Quad | null => {
  const mapped = quad.map(([x, y]) => project(m, x, y));
  return mapped.every((point) => point) ? (mapped as Quad) : null;
};

export const quadToQuad = (from: Quad, to: Quad): Homography | null => {
  const source = squareToQuad(from);
  const target = squareToQuad(to);
  const inverse = source && invert(source);
  return inverse && target ? chain(inverse, target) : null;
};

export const scaleQuad = (quad: Quad, sx: number, sy: number): Quad => quad.map(([x, y]) => [x * sx, y * sy]) as Quad;

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const boundsQuad = ({ left, top, right, bottom }: Bounds): Quad => [
  [left, top],
  [right, top],
  [right, bottom],
  [left, bottom],
];

export const quadBounds = (quad: Array<[number, number]>): Bounds => ({
  left: Math.min(...quad.map(([x]) => x)),
  top: Math.min(...quad.map(([, y]) => y)),
  right: Math.max(...quad.map(([x]) => x)),
  bottom: Math.max(...quad.map(([, y]) => y)),
});

export const isConvex = (quad: Quad) => {
  const turns = quad.map((a, index) => {
    const b = quad[(index + 1) % 4];
    const c = quad[(index + 2) % 4];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  });
  return turns.every((turn) => turn > 1e-9) || turns.every((turn) => turn < -1e-9);
};

export const snapCorner = (quad: Quad, corner: number, snaps: Array<[number, number]>, screenScale: number) => {
  const [x, y] = quad[corner];
  const reach = Math.min(SNAP_PX / screenScale, SNAP_REACH);
  const nearest = snaps.reduce<{ point: [number, number]; distance: number } | null>((best, point) => {
    const distance = Math.hypot(point[0] - x, point[1] - y);
    return distance <= reach && (!best || distance < best.distance) ? { point, distance } : best;
  }, null);
  if (!nearest) return null;
  const next = quad.map((point, index) => (index === corner ? nearest.point : point)) as Quad;
  return isConvex(next) ? next : null;
};

export const quadCenter = (quad: Quad): [number, number] => {
  const map = squareToQuad(quad);
  return (
    (map && project(map, 0.5, 0.5)) ?? [
      quad.reduce((sum, [x]) => sum + x, 0) / 4,
      quad.reduce((sum, [, y]) => sum + y, 0) / 4,
    ]
  );
};

export const quadArea = (quad: Quad) =>
  Math.abs(
    quad.reduce((sum, [x, y], index) => {
      const [nx, ny] = quad[(index + 1) % 4];
      return sum + x * ny - nx * y;
    }, 0),
  ) / 2;

export const quadAngle = (quad: Quad) => {
  const left = [(quad[0][0] + quad[3][0]) / 2, (quad[0][1] + quad[3][1]) / 2];
  const right = [(quad[1][0] + quad[2][0]) / 2, (quad[1][1] + quad[2][1]) / 2];
  return Math.atan2(right[1] - left[1], right[0] - left[0]);
};
