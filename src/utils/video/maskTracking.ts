import { Mask, SubMask } from '../../types/masks';
import { MotionTrack, Quad, TrackAttach, TrackExits, TrackKey } from '../../types/video';
import type { AiPatch, MaskContainer } from '../adjustments';
import { PenPoint, penBounds, rectangleBounds } from '../maskShapes';
import {
  Bounds,
  Homography,
  boundsQuad,
  invert,
  localScale,
  mapQuad,
  project,
  quadAngle,
  quadArea,
  quadBounds,
  quadCenter,
  quadToQuad,
  scaleQuad,
} from './planar';

export const VIDEO_AI_MASKS: Array<Mask> = [Mask.AiSubject, Mask.AiForeground, Mask.AiSky];

export interface ColorKey {
  color: string;
  tolerance: number;
  softness: number;
  spill: number;
}

export const KEY_PRESETS = [
  { id: 'green', color: '#00ff00' },
  { id: 'blue', color: '#0000ff' },
] as const;

export const DEFAULT_KEY: ColorKey = { color: KEY_PRESETS[0].color, tolerance: 50, softness: 10, spill: 50 };

export interface Trackable {
  id: string;
  subMasks: Array<SubMask>;
  track?: MotionTrack | null;
  trackArea?: Quad | null;
}

export type TrackedContainer = MaskContainer &
  Trackable & {
    cutout?: boolean;
    key?: ColorKey | null;
  };

export type SourceMode = 'follow' | 'fixed' | 'track';

export type StampContainer = AiPatch &
  Trackable & {
    sourceMode?: SourceMode;
    sourceTrack?: MotionTrack | null;
  };

export interface Similarity {
  from: { x: number; y: number };
  to: { x: number; y: number };
  scale: number;
  angle: number;
}

export interface ResolvedFollow {
  similarity: Similarity | null;
  plane: Homography | null;
  corners: Quad | null;
}

const followKeys = new WeakMap<MotionTrack, string>();
let resolvedFollows = new Map<string, ResolvedFollow>();

const followKey = (track: MotionTrack) => {
  const known = followKeys.get(track);
  if (known !== undefined) return known;
  const key = JSON.stringify(track);
  followKeys.set(track, key);
  return key;
};

export const resolveFollows = (entries: Array<[MotionTrack, ResolvedFollow]>) => {
  resolvedFollows = new Map(entries.map(([track, follow]) => [followKey(track), follow]));
};

const resolvedOf = (track: MotionTrack, time: number | null) =>
  time === null ? null : (resolvedFollows.get(followKey(track)) ?? null);

export const SURFACE_ATTACH: Array<TrackAttach> = ['perspective', 'pin'];

export interface AttachChoices {
  object: Array<TrackAttach>;
  surface: Array<TrackAttach>;
  defaults: { object: TrackAttach; surface: TrackAttach };
}

export const LAYER_ATTACH: AttachChoices = {
  object: ['move', 'transform'],
  surface: ['move', 'transform', 'perspective', 'pin'],
  defaults: { object: 'move', surface: 'perspective' },
};

export const SHAPE_ATTACH: AttachChoices = {
  object: ['move', 'transform'],
  surface: ['move', 'transform', 'perspective'],
  defaults: { object: 'transform', surface: 'perspective' },
};

export const chosenAttach = (
  choices: AttachChoices,
  surface: boolean,
  ...candidates: Array<TrackAttach | null | undefined>
): TrackAttach => {
  const options = surface ? choices.surface : choices.object;
  return (
    candidates.find((candidate): candidate is TrackAttach => !!candidate && options.includes(candidate)) ??
    (surface ? choices.defaults.surface : choices.defaults.object)
  );
};

const MIN_REGION_SHARE = 0.04;
const MAX_REGION_SHARE = 0.8;
const LINEAR_REGION_SHARE = 0.2;
const TRACKABLE = new Set<string>([
  Mask.Radial,
  Mask.Linear,
  Mask.Rectangle,
  Mask.Pen,
  Mask.Brush,
  Mask.Flow,
  Mask.Clone,
  Mask.Heal,
]);

