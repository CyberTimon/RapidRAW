import { v4 as uuidv4 } from 'uuid';
import {
  AdjustmentItem,
  AudioItem,
  AudioTrack,
  ClipItem,
  ClipSettings,
  FrameRate,
  Keyframe,
  MediaInfo,
  MediaKind,
  MediaOrigin,
  MediaRef,
  PROJECT_SCHEMA,
  PROJECT_VERSION,
  ProjectSettings,
  Sequence,
  SolidItem,
  TICKS_PER_SECOND,
  Ticks,
  TimelineItem,
  TitleAlign,
  TitleItem,
  Track,
  TrackKind,
  Transform,
  VideoProject,
  VideoTrack,
  VisualItem,
} from '../../types/video';
import type { Adjustments } from '../adjustments';
import { animated, valueAt } from './animation';
import { DEFAULT_FPS, frameTicks, fromFrame, rateFromNumber, secondsToTicks, snapTicks, toFrame } from './time';

const STILL_SECONDS = 3;
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 16;
const MAX_DEFAULT_DIMENSION = 3840;
const DEFAULT_SAMPLE_RATE = 48000;

export type TitlePreset = 'title' | 'lowerThird';

export const identityTransform = (): Transform => ({
  x: animated(0),
  y: animated(0),
  scale: animated(1),
  rotation: animated(0),
  opacity: animated(1),
  radius: animated(0),
  flipH: false,
  flipV: false,
});

export const createTrack = <T extends TimelineItem>(): Track<T> => ({
  id: uuidv4(),
  items: [],
  muted: false,
  hidden: false,
  locked: false,
});

export const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

const RATIO_TOLERANCE = 0.01;

export const sameRatio = (a: number, b: number) => Math.abs(a - b) < RATIO_TOLERANCE;

export const canvasSize = (ratio: number, shortSide: number) =>
  ratio >= 1
    ? { width: even(shortSide * ratio), height: even(shortSide) }
    : { width: even(shortSide), height: even(shortSide / ratio) };

const VARIABLE_RATE_TARGETS = [24, 25, 30, 50, 60, 120];

const projectRate = (info: MediaInfo | undefined): FrameRate => {
  if (!info || info.isStill || info.fps <= 0) return DEFAULT_FPS;
  if (!info.variableFrameRate) return rateFromNumber(info.fps);
  const nearest = VARIABLE_RATE_TARGETS.reduce((best, rate) =>
    Math.abs(rate - info.fps) < Math.abs(best - info.fps) ? rate : best,
  );
  return { num: nearest, den: 1 };
};

export const settingsFor = (info: MediaInfo | undefined): ProjectSettings => {
  const width = info?.width || 1920;
  const height = info?.height || 1080;
  const scale = Math.min(1, MAX_DEFAULT_DIMENSION / Math.max(width, height));
  return {
    width: even(width * scale),
    height: even(height * scale),
    fps: projectRate(info),
    background: '#000000',
    sampleRate: DEFAULT_SAMPLE_RATE,
  };
};

export const mediaKindOf = (info: MediaInfo, isAudioFile: boolean): MediaKind =>
  isAudioFile || !info.hasVideo ? 'audio' : info.isStill ? 'image' : 'video';

export const isMovingVideo = (info: MediaInfo | null | undefined): info is MediaInfo =>
  !!info && info.hasVideo && !info.isStill;

export const hashString = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
};

export const fileName = (path: string) => path.split('?vc=')[0].split(/[\\/]/).pop() ?? path;

export const createMediaRef = (path: string, kind: MediaKind, { log, immich }: MediaOrigin = {}): MediaRef => ({
  id: uuidv4(),
  path,
  kind,
  ...(log ? { log } : {}),
  ...(immich ? { immich } : {}),
});

export const clipSpeed = (item: { speed: number }) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, item.speed || 1));

interface Sourced {
  speed: number;
  speedRamp?: Array<Keyframe> | null;
  freeze?: boolean;
  reverse?: boolean;
}

const rampOf = (item: Sourced) => (item.speedRamp?.length ? item.speedRamp : null);

export const isRamped = (item: TimelineItem | undefined) => !!item && 'speedRamp' in item && !!item.speedRamp?.length;

