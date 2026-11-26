import type { Adjustments } from '../adjustments';
import { AdjustmentItem, Animated, ClipItem, FrameRate, Keyframe, Ticks } from '../../types/video';
import { EasePreset, easeAt, moveKeyAt, setEaseAt, setValueAt, valueAt } from './animation';
import { localForSource, sourceTimeOf } from './model';
import { keyInsertedPenPoints } from './maskPaths';

type LookChannels = Record<string, Array<Keyframe>>;

const ANIMATION_KEY = 'animation';
const DISCRETE_KEYS = new Set(['orientationSteps', 'aspectRatio', 'lutSize', 'version']);
const ID_PREFIX = '#';

export const channelsOf = (look: Adjustments): LookChannels => (look[ANIMATION_KEY] as LookChannels | undefined) ?? {};

export const lookTimeOf = (item: ClipItem | AdjustmentItem, time: Ticks, fps: FrameRate): Ticks =>
  item.type === 'clip' ? sourceTimeOf(item, time, fps) : Math.max(0, time - item.start);

export const timelineTimeOf = (item: ClipItem | AdjustmentItem, lookTime: Ticks, fps: FrameRate): Ticks =>
  item.start + (item.type === 'clip' ? Math.round(localForSource(item, lookTime - item.sourceIn, fps)) : lookTime);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const numericLeaves = (value: unknown, prefix = '', leaves = new Map<string, number>()) => {
  if (typeof value === 'number' && Number.isFinite(value) && prefix) {
    leaves.set(prefix, value);
  } else if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (isRecord(entry) && typeof entry.id === 'string') {
        numericLeaves(entry, `${prefix}.${ID_PREFIX}${entry.id}`, leaves);
      }
    });
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      if (key !== ANIMATION_KEY && !DISCRETE_KEYS.has(key))
        numericLeaves(entry, prefix ? `${prefix}.${key}` : key, leaves);
    });
  }
  return leaves;
};

const withPath = (node: unknown, segments: Array<string>, value: number): unknown => {
  if (segments.length === 0) return value;
  const [segment, ...rest] = segments;
  if (segment.startsWith(ID_PREFIX) && Array.isArray(node)) {
    const id = segment.slice(ID_PREFIX.length);
    return node.map((entry) => (isRecord(entry) && entry.id === id ? withPath(entry, rest, value) : entry));
  }
  if (!isRecord(node) || !(segment in node)) return node;
  return { ...node, [segment]: withPath(node[segment], rest, value) };
};

const setLookValue = (look: Adjustments, path: string, value: number): Adjustments =>
  withPath(look, path.split('.'), value) as Adjustments;

const atPath = (node: unknown, segments: Array<string>): unknown => {
  if (segments.length === 0) return node;
  const [segment, ...rest] = segments;
  if (segment.startsWith(ID_PREFIX) && Array.isArray(node)) {
    const id = segment.slice(ID_PREFIX.length);
    return atPath(
      node.find((entry) => isRecord(entry) && entry.id === id),
      rest,
    );
  }
  return isRecord(node) && segment in node ? atPath(node[segment], rest) : undefined;
};