export const isTrackable = (subMask: SubMask) => TRACKABLE.has(subMask.type);

const poseAt = (keys: Array<TrackKey>, time: number): TrackKey => {
  const after = keys.findIndex((key) => key.time > time);
  if (after === 0) return keys[0];
  if (after < 0) return keys[keys.length - 1];
  const from = keys[after - 1];
  const to = keys[after];
  const t = Math.min(1, Math.max(0, (time - from.time) / Math.max(1e-9, to.time - from.time)));
  const mix = (a: number, b: number) => a + (b - a) * t;
  const corners =
    from.corners && to.corners
      ? (from.corners.map(([x, y], index) => [mix(x, to.corners![index][0]), mix(y, to.corners![index][1])]) as Quad)
      : undefined;
  return {
    time,
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    scale: mix(from.scale, to.scale),
    rotation: mix(from.rotation, to.rotation),
    ...(corners && { corners }),
  };
};

const EXIT_WINDOW = 0.3;
const EXIT_SETTLE = 0.5;

const continued = (keys: Array<TrackKey>, edge: TrackKey, toward: number, time: number, aspect: number): TrackKey => {
  const inner = poseAt(keys, Math.min(keys[keys.length - 1].time, Math.max(keys[0].time, toward)));
  const span = edge.time - inner.time;
  if (Math.abs(span) < 1e-6) return { ...edge, time };
  const elapsed = time - edge.time;
  const settled = EXIT_SETTLE * (1 - Math.exp(-Math.abs(elapsed) / EXIT_SETTLE)) * Math.sign(elapsed);
  const rate = (atEdge: number, inside: number) => (atEdge - inside) / span;
  const x = edge.x + rate(edge.x, inner.x) * elapsed;
  const y = edge.y + rate(edge.y, inner.y) * elapsed;
  const growth = Math.exp(rate(Math.log(Math.max(1e-3, edge.scale)), Math.log(Math.max(1e-3, inner.scale))) * settled);
  const turn = rate(edge.rotation, inner.rotation) * settled;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const corners = edge.corners?.map(([cx, cy]) => {
    const dx = (cx - edge.x) * aspect;
    const dy = cy - edge.y;
    return [x + (growth * (cos * dx - sin * dy)) / aspect, y + growth * (sin * dx + cos * dy)];
  }) as Quad | undefined;
  return {
    time,
    x,
    y,
    scale: edge.scale * growth,
    rotation: edge.rotation + turn,
    ...(corners && { corners }),
  };
};

const poseOf = (track: MotionTrack, time: number, aspect: number): TrackKey => {
  const { keys } = track;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (time > last.time && track.exits?.end) return continued(keys, last, last.time - EXIT_WINDOW, time, aspect);
  if (time < first.time && track.exits?.start) return continued(keys, first, first.time + EXIT_WINDOW, time, aspect);
  return poseAt(keys, time);
};

const referenceOf = (track: MotionTrack) => track.reference ?? track.keys[0];

export const isPlanar = (track: MotionTrack | null | undefined) =>
  !!track?.keys.length && !!referenceOf(track).corners && track.keys.every((key) => !!key.corners);

export const frozenTrack = (track: MotionTrack, time: number, aspect: number): MotionTrack | null =>
  track.anchor || !track.keys.length
    ? null
    : { ...track, keys: [{ ...poseOf(track, time, aspect), time: 0 }], exits: {} };

export const referenceCorners = (track: MotionTrack | null | undefined) =>
  track?.keys.length ? (referenceOf(track).corners ?? null) : null;

export const attachOf = (track: MotionTrack | null | undefined): TrackAttach =>
  track?.attach ?? (isPlanar(track) ? 'perspective' : 'transform');

export const followsSurface = (track: MotionTrack | null | undefined) =>
  isPlanar(track) && SURFACE_ATTACH.includes(attachOf(track));

