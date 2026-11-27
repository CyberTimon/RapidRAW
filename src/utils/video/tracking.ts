import { FrameRate, Quad, Ticks, TimelineItem, TrackKey, Transform } from '../../types/video';
import { valueAt } from './animation';
import { followsSurface, mapPoint, planeWarp, trackSimilarity } from './maskTracking';
import { boundsQuad, mapQuad, scaleQuad } from './planar';
import { itemEnd } from './model';
import { frameTicks, snapTicks, ticksToSeconds } from './time';

export type TrackDirection = 'backward' | 'both' | 'forward';

export interface TrackSample {
  cx: number;
  cy: number;
  scale: number;
  rotation: number;
  corners?: Quad;
}

export type TrackKind = 'position' | 'planar';

const MAX_GAP_SECONDS = 1;
const TRACK_TOLERANCE_PX = 0.25;
const MIN_REGION = 12;

const keyIndices = (times: Array<number>, values: Array<number>, weight: number) => {
  const keep = new Set([0, values.length - 1]);
  const stack: Array<[number, number]> = [[0, values.length - 1]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    let worst = -1;
    let distance = TRACK_TOLERANCE_PX;
    for (let index = from + 1; index < to; index++) {
      const span = times[to] - times[from];
      const t = Math.abs(span) > 1e-9 ? (times[index] - times[from]) / span : 0;
      const off = weight * Math.abs(values[index] - (values[from] + (values[to] - values[from]) * t));
      if (off > distance) {
        distance = off;
        worst = index;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([from, worst], [worst, to]);
    }
  }
  return [...keep].sort((a, b) => a - b);
};

export const thinTrack = (keys: Array<TrackKey>, weights: [number, number, number, number]) => {
  const times = keys.map((key) => key.time);
  const kept = new Set([0, keys.length - 1]);
  const channels: Array<[(key: TrackKey) => number, number]> = [
    [(key) => key.x, weights[0]],
    [(key) => key.y, weights[1]],
    [(key) => key.scale, weights[2]],
    [(key) => key.rotation, weights[3]],
    ...(keys.every((key) => key.corners)
      ? [0, 1, 2, 3].flatMap((corner): Array<[(key: TrackKey) => number, number]> => [
          [(key) => key.corners![corner][0], weights[0]],
          [(key) => key.corners![corner][1], weights[1]],
        ])
      : []),
  ];
  channels.forEach(([channel, weight]) => {
    const values = keys.map(channel);
    if ((Math.max(...values) - Math.min(...values)) * weight > TRACK_TOLERANCE_PX)
      keyIndices(times, values, weight).forEach((index) => kept.add(index));
  });
  return [...kept].sort((a, b) => a - b).map((index) => keys[index]);
};

export interface Placement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export const layerSimilarity = (transform: Transform, local: Ticks, width: number, height: number) =>
  followsSurface(transform.track) ? null : trackSimilarity(transform.track, ticksToSeconds(local), width, height);

export const layerSurface = (transform: Transform, local: Ticks, width: number, height: number) =>
  transform.pin ? null : planeWarp(transform.track, ticksToSeconds(local), width, height);

export const placementAt = (transform: Transform, local: Ticks, width: number, height: number): Placement => {
  const x = (0.5 + valueAt(transform.x, local)) * width;
  const y = (0.5 + valueAt(transform.y, local)) * height;
  const scale = valueAt(transform.scale, local);
  const rotation = valueAt(transform.rotation, local);
  const similarity = layerSimilarity(transform, local, width, height);
  if (!similarity) return { x, y, scale, rotation };
  return {
    ...mapPoint(similarity, x, y),
    scale: scale * similarity.scale,
    rotation: rotation + (similarity.angle * 180) / Math.PI,
  };
};

export const pinnedQuad = (transform: Transform, local: Ticks, width: number, height: number): Quad | null => {
  if (!transform.pin) return null;
  const corners = scaleQuad(transform.pin, width, height);
  const warp = planeWarp(transform.track, ticksToSeconds(local), width, height);
  if (warp) return mapQuad(warp, corners) ?? corners;
  const similarity = layerSimilarity(transform, local, width, height);
  if (!similarity) return corners;
  return corners.map(([x, y]) => {
    const point = mapPoint(similarity, x, y);
    return [point.x, point.y];
  }) as Quad;
};

export const layerQuad = (
  transform: Transform,
  size: { width: number; height: number },
  local: Ticks,
  width: number,
  height: number,
): Quad => {
  const placed = placementAt(transform, local, width, height);
  const angle = (placed.rotation * Math.PI) / 180;
  const corner = (sx: number, sy: number): [number, number] => {
    const dx = (sx * size.width * placed.scale) / 2;
    const dy = (sy * size.height * placed.scale) / 2;
    return [
      placed.x + dx * Math.cos(angle) - dy * Math.sin(angle),
      placed.y + dx * Math.sin(angle) + dy * Math.cos(angle),
    ];
  };
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
};

export const shownQuad = (
  transform: Transform,
  size: { width: number; height: number },
  local: Ticks,
  width: number,
  height: number,
): Quad | null => {
  const pinned = pinnedQuad(transform, local, width, height);
  if (pinned) return pinned;
  const surface = layerSurface(transform, local, width, height);
  return surface && mapQuad(surface, layerQuad(transform, size, local, width, height));
};

export type Region = { x: number; y: number; width: number; height: number };

export const regionQuad = ({ x, y, width, height }: Region): Quad =>
  boundsQuad({ left: x, top: y, right: x + width, bottom: y + height });

export const dragRegion = (
  start: Region,
  corner: readonly [number, number] | null,
  dx: number,
  dy: number,
  frame: { width: number; height: number },
): Region => {
  if (!corner)
    return {
      ...start,
      x: Math.min(Math.max(start.x + dx, 0), frame.width - start.width),
      y: Math.min(Math.max(start.y + dy, 0), frame.height - start.height),
    };
  const [cx, cy] = corner;
  const left = cx === 0 ? Math.min(Math.max(start.x + dx, 0), start.x + start.width - MIN_REGION) : start.x;
  const top = cy === 0 ? Math.min(Math.max(start.y + dy, 0), start.y + start.height - MIN_REGION) : start.y;
  const right =
    cx === 1
      ? Math.max(Math.min(start.x + start.width + dx, frame.width), start.x + MIN_REGION)
      : start.x + start.width;
  const bottom =
    cy === 1
      ? Math.max(Math.min(start.y + start.height + dy, frame.height), start.y + MIN_REGION)
      : start.y + start.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export const clampIntoItem = (item: TimelineItem, time: Ticks) =>
  Math.min(Math.max(time, item.start), itemEnd(item) - 1);

export const trackStart = (item: TimelineItem, time: Ticks, fps: FrameRate) =>
  Math.max(item.start, Math.min(snapTicks(clampIntoItem(item, time), fps), itemEnd(item) - frameTicks(fps)));

export const trackRuns = (direction: TrackDirection): Array<'backward' | 'forward'> =>
  direction === 'both' ? ['backward', 'forward'] : [direction];

export const trackTimes = (
  start: Ticks,
  first: Ticks,
  end: Ticks,
  step: Ticks,
  run: 'backward' | 'forward',
): Array<Ticks> => {
  const times: Array<Ticks> = [];
  if (run === 'forward') for (let time = start; time < end; time += step) times.push(time);
  else for (let time = start; time >= first; time -= step) times.push(time);
  return times;
};

export const maxTrackGap = (framesPerSecond: number) => Math.max(1, Math.round(MAX_GAP_SECONDS * framesPerSecond));

export const keptSamples = <T>(samples: Array<T | null>, maxGap: number): Array<[number, T]> => {
  const kept: Array<[number, T]> = [];
  let gap = 0;
  for (const [index, sample] of samples.entries()) {
    if (sample) {
      gap = 0;
      kept.push([index, sample]);
    } else if (++gap > maxGap) {
      break;
    }
  }
  return kept;
};
