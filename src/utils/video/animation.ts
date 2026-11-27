import { Animated, Ease, Handle, Keyframe, Ticks } from '../../types/video';

export type EasePreset = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold';
export type EaseChoice = EasePreset | 'custom';
export type HandleSide = 'in' | 'out';

export const EASE_PRESETS: Array<EasePreset> = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'];

const LINEAR: Handle = [1 / 3, 1 / 3];
const SMOOTH: Handle = [1 / 3, 0];
const PRESET_HANDLES: Record<Exclude<EasePreset, 'hold'>, [Handle, Handle]> = {
  linear: [LINEAR, LINEAR],
  easeIn: [SMOOTH, LINEAR],
  easeOut: [LINEAR, SMOOTH],
  easeInOut: [SMOOTH, SMOOTH],
};
const SOLVE_STEPS = 32;
const HANDLE_PRECISION = 1e4;
const HANDLE_TOLERANCE = 1e-3;

export const animated = (value: number): Animated => ({ value });

export const isAnimated = (value: Animated) => (value.keys?.length ?? 0) > 0;

const sideOf = (ease: Ease): Handle => (ease === 'ease' ? SMOOTH : LINEAR);

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

const cubic = (a: number, b: number, c: number, s: number) => ((a * s + b) * s + c) * s;

const bezierEase = ([rawX1, y1]: Handle, [rawX2, y2]: Handle, t: number) => {
  const x1 = clampUnit(rawX1);
  const x2 = clampUnit(rawX2);
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let low = 0;
  let high = 1;
  let s = t;
  for (let step = 0; step < SOLVE_STEPS; step += 1) {
    const error = cubic(ax, bx, cx, s) - t;
    if (Math.abs(error) < 1e-12) break;
    if (error > 0) high = s;
    else low = s;
    const next = s - error / ((3 * ax * s + 2 * bx) * s + cx);
    s = next > low && next < high ? next : (low + high) / 2;
  }
  return cubic(ay, by, cy, s);
};

export const segmentHandles = (from: Keyframe, to: Keyframe): [Handle, Handle] => [
  from.out ?? sideOf(from.ease),
  to.in ?? sideOf(from.ease),
];

const progress = (from: Keyframe, to: Keyframe, t: number) => {
  if (from.ease === 'hold') return 0;
  if (!from.out && !to.in) return from.ease === 'ease' ? t * t * (3 - 2 * t) : t;
  const [outgoing, incoming] = segmentHandles(from, to);
  return bezierEase(outgoing, [1 - incoming[0], 1 - incoming[1]], t);
};

export const valueAt = (value: Animated, time: Ticks) => {
  const keys = value.keys;
  if (!keys || keys.length === 0) return value.value;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  const next = keys.findIndex((key) => key.time > time);
  const from = keys[next - 1];
  const to = keys[next];
  const t = (time - from.time) / Math.max(1, to.time - from.time);
  return from.value + (to.value - from.value) * progress(from, to, t);
};

const keyIndexAt = (value: Animated, time: Ticks, tolerance: Ticks) =>
  value.keys?.findIndex((key) => Math.abs(key.time - time) <= tolerance) ?? -1;

export const keyAt = (value: Animated, time: Ticks, tolerance: Ticks) =>
  value.keys?.[keyIndexAt(value, time, tolerance)] ?? null;

const near = (a: Handle, b: Handle) =>
  Math.abs(a[0] - b[0]) < HANDLE_TOLERANCE && Math.abs(a[1] - b[1]) < HANDLE_TOLERANCE;

const incomingSide = (keys: Array<Keyframe>, index: number) => sideOf(keys[index - 1]?.ease ?? 'ease');

const keyHandles = (keys: Array<Keyframe>, index: number): [Handle, Handle] => [
  keys[index].in ?? incomingSide(keys, index),
  keys[index].out ?? sideOf(keys[index].ease),
];

export const easeOfKey = (keys: Array<Keyframe>, index: number): EaseChoice => {
  if (keys[index].ease === 'hold') return 'hold';
  const [incoming, outgoing] = keyHandles(keys, index);
  const presets = Object.keys(PRESET_HANDLES) as Array<keyof typeof PRESET_HANDLES>;
  return (
    presets.find((preset) => near(PRESET_HANDLES[preset][0], incoming) && near(PRESET_HANDLES[preset][1], outgoing)) ??
    'custom'
  );
};

const withoutHandles = ({ in: _in, out: _out, ...key }: Keyframe): Keyframe => key;