export const planeWarp = (
  track: MotionTrack | undefined | null,
  time: number | null,
  width: number,
  height: number,
): Homography | null => {
  if (!track || time === null || !followsSurface(track)) return null;
  if (track.anchor) return resolvedOf(track, time)?.plane ?? null;
  return quadToQuad(
    scaleQuad(referenceOf(track).corners!, width, height),
    scaleQuad(poseOf(track, time, width / height).corners!, width, height),
  );
};

export const planeAt = (track: MotionTrack | undefined | null, time: number | null, width: number, height: number) => {
  if (!track || time === null || !isPlanar(track)) return null;
  if (track.anchor) return resolvedOf(track, time)?.corners ?? null;
  return scaleQuad(poseOf(track, time, width / height).corners!, width, height);
};

const between = (reference: TrackKey, pose: TrackKey, width: number, height: number): Similarity => ({
  from: { x: reference.x * width, y: reference.y * height },
  to: { x: pose.x * width, y: pose.y * height },
  scale: pose.scale / Math.max(1e-3, reference.scale),
  angle: pose.rotation - reference.rotation,
});

export const trackSimilarity = (
  track: MotionTrack | undefined | null,
  time: number | null,
  width: number,
  height: number,
): Similarity | null => {
  if (!track?.keys.length || time === null) return null;
  if (track.anchor) return resolvedOf(track, time)?.similarity ?? null;
  const similarity = between(referenceOf(track), poseOf(track, time, width / height), width, height);
  return attachOf(track) === 'move' ? { ...similarity, scale: 1, angle: 0 } : similarity;
};

const mergedExits = (
  existing: MotionTrack | null,
  kept: Array<TrackKey>,
  first: number,
  last: number,
  exits: TrackExits,
): TrackExits => ({
  start: kept.some((key) => key.time < first) ? !!existing?.exits?.start : !!exits.start,
  end: kept.some((key) => key.time > last) ? !!existing?.exits?.end : !!exits.end,
});

export const extendTrack = (
  track: MotionTrack | null | undefined,
  startTime: number,
  origin: { x: number; y: number },
  samples: Array<TrackKey>,
  width: number,
  height: number,
  thin: (keys: Array<TrackKey>) => Array<TrackKey>,
  exits: TrackExits,
): MotionTrack => {
  const existing = track?.keys.length ? track : null;
  const base = existing
    ? poseOf(existing, startTime, width / height)
    : { time: startTime, x: origin.x / width, y: origin.y / height, scale: 1, rotation: 0 };
  const dx = base.x * width - origin.x;
  const dy = base.y * height - origin.y;
  const keys = thin(
    samples.map((sample) => {
      const cos = Math.cos(sample.rotation) * sample.scale;
      const sin = Math.sin(sample.rotation) * sample.scale;
      return {
        time: sample.time,
        x: (sample.x * width + cos * dx - sin * dy) / width,
        y: (sample.y * height + sin * dx + cos * dy) / height,
        scale: sample.scale * base.scale,
        rotation: sample.rotation + base.rotation,
      };
    }),
  );
  const first = Math.min(...keys.map((key) => key.time));
  const last = Math.max(...keys.map((key) => key.time));
  const kept = existing?.keys.filter((key) => key.time < first || key.time > last) ?? [];
  return {
    reference: existing ? referenceOf(existing) : base,
    keys: [...kept, ...keys].sort((a, b) => a.time - b.time),
    ...(existing?.attach && { attach: existing.attach }),
    exits: mergedExits(existing, kept, first, last, exits),
  };
};

interface PlaneKey {
  time: number;
  corners: Quad;
}

const planeKeys = (reference: Quad, keys: Array<PlaneKey>, width: number, height: number): Array<TrackKey> => {
  const base = scaleQuad(reference, width, height);
  const area = Math.max(1e-9, quadArea(base));
  const angle = quadAngle(base);
  let turned = 0;
  return keys.map(({ time, corners }) => {
    const scaled = scaleQuad(corners, width, height);
    const [x, y] = quadCenter(scaled);
    const raw = quadAngle(scaled) - angle;
    turned = raw + Math.round((turned - raw) / (2 * Math.PI)) * 2 * Math.PI;
    return { time, x: x / width, y: y / height, scale: Math.sqrt(quadArea(scaled) / area), rotation: turned, corners };
  });
};