export const varies = (keys: Array<Keyframe> | null | undefined) => !!keys?.some((key) => key.value !== keys[0].value);

const sourceSign = (item: Sourced) => (item.reverse ? -1 : 1);

const rampSpeed = (ramp: Array<Keyframe>, frame: number, fps: FrameRate) =>
  Math.min(MAX_SPEED, Math.max(MIN_SPEED, valueAt({ value: 1, keys: ramp }, fromFrame(frame, fps))));

const rampSum = (ramp: Array<Keyframe>, from: number, to: number, fps: FrameRate, start = 0) => {
  let total = start;
  for (let frame = from; frame < to; frame += 1) total += rampSpeed(ramp, frame, fps);
  return total;
};

export const sourceOffset = (item: Sourced, local: Ticks, fps: FrameRate): Ticks => {
  if (item.freeze) return 0;
  const ramp = rampOf(item);
  if (!ramp) return sourceSign(item) * Math.round(local * clipSpeed(item));
  const frames = toFrame(local, fps);
  const total = rampSum(ramp, Math.min(0, frames), Math.max(0, frames), fps);
  return sourceSign(item) * Math.round(Math.sign(frames) * total * frameTicks(fps));
};

export const sourceLength = (item: Sourced & { duration: Ticks }, fps: FrameRate): Ticks =>
  Math.abs(sourceOffset(item, item.duration, fps));

export const sourceOffsets = (item: Sourced, locals: Array<Ticks>, fps: FrameRate): Array<Ticks> => {
  const ramp = rampOf(item);
  if (item.freeze || !ramp) return locals.map((local) => sourceOffset(item, local, fps));
  let frame = 0;
  let total = 0;
  return locals.map((local) => {
    const frames = Math.max(frame, toFrame(local, fps));
    total = rampSum(ramp, frame, frames, fps, total);
    frame = frames;
    return sourceSign(item) * Math.round(total * frameTicks(fps));
  });
};

export const sourceTimeOf = (item: TimelineItem, time: Ticks, fps: FrameRate) =>
  'sourceIn' in item
    ? item.sourceIn + sourceOffset(item, Math.max(0, Math.min(time, itemEnd(item)) - item.start), fps)
    : 0;

export const sourceFrameTicks = (fps: FrameRate, sourceFps?: number) =>
  sourceFps && sourceFps > 0 ? Math.round(TICKS_PER_SECOND / sourceFps) : frameTicks(fps);

export const frameSourceTime = (item: TimelineItem, time: Ticks, fps: FrameRate, sourceFps?: number) =>
  Math.max(
    0,
    sourceTimeOf(item, time, fps) - ('reverse' in item && item.reverse ? sourceFrameTicks(fps, sourceFps) : 0),
  );

export const localForSource = (item: Sourced, offset: Ticks, fps: FrameRate): Ticks => {
  if (item.freeze) return offset === 0 ? 0 : Math.sign(offset) * Number.POSITIVE_INFINITY;
  const source = sourceSign(item) * offset;
  const ramp = rampOf(item);
  if (!ramp || !Number.isFinite(source)) return source / clipSpeed(item);
  const step = frameTicks(fps);
  const direction = source < 0 ? -1 : 1;
  const target = Math.abs(source);
  let total = 0;
  let frames = 0;
  for (;;) {
    const frame = direction > 0 ? frames : -frames - 1;
    const speed = rampSpeed(ramp, frame, fps) * step;
    const time = fromFrame(frame, fps);
    if (direction > 0 ? time >= ramp[ramp.length - 1].time : time <= ramp[0].time) {
      frames += Math.floor((target - total) / speed);
      break;
    }
    if (total + speed > target) break;
    total += speed;
    frames += 1;
  }
  return direction * fromFrame(frames, fps);
};

const DEFAULT_CLIP_SETTINGS: ClipSettings = { in: 0, out: null, muted: false };

export const clipSettingsOf = (video: Adjustments['video']): ClipSettings => ({ ...DEFAULT_CLIP_SETTINGS, ...video });

