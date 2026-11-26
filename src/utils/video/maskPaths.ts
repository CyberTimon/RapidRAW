import type { Adjustments } from '../adjustments';
import { Keyframe, Ticks } from '../../types/video';
import { Mask, SubMask } from '../../types/masks';
import { PenPoint, nearestOnPen, splitPen } from '../maskShapes';
import { setValueAt, valueAt } from './animation';

type Channels = Record<string, Array<Keyframe>>;
type PointField = 'x' | 'y' | 'inX' | 'inY' | 'outX' | 'outY';

const POINT_FIELDS: Array<PointField> = ['x', 'y', 'inX', 'inY', 'outX', 'outY'];
const POINT_CHANNEL = /(\.parameters\.points)\.#[^.]+\.[^.]+$/;
const LIGHT_POSITION = /^(relightLights\.#[^.]+)\.[xy]$/;

export const channelGroupOf = (path: string) =>
  path.replace(POINT_CHANNEL, '$1').replace(LIGHT_POSITION, '$1.position');

const channelsOf = (look: Adjustments): Channels => (look.animation as Channels | undefined) ?? {};

const pointsPrefix = (containerId: string, subMaskId: string) =>
  `masks.#${containerId}.subMasks.#${subMaskId}.parameters.points.#`;

const pointAt = (channels: Channels, prefix: string, point: PenPoint, time: Ticks): PenPoint => ({
  ...point,
  ...Object.fromEntries(
    POINT_FIELDS.map((field) => {
      const keys = channels[`${prefix}${point.id}.${field}`];
      return [field, keys ? valueAt({ value: point[field], keys }, time) : point[field]];
    }),
  ),
});

const storedPoints = (look: Adjustments, containerId: string, subMaskId: string): Array<PenPoint> | undefined =>
  look.masks
    ?.find((container) => container.id === containerId)
    ?.subMasks.find((subMask: SubMask) => subMask.id === subMaskId)?.parameters?.points;

export const keyInsertedPenPoints = (
  stored: Adjustments,
  next: Adjustments,
  time: Ticks,
  tolerance: Ticks,
): Adjustments => {
  const before = channelsOf(stored);
  const channels = { ...channelsOf(next) };
  const setKey = (path: string, at: Ticks, value: number) => {
    channels[path] = setValueAt({ value, keys: channels[path] }, at, value, tolerance, true).keys ?? [];
  };
  let keyed = false;
  (next.masks ?? []).forEach((container) =>
    container.subMasks.forEach((subMask: SubMask) => {
      if (subMask.type !== Mask.Pen) return;
      const prefix = pointsPrefix(container.id, subMask.id);
      const times = [
        ...new Set(
          Object.entries(before)
            .filter(([path]) => path.startsWith(prefix))
            .flatMap(([, keys]) => keys.map((key) => key.time)),
        ),
      ].filter((at) => Math.abs(at - time) > tolerance);
      const old = storedPoints(stored, container.id, subMask.id);
      const points: Array<PenPoint> = subMask.parameters?.points ?? [];
      if (times.length === 0 || !old || points.length <= old.length) return;
      const known = new Map(old.map((point, index) => [point.id, index]));
      points.forEach((point, index) => {
        const previous = points[(index - 1 + points.length) % points.length];
        const following = points[(index + 1) % points.length];
        const from = known.get(previous.id);
        const to = known.get(following.id);
        if (known.has(point.id) || from === undefined || to !== (from + 1) % old.length) return;
        const segmentAt = (at: Ticks) => [pointAt(before, prefix, old[from], at), pointAt(before, prefix, old[to], at)];
        const t = nearestOnPen(segmentAt(time), false, point)?.t;
        if (t === undefined) return;
        const write = (at: Ticks, [start, inserted, end]: Array<PenPoint>) => {
          POINT_FIELDS.forEach((field) => setKey(`${prefix}${point.id}.${field}`, at, inserted[field]));
          setKey(`${prefix}${previous.id}.outX`, at, start.outX);
          setKey(`${prefix}${previous.id}.outY`, at, start.outY);
          setKey(`${prefix}${following.id}.inX`, at, end.inX);
          setKey(`${prefix}${following.id}.inY`, at, end.inY);
        };
        write(time, [previous, point, following]);
        times.forEach((at) => write(at, splitPen(segmentAt(at), false, 0, t)));
        keyed = true;
      });
    }),
  );
  return keyed ? { ...next, animation: channels } : next;
};