const cornersOf = (keys: Array<TrackKey>): Array<PlaneKey> =>
  keys.map(({ time, corners }) => ({ time, corners: corners! }));

const anchored = (anchor: Quad, start: Quad, keys: Array<PlaneKey>, width: number, height: number) => {
  const target = scaleQuad(anchor, width, height);
  const origin = scaleQuad(start, width, height);
  return keys.map(({ time, corners }) => {
    const warp = quadToQuad(origin, scaleQuad(corners, width, height));
    const mapped = warp && mapQuad(warp, target);
    return { time, corners: mapped ? scaleQuad(mapped, 1 / width, 1 / height) : corners };
  });
};

export const extendPlane = (
  track: MotionTrack | null | undefined,
  startTime: number,
  samples: Array<PlaneKey>,
  width: number,
  height: number,
  thin: (keys: Array<TrackKey>) => Array<TrackKey>,
  exits: TrackExits,
): MotionTrack => {
  const existing = track && isPlanar(track) ? track : null;
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const first = sorted[0].time;
  const last = sorted[sorted.length - 1].time;
  const start = sorted.find((sample) => sample.time === startTime) ?? sorted[0];
  const reference = existing ? referenceOf(existing) : planeKeys(start.corners, [start], width, height)[0];
  const moved = existing
    ? anchored(poseOf(existing, startTime, width / height).corners!, start.corners, sorted, width, height)
    : sorted;
  const fresh = thin(planeKeys(reference.corners!, moved, width, height));
  const kept = existing?.keys.filter((key) => key.time < first || key.time > last) ?? [];
  return {
    reference,
    keys: planeKeys(reference.corners!, cornersOf([...kept, ...fresh].sort((a, b) => a.time - b.time)), width, height),
    ...(existing?.attach && { attach: existing.attach }),
    exits: mergedExits(existing, kept, first, last, exits),
  };
};

export const shiftTrack = (track: MotionTrack, seconds: number): MotionTrack =>
  track.anchor ? track : { ...track, keys: track.keys.map((key) => ({ ...key, time: key.time + seconds })) };

export const sameCorners = (a: Quad | null | undefined, b: Quad | null | undefined) =>
  a === b || (!!a && !!b && a.every(([x, y], index) => x === b[index][0] && y === b[index][1]));

const sameKey = (a: TrackKey, b: TrackKey) =>
  a.x === b.x && a.y === b.y && a.scale === b.scale && a.rotation === b.rotation && sameCorners(a.corners, b.corners);

const rebased = (track: MotionTrack, reference: TrackKey, width: number, height: number): MotionTrack => {
  const from = referenceOf(track);
  if (sameKey(from, reference)) return track;
  if (isPlanar(track) && reference.corners) {
    return {
      reference,
      keys: planeKeys(
        reference.corners,
        anchored(reference.corners, from.corners!, cornersOf(track.keys), width, height),
        width,
        height,
      ),
    };
  }
  return {
    reference,
    keys: track.keys.map((key) => {
      const similarity = between(from, key, width, height);
      const point = mapPoint(similarity, reference.x * width, reference.y * height);
      return {
        time: key.time,
        x: point.x / width,
        y: point.y / height,
        scale: reference.scale * similarity.scale,
        rotation: reference.rotation + similarity.angle,
      };
    }),
  };
};

const mergeAnchored = (head: MotionTrack, tail: MotionTrack): MotionTrack => {
  const covered = trackSpan(head)!;
  const keys = [...head.keys, ...tail.keys.filter((key) => key.time < covered[0] || key.time > covered[1])].sort(
    (a, b) => a.time - b.time,
  );
  return {
    ...head,
    keys,
    exits: {
      start: keys[0] === head.keys[0] ? !!head.exits?.start : !!tail.exits?.start,
      end: keys[keys.length - 1] === head.keys[head.keys.length - 1] ? !!head.exits?.end : !!tail.exits?.end,
    },
  };
};

