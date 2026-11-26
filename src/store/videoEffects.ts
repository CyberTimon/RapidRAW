import i18n from 'i18next';
import { Check, Trash2 } from 'lucide-react';
import { OPTION_SEPARATOR, Option } from '../types/ui';
import {
  ClipItem,
  Motion,
  MotionKind,
  Ticks,
  TimelineItem,
  TransitionKind,
  VideoProject,
  VisualItem,
} from '../types/video';
import { gapOf, minItemDuration, placeItem, setAnimation, tidy, withTransitionKind } from '../utils/video/edit';
import { TRANSITIONS, isDirectional } from '../utils/video/effectRegistry';
import {
  TitlePreset,
  createAdjustmentItem,
  createSolidItem,
  createTitleItem,
  itemEnd,
  mainTrack,
  sequenceDuration,
} from '../utils/video/model';
import { secondsToTicks, snapTicks } from '../utils/video/time';
import { editProject, getVideo, setVideo } from './useVideoStore';

export type Generator = 'adjustment' | 'solid' | `title:${TitlePreset}`;

export const cutNear = (project: VideoProject, time: Ticks) => {
  const items = mainTrack(project).items;
  let best: ClipItem | null = null;
  let distance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    if (index === 0 || item.type !== 'clip' || gapOf(item) > 0) return;
    const cut = itemEnd(items[index - 1]);
    if (Math.abs(cut - time) < distance) {
      distance = Math.abs(cut - time);
      best = item;
    }
  });
  return best as ClipItem | null;
};

export const applyTransition = (kind: TransitionKind, time?: Ticks) => {
  const { project, selection, playhead } = getVideo();
  if (!project) return false;
  const mainItems = mainTrack(project).items;
  const selected =
    time === undefined ? selection.find((id) => mainItems.findIndex((item) => item.id === id) > 0) : undefined;
  const target = selected
    ? (mainItems.find((item) => item.id === selected) as ClipItem | undefined)
    : cutNear(project, time ?? playhead);
  if (!target || mainItems.indexOf(target) <= 0) return false;
  setTransitionKind(target.id, kind);
  setVideo({ selection: [target.id] });
  return true;
};

export type TransitionTarget = { cut: string } | { item: string; edge: 'in' | 'out' };

const EDGE_MOTIONS: Record<TransitionKind, MotionKind> = {
  dissolve: 'fade',
  dipToBlack: 'fade',
  dipToWhite: 'fade',
  wipe: 'wipe',
  push: 'slide',
  slide: 'slide',
  whip: 'slide',
  zoom: 'zoom',
  iris: 'zoom',
  blur: 'blur',
  spin: 'spin',
};

const ANIMATED_TYPES: Array<TimelineItem['type']> = ['clip', 'title', 'solid'];

const edgeMotion = (kind: TransitionKind, edge: 'in' | 'out'): Motion => {
  const motion = EDGE_MOTIONS[kind];
  return { kind: motion, ...(isDirectional(motion) ? { direction: edge === 'in' ? 'right' : 'left' } : {}) };
};

export const transitionTargetAt = (project: VideoProject, trackIndex: number, time: Ticks): TransitionTarget | null => {
  const items: Array<TimelineItem> = project.videoTracks[trackIndex]?.items ?? [];
  const index = items.findIndex((item) => time >= item.start && time < itemEnd(item));
  const item = items[index];
  if (!item) return null;
  const atStart = time < item.start + item.duration / 2;
  if (trackIndex === 0) {
    const cut = atStart ? (index > 0 ? item : null) : items[index + 1];
    if (cut?.type === 'clip' && gapOf(cut) === 0) return { cut: cut.id };
  }
  return ANIMATED_TYPES.includes(item.type) ? { item: item.id, edge: atStart ? 'in' : 'out' } : null;
};

export const withTransitionTarget = (project: VideoProject, target: TransitionTarget, kind: TransitionKind) =>
  'cut' in target
    ? withTransitionKind(project, target.cut, kind)
    : setAnimation(project, target.item, target.edge, edgeMotion(kind, target.edge));

export const applyTransitionTarget = (target: TransitionTarget, kind: TransitionKind) => {
  editProject((project) => withTransitionTarget(project, target, kind));
  setVideo({ selection: ['cut' in target ? target.cut : target.item] });
};

export const setTransitionKind = (clipId: string, kind: TransitionKind | null) =>
  editProject((project) => withTransitionKind(project, clipId, kind));

export const transitionClips = (project: VideoProject, ids: Array<string>) => {
  const items = mainTrack(project).items;
  return items.filter(
    (item, index): item is ClipItem => index > 0 && item.type === 'clip' && !gapOf(item) && ids.includes(item.id),
  );
};

const setTransitionKinds = (clipIds: Array<string>, kind: TransitionKind | null) =>
  editProject((project) => clipIds.reduce((next, id) => withTransitionKind(next, id, kind), project));

export const transitionMenu = (clips: Array<ClipItem>): Array<Option> => {
  const ids = clips.map((clip) => clip.id);
  const kinds = new Set(clips.map((clip) => clip.transitionIn?.kind ?? null));
  const current = kinds.size === 1 ? [...kinds][0] : null;
  const any = clips.some((clip) => clip.transitionIn);
  return [
    ...TRANSITIONS.map((kind) => ({
      icon: kind === current ? Check : undefined,
      label: i18n.t(`video.transitions.${kind}`),
      onClick: () => setTransitionKinds(ids, kind),
    })),
    ...(any
      ? [
          { type: OPTION_SEPARATOR },
          {
            icon: Trash2,
            label: i18n.t('video.timeline.removeTransition'),
            isDestructive: true,
            onClick: () => setTransitionKinds(ids, null),
          },
        ]
      : []),
  ];
};

const span = (project: VideoProject, time: Ticks, seconds: number) => {
  const fps = project.settings.fps;
  const end = sequenceDuration(project);
  const duration = Math.max(
    minItemDuration(fps),
    end > 0 ? Math.min(snapTicks(secondsToTicks(seconds), fps), end) : snapTicks(secondsToTicks(seconds), fps),
  );
  const start = snapTicks(Math.max(0, Math.min(time, Math.max(0, end - duration))), fps);
  return { start, duration };
};

export const placeGenerated = (project: VideoProject, item: VisualItem, trackIndex: number | null) =>
  tidy(placeItem(project, item, trackIndex ?? 1, trackIndex !== null && trackIndex >= project.videoTracks.length));

const placeNew = (item: VisualItem, trackIndex: number | null) => {
  editProject((current) => placeGenerated(current, item, trackIndex));
  setVideo({ selection: [item.id] });
};

export const generatorItem = (project: VideoProject, generator: Generator, time: Ticks): VisualItem => {
  if (generator === 'adjustment') {
    const { start, duration } = span(project, time, 5);
    return createAdjustmentItem(start, duration);
  }
  const { start, duration } = span(project, time, 3);
  if (generator === 'solid') return createSolidItem(start, duration, '#000000');
  const preset = generator.slice('title:'.length) as TitlePreset;
  return createTitleItem(preset, i18n.t(`video.titles.presets.${preset}`), start, duration, 0);
};

export const addGenerator = (generator: Generator, time?: Ticks, trackIndex: number | null = null) => {
  const { project, playhead } = getVideo();
  if (project) placeNew(generatorItem(project, generator, time ?? playhead), trackIndex);
};

export const addTitle = () => addGenerator('title:title');
