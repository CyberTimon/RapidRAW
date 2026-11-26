import { Animated, ClipItem, Ticks, TimelineItem, VideoProject } from '../../types/video';
import { animated, isAnimated } from './animation';
import { minItemDuration, trimItem, updateItem } from './edit';
import { itemEnd, locateItem, mainTrack } from './model';

export type KenBurns = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight';
export type KenBurnsMove = KenBurns | 'none';
export type KenBurnsChoice = KenBurnsMove | 'random';

export const KEN_BURNS: Array<KenBurns> = ['zoomIn', 'zoomOut', 'panLeft', 'panRight'];
export const BEAT_STEPS = [1, 2, 4];

const ZOOM = 1.15;
const PAN = (ZOOM - 1) / 2;

const MOVES: Record<KenBurns, { scale: [number, number]; x: [number, number] }> = {
  zoomIn: { scale: [1, ZOOM], x: [0, 0] },
  zoomOut: { scale: [ZOOM, 1], x: [0, 0] },
  panLeft: { scale: [ZOOM, ZOOM], x: [PAN, -PAN] },
  panRight: { scale: [ZOOM, ZOOM], x: [-PAN, PAN] },
};

const restValue = (value: Animated, neutral: number) => (isAnimated(value) ? neutral : value.value);

const endpoints = (value: Animated): [number, number] | null =>
  value.keys?.length === 2 ? [value.keys[0].value, value.keys[1].value] : null;

const near = (value: number, target: number) => Math.abs(value - target) <= 1e-6 * Math.max(1, Math.abs(target));

export const kenBurnsOf = (item: ClipItem): KenBurnsMove => {
  const scale = endpoints(item.transform.scale);
  const x = endpoints(item.transform.x);
  if (scale && !isAnimated(item.transform.x)) {
    if (near(scale[1], scale[0] * ZOOM)) return 'zoomIn';
    if (near(scale[0], scale[1] * ZOOM)) return 'zoomOut';
  }
  if (x && !isAnimated(item.transform.scale)) {
    const shift = (2 * PAN * item.transform.scale.value) / ZOOM;
    if (near(x[1] - x[0], -shift)) return 'panLeft';
    if (near(x[1] - x[0], shift)) return 'panRight';
  }
  return 'none';
};

const withoutKenBurns = (item: ClipItem): ClipItem => {
  const move = kenBurnsOf(item);
  const { scale, x } = item.transform;
  const zoom = move === 'zoomIn' || move === 'zoomOut' ? endpoints(scale) : null;
  const pan = move === 'panLeft' || move === 'panRight' ? endpoints(x) : null;
  if (!zoom && !pan) return item;
  return {
    ...item,
    transform: {
      ...item.transform,
      scale: animated(zoom ? Math.min(...zoom) : scale.value / ZOOM),
      x: animated(pan ? (pan[0] + pan[1]) / 2 : x.value),
    },
  };
};

const glide = ([from, to]: [number, number], duration: Ticks): Animated =>
  from === to
    ? animated(from)
    : {
        value: from,
        keys: [
          { time: 0, value: from, ease: 'linear' },
          { time: duration, value: to, ease: 'linear' },
        ],
      };

const withKenBurns = (item: ClipItem, variant: KenBurnsMove): ClipItem => {
  const base = withoutKenBurns(item);
  if (variant === 'none') return base;
  const scale = restValue(base.transform.scale, 1);
  const x = restValue(base.transform.x, 0);
  const move = MOVES[variant];
  return {
    ...base,
    transform: {
      ...base.transform,
      scale: glide([move.scale[0] * scale, move.scale[1] * scale], item.duration),
      x: glide([x + move.x[0] * scale, x + move.x[1] * scale], item.duration),
    },
  };
};

export const kenBurnsPlan = (count: number, choice: KenBurnsChoice): Array<KenBurnsMove> => {
  if (choice !== 'random') return Array.from({ length: count }, () => choice);
  const plan: Array<KenBurns> = [];
  for (let index = 0; index < count; index++) {
    const options = KEN_BURNS.filter((variant) => variant !== plan[index - 1]);
    plan.push(options[Math.floor(Math.random() * options.length)]);
  }
  return plan;
};

export const applyKenBurns = (project: VideoProject, ids: Array<string>, plan: Array<KenBurnsMove>): VideoProject =>
  ids.reduce(
    (next, id, index) => updateItem<ClipItem>(next, id, (item) => withKenBurns(item, plan[index] ?? plan[0])),
    project,
  );

export const mainItemsIn = (project: VideoProject, ids: Array<string>) => {
  const selected = new Set(ids);
  return mainTrack(project).items.filter((item) => selected.has(item.id));
};

export const cutToBeats = (
  project: VideoProject,
  ids: Array<string>,
  cuts: Array<Ticks>,
  mediaDuration: (project: VideoProject, item: TimelineItem) => Ticks,
): VideoProject => {
  const spacing = cuts.length > 1 ? (cuts[cuts.length - 1] - cuts[0]) / (cuts.length - 1) : 0;
  const shortest = Math.max(minItemDuration(project.settings.fps), spacing / 2);
  return mainItemsIn(project, ids).reduce((next, { id }) => {
    const item = locateItem(next, id)?.item;
    const earliest = item ? item.start + shortest : Number.POSITIVE_INFINITY;
    const cut = cuts.find((time) => time >= earliest);
    if (!item || cut === undefined) return next;
    const trimTo = (time: Ticks) => trimItem(next, id, 'end', time, (other) => mediaDuration(next, other));
    const trimmed = trimTo(cut);
    const reached = locateItem(trimmed, id)?.item;
    if (!reached || itemEnd(reached) >= cut) return trimmed;
    const fitting = cuts.findLast((time) => time >= earliest && time <= itemEnd(reached));
    return fitting === undefined ? trimmed : trimTo(fitting);
  }, project);
};