export const joinTracks = (
  head: MotionTrack | null | undefined,
  tail: MotionTrack | null | undefined,
  boundary: number,
  width: number,
  height: number,
): MotionTrack | null => {
  if (!tail?.keys.length) return head ?? null;
  const shifted = shiftTrack(tail, boundary);
  if (!head?.keys.length) return shifted;
  if (head.anchor || tail.anchor) return head.anchor?.media === tail.anchor?.media ? mergeAnchored(head, tail) : head;
  const aligned = rebased(shifted, referenceOf(head), width, height);
  return {
    ...head,
    keys: [...head.keys.filter((key) => key.time < boundary), ...aligned.keys.filter((key) => key.time >= boundary)],
    exits: { start: !!head.exits?.start, end: !!tail.exits?.end },
  };
};

export const trackSpan = (track: MotionTrack | null | undefined): [number, number] | null =>
  track?.keys.length ? [track.keys[0].time, track.keys[track.keys.length - 1].time] : null;

export const invertSimilarity = (similarity: Similarity): Similarity => ({
  from: similarity.to,
  to: similarity.from,
  scale: 1 / similarity.scale,
  angle: -similarity.angle,
});

export type MaskWarp = Similarity | Homography;

const isPlane = (warp: MaskWarp): warp is Homography => Array.isArray(warp);

export const maskWarp = (
  track: MotionTrack | undefined | null,
  time: number | null,
  width: number,
  height: number,
): MaskWarp | null => planeWarp(track, time, width, height) ?? trackSimilarity(track, time, width, height);

export const invertWarp = (warp: MaskWarp): MaskWarp | null => (isPlane(warp) ? invert(warp) : invertSimilarity(warp));

const turnVector = (similarity: Similarity, dx: number, dy: number) => {
  const cos = Math.cos(similarity.angle);
  const sin = Math.sin(similarity.angle);
  return { x: similarity.scale * (cos * dx - sin * dy), y: similarity.scale * (sin * dx + cos * dy) };
};

export const mapPoint = (similarity: Similarity, x: number, y: number) => {
  const turned = turnVector(similarity, x - similarity.from.x, y - similarity.from.y);
  return { x: similarity.to.x + turned.x, y: similarity.to.y + turned.y };
};

export const warpPoint = (warp: MaskWarp, x: number, y: number) => {
  if (!isPlane(warp)) return mapPoint(warp, x, y);
  const [px, py] = project(warp, x, y) ?? [x, y];
  return { x: px, y: py };
};

export const warpQuad = (warp: MaskWarp | null, quad: Quad): Quad =>
  warp
    ? (quad.map(([x, y]) => {
        const point = warpPoint(warp, x, y);
        return [point.x, point.y];
      }) as Quad)
    : quad;

const localSimilarity = (plane: Homography, x: number, y: number): Similarity => {
  const to = warpPoint(plane, x, y);
  const step = warpPoint(plane, x + 1, y);
  return { from: { x, y }, to, scale: localScale(plane, x, y), angle: Math.atan2(step.y - to.y, step.x - to.x) };
};

const mapPenPoint = (warp: MaskWarp, point: PenPoint): PenPoint => {
  const at = warpPoint(warp, point.x, point.y);
  if (!isPlane(warp)) {
    const handleIn = turnVector(warp, point.inX, point.inY);
    const handleOut = turnVector(warp, point.outX, point.outY);
    return { ...point, ...at, inX: handleIn.x, inY: handleIn.y, outX: handleOut.x, outY: handleOut.y };
  }
  const handleIn = warpPoint(warp, point.x + point.inX, point.y + point.inY);
  const handleOut = warpPoint(warp, point.x + point.outX, point.y + point.outY);
  return {
    ...point,
    ...at,
    inX: handleIn.x - at.x,
    inY: handleIn.y - at.y,
    outX: handleOut.x - at.x,
    outY: handleOut.y - at.y,
  };
};

