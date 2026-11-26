export interface Point {
  x: number;
  y: number;
}

export interface PenPoint extends Point {
  id: string;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export type Cubic = [Point, Point, Point, Point];

const SMOOTH_TOLERANCE = 0.01;
const NEAREST_SAMPLES = 48;
const NEAREST_REFINE_STEPS = 12;

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export const newPenPoint = ({ x, y }: Point): PenPoint => ({
  id: Math.random().toString(36).slice(2, 10),
  x,
  y,
  inX: 0,
  inY: 0,
  outX: 0,
  outY: 0,
});

export const penSegments = (points: Array<PenPoint>, closed: boolean): Array<Cubic> =>
  points.slice(0, closed ? points.length : points.length - 1).map((from, index) => {
    const to = points[(index + 1) % points.length];
    return [
      { x: from.x, y: from.y },
      { x: from.x + from.outX, y: from.y + from.outY },
      { x: to.x + to.inX, y: to.y + to.inY },
      { x: to.x, y: to.y },
    ];
  });

export const cubicAt = ([p0, p1, p2, p3]: Cubic, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
};

export const nearestOnPen = (points: Array<PenPoint>, closed: boolean, target: Point) => {
  const distance = (segment: Cubic, t: number) => {
    const point = cubicAt(segment, t);
    return Math.hypot(point.x - target.x, point.y - target.y);
  };
  const segments = penSegments(points, closed);
  let best = { index: -1, t: 0, distance: Infinity };
  segments.forEach((segment, index) => {
    for (let sample = 0; sample <= NEAREST_SAMPLES; sample++) {
      const t = sample / NEAREST_SAMPLES;
      const d = distance(segment, t);
      if (d < best.distance) best = { index, t, distance: d };
    }
  });
  if (best.index < 0) return null;
  const segment = segments[best.index];
  let step = 1 / NEAREST_SAMPLES;
  for (let iteration = 0; iteration < NEAREST_REFINE_STEPS; iteration++) {
    step /= 2;
    [best.t - step, best.t + step].forEach((t) => {
      const clamped = Math.min(1, Math.max(0, t));
      const d = distance(segment, clamped);
      if (d < best.distance) best = { ...best, t: clamped, distance: d };
    });
  }
  return best;
};

export const splitPen = (points: Array<PenPoint>, closed: boolean, index: number, t: number): Array<PenPoint> => {
  const [p0, p1, p2, p3] = penSegments(points, closed)[index];
  const p01 = lerp(p0, p1, t);
  const p12 = lerp(p1, p2, t);
  const p23 = lerp(p2, p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const middle = lerp(p012, p123, t);
  const next = (index + 1) % points.length;
  const inserted: PenPoint = {
    ...newPenPoint(middle),
    inX: p012.x - middle.x,
    inY: p012.y - middle.y,
    outX: p123.x - middle.x,
    outY: p123.y - middle.y,
  };
  const updated = points.map((point, position) => {
    if (position === index) return { ...point, outX: p01.x - p0.x, outY: p01.y - p0.y };
    if (position === next) return { ...point, inX: p23.x - p3.x, inY: p23.y - p3.y };
    return point;
  });
  return [...updated.slice(0, index + 1), inserted, ...updated.slice(index + 1)];
};

export const isSmoothPoint = ({ inX, inY, outX, outY }: PenPoint) => {
  const inLength = Math.hypot(inX, inY);
  const outLength = Math.hypot(outX, outY);
  if (inLength === 0 || outLength === 0) return false;
  return Math.abs(inX * outY - inY * outX) / (inLength * outLength) < SMOOTH_TOLERANCE && inX * outX + inY * outY < 0;
};

export const hasHandles = ({ inX, inY, outX, outY }: PenPoint) => inX !== 0 || inY !== 0 || outX !== 0 || outY !== 0;

export const toggleSmooth = (points: Array<PenPoint>, closed: boolean, index: number): Array<PenPoint> => {
  const point = points[index];
  if (hasHandles(point)) return points.map((p, i) => (i === index ? { ...p, inX: 0, inY: 0, outX: 0, outY: 0 } : p));
  const count = points.length;
  const previous = index > 0 || closed ? points[(index - 1 + count) % count] : point;
  const next = index < count - 1 || closed ? points[(index + 1) % count] : point;
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  const before = Math.hypot(point.x - previous.x, point.y - previous.y) / 3;
  const after = Math.hypot(next.x - point.x, next.y - point.y) / 3;
  return points.map((p, i) =>
    i === index
      ? {
          ...p,
          inX: (-dx / length) * before,
          inY: (-dy / length) * before,
          outX: (dx / length) * after,
          outY: (dy / length) * after,
        }
      : p,
  );
};

const HANDLE_KEYS = { in: ['inX', 'inY'], out: ['outX', 'outY'] } as const;

export type HandleSide = keyof typeof HANDLE_KEYS;

export const handleOf = (point: PenPoint, side: HandleSide): Point => {
  const [x, y] = HANDLE_KEYS[side];
  return { x: point[x], y: point[y] };
};

export const moveHandle = (point: PenPoint, side: HandleSide, offset: Point, mirror: boolean): PenPoint => {
  const [x, y] = HANDLE_KEYS[side];
  const [otherX, otherY] = HANDLE_KEYS[side === 'in' ? 'out' : 'in'];
  const moved = { ...point, [x]: offset.x, [y]: offset.y };
  const length = Math.hypot(offset.x, offset.y);
  if (!mirror || length === 0) return moved;
  const otherLength = Math.hypot(point[otherX], point[otherY]);
  return { ...moved, [otherX]: (-offset.x / length) * otherLength, [otherY]: (-offset.y / length) * otherLength };
};

export const translatePen = (points: Array<PenPoint>, dx: number, dy: number): Array<PenPoint> =>
  points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));

export const penBounds = (points: Array<PenPoint>) => {
  const xs = points.flatMap((p) => [p.x, p.x + p.inX, p.x + p.outX]);
  const ys = points.flatMap((p) => [p.y, p.y + p.inY, p.y + p.outY]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
};

export const rectangleBounds = ({
  centerX,
  centerY,
  width,
  height,
  rotation = 0,
}: {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotation?: number;
}) => {
  const angle = (rotation * Math.PI) / 180;
  const halfX = (Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))) / 2;
  const halfY = (Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))) / 2;
  return { left: centerX - halfX, top: centerY - halfY, right: centerX + halfX, bottom: centerY + halfY };
};