export const trimRange = (settings: ClipSettings, duration: Ticks): [Ticks, Ticks] => {
  const start = Math.min(secondsToTicks(settings.in), duration);
  const end = settings.out === null ? duration : Math.min(secondsToTicks(settings.out), duration);
  return [start, Math.max(start, end)];
};

export const mediaDurationTicks = (info: MediaInfo | undefined, kind: MediaKind): Ticks =>
  kind === 'image' ? Number.POSITIVE_INFINITY : secondsToTicks(info?.duration ?? 0);

const overlayScale = (info: MediaInfo, settings: ProjectSettings) =>
  info.width > 0 && info.height > 0
    ? Math.min(1, Math.max(info.width / settings.width, info.height / settings.height))
    : 1;

export const createClipItem = (
  media: MediaRef,
  info: MediaInfo,
  settings: ProjectSettings,
  look: string | null,
  overlay = false,
): ClipItem => ({
  id: uuidv4(),
  type: 'clip',
  start: 0,
  duration: snapTicks(secondsToTicks(media.kind === 'image' ? STILL_SECONDS : info.duration), settings.fps),
  fadeIn: 0,
  fadeOut: 0,
  media: media.id,
  sourceIn: 0,
  speed: 1,
  volume: animated(1),
  muted: false,
  look,
  transform:
    overlay && media.kind === 'image'
      ? { ...identityTransform(), scale: animated(overlayScale(info, settings)) }
      : identityTransform(),
  fit: 'fit',
  blend: 'normal',
  transitionIn: null,
});

export const createAudioItem = (
  media: MediaRef,
  info: MediaInfo,
  start: Ticks,
  settings: ProjectSettings,
): AudioItem => ({
  id: uuidv4(),
  type: 'audio',
  start,
  duration: snapTicks(secondsToTicks(info.duration), settings.fps),
  fadeIn: 0,
  fadeOut: 0,
  media: media.id,
  sourceIn: 0,
  speed: 1,
  volume: animated(1),
  muted: false,
});

const TITLE_STYLES: Record<
  TitlePreset,
  { size: number; bold: boolean; align: TitleAlign; backdrop: boolean; y: number }
> = {
  title: { size: 0.1, bold: true, align: 'center', backdrop: false, y: 0 },
  lowerThird: { size: 0.055, bold: true, align: 'left', backdrop: true, y: 0.32 },
};

export const createTitleItem = (
  preset: TitlePreset,
  text: string,
  start: Ticks,
  duration: Ticks,
  fadeTicks: Ticks,
): TitleItem => {
  const style = TITLE_STYLES[preset];
  return {
    id: uuidv4(),
    type: 'title',
    start,
    duration,
    fadeIn: fadeTicks,
    fadeOut: fadeTicks,
    text,
    font: null,
    size: style.size,
    color: '#ffffff',
    bold: style.bold,
    italic: false,
    align: style.align,
    backdrop: style.backdrop,
    transform: { ...identityTransform(), y: animated(style.y) },
    blend: 'normal',
  };
};

export const createAdjustmentItem = (start: Ticks, duration: Ticks): AdjustmentItem => ({
  id: uuidv4(),
  type: 'adjustment',
  start,
  duration,
  fadeIn: 0,
  fadeOut: 0,
  look: null,
  opacity: animated(1),
});

export const createSolidItem = (start: Ticks, duration: Ticks, color: string): SolidItem => ({
  id: uuidv4(),
  type: 'solid',
  start,
  duration,
  fadeIn: 0,
  fadeOut: 0,
  color,
  transform: identityTransform(),
  blend: 'normal',
});

export const createProject = (name: string, settings: ProjectSettings): VideoProject => ({
  schema: PROJECT_SCHEMA,
  version: PROJECT_VERSION,
  id: uuidv4(),
  name,
  settings,
  media: [],
  looks: {},
  videoTracks: [createTrack<VisualItem>()],
  audioTracks: [createTrack<AudioItem>()],
  markers: [],
  captions: null,
  modified: Date.now(),
});

export const itemEnd = (item: TimelineItem) => item.start + item.duration;

export const mainTrack = (project: VideoProject) => project.videoTracks[0];

export const mediaOf = (project: VideoProject, id: string) => project.media.find((media) => media.id === id) ?? null;