type Parameters = NonNullable<SubMask['parameters']>;

const scaleAt = (warp: MaskWarp, x: number, y: number) => (isPlane(warp) ? localScale(warp, x, y) : warp.scale);

const mapLine = (warp: MaskWarp, line: Parameters) => {
  const first = line.points?.[0];
  return {
    ...line,
    brushSize: (line.brushSize ?? 0) * scaleAt(warp, first?.x ?? 0, first?.y ?? 0),
    points: (line.points ?? []).map((point: { x: number; y: number }) => ({
      ...point,
      ...warpPoint(warp, point.x, point.y),
    })),
  };
};

export const mapParameters = (type: string, parameters: Parameters | undefined, warp: MaskWarp) => {
  if (!parameters) return parameters;
  if (type === Mask.Radial || type === Mask.Rectangle) {
    if (isPlane(warp)) return { ...parameters, plane: warp };
    const center = mapPoint(warp, parameters.centerX, parameters.centerY);
    const sizes = Object.fromEntries(
      ['radiusX', 'radiusY', 'width', 'height']
        .filter((key) => key in parameters)
        .map((key) => [key, parameters[key] * warp.scale]),
    );
    return {
      ...parameters,
      ...sizes,
      centerX: center.x,
      centerY: center.y,
      rotation: (parameters.rotation ?? 0) + (warp.angle * 180) / Math.PI,
    };
  }
  if (type === Mask.Pen) {
    return {
      ...parameters,
      points: (parameters.points ?? []).map((point: PenPoint) => mapPenPoint(warp, point)),
    };
  }
  if (type === Mask.Linear) {
    const start = warpPoint(warp, parameters.startX, parameters.startY);
    const end = warpPoint(warp, parameters.endX, parameters.endY);
    return {
      ...parameters,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      range: (parameters.range ?? 50) * scaleAt(warp, parameters.startX, parameters.startY),
    };
  }
  if (Array.isArray(parameters.lines))
    return { ...parameters, lines: parameters.lines.map((line: Parameters) => mapLine(warp, line)) };
  return parameters;
};

export interface StampWarps {
  spot: MaskWarp | null;
  source: MaskWarp | null;
}

export const stampWarps = (
  container: StampContainer,
  time: number | null,
  width: number,
  height: number,
): StampWarps => {
  const spot = maskWarp(container.track, time, width, height);
  const mode = container.sourceMode ?? 'follow';
  if (mode === 'fixed') return { spot, source: null };
  return { spot, source: mode === 'track' ? maskWarp(container.sourceTrack, time, width, height) : spot };
};

const movedSource = (parameters: Parameters, warp: MaskWarp | null): Parameters => {
  if (!warp || parameters.sourceX === undefined || parameters.sourceY === undefined) return parameters;
  const point = warpPoint(warp, parameters.sourceX, parameters.sourceY);
  return { ...parameters, sourceX: point.x, sourceY: point.y };
};

export const shownStamp = (type: string, parameters: Parameters, { spot, source }: StampWarps): Parameters =>
  movedSource((spot && mapParameters(type, parameters, spot)) || parameters, source);

const inverseOf = (warp: MaskWarp | null) => (warp ? invertWarp(warp) : null);

export const storedStamp = (type: string, parameters: Parameters, { spot, source }: StampWarps): Parameters =>
  shownStamp(type, parameters, { spot: inverseOf(spot), source: inverseOf(source) });

export const unmapUpdate = (
  type: string,
  stored: Parameters | undefined,
  incoming: Parameters,
  warp: MaskWarp,
): Parameters => {
  const inverse = invertWarp(warp);
  if (!inverse) return incoming;
  if (Array.isArray(incoming.lines) && Array.isArray(stored?.lines) && incoming.lines.length >= stored.lines.length) {
    const appended = incoming.lines.slice(stored.lines.length).map((line: Parameters) => mapLine(inverse, line));
    return { ...incoming, lines: [...incoming.lines.slice(0, stored.lines.length), ...appended] };
  }
  if (isPlane(inverse) && (type === Mask.Radial || type === Mask.Rectangle)) {
    const { plane, ...reference } = incoming;
    if (plane) return reference;
    return mapParameters(type, incoming, localSimilarity(inverse, incoming.centerX, incoming.centerY)) ?? incoming;
  }
  return mapParameters(type, incoming, inverse) ?? incoming;
};