export const lookValueAt = (look: Adjustments, path: string) => {
  const segments = path.split('.');
  if (segments.some((segment) => segment === ANIMATION_KEY || DISCRETE_KEYS.has(segment))) return undefined;
  const value = atPath(look, segments);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const isAnimatablePath = (look: Adjustments, path: string) => lookValueAt(look, path) !== undefined;

const channel = (base: number, keys: Array<Keyframe>): Animated => ({ value: base, keys });

export const animatedValues = (look: Adjustments, time: Ticks) => {
  const values = new Map<string, number>();
  Object.entries(channelsOf(look)).forEach(([path, keys]) => {
    const base = lookValueAt(look, path);
    if (base !== undefined) values.set(path, valueAt(channel(base, keys), time));
  });
  return values;
};

export const animateLook = (look: Adjustments, time: Ticks): Adjustments =>
  [...animatedValues(look, time)].reduce((current, [path, value]) => setLookValue(current, path, value), look);

const withChannels = (look: Adjustments, channels: LookChannels): Adjustments => {
  const next = { ...look };
  if (Object.keys(channels).length > 0) next[ANIMATION_KEY] = channels;
  else delete next[ANIMATION_KEY];
  return next;
};

export const recordLookEdit = (
  stored: Adjustments,
  edited: Adjustments,
  editedAt: Ticks,
  time: Ticks,
  record: boolean,
  tolerance: Ticks,
): Adjustments => {
  const before = numericLeaves(animateLook(stored, editedAt));
  const after = numericLeaves(edited);
  const channels: LookChannels = {};
  Object.entries(channelsOf(stored)).forEach(([path, keys]) => {
    if (after.has(path)) channels[path] = keys;
  });
  after.forEach((value, path) => {
    if (before.get(path) === value) return;
    const keys = setValueAt(
      channel(value, channels[path] ?? []),
      time,
      value,
      tolerance,
      record && before.has(path),
    ).keys;
    if (keys) channels[path] = keys;
  });
  return keyInsertedPenPoints(stored, withChannels(edited, channels), time, tolerance);
};

export const keyTimes = (look: Adjustments, paths?: Array<string>): Array<Ticks> =>
  [
    ...new Set(
      Object.entries(channelsOf(look))
        .filter(([path]) => !paths || paths.includes(path))
        .flatMap(([, keys]) => keys.map((key) => key.time)),
    ),
  ].sort((a, b) => a - b);

export const keyNear = (look: Adjustments, paths: Array<string>, time: Ticks, tolerance: Ticks) =>
  paths.some((path) => channelsOf(look)[path]?.some((key) => Math.abs(key.time - time) <= tolerance));

export const addKeys = (look: Adjustments, paths: Array<string>, time: Ticks, tolerance: Ticks): Adjustments => {
  const current = numericLeaves(animateLook(look, time));
  const channels = { ...channelsOf(look) };
  paths.forEach((path) => {
    const value = current.get(path);
    if (value === undefined) return;
    channels[path] = channels[path]
      ? (setValueAt(channel(value, channels[path]), time, value, tolerance).keys ?? [])
      : [{ time, value, ease: 'ease' }];
  });
  return withChannels(look, channels);
};

export const removeKeys = (look: Adjustments, paths: Array<string>, time: Ticks, tolerance: Ticks): Adjustments => {
  const channels = { ...channelsOf(look) };
  let baked = look;
  paths.forEach((path) => {
    const keys = channels[path];
    if (!keys) return;
    const kept = keys.filter((key) => Math.abs(key.time - time) > tolerance);
    if (kept.length > 0) {
      channels[path] = kept;
      return;
    }
    baked = setLookValue(baked, path, keys[0].value);
    delete channels[path];
  });
  return withChannels(baked, channels);
};

const mapChannels = (
  look: Adjustments,
  paths: Array<string>,
  map: (keys: Array<Keyframe>) => Array<Keyframe>,
): Adjustments => {
  const channels = { ...channelsOf(look) };
  paths.forEach((path) => {
    if (channels[path]) channels[path] = map(channels[path]);
  });
  return withChannels(look, channels);
};

export const moveKeys = (
  look: Adjustments,
  paths: Array<string>,
  from: Ticks,
  to: Ticks,
  tolerance: Ticks,
): Adjustments => mapChannels(look, paths, (keys) => moveKeyAt(channel(0, keys), from, to, tolerance).keys ?? []);

export const lookEaseAt = (look: Adjustments, path: string, time: Ticks, tolerance: Ticks) =>
  easeAt(channel(0, channelsOf(look)[path] ?? []), time, tolerance);

export const easeKeys = (
  look: Adjustments,
  paths: Array<string>,
  time: Ticks,
  tolerance: Ticks,
  preset: EasePreset,
): Adjustments => mapChannels(look, paths, (keys) => setEaseAt(channel(0, keys), time, tolerance, preset).keys ?? []);

export const withChannelKeys = (look: Adjustments, path: string, keys: Array<Keyframe>): Adjustments =>
  channelsOf(look)[path] ? withChannels(look, { ...channelsOf(look), [path]: keys }) : look;

export const stopAnimating = (look: Adjustments, paths: Array<string>, time: Ticks): Adjustments => {
  const current = numericLeaves(animateLook(look, time));
  const channels = { ...channelsOf(look) };
  let baked = look;
  paths.forEach((path) => {
    if (!channels[path]) return;
    const value = current.get(path);
    if (value !== undefined) baked = setLookValue(baked, path, value);
    delete channels[path];
  });
  return withChannels(baked, channels);
};