export const withEase = (keys: Array<Keyframe>, index: number, preset: EasePreset): Array<Keyframe> =>
  keys.map((key, at) => {
    if (at !== index) return key;
    if (preset === 'hold') return { ...withoutHandles(key), ease: 'hold', ...(key.in ? { in: key.in } : {}) };
    const ease = key.ease === 'hold' ? 'ease' : key.ease;
    const [incoming, outgoing] = PRESET_HANDLES[preset];
    return {
      ...withoutHandles(key),
      ease,
      ...(near(incoming, incomingSide(keys, index)) ? {} : { in: incoming }),
      ...(near(outgoing, sideOf(ease)) ? {} : { out: outgoing }),
    };
  });

export const withEaseOf = (keys: Array<Keyframe>, source: Array<Keyframe>, tolerance: Ticks): Array<Keyframe> =>
  keys.map((key) => {
    const match = source.find((other) => Math.abs(other.time - key.time) <= tolerance);
    if (!match) return key;
    return {
      ...withoutHandles(key),
      ease: match.ease,
      ...(match.in ? { in: match.in } : {}),
      ...(match.out ? { out: match.out } : {}),
    };
  });

const rounded = (value: number) => Math.round(value * HANDLE_PRECISION) / HANDLE_PRECISION;

export const withHandle = (keys: Array<Keyframe>, index: number, side: HandleSide, [x, y]: Handle) =>
  keys.map((key, at) => (at === index ? { ...key, [side]: [rounded(clampUnit(x)), rounded(y)] } : key));

export const easeAt = (value: Animated, time: Ticks, tolerance: Ticks): EaseChoice | null => {
  const index = keyIndexAt(value, time, tolerance);
  return index < 0 ? null : easeOfKey(value.keys!, index);
};

export const setEaseAt = (value: Animated, time: Ticks, tolerance: Ticks, preset: EasePreset): Animated => {
  const index = keyIndexAt(value, time, tolerance);
  return index < 0 ? value : { ...value, keys: withEase(value.keys!, index, preset) };
};

const sortKeys = (keys: Array<Keyframe>) => [...keys].sort((a, b) => a.time - b.time);

export const localTime = (time: Ticks, start: Ticks, duration: Ticks, frame: Ticks) =>
  Math.min(Math.max(time - start, 0), Math.max(0, duration - frame));

export const setValueAt = (
  value: Animated,
  time: Ticks,
  next: number,
  tolerance: Ticks,
  record = false,
  anchor: Ticks | null = null,
): Animated => {
  if (!isAnimated(value)) {
    if (!record) return { value: next };
    const keys: Array<Keyframe> = [{ time, value: next, ease: 'ease' }];
    if (anchor !== null && Math.abs(anchor - time) > tolerance && value.value !== next) {
      keys.push({ time: anchor, value: value.value, ease: 'ease' });
    }
    return { value: next, keys: sortKeys(keys) };
  }
  const existing = keyAt(value, time, tolerance);
  const keys = existing
    ? value.keys!.map((key) => (key === existing ? { ...key, value: next } : key))
    : sortKeys([...value.keys!, { time, value: next, ease: 'ease' }]);
  return { value: next, keys };
};

export const removeKeyAt = (value: Animated, time: Ticks, tolerance: Ticks): Animated => {
  const existing = keyAt(value, time, tolerance);
  if (!existing) return value;
  const keys = value.keys!.filter((key) => key !== existing);
  return keys.length > 0 ? { value: valueAt(value, time), keys } : { value: valueAt(value, time) };
};

export const moveKeyAt = (value: Animated, from: Ticks, to: Ticks, tolerance: Ticks): Animated => {
  const moving = keyAt(value, from, tolerance);
  if (!moving || moving.time === to) return value;
  const kept = value.keys!.filter((key) => key !== moving && Math.abs(key.time - to) > tolerance);
  return { ...value, keys: sortKeys([...kept, { ...moving, time: to }]) };
};

export const toggleKeyAt = (value: Animated, time: Ticks, tolerance: Ticks): Animated =>
  keyAt(value, time, tolerance)
    ? removeKeyAt(value, time, tolerance)
    : {
        value: valueAt(value, time),
        keys: sortKeys([...(value.keys ?? []), { time, value: valueAt(value, time), ease: 'ease' }]),
      };

export const scaleKeys = (value: Animated, ratio: number): Animated =>
  isAnimated(value) && ratio !== 1
    ? { ...value, keys: value.keys!.map((key) => ({ ...key, time: Math.round(key.time * ratio) })) }
    : value;

export const shiftKeys = (value: Animated, offset: Ticks): Animated =>
  isAnimated(value) && offset !== 0
    ? { ...value, keys: value.keys!.map((key) => ({ ...key, time: key.time + offset })) }
    : value;

export const keysWithin = (value: Animated, length: Ticks) =>
  (value.keys ?? []).filter((key) => key.time >= 0 && key.time <= length);