const shapeBounds = (subMask: SubMask, width: number, height: number): Bounds | null => {
  const p = subMask.parameters ?? {};
  if (subMask.type === Mask.Radial) {
    const radius = Math.max(p.radiusX ?? 0, p.radiusY ?? 0);
    return { left: p.centerX - radius, top: p.centerY - radius, right: p.centerX + radius, bottom: p.centerY + radius };
  }
  if (subMask.type === Mask.Rectangle) return rectangleBounds(p);
  if (subMask.type === Mask.Pen) return p.points?.length ? penBounds(p.points) : null;
  if (subMask.type === Mask.Linear) {
    const half = (Math.min(width, height) * LINEAR_REGION_SHARE) / 2;
    const x = (p.startX + p.endX) / 2;
    const y = (p.startY + p.endY) / 2;
    return { left: x - half, top: y - half, right: x + half, bottom: y + half };
  }
  const points = (p.lines ?? []).flatMap((line: Parameters) =>
    (line.points ?? []).map((point: { x: number; y: number }) => ({ ...point, pad: (line.brushSize ?? 0) / 2 })),
  );
  if (points.length === 0) return null;
  return {
    left: Math.min(...points.map((point: { x: number; pad: number }) => point.x - point.pad)),
    top: Math.min(...points.map((point: { y: number; pad: number }) => point.y - point.pad)),
    right: Math.max(...points.map((point: { x: number; pad: number }) => point.x + point.pad)),
    bottom: Math.max(...points.map((point: { y: number; pad: number }) => point.y + point.pad)),
  };
};

const planeBounds = (plane: Homography, bounds: Bounds) =>
  quadBounds(boundsQuad(bounds).map(([x, y]) => project(plane, x, y) ?? [x, y]));

export interface TrackRegion {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export const trackingRegion = (subMasks: Array<SubMask>, width: number, height: number): TrackRegion | null => {
  const boxes = subMasks.filter(isTrackable).flatMap((subMask) => {
    const box = shapeBounds(subMask, width, height);
    const plane = subMask.parameters?.plane as Homography | undefined;
    return box ? [plane ? planeBounds(plane, box) : box] : [];
  });
  if (boxes.length === 0) return null;
  const left = Math.max(0, Math.min(...boxes.map((box) => box.left)));
  const top = Math.max(0, Math.min(...boxes.map((box) => box.top)));
  const right = Math.min(width, Math.max(...boxes.map((box) => box.right)));
  const bottom = Math.min(height, Math.max(...boxes.map((box) => box.bottom)));
  const clampShare = (value: number, size: number) =>
    Math.min(size * MAX_REGION_SHARE, Math.max(Math.min(width, height) * MIN_REGION_SHARE, value)) / size;
  return {
    cx: (left + right) / 2 / width,
    cy: (top + bottom) / 2 / height,
    width: clampShare(right - left, width),
    height: clampShare(bottom - top, height),
  };
};

export const regionBounds = ({ cx, cy, width, height }: TrackRegion): Bounds => ({
  left: cx - width / 2,
  top: cy - height / 2,
  right: cx + width / 2,
  bottom: cy + height / 2,
});

export const boundsRegion = ({ left, top, right, bottom }: Bounds, width: number, height: number): TrackRegion => ({
  cx: (left + right) / 2 / width,
  cy: (top + bottom) / 2 / height,
  width: (right - left) / width,
  height: (bottom - top) / height,
});

export const trackAreaAt = (container: Trackable, time: number | null, width: number, height: number) =>
  container.trackArea
    ? warpQuad(maskWarp(container.track, time, width, height), scaleQuad(container.trackArea, width, height))
    : null;