export const mediaPathOf = (project: VideoProject, item: TimelineItem) =>
  'media' in item ? (mediaOf(project, item.media)?.path ?? null) : null;

export interface ItemLocation {
  item: TimelineItem;
  track: VideoTrack | AudioTrack;
  kind: TrackKind;
  trackIndex: number;
  index: number;
}

export const locateItem = (project: VideoProject, id: string | null): ItemLocation | null => {
  if (!id) return null;
  for (const [kind, tracks] of [
    ['video', project.videoTracks],
    ['audio', project.audioTracks],
  ] as const) {
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const track = tracks[trackIndex];
      const index = (track.items as Array<TimelineItem>).findIndex((item) => item.id === id);
      if (index >= 0) return { item: track.items[index], track, kind, trackIndex, index };
    }
  }
  return null;
};

export const allItems = (timeline: Sequence): Array<TimelineItem> => [
  ...timeline.videoTracks.flatMap((track) => track.items),
  ...timeline.audioTracks.flatMap((track) => track.items),
];

export const allTimelines = (project: VideoProject): Array<Sequence> => [
  project,
  ...Object.values(project.sequences ?? {}),
];

export const sequenceDuration = (project: VideoProject): Ticks =>
  Math.max(
    0,
    ...allItems(project).map(itemEnd),
    ...(project.captions?.enabled ? project.captions.items.map((caption) => caption.start + caption.duration) : []),
  );

export const hasLook = (item: TimelineItem): item is ClipItem | AdjustmentItem =>
  item.type === 'clip' || item.type === 'adjustment';

export const lookOf = (project: VideoProject, item: TimelineItem): Adjustments | null =>
  hasLook(item) && item.look ? (project.looks[item.look] ?? null) : null;

const fill = <T extends object>(defaults: T, value: unknown): T =>
  value && typeof value === 'object' ? { ...defaults, ...(value as Partial<T>) } : defaults;

const normalizeItem = (item: TimelineItem): TimelineItem => {
  const base = { ...item, fadeIn: item.fadeIn ?? 0, fadeOut: item.fadeOut ?? 0 };
  switch (item.type) {
    case 'clip':
      return {
        speed: 1,
        volume: animated(1),
        muted: false,
        look: null,
        fit: 'fit',
        blend: 'normal',
        transitionIn: null,
        ...base,
        transform: fill(identityTransform(), (item as ClipItem).transform),
      } as ClipItem;
    case 'title':
    case 'solid':
      return {
        blend: 'normal',
        ...base,
        transform: fill(identityTransform(), item.transform),
      } as VisualItem;
    case 'adjustment':
      return { look: null, opacity: animated(1), ...base } as AdjustmentItem;
    default:
      return { speed: 1, volume: animated(1), muted: false, ...base } as AudioItem;
  }
};

const normalizeTracks = (value: { videoTracks?: Array<VideoTrack>; audioTracks?: Array<AudioTrack> }) => ({
  videoTracks: (value.videoTracks?.length ? value.videoTracks : [createTrack<VisualItem>()]).map((track) => ({
    ...createTrack<VisualItem>(),
    ...track,
    items: track.items.map((item) => normalizeItem(item) as VisualItem),
  })),
  audioTracks: (value.audioTracks?.length ? value.audioTracks : [createTrack<AudioItem>()]).map((track) => ({
    ...createTrack<AudioItem>(),
    ...track,
    items: track.items.map((item) => normalizeItem(item) as AudioItem),
  })),
});

export const normalizeProject = (raw: unknown): VideoProject | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<VideoProject>;
  if (!Array.isArray(value.videoTracks) || !value.settings) return null;
  const settings = { ...settingsFor(undefined), ...value.settings };
  return {
    ...(value as VideoProject),
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    media: value.media ?? [],
    looks: value.looks ?? {},
    markers: value.markers ?? [],
    captions: value.captions ?? null,
    settings,
    ...normalizeTracks(value),
    sequences: Object.fromEntries(
      Object.entries(value.sequences ?? {}).map(([id, sequence]) => [
        id,
        {
          ...sequence,
          markers: sequence.markers ?? [],
          captions: sequence.captions ?? null,
          ...normalizeTracks(sequence),
        },
      ]),
    ),
  };
};
