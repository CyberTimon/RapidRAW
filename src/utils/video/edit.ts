import { v4 as uuidv4 } from 'uuid';
import {
  Animated,
  AudioItem,
  AudioTrack,
  ClipItem,
  Ease,
  FrameRate,
  Keyframe,
  Marker,
  MediaKind,
  MediaOrigin,
  MediaRef,
  Motion,
  MotionTrack,
  Sequence,
  Ticks,
  TimeRange,
  TimelineItem,
  TrackAnchor,
  TrackKind,
  Transition,
  TransitionKind,
  VideoProject,
  VideoTrack,
  VisualItem,
} from '../../types/video';
import type { Adjustments } from '../adjustments';
import {
  EaseChoice,
  EasePreset,
  easeAt,
  isAnimated,
  moveKeyAt,
  removeKeyAt,
  scaleKeys,
  setEaseAt,
  shiftKeys,
  toggleKeyAt,
  valueAt,
  withEaseOf,
} from './animation';
import { isDirectional } from './effectRegistry';
import {
  addKeys,
  channelsOf,
  easeKeys,
  lookTimeOf,
  moveKeys,
  numericLeaves,
  removeKeys,
  stopAnimating,
  timelineTimeOf,
  withChannelKeys,
} from './lookAnimation';
import { channelGroupOf } from './maskPaths';
import { TrackedContainer, joinTracks, shiftTrack, trackSpan } from './maskTracking';
import {
  ItemLocation,
  MAX_SPEED,
  MIN_SPEED,
  allItems,
  allTimelines,
  clipSpeed,
  createMediaRef,
  createTrack,
  hasLook,
  isRamped,
  itemEnd,
  localForSource,
  locateItem,
  lookOf,
  mainTrack,
  mediaOf,
  sequenceDuration,
  sourceFrameTicks,
  sourceLength,
  sourceOffset,
  sourceTimeOf,
  frameSourceTime,
  varies,
} from './model';
import { frameTicks, fromFrame, secondsToTicks, snapTicks, ticksToSeconds, toFrame } from './time';
import { pinnedQuad, placementAt } from './tracking';
import { scaleQuad } from './planar';

const MIN_ITEM_FRAMES = 2;
export const DEFAULT_TRANSITION_SECONDS = 0.5;

export const minItemDuration = (fps: FrameRate) => frameTicks(fps) * MIN_ITEM_FRAMES;

export const halfDuration = (duration: Ticks, fps: FrameRate): Ticks =>
  fromFrame(Math.floor(toFrame(duration, fps) / 2), fps);

export const transitionLimit = (previous: { duration: Ticks }, item: { duration: Ticks }, fps: FrameRate): Ticks =>
  Math.min(halfDuration(previous.duration, fps), halfDuration(item.duration, fps));

const tracksOf = (project: VideoProject, kind: TrackKind) =>
  (kind === 'video' ? project.videoTracks : project.audioTracks) as Array<VideoTrack | AudioTrack>;

const withTracks = (project: VideoProject, kind: TrackKind, tracks: Array<VideoTrack | AudioTrack>): VideoProject =>
  kind === 'video'
    ? { ...project, videoTracks: tracks as Array<VideoTrack> }
    : { ...project, audioTracks: tracks as Array<AudioTrack> };

const withTrackItems = (
  project: VideoProject,
  kind: TrackKind,
  trackIndex: number,
  items: Array<TimelineItem>,
): VideoProject =>
  withTracks(
    project,
    kind,
    tracksOf(project, kind).map((track, index) => (index === trackIndex ? { ...track, items } : track)) as Array<
      VideoTrack | AudioTrack
    >,
  );

const transitionOverlap = (project: VideoProject, previous: VisualItem | undefined, item: VisualItem): Ticks => {
  if (!previous || item.type !== 'clip' || !item.transitionIn) return 0;
  const fps = project.settings.fps;
  return Math.max(0, Math.min(snapTicks(item.transitionIn.duration, fps), transitionLimit(previous, item, fps)));
};

const mapTracks = (
  project: VideoProject,
  map: <T extends VideoTrack | AudioTrack>(track: T, kind: TrackKind, trackIndex: number) => T,
): VideoProject => ({
  ...project,
  videoTracks: project.videoTracks.map((track, index) => map(track, 'video', index)),
  audioTracks: project.audioTracks.map((track, index) => map(track, 'audio', index)),
});

const isMainTrack = (kind: TrackKind, trackIndex: number) => kind === 'video' && trackIndex === 0;

const followLinks = (
  project: VideoProject,
  shifts: Map<string, Ticks>,
  fixed: (kind: TrackKind, trackIndex: number) => boolean,
): VideoProject =>
  mapTracks(project, (track, kind, trackIndex) => {
    const items = track.items as Array<TimelineItem>;
    const shiftOf = (item: TimelineItem) => (item.link ? (shifts.get(item.link) ?? 0) : 0);
    if (fixed(kind, trackIndex) || !items.some(shiftOf)) return track;
    return {
      ...track,
      items: sortByStart(
        items.map((item) => (shiftOf(item) ? { ...item, start: Math.max(0, item.start + shiftOf(item)) } : item)),
      ),
    } as typeof track;
  });

export const gapOf = (item: TimelineItem) => (item.type === 'clip' ? (item.gap ?? 0) : 0);

export const withGap = <T extends TimelineItem>(item: T, gap: Ticks): T => {
  if (item.type !== 'clip' || gapOf(item) === gap) return item;
  const { gap: _gap, ...rest } = item as ClipItem;
  return (gap > 0 ? { ...rest, gap } : rest) as T;
};

const withMainGap = (project: VideoProject, id: string, gap: Ticks): VideoProject =>
  withTrackItems(
    project,
    'video',
    0,
    mainTrack(project).items.map((item) => (item.id === id ? withGap(item, gap) : item)),
  );

const keepGaps = (items: Array<VisualItem>, drop: Set<string>): Array<VisualItem> => {
  let carry = 0;
  return items.flatMap((item) => {
    if (drop.has(item.id)) {
      carry += gapOf(item);
      return [];
    }
    const kept = carry > 0 ? withGap(item, gapOf(item) + carry) : item;
    carry = 0;
    return [kept];
  });
};

const normalizeMain = (project: VideoProject): VideoProject => {
  const items = mainTrack(project).items;
  let end = 0;
  let changed = false;
  const shifts = new Map<string, Ticks>();
  const placed = items.map((item, index) => {
    const gap = gapOf(item);
    const start = Math.max(0, end - (gap > 0 ? 0 : transitionOverlap(project, items[index - 1], item))) + gap;
    end = start + item.duration;
    const cleared = gap > 0 && item.type === 'clip' && item.transitionIn ? { ...item, transitionIn: null } : item;
    if (start === item.start && cleared === item) return item;
    changed = true;
    if (item.link && start !== item.start) shifts.set(item.link, start - item.start);
    return { ...cleared, start };
  });
  if (!changed) return project;
  const packed = withTrackItems(project, 'video', 0, placed);
  return shifts.size > 0 ? followLinks(packed, shifts, isMainTrack) : packed;
};

const separateLinked = (project: VideoProject): VideoProject => {
  const evicted: Array<[TimelineItem, number]> = [];
  const separated = mapTracks(project, (track, kind, trackIndex) => {
    if (kind === 'video' && trackIndex === 0) return track;
    const kept: Array<TimelineItem> = [];
    (track.items as Array<TimelineItem>).forEach((item) => {
      const clashes = kept.filter((other) => other.start < itemEnd(item) && item.start < itemEnd(other));
      if (clashes.length > 0 && item.link) {
        evicted.push([item, trackIndex]);
        return;
      }
      if (clashes.length > 0 && clashes.every((other) => other.link)) {
        clashes.forEach((other) => {
          kept.splice(kept.indexOf(other), 1);
          evicted.push([other, trackIndex]);
        });
      }
      kept.push(item);
    });
    return kept.length === track.items.length ? track : ({ ...track, items: kept } as typeof track);
  });
  return evicted.length === 0
    ? project
    : evicted.reduce((next, [item, trackIndex]) => placeItem(next, item, trackIndex), separated);
};

const pruneTracks = (project: VideoProject): VideoProject => {
  const keep = <T extends { items: Array<unknown> }>(tracks: Array<T>) =>
    tracks.filter((track, index) => index === 0 || track.items.length > 0);
  const videoTracks = keep(project.videoTracks);
  const audioTracks = keep(project.audioTracks);
  return videoTracks.length === project.videoTracks.length && audioTracks.length === project.audioTracks.length
    ? project
    : { ...project, videoTracks, audioTracks };
};

export const tidy = (project: VideoProject) => pruneTracks(separateLinked(normalizeMain(project)));

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity', 'radius'] as const;

type TrackMerge = (
  track: MotionTrack | null | undefined,
  partner: MotionTrack | null | undefined,
) => MotionTrack | null | undefined;

const zipAnimated = <T extends TimelineItem>(
  item: T,
  other: T,
  merge: (value: Animated, partner: Animated) => Animated,
  mergeTrack: TrackMerge = (track) => track,
): T => {
  const next = { ...item } as T & Record<string, unknown>;
  if ('transform' in item && 'transform' in other) {
    const transform = { ...item.transform };
    TRANSFORM_KEYS.forEach((key) => {
      transform[key] = merge(transform[key], other.transform[key]);
    });
    const track = mergeTrack(item.transform.track, other.transform.track);
    if (track !== item.transform.track) {
      if (track) transform.track = track;
      else delete transform.track;
    }
    (next as { transform: typeof transform }).transform = transform;
  }
  if ('volume' in item && 'volume' in other) (next as { volume: Animated }).volume = merge(item.volume, other.volume);
  if ('opacity' in item && 'opacity' in other)
    (next as { opacity: Animated }).opacity = merge(item.opacity, other.opacity);
  const clip = item as TimelineItem;
  const partner = other as TimelineItem;
  if ((isRamped(clip) || isRamped(partner)) && 'speed' in clip && 'speed' in partner && clip.type === partner.type) {
    const ramp = merge(
      { value: clip.speed, keys: clip.speedRamp ?? undefined },
      { value: partner.speed, keys: partner.speedRamp ?? undefined },
    );
    (next as ClipItem | AudioItem).speedRamp = ramp.keys?.length ? ramp.keys : null;
  }
  return next;
};

const mapAnimated = <T extends TimelineItem>(
  item: T,
  map: (value: Animated) => Animated,
  mapTrack?: (track: MotionTrack) => MotionTrack | null,
): T => zipAnimated(item, item, map, (track) => (track && mapTrack ? mapTrack(track) : track));

const sortByStart = <T extends TimelineItem>(items: Array<T>) => [...items].sort((a, b) => a.start - b.start);

const onMain = (location: ItemLocation) => location.kind === 'video' && location.trackIndex === 0;

export const mainSlotOf = (project: VideoProject, id: string | null) => {
  const location = locateItem(project, id);
  return location && onMain(location) ? location.index : null;
};

export const linkedIds = (project: VideoProject, ids: Array<string>): Array<string> => {
  const links = new Set(ids.map((id) => locateItem(project, id)?.item.link).filter((link) => !!link));
  if (links.size === 0) return ids;
  const partners = allItems(project)
    .filter((item) => item.link && links.has(item.link) && !ids.includes(item.id))
    .map((item) => item.id);
  return partners.length === 0 ? ids : [...ids, ...partners];
};

export const groupLeaders = (project: VideoProject, ids: Array<string>) =>
  ids.filter((id, index) => !linkedIds(project, ids.slice(0, index)).includes(id));

export const pairedLinks = (project: VideoProject) => {
  const seen = new Set<string>();
  const paired = new Set<string>();
  allItems(project).forEach(({ link }) => {
    if (link) (seen.has(link) ? paired : seen).add(link);
  });
  return paired;
};

const mainLinks = (project: VideoProject, except: Set<string> = new Set()) =>
  new Set(
    mainTrack(project)
      .items.filter((item) => item.link && !except.has(item.id))
      .map((item) => item.link),
  );

export const relinker = (items: Array<TimelineItem>) => {
  const counts = new Map<string, number>();
  items.forEach(({ link }) => {
    if (link) counts.set(link, (counts.get(link) ?? 0) + 1);
  });
  const fresh = new Map([...counts].filter(([, count]) => count > 1).map(([link]) => [link, uuidv4()]));
  return <T extends TimelineItem>(item: T): T => ({ ...item, link: item.link ? fresh.get(item.link) : undefined });
};

const setLinks = (project: VideoProject, link: (item: TimelineItem) => string | undefined | null) =>
  mapTracks(
    project,
    (track) =>
      ({
        ...track,
        items: (track.items as Array<TimelineItem>).map((item) => {
          const next = link(item);
          return next === null ? item : { ...item, link: next };
        }),
      }) as typeof track,
  );

export const canLink = (project: VideoProject, ids: Array<string>) => {
  const links = ids.flatMap((id) => locateItem(project, id) ?? []).map(({ item }) => item.link);
  return links.length > 1 && !(links[0] && links.every((link) => link === links[0]));
};

export const linkItems = (project: VideoProject, ids: Array<string>) => {
  const link = uuidv4();
  const chosen = new Set(ids);
  return setLinks(project, (item) => (chosen.has(item.id) ? link : null));
};

export const unlinkItems = (project: VideoProject, ids: Array<string>) => {
  const links = new Set(ids.map((id) => locateItem(project, id)?.item.link).filter((link) => !!link));
  return setLinks(project, (item) => (item.link && links.has(item.link) ? undefined : null));
};

const isFree = (items: Array<TimelineItem>, start: Ticks, end: Ticks, ignore?: string) =>
  items.every((item) => item.id === ignore || itemEnd(item) <= start || item.start >= end);

const trackRoom = ({ item, track }: ItemLocation, moving: Array<string> = [item.id]) => {
  const others = (track.items as Array<TimelineItem>).filter((other) => !moving.includes(other.id));
  return {
    earliest: Math.max(0, ...others.filter((other) => itemEnd(other) <= item.start).map(itemEnd)),
    latest: Math.min(
      Number.POSITIVE_INFINITY,
      ...others.filter((other) => other.start >= itemEnd(item)).map((other) => other.start),
    ),
  };
};

const firstFreeTrack = (
  project: VideoProject,
  kind: TrackKind,
  start: Ticks,
  end: Ticks,
  preferred: number | null,
  ignore?: string,
) => {
  const tracks = tracksOf(project, kind);
  const lowest = kind === 'video' ? 1 : 0;
  const candidates = [
    ...(preferred !== null && preferred >= lowest && preferred < tracks.length ? [preferred] : []),
    ...tracks.map((_, index) => index).filter((index) => index >= lowest && index !== preferred),
  ];
  return candidates.find((index) => isFree(tracks[index].items, start, end, ignore)) ?? null;
};

export const placeItem = (
  project: VideoProject,
  item: TimelineItem,
  preferredTrack: number | null = null,
  forceNewTrack = false,
): VideoProject => {
  const kind: TrackKind = item.type === 'audio' ? 'audio' : 'video';
  const start = Math.max(0, item.start);
  const placed = { ...item, start };
  const free = forceNewTrack ? null : firstFreeTrack(project, kind, start, start + item.duration, preferredTrack);
  if (free !== null) {
    const tracks = tracksOf(project, kind);
    return withTrackItems(project, kind, free, sortByStart([...tracks[free].items, placed] as Array<TimelineItem>));
  }
  const track = kind === 'video' ? createTrack<VisualItem>() : createTrack<AudioItem>();
  const tracks = [...tracksOf(project, kind), { ...track, items: [placed] }] as Array<VideoTrack | AudioTrack>;
  return withTracks(project, kind, tracks);
};

const placeOn = (project: VideoProject, item: TimelineItem, trackIndex: number, newTrack = false) => {
  const placed = { ...item, start: Math.max(0, item.start) } as TimelineItem;
  const tracks = tracksOf(project, item.type === 'audio' ? 'audio' : 'video');
  const fits =
    !newTrack && trackIndex < tracks.length && isFree(tracks[trackIndex].items, placed.start, itemEnd(placed));
  return placeItem(project, placed, fits ? trackIndex : null, !fits);
};

export const insertMainClips = (project: VideoProject, clips: Array<ClipItem>, index: number, gap: Ticks = 0) => {
  const items = [...mainTrack(project).items];
  items.splice(
    Math.max(0, Math.min(index, items.length)),
    0,
    ...clips.map((clip, position) => (position === 0 ? withGap(clip, gap) : clip)),
  );
  return normalizeMain(withTrackItems(project, 'video', 0, items));
};

const slotAt = (items: Array<VisualItem>, time: Ticks) => {
  const index = items.findIndex((item) => time < item.start + item.duration / 2);
  return index < 0 ? items.length : index;
};

const mainIndexAt = (project: VideoProject, time: Ticks) => slotAt(mainTrack(project).items, time);

const blockSpan = (clips: Array<ClipItem>) =>
  clips.reduce((span, clip, index) => span + clip.duration + (index > 0 ? gapOf(clip) : 0), 0);

const landBetween = (
  project: VideoProject,
  previous: VisualItem | undefined,
  next: VisualItem | undefined,
  start: Ticks,
  span: Ticks,
) => {
  const earliest = previous ? itemEnd(previous) : 0;
  const landing = Math.max(earliest, next ? Math.min(start, next.start) : start);
  const room = next ? withMainGap(project, next.id, Math.max(0, next.start - (landing + span))) : project;
  return { room, gap: landing - earliest };
};

const landOnMain = (project: VideoProject, clips: Array<ClipItem>, index: number, start: Ticks, span: Ticks) => {
  const items = mainTrack(project).items;
  const { room, gap } = landBetween(project, items[index - 1], items[index], start, span);
  return insertMainClips(room, clips, index, gap);
};

const withoutMain = (project: VideoProject, drop: Set<string>) =>
  normalizeMain(withTrackItems(project, 'video', 0, keepGaps(mainTrack(project).items, drop)));

const moveMainBlock = (project: VideoProject, block: Array<ClipItem>, start: Ticks, pointer: Ticks) => {
  const ids = new Set(block.map((item) => item.id));
  const items = mainTrack(project).items;
  const others = items.filter((item) => !ids.has(item.id));
  const index = slotAt(others, pointer);
  const span = itemEnd(block[block.length - 1]) - block[0].start;
  if (items.findIndex((item) => item.id === block[0].id) === index) {
    const { room, gap } = landBetween(project, others[index - 1], others[index], start, span);
    return normalizeMain(withMainGap(room, block[0].id, gap));
  }
  return landOnMain(withoutMain(project, ids), block, index, start, span);
};

interface MainGap {
  id: string;
  start: Ticks;
  end: Ticks;
}

export const mainGaps = (project: VideoProject): Array<MainGap> =>
  mainTrack(project).items.flatMap((item) =>
    gapOf(item) > 0 ? [{ id: item.id, start: item.start - gapOf(item), end: item.start }] : [],
  );

export const closeGap = (project: VideoProject, id: string) => tidy(withMainGap(project, id, 0));

export const closeAllGaps = (project: VideoProject) =>
  tidy(mainGaps(project).reduce((next, gap) => withMainGap(next, gap.id, 0), project));

export interface MediaTarget {
  mainIndex?: number;
  time?: Ticks;
  trackIndex?: number | null;
  audioTrack?: number | null;
}

export const overlayTrackOf = (at: MediaTarget) => (at.trackIndex && at.trackIndex > 0 ? at.trackIndex : null);

export const placeMedia = (project: VideoProject, items: Array<ClipItem | AudioItem>, at: MediaTarget) => {
  const start = snapTicks(at.time ?? 0, project.settings.fps);
  const overlay = overlayTrackOf(at);
  const clips: Array<ClipItem> = [];
  let audioTime = start;
  let clipTime = start;
  let next = project;
  for (const item of items) {
    if (item.type === 'audio') {
      const track = at.audioTrack ?? 0;
      next = placeItem(next, { ...item, start: audioTime }, track, track >= next.audioTracks.length);
      audioTime += item.duration;
    } else if (overlay !== null) {
      next = placeItem(next, { ...item, start: clipTime }, overlay, overlay >= next.videoTracks.length);
      clipTime += item.duration;
    } else {
      clips.push(item);
    }
  }
  if (clips.length === 0) return tidy(next);
  if (at.mainIndex !== undefined || at.time === undefined) {
    return tidy(insertMainClips(next, clips, at.mainIndex ?? mainTrack(next).items.length));
  }
  const landing = mainTrack(next).items.length > 0 ? start : 0;
  return tidy(landOnMain(next, clips, mainIndexAt(next, at.time), landing, blockSpan(clips)));
};

export const updateItem = <T extends TimelineItem>(
  project: VideoProject,
  id: string,
  patch: Partial<T> | ((item: T) => T),
): VideoProject => {
  const location = locateItem(project, id);
  if (!location) return project;
  const current = location.item as T;
  const next = typeof patch === 'function' ? patch(current) : ({ ...current, ...patch } as T);
  if (next === current) return project;
  const items = [...location.track.items] as Array<TimelineItem>;
  items[location.index] = next;
  const updated = withTrackItems(project, location.kind, location.trackIndex, items);
  return location.kind === 'video' && location.trackIndex === 0 ? normalizeMain(updated) : updated;
};

export const removeItems = (project: VideoProject, ids: Array<string>) => {
  const drop = new Set(ids);
  const filter = <T extends VideoTrack | AudioTrack>(tracks: Array<T>, main: boolean) =>
    tracks.map((track, index) =>
      track.items.some((item) => drop.has(item.id))
        ? {
            ...track,
            items:
              main && index === 0
                ? keepGaps(track.items as Array<VisualItem>, drop)
                : (track.items as Array<TimelineItem>).filter((item) => !drop.has(item.id)),
          }
        : track,
    ) as Array<T>;
  return tidy({
    ...project,
    videoTracks: filter(project.videoTracks, true),
    audioTracks: filter(project.audioTracks, false),
  });
};

export const advanceStart = (item: TimelineItem, delta: Ticks, fps: FrameRate): TimelineItem =>
  mapAnimated(
    {
      ...item,
      start: item.start + delta,
      duration: item.duration - delta,
      ...('sourceIn' in item ? { sourceIn: Math.max(0, item.sourceIn + sourceOffset(item, delta, fps)) } : {}),
    } as TimelineItem,
    (value) => shiftKeys(value, -delta),
    (track) => shiftTrack(track, -ticksToSeconds(delta)),
  );

export const splitOne = (project: VideoProject, id: string, time: Ticks, link?: string): VideoProject => {
  const location = locateItem(project, id);
  if (!location) return project;
  const { item } = location;
  const offset = time - item.start;
  const min = minItemDuration(project.settings.fps);
  if (offset < min || item.duration - offset < min) return project;
  const head = { ...item, duration: offset, fadeOut: 0, ...('animOut' in item ? { animOut: null } : {}) };
  const tail = advanceStart(
    withGap(
      {
        ...item,
        id: uuidv4(),
        ...(link ? { link } : {}),
        fadeIn: 0,
        ...('animIn' in item ? { animIn: null } : {}),
        ...(item.type === 'clip' ? { transitionIn: null } : {}),
      } as TimelineItem,
      0,
    ),
    offset,
    project.settings.fps,
  );
  const items = [...location.track.items] as Array<TimelineItem>;
  items.splice(location.index, 1, head as TimelineItem, tail);
  return tidy(withTrackItems(project, location.kind, location.trackIndex, items));
};

export const splitItem = (project: VideoProject, id: string, time: Ticks): VideoProject => {
  const link = locateItem(project, id)?.item.link ? uuidv4() : undefined;
  const split = splitOne(project, id, time, link);
  if (split === project) return project;
  return linkedIds(project, [id])
    .filter((member) => member !== id)
    .reduce((current, member) => splitOne(current, member, time, link), split);
};

const trimLimits = (project: VideoProject, item: TimelineItem, mediaDuration: Ticks) => {
  if (!('sourceIn' in item) || !Number.isFinite(mediaDuration) || (item.type === 'clip' && item.freeze)) {
    return { earliest: Number.NEGATIVE_INFINITY, latest: Number.POSITIVE_INFINITY };
  }
  const fps = project.settings.fps;
  const bounds = [localForSource(item, -item.sourceIn, fps), localForSource(item, mediaDuration - item.sourceIn, fps)];
  return { earliest: item.start + Math.min(...bounds), latest: item.start + Math.max(...bounds) };
};

const trimOne = (
  project: VideoProject,
  id: string,
  edge: 'start' | 'end',
  edgeTime: Ticks,
  mediaDuration: Ticks,
  ripples: boolean,
): VideoProject => {
  const location = locateItem(project, id);
  if (!location) return project;
  const { item } = location;
  const min = minItemDuration(project.settings.fps);
  const limits = trimLimits(project, item, mediaDuration);
  const room = ripples ? { earliest: Number.NEGATIVE_INFINITY, latest: Number.POSITIVE_INFINITY } : trackRoom(location);
  if (edge === 'end') {
    const duration = Math.max(min, Math.min(edgeTime, limits.latest, room.latest) - item.start);
    return updateItem<TimelineItem>(project, id, { duration });
  }
  const start = Math.min(itemEnd(item) - min, Math.max(edgeTime, limits.earliest, room.earliest));
  return updateItem(project, id, (current: TimelineItem) =>
    advanceStart(current, start - current.start, project.settings.fps),
  );
};

export type MediaDurations = (item: TimelineItem) => Ticks;

export const trimItem = (
  project: VideoProject,
  id: string,
  edge: 'start' | 'end',
  edgeTime: Ticks,
  durations: MediaDurations,
): VideoProject => {
  const item = locateItem(project, id)?.item;
  if (!item) return project;
  const edgeOf = (member: TimelineItem) => (edge === 'start' ? member.start : itemEnd(member));
  const located = linkedIds(project, [id]).flatMap((member) => locateItem(project, member) ?? []);
  const members = located.sort((a, b) => Number(onMain(a)) - Number(onMain(b))).map((location) => location.item);
  const ripples = located.some(onMain);
  const reach = (member: TimelineItem, wanted: Ticks) => {
    const trimmed = locateItem(
      trimOne(project, member.id, edge, edgeOf(member) + wanted, durations(member), ripples),
      member.id,
    );
    const grown = trimmed ? trimmed.item.duration - member.duration : 0;
    return edge === 'start' ? -grown : grown;
  };
  const delta = members.reduce(
    (wanted, member) => {
      const reached = reach(member, wanted);
      return Math.abs(reached) < Math.abs(wanted) ? reached : wanted;
    },
    edgeTime - edgeOf(item),
  );
  const trimmed = members.reduce((current, member) => {
    const now = locateItem(current, member.id)?.item;
    return now ? trimOne(current, member.id, edge, edgeOf(now) + delta, durations(now), ripples) : current;
  }, project);
  return members.length > 1 ? tidy(trimmed) : trimmed;
};

export interface MoveTarget {
  kind: TrackKind;
  trackIndex: number;
  start: Ticks;
  newTrack?: boolean;
}

export const moveItems = (
  project: VideoProject,
  ids: Array<string>,
  id: string,
  target: MoveTarget,
  at: Ticks,
): VideoProject => {
  const members = [id, ...ids.filter((member) => member !== id)].flatMap((member) => locateItem(project, member) ?? []);
  const [dragged] = members;
  if (dragged?.item.id !== id || (dragged.item.type === 'audio') !== (target.kind === 'audio')) return project;
  const toMain = target.kind === 'video' && target.trackIndex === 0 && !target.newTrack;
  const main = members.filter(onMain).sort((a, b) => a.index - b.index);
  const contiguous = main.every((location, offset) => location.index === main[0].index + offset);
  const leaves = onMain(dragged) && !toMain && main.length === 1;
  const enters = !onMain(dragged) && toMain && main.length === 0 && dragged.item.type === 'clip';
  const block = enters ? [dragged] : contiguous && !leaves ? main : [];
  const anchors = mainLinks(project, new Set(leaves ? [id] : []));
  if (enters && dragged.item.link) anchors.add(dragged.item.link);
  const free = members
    .filter((location) => (leaves || !onMain(location)) && !block.includes(location))
    .filter((location) => !location.item.link || !anchors.has(location.item.link) || (leaves && location === dragged));
  const moving = [...block, ...free].map((location) => location.item.id);
  const lifted = [...block.filter((location) => !onMain(location)), ...free].map((location) => location.item.id);
  let next = removeItemsKeepTracks(withoutMain(project, new Set(lifted)), lifted);
  if (block.length > 0) {
    const offset = block[0].item.start - dragged.item.start;
    next = moveMainBlock(
      next,
      block.map((location) => (onMain(location) ? location.item : withGap(location.item, 0)) as ClipItem),
      Math.max(0, target.start + offset),
      block.includes(dragged) ? at : at + offset,
    );
  }
  const earliest = Math.min(...free.map((location) => location.item.start));
  const shift = block.includes(dragged)
    ? (locateItem(next, id)?.item.start ?? dragged.item.start) - dragged.item.start
    : Math.max(target.start - dragged.item.start, -earliest);
  next = free.reduce((current, location) => {
    const placed = withGap({ ...location.item, start: location.item.start + shift } as TimelineItem, 0);
    return location === dragged && !toMain
      ? placeOn(current, placed, target.trackIndex, target.newTrack)
      : placeOn(current, placed, location.trackIndex);
  }, next);
  const follower = locateItem(next, id);
  if (
    follower &&
    !moving.includes(id) &&
    !onMain(follower) &&
    !toMain &&
    (target.newTrack || target.trackIndex !== follower.trackIndex)
  ) {
    next = placeOn(removeItemsKeepTracks(next, [id]), follower.item, target.trackIndex, target.newTrack);
  }
  return tidy(next);
};

export const removeItemsKeepTracks = (project: VideoProject, ids: Array<string>) => {
  const drop = new Set(ids);
  const strip = <T extends VideoTrack | AudioTrack>(tracks: Array<T>) =>
    tracks.map((track) => ({
      ...track,
      items: (track.items as Array<TimelineItem>).filter((item) => !drop.has(item.id)),
    })) as Array<T>;
  return normalizeMain({
    ...project,
    videoTracks: strip(project.videoTracks),
    audioTracks: strip(project.audioTracks),
  });
};

export const duplicateItems = (project: VideoProject, ids: Array<string>): VideoProject => {
  const relink = relinker(ids.flatMap((id) => locateItem(project, id)?.item ?? []));
  const shifts = new Map<string, Ticks>();
  const mainIds = new Set(mainTrack(project).items.map((item) => item.id));
  const ordered = [...ids].sort((a, b) => Number(mainIds.has(b)) - Number(mainIds.has(a)));
  return ordered.reduce((current, id) => {
    const location = locateItem(current, id);
    if (!location) return current;
    const copy = relink({ ...location.item, id: uuidv4() } as TimelineItem);
    if (onMain(location)) {
      const next = insertMainClips(current, [{ ...(copy as ClipItem), transitionIn: null }], location.index + 1);
      const placed = locateItem(next, copy.id)?.item;
      if (copy.link && placed) shifts.set(copy.link, placed.start - location.item.start);
      return next;
    }
    const shift = (copy.link ? shifts.get(copy.link) : undefined) ?? location.item.duration;
    if (copy.link) shifts.set(copy.link, shift);
    return tidy(placeItem(current, { ...copy, start: location.item.start + shift }, location.trackIndex));
  }, project);
};

export const setTransition = (project: VideoProject, clipId: string, transition: Transition | null) =>
  tidy(updateItem<ClipItem>(project, clipId, { transitionIn: transition }));

const fitTransition = (
  project: VideoProject,
  clipId: string,
  update: (current: Transition | null) => Transition | null,
): VideoProject => {
  const items = mainTrack(project).items;
  const index = items.findIndex((item) => item.id === clipId);
  const item = items[index];
  if (index < 1 || item.type !== 'clip' || gapOf(item) > 0) return project;
  const current = item.transitionIn;
  const next = update(current);
  if (!next) return project;
  const fps = project.settings.fps;
  const limit = transitionLimit(items[index - 1], item, fps);
  const fitted = { ...next, duration: Math.max(frameTicks(fps), Math.min(limit, snapTicks(next.duration, fps))) };
  const same =
    current?.kind === fitted.kind && current.duration === fitted.duration && current.direction === fitted.direction;
  return same ? project : setTransition(project, clipId, fitted);
};

export const withTransitionKind = (project: VideoProject, clipId: string, kind: TransitionKind | null) =>
  kind
    ? fitTransition(project, clipId, (current) => ({
        kind,
        duration: current?.duration ?? secondsToTicks(DEFAULT_TRANSITION_SECONDS),
        ...(isDirectional(kind) ? { direction: current?.direction ?? 'left' } : {}),
      }))
    : setTransition(project, clipId, null);

export const setTransitionDuration = (project: VideoProject, clipId: string, duration: Ticks) =>
  fitTransition(project, clipId, (current) => current && { ...current, duration });

export const addMedia = (
  project: VideoProject,
  path: string,
  kind: MediaKind,
  origin?: MediaOrigin,
): [VideoProject, MediaRef] => {
  const existing = project.media.find((media) => media.path === path);
  if (existing) return [project, existing];
  const media = createMediaRef(path, kind, origin);
  return [{ ...project, media: [...project.media, media] }, media];
};

export const patchMedia = (
  project: VideoProject,
  mediaId: string,
  patch: Partial<Omit<MediaRef, 'id'>>,
): VideoProject => ({
  ...project,
  media: project.media.map((media) => (media.id === mediaId ? { ...media, ...patch } : media)),
});

const rangeWithEdge = (
  range: TimeRange | null | undefined,
  edge: keyof TimeRange,
  time: Ticks,
  end: Ticks,
): TimeRange | null => {
  const current = range ?? { start: 0, end };
  const next =
    edge === 'start'
      ? { start: time, end: current.end > time ? current.end : end }
      : { start: current.start < time ? current.start : 0, end: time };
  return next.end > next.start ? next : null;
};

export const mediaRangeWithin = (range: TimeRange | null | undefined, duration: Ticks): TimeRange | null =>
  range && range.start < duration ? { start: range.start, end: Math.min(range.end, duration) } : null;

export const setMediaRangeEdge = (
  project: VideoProject,
  mediaId: string,
  edge: keyof TimeRange,
  time: Ticks,
  duration: Ticks,
): VideoProject => {
  const media = project.media.find((entry) => entry.id === mediaId);
  const range = media ? rangeWithEdge(mediaRangeWithin(media.range, duration), edge, time, duration) : null;
  return range ? patchMedia(project, mediaId, { range }) : project;
};

const setLook = (project: VideoProject, lookId: string, look: Adjustments): VideoProject => ({
  ...project,
  looks: { ...project.looks, [lookId]: look },
});

export const assignLook = (project: VideoProject, itemId: string, look: Adjustments): [VideoProject, string] => {
  const location = locateItem(project, itemId);
  const item = location?.item;
  if (!item || !hasLook(item)) return [project, ''];
  if (item.look) return [setLook(project, item.look, look), item.look];
  const lookId = uuidv4();
  return [updateItem(setLook(project, lookId, look), itemId, { look: lookId }), lookId];
};

export const lookUsers = (project: VideoProject, lookId: string) =>
  allTimelines(project).flatMap((sequence) =>
    sequence.videoTracks.flatMap((track) => track.items.filter((item) => hasLook(item) && item.look === lookId)),
  );

export const makeLookUnique = (project: VideoProject, itemId: string): VideoProject => {
  const item = locateItem(project, itemId)?.item;
  if (!item || !hasLook(item) || !item.look) return project;
  const source = lookOf(project, item);
  if (!source || lookUsers(project, item.look).length < 2) return project;
  const lookId = uuidv4();
  return updateItem(setLook(project, lookId, structuredClone(source)), itemId, { look: lookId });
};

export const detachAudio = (project: VideoProject, clipId: string) => {
  const clip = locateItem(project, clipId)?.item;
  if (!clip || clip.type !== 'clip' || clip.freeze || !mediaOf(project, clip.media)) return project;
  const link = clip.link ?? uuidv4();
  const audio = mirrorTiming<AudioItem>(
    {
      id: uuidv4(),
      type: 'audio',
      start: clip.start,
      duration: clip.duration,
      media: clip.media,
      sourceIn: clip.sourceIn,
      speed: clip.speed,
      volume: clip.volume,
      muted: false,
      fadeIn: clip.fadeIn,
      fadeOut: clip.fadeOut,
      link,
      ...(clip.reverse ? { reverse: true } : {}),
    },
    clip,
    project.settings.fps,
  );
  return tidy(placeItem(updateItem<ClipItem>(project, clipId, { muted: true, link }), audio, 0));
};

export const updateTrack = (
  project: VideoProject,
  kind: TrackKind,
  trackIndex: number,
  patch: Partial<Pick<VideoTrack, 'muted' | 'hidden' | 'locked' | 'volume' | 'pan' | 'solo'>>,
) =>
  withTracks(
    project,
    kind,
    tracksOf(project, kind).map((track, index) => (index === trackIndex ? { ...track, ...patch } : track)) as Array<
      VideoTrack | AudioTrack
    >,
  );

export type TrackHeights = Record<string, number | null>;

const withHeights = <T extends VideoTrack | AudioTrack>(tracks: Array<T>, heights: TrackHeights): Array<T> =>
  tracks.some((track) => heights[track.id] !== undefined && heights[track.id] !== (track.height ?? null))
    ? tracks.map((track) => {
        const height = heights[track.id];
        if (height === undefined) return track;
        const { height: _height, ...rest } = track;
        return (height === null ? rest : { ...rest, height }) as T;
      })
    : tracks;

const resized = <T extends Sequence | VideoProject>(sequence: T, heights: TrackHeights): T => {
  const videoTracks = withHeights(sequence.videoTracks, heights);
  const audioTracks = withHeights(sequence.audioTracks, heights);
  return videoTracks === sequence.videoTracks && audioTracks === sequence.audioTracks
    ? sequence
    : { ...sequence, videoTracks, audioTracks };
};

export const trackHeights = (project: VideoProject): TrackHeights =>
  Object.fromEntries(
    allTimelines(project)
      .flatMap((sequence) => [...sequence.videoTracks, ...sequence.audioTracks])
      .map((track) => [track.id, track.height ?? null]),
  );

export const withTrackHeights = (project: VideoProject, heights: TrackHeights): VideoProject => {
  const root = resized(project, heights);
  const sequences = Object.entries(project.sequences ?? {}).map(
    ([id, sequence]) => [id, resized(sequence, heights)] as const,
  );
  return sequences.every(([id, sequence]) => sequence === project.sequences?.[id])
    ? root
    : { ...root, sequences: Object.fromEntries(sequences) };
};

export const visualItemsAt = (project: VideoProject, time: Ticks) =>
  project.videoTracks.flatMap((track, trackIndex) =>
    track.hidden
      ? []
      : track.items.filter((item) => time >= item.start && time < itemEnd(item)).map((item) => ({ item, trackIndex })),
  );

export const rippleDelete = (project: VideoProject, ids: Array<string>) => {
  const drop = new Set(ids);
  const anchors = mainLinks(project, drop);
  const ripple = <T extends VideoTrack | AudioTrack>(track: T, isMain: boolean): T => {
    const removed = (track.items as Array<TimelineItem>).filter((item) => drop.has(item.id));
    if (removed.length === 0 || isMain) return track;
    const items = (track.items as Array<TimelineItem>)
      .filter((item) => !drop.has(item.id))
      .map((item) => {
        if (item.link && anchors.has(item.link)) return item;
        const shift = removed
          .filter((gone) => itemEnd(gone) <= item.start)
          .reduce((total, gone) => total + gone.duration, 0);
        return shift > 0 ? { ...item, start: Math.max(0, item.start - shift) } : item;
      });
    return { ...track, items } as T;
  };
  return removeItems(
    {
      ...project,
      videoTracks: project.videoTracks.map((track, index) => ripple(track, index === 0)),
      audioTracks: project.audioTracks.map((track) => ripple(track, false)),
    },
    ids,
  );
};

export interface ClipboardEntry {
  item: TimelineItem;
  kind: TrackKind;
  trackIndex: number;
  offset: Ticks;
}

export const copyItems = (project: VideoProject, ids: Array<string>): Array<ClipboardEntry> => {
  const located = ids.map((id) => locateItem(project, id)).filter((location) => !!location);
  const first = Math.min(...located.map((location) => location.item.start));
  return located.map((location) => ({
    item: structuredClone(location.item),
    kind: location.kind,
    trackIndex: location.trackIndex,
    offset: location.item.start - first,
  }));
};

export const pasteItems = (
  project: VideoProject,
  entries: Array<ClipboardEntry>,
  at: Ticks,
): [VideoProject, Array<string>] => {
  const ids: Array<string> = [];
  const known = new Set(project.media.map((media) => media.id));
  let next = project;
  const usable = entries.filter((entry) => !('media' in entry.item) || known.has(entry.item.media));
  const relink = relinker(usable.map((entry) => entry.item));
  const shifts = new Map<string, Ticks>();
  const main = usable.filter((entry) => entry.kind === 'video' && entry.trackIndex === 0 && entry.item.type === 'clip');
  if (main.length > 0) {
    const clips = main.map((entry) => {
      const id = uuidv4();
      ids.push(id);
      return relink({ ...(entry.item as ClipItem), id, start: 0, transitionIn: null });
    });
    next = landOnMain(next, clips, mainIndexAt(next, at), at, blockSpan(clips));
    clips.forEach((clip, index) => {
      const placed = locateItem(next, clip.id)?.item;
      if (clip.link && placed) shifts.set(clip.link, placed.start - at - main[index].offset);
    });
  }
  usable
    .filter((entry) => !main.includes(entry))
    .forEach((entry) => {
      const id = uuidv4();
      ids.push(id);
      const item = relink({ ...entry.item, id } as TimelineItem);
      next = placeItem(
        next,
        { ...item, start: at + entry.offset + ((item.link ? shifts.get(item.link) : undefined) ?? 0) },
        Math.max(entry.trackIndex, entry.kind === 'video' ? 1 : 0),
      );
    });
  return [tidy(next), ids];
};

export const nudgeItems = (project: VideoProject, ids: Array<string>, delta: Ticks) => {
  const anchors = mainLinks(project);
  const startOf = (id: string) => locateItem(project, id)?.item.start ?? 0;
  return groupLeaders(project, ids)
    .sort((a, b) => (startOf(b) - startOf(a)) * Math.sign(delta))
    .reduce((current, leader) => {
      const group = linkedIds(current, [leader]);
      const members = group.flatMap((id) => locateItem(current, id) ?? []);
      if (members.some((location) => onMain(location) || anchors.has(location.item.link))) return current;
      const shift = members.reduce((wanted, location) => {
        const room = trackRoom(location, group);
        return Math.min(room.latest - itemEnd(location.item), Math.max(room.earliest - location.item.start, wanted));
      }, delta);
      return shift === 0
        ? current
        : members.reduce((next, { item }) => updateItem(next, item.id, { start: item.start + shift }), current);
    }, project);
};

export const splitAll = (project: VideoProject, time: Ticks) =>
  allItems(project)
    .filter((item) => time > item.start && time < itemEnd(item))
    .reduce((current, item) => splitItem(current, item.id, time), project);

export const markerAt = (project: VideoProject, time: Ticks) =>
  project.markers.find((marker) => marker.time === time) ?? null;

export const addMarker = (project: VideoProject, time: Ticks): [VideoProject, string | null] => {
  if (markerAt(project, time)) return [project, null];
  const id = uuidv4();
  const markers = [...project.markers, { id, time, label: '' }].sort((a, b) => a.time - b.time);
  return [{ ...project, markers }, id];
};

export const updateMarker = (project: VideoProject, id: string, patch: Partial<Marker>): VideoProject => ({
  ...project,
  markers: project.markers
    .map((marker) => (marker.id === id ? { ...marker, ...patch } : marker))
    .sort((a, b) => a.time - b.time),
});

export const removeMarker = (project: VideoProject, id: string): VideoProject => ({
  ...project,
  markers: project.markers.filter((marker) => marker.id !== id),
});

export const toggleMarker = (project: VideoProject, time: Ticks): VideoProject => {
  const existing = markerAt(project, time);
  return existing ? removeMarker(project, existing.id) : addMarker(project, time)[0];
};

export const setRangeEdge = (project: VideoProject, edge: keyof TimeRange, time: Ticks): VideoProject => {
  const range = rangeWithEdge(project.range, edge, time, sequenceDuration(project));
  return range ? { ...project, range } : project;
};

const EDIT_FIELDS = new Set([
  'id',
  'start',
  'duration',
  'gap',
  'fadeIn',
  'fadeOut',
  'sourceIn',
  'transitionIn',
  'animIn',
  'animOut',
  'look',
  'link',
]);

const settingsOf = (project: VideoProject, item: TimelineItem) =>
  JSON.stringify([
    ...Object.entries(
      mapAnimated(
        item,
        () => ({ value: 0 }),
        () => null,
      ),
    )
      .filter(([key]) => !EDIT_FIELDS.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
    lookOf(project, item),
    isRamped(item),
  ]);

const holdKey = (time: Ticks, value: number) => ({ time, value, ease: 'hold' as Ease });

const joinAnimated = (head: Animated, tail: Animated, boundary: Ticks): Animated => {
  if (!isAnimated(head) && !isAnimated(tail) && head.value === tail.value) return head;
  const shifted = shiftKeys(tail, boundary);
  const before = isAnimated(head) ? head.keys!.filter((key) => key.time < boundary) : [holdKey(0, head.value)];
  const after = isAnimated(tail)
    ? shifted.keys!.filter((key) => key.time >= boundary)
    : [holdKey(boundary, tail.value)];
  const bridge =
    isAnimated(head) || after[0]?.time === boundary
      ? []
      : [
          {
            time: boundary,
            value: valueAt(shifted, boundary),
            ease: shifted.keys!.filter((key) => key.time < boundary).at(-1)?.ease ?? ('linear' as Ease),
          },
        ];
  return { value: head.value, keys: [...before, ...bridge, ...after] };
};

const joinTarget = (project: VideoProject, id: string): TimelineItem | null => {
  const location = locateItem(project, id);
  if (!location) return null;
  const { item } = location;
  const next = location.track.items[location.index + 1] as TimelineItem | undefined;
  const fps = project.settings.fps;
  const frame = frameTicks(fps);
  if (!next || next.type !== item.type || Math.abs(next.start - itemEnd(item)) > frame / 2) return null;
  if ('sourceIn' in item && 'sourceIn' in next) {
    const expected = sourceTimeOf(item, itemEnd(item), fps);
    if (Math.abs(next.sourceIn - expected) > frame * clipSpeed(item)) return null;
  }
  return settingsOf(project, item) === settingsOf(project, next) ? next : null;
};

const joinWithNext = (project: VideoProject, id: string): VideoProject => {
  const next = joinTarget(project, id);
  const item = locateItem(project, id)?.item;
  if (!next || !item) return project;
  const boundary = next.start - item.start;
  const joined = zipAnimated(
    item,
    next,
    (head, tail) => joinAnimated(head, tail, boundary),
    (head, tail) => joinTracks(head, tail, ticksToSeconds(boundary), project.settings.width, project.settings.height),
  );
  return updateItem<TimelineItem>(removeItemsKeepTracks(project, [next.id]), id, {
    ...joined,
    duration: itemEnd(next) - item.start,
    fadeOut: next.fadeOut,
    ...('animOut' in item || 'animOut' in next
      ? { animOut: (next as { animOut?: Motion | null }).animOut ?? null }
      : {}),
  } as TimelineItem);
};

export const joinItems = (project: VideoProject, ids: Array<string>): [VideoProject, Array<string>] => {
  const chosen = new Set(ids);
  const ordered = allItems(project)
    .filter((item) => chosen.has(item.id))
    .sort((a, b) => a.start - b.start);
  if (ordered.length === 1) {
    const [item] = ordered;
    if (joinTarget(project, item.id)) return [joinWithNext(project, item.id), [item.id]];
    const location = locateItem(project, item.id);
    const previous = location?.track.items[location.index - 1];
    return previous && joinTarget(project, previous.id)?.id === item.id
      ? [joinWithNext(project, previous.id), [previous.id]]
      : [project, ids];
  }
  let next = project;
  const kept: Array<string> = [];
  ordered.forEach((item) => {
    if (!locateItem(next, item.id)) return;
    kept.push(item.id);
    let target = joinTarget(next, item.id);
    while (target && chosen.has(target.id)) {
      next = joinWithNext(next, item.id);
      target = joinTarget(next, item.id);
    }
  });
  return [next, kept];
};

export const canJoin = (project: VideoProject, ids: Array<string>) => joinItems(project, ids)[0] !== project;

const slipItem = (project: VideoProject, id: string, delta: Ticks, mediaDuration: Ticks): VideoProject =>
  updateItem(project, id, (item: TimelineItem) => {
    if (!('sourceIn' in item) || !Number.isFinite(mediaDuration)) return item;
    const span = sourceOffset(item, item.duration, project.settings.fps);
    const lowest = Math.max(0, -span);
    const latest = Math.max(lowest, mediaDuration - Math.max(0, span));
    const sign = item.reverse ? -1 : 1;
    const sourceIn = Math.min(latest, Math.max(lowest, item.sourceIn - sign * Math.round(delta * clipSpeed(item))));
    return sourceIn === item.sourceIn ? item : { ...item, sourceIn };
  });

export const slipLinked = (project: VideoProject, id: string, delta: Ticks, durations: MediaDurations) =>
  linkedIds(project, [id]).reduce((current, member) => {
    const item = locateItem(current, member)?.item;
    return item ? slipItem(current, member, delta, durations(item)) : current;
  }, project);

export const rollEdit = (
  project: VideoProject,
  id: string,
  edge: 'start' | 'end',
  time: Ticks,
  mediaDurations: (item: TimelineItem) => Ticks,
): VideoProject | null => {
  const location = locateItem(project, id);
  if (!location) return null;
  const items = location.track.items as Array<TimelineItem>;
  const index = edge === 'end' ? location.index : location.index - 1;
  const left = items[index];
  const right = items[index + 1];
  if (!left || !right || Math.abs(right.start - itemEnd(left)) > frameTicks(project.settings.fps) / 2) return null;
  const min = minItemDuration(project.settings.fps);
  const cut = Math.min(
    itemEnd(right) - min,
    trimLimits(project, left, mediaDurations(left)).latest,
    Math.max(left.start + min, trimLimits(project, right, mediaDurations(right)).earliest, time),
  );
  if (cut === right.start) return project;
  const delta = cut - right.start;
  const edges: Array<[TimelineItem, 'start' | 'end']> =
    delta > 0
      ? [
          [right, 'start'],
          [left, 'end'],
        ]
      : [
          [left, 'end'],
          [right, 'start'],
        ];
  return edges.reduce((current, [member, edge]) => {
    const now = locateItem(current, member.id)?.item;
    if (!now) return current;
    const edgeTime = (edge === 'start' ? now.start : itemEnd(now)) + delta;
    return trimItem(current, member.id, edge, edgeTime, mediaDurations);
  }, project);
};

const slideRange = (
  project: VideoProject,
  location: ItemLocation,
  durations: MediaDurations,
): [Ticks, Ticks, TimelineItem | null, TimelineItem | null] => {
  const { item, index } = location;
  const items = location.track.items as Array<TimelineItem>;
  const main = onMain(location);
  const min = minItemDuration(project.settings.fps);
  const tolerance = frameTicks(project.settings.fps) / 2;
  const previous = items[index - 1] as TimelineItem | undefined;
  const next = items[index + 1] as TimelineItem | undefined;
  const left =
    previous && (main ? gapOf(item) === 0 : Math.abs(itemEnd(previous) - item.start) <= tolerance) ? previous : null;
  const right = next && (main ? gapOf(next) === 0 : Math.abs(next.start - itemEnd(item)) <= tolerance) ? next : null;
  const [lowLeft, highLeft] = left
    ? [left.start + min - itemEnd(left), trimLimits(project, left, durations(left)).latest - itemEnd(left)]
    : [main ? -gapOf(item) : (previous ? itemEnd(previous) : 0) - item.start, Number.POSITIVE_INFINITY];
  const [lowRight, highRight] = right
    ? [trimLimits(project, right, durations(right)).earliest - right.start, itemEnd(right) - min - right.start]
    : [Number.NEGATIVE_INFINITY, next ? (main ? gapOf(next) : next.start - itemEnd(item)) : Number.POSITIVE_INFINITY];
  return [Math.max(lowLeft, lowRight), Math.min(highLeft, highRight), left, right];
};

export const canSlide = (project: VideoProject, id: string, durations: MediaDurations) => {
  const location = locateItem(project, id);
  if (!location || followsMain(project, location)) return false;
  const [low, high] = slideRange(project, location, durations);
  return low <= high && (low < 0 || high > 0);
};

export const slideItem = (project: VideoProject, id: string, delta: Ticks, durations: MediaDurations): VideoProject => {
  const location = locateItem(project, id);
  if (!location || followsMain(project, location)) return project;
  const [low, high, left, right] = slideRange(project, location, durations);
  const shift = Math.min(high, Math.max(low, delta));
  if (!shift || low > high) return project;
  const solo = (other: TimelineItem) => {
    const found = locateItem(project, other.id);
    return !!found && followsMain(project, found);
  };
  const trimEdge = (current: VideoProject, other: TimelineItem, edge: 'start' | 'end') => {
    const now = locateItem(current, other.id)?.item;
    if (!now) return current;
    const edgeTime = (edge === 'start' ? now.start : itemEnd(now)) + shift;
    return solo(other)
      ? trimOne(current, other.id, edge, edgeTime, durations(now), false)
      : trimItem(current, other.id, edge, edgeTime, durations);
  };
  if (onMain(location)) {
    const next = location.track.items[location.index + 1] as TimelineItem | undefined;
    const moved = left
      ? trimEdge(project, left, 'end')
      : normalizeMain(withMainGap(project, id, gapOf(location.item) + shift));
    if (right) return tidy(trimEdge(moved, right, 'start'));
    const after = next && locateItem(moved, next.id)?.item;
    return tidy(after ? normalizeMain(withMainGap(moved, after.id, gapOf(after) - shift)) : moved);
  }
  const [first, last] = shift > 0 ? [right, left] : [left, right];
  const opened = first ? trimEdge(project, first, first === left ? 'end' : 'start') : project;
  const moved = linkedIds(opened, [id]).reduce(
    (current, member) => updateItem<TimelineItem>(current, member, (now) => ({ ...now, start: now.start + shift })),
    opened,
  );
  return tidy(last ? trimEdge(moved, last, last === left ? 'end' : 'start') : moved);
};

const clampFades = <T extends TimelineItem>(item: T, fps: FrameRate): T => {
  const limit = halfDuration(item.duration, fps);
  if (item.fadeIn <= limit && item.fadeOut <= limit) return item;
  return { ...item, fadeIn: Math.min(item.fadeIn, limit), fadeOut: Math.min(item.fadeOut, limit) };
};

export const roomAfter = (project: VideoProject, id: string): Ticks => {
  const location = locateItem(project, id);
  if (!location || (location.kind === 'video' && location.trackIndex === 0)) return Number.POSITIVE_INFINITY;
  const { item } = location;
  const starts = (location.track.items as Array<TimelineItem>)
    .filter((other) => other.id !== id && other.start >= item.start)
    .map((other) => other.start);
  return Math.min(Number.POSITIVE_INFINITY, ...starts) - item.start;
};

export const setItemDuration = (project: VideoProject, id: string, duration: Ticks): VideoProject => {
  const fps = project.settings.fps;
  const room = roomAfter(project, id);
  return updateItem<TimelineItem>(project, id, (item) => {
    const next = Math.min(Math.max(minItemDuration(fps), snapTicks(duration, fps)), Math.max(room, item.duration));
    return next === item.duration ? item : clampFades({ ...item, duration: next }, fps);
  });
};

export const setItemFade = (project: VideoProject, id: string, edge: 'fadeIn' | 'fadeOut', fade: Ticks) => {
  const fps = project.settings.fps;
  return updateItem<TimelineItem>(project, id, (item) => {
    const next = Math.max(0, Math.min(halfDuration(item.duration, fps), snapTicks(fade, fps)));
    if (item[edge] === next) return item;
    return edge === 'fadeIn' ? { ...item, fadeIn: next } : { ...item, fadeOut: next };
  });
};

export const setAnimation = (project: VideoProject, id: string, edge: 'in' | 'out', motion: Motion | null) => {
  const fadeKey = edge === 'in' ? 'fadeIn' : 'fadeOut';
  const updated = updateItem<VisualItem>(project, id, { [edge === 'in' ? 'animIn' : 'animOut']: motion });
  const fade = locateItem(updated, id)?.item[fadeKey] || secondsToTicks(DEFAULT_TRANSITION_SECONDS);
  return setItemFade(updated, id, fadeKey, motion ? fade : 0);
};

export const previousAudio = (project: VideoProject, item: AudioItem): AudioItem | null => {
  const location = locateItem(project, item.id);
  if (location?.kind !== 'audio') return null;
  const tolerance = frameTicks(project.settings.fps) / 2;
  return (
    (location.track.items as Array<AudioItem>).find(
      (other) => other.id !== item.id && Math.abs(itemEnd(other) - item.start) <= tolerance,
    ) ?? null
  );
};

export const setCrossfade = (project: VideoProject, id: string, value: Ticks) =>
  updateItem<AudioItem>(project, id, (item) => {
    const previous = previousAudio(project, item);
    const fps = project.settings.fps;
    const limit = previous ? transitionLimit(previous, item, fps) : 0;
    const crossfade = Math.max(0, Math.min(limit, snapTicks(value, fps)));
    return crossfade === (item.crossfade ?? 0) ? item : { ...item, crossfade };
  });

interface Timing {
  speed: number;
  speedRamp?: Array<Keyframe> | null;
}

const retime = <T extends ClipItem | AudioItem>(item: T, duration: Ticks, timing: Timing, fps: FrameRate): T => {
  const ratio = duration / Math.max(1, item.duration);
  return clampFades({ ...mapAnimated(item, (value) => scaleKeys(value, ratio)), ...timing, duration } as T, fps);
};

const mirrorTiming = <T extends ClipItem | AudioItem>(partner: T, primary: ClipItem | AudioItem, fps: FrameRate): T =>
  retime(
    partner,
    primary.duration,
    { speed: primary.speed, speedRamp: isRamped(primary) ? primary.speedRamp : null },
    fps,
  );

const syncLinked = (project: VideoProject, id: string): VideoProject => {
  const primary = locateItem(project, id)?.item;
  if (!primary?.link || (primary.type !== 'clip' && primary.type !== 'audio')) return project;
  const fps = project.settings.fps;
  const synced = linkedIds(project, [id])
    .filter((other) => other !== id)
    .reduce(
      (next, other) =>
        updateItem<TimelineItem>(next, other, (partner) =>
          partner.type === 'audio' || (partner.type === 'clip' && !partner.freeze)
            ? mirrorTiming(partner, primary, fps)
            : partner,
        ),
      project,
    );
  return tidy(synced);
};

const speedRoom = (project: VideoProject, id: string) => {
  const link = locateItem(project, id)?.item.link;
  return link && mainLinks(project).has(link) ? Number.POSITIVE_INFINITY : roomAfter(project, id);
};

const setOneSpeed = (project: VideoProject, id: string, speed: number, source: Ticks): VideoProject => {
  const fps = project.settings.fps;
  const room = speedRoom(project, id);
  return updateItem<ClipItem | AudioItem>(project, id, (item) => {
    if (item.type === 'clip' && item.freeze) return item;
    const longest = Math.max(room, item.duration);
    const slowest = Math.max(MIN_SPEED, source / longest);
    const fastest = Math.max(slowest, Math.min(MAX_SPEED, source / minItemDuration(fps)));
    const nextSpeed = Math.min(fastest, Math.max(slowest, speed));
    const duration = Math.min(longest, Math.max(minItemDuration(fps), snapTicks(source / nextSpeed, fps)));
    if (nextSpeed === item.speed && duration === item.duration && !isRamped(item)) return item;
    return retime(item, duration, { speed: nextSpeed, speedRamp: null }, fps);
  });
};

export const setItemSpeed = (project: VideoProject, id: string, speed: number, source: Ticks): VideoProject => {
  const updated = setOneSpeed(project, id, speed, source);
  return updated === project ? project : syncLinked(updated, id);
};

export const speedOf = (item: ClipItem | AudioItem): Animated =>
  isRamped(item) ? { value: item.speed, keys: item.speedRamp! } : { value: item.speed };

const fitRamp = (keys: Array<Keyframe>, duration: Ticks, source: Ticks, longest: Ticks, fps: FrameRate) => {
  const scaled = (length: Ticks) =>
    keys.map((key) => ({ ...key, time: Math.round((key.time * length) / Math.max(1, duration)) }));
  const frame = frameTicks(fps);
  const reach = (length: Ticks, at = length) => sourceOffset({ speed: 1, speedRamp: scaled(length) }, at, fps);
  const guess = snapTicks((source * duration) / Math.max(1, reach(duration)), fps);
  const shortest = minItemDuration(fps);
  const candidates = [-2, -1, 0, 1, 2].map((step) => Math.min(longest, Math.max(shortest, guess + step * frame)));
  const inside = candidates.filter((length) => reach(length, length - frame) < source - frame / 2);
  const length = (inside.length > 0 ? inside : candidates).reduce((best, candidate) =>
    Math.abs(reach(candidate) - source) < Math.abs(reach(best) - source) ? candidate : best,
  );
  return { duration: length, keys: scaled(length) };
};

export const setSpeedCurve = (project: VideoProject, id: string, speed: Animated, source: Ticks): VideoProject => {
  const item = locateItem(project, id)?.item;
  if (!item || (item.type !== 'clip' && item.type !== 'audio') || (item.type === 'clip' && item.freeze)) return project;
  if (!isAnimated(speed)) return setItemSpeed(project, id, speed.value, source);
  const fps = project.settings.fps;
  const keys = speed.keys!.map((key) => ({ ...key, value: clipSpeed({ speed: key.value }) }));
  const fitted = fitRamp(keys, item.duration, source, Math.max(speedRoom(project, id), item.duration), fps);
  const base = varies(keys) ? clipSpeed({ speed: speed.value }) : keys[0].value;
  const updated = updateItem<ClipItem | AudioItem>(project, id, (current) =>
    retime(current, fitted.duration, { speed: base, speedRamp: fitted.keys }, fps),
  );
  return updated === project ? project : syncLinked(updated, id);
};

const flipSource = <T extends ClipItem | AudioItem>(item: T, reverse: boolean, fps: FrameRate): T => {
  const { reverse: _reverse, ...rest } = item;
  const span = sourceOffset(item, item.duration, fps);
  return { ...rest, ...(reverse ? { reverse } : {}), sourceIn: Math.max(0, item.sourceIn + span) } as T;
};

export const setClipReverse = (project: VideoProject, id: string, reverse: boolean): VideoProject => {
  const clip = locateItem(project, id)?.item;
  if (clip?.type !== 'clip' || clip.freeze || !!clip.reverse === reverse) return project;
  const fps = project.settings.fps;
  const flipped = updateItem<ClipItem>(project, id, (current) => flipSource(current, reverse, fps));
  return linkedIds(project, [id]).reduce(
    (next, member) =>
      updateItem<AudioItem>(next, member, (item) =>
        item.type === 'audio' && item.media === clip.media && !!item.reverse !== reverse
          ? flipSource(item, reverse, fps)
          : item,
      ),
    flipped,
  );
};

const rippleInsert = (project: VideoProject, kind: TrackKind, trackIndex: number, item: TimelineItem) => {
  const anchors = mainLinks(project);
  const shifts = new Map<string, Ticks>();
  const items = (tracksOf(project, kind)[trackIndex].items as Array<TimelineItem>).map((other) => {
    if (other.start < item.start || anchors.has(other.link)) return other;
    if (other.link) shifts.set(other.link, item.duration);
    return { ...other, start: other.start + item.duration };
  });
  const inserted = withTrackItems(project, kind, trackIndex, sortByStart([...items, item]));
  return followLinks(
    inserted,
    shifts,
    (otherKind, otherIndex) => isMainTrack(otherKind, otherIndex) || (otherKind === kind && otherIndex === trackIndex),
  );
};

export const insertFreeze = (
  project: VideoProject,
  id: string,
  time: Ticks,
  hold: Ticks,
  sourceFps?: number,
): [VideoProject, string | null] => {
  const location = locateItem(project, id);
  const item = location?.item;
  if (!location || item?.type !== 'clip' || item.freeze) return [project, null];
  const fps = project.settings.fps;
  const min = minItemDuration(fps);
  const frame = frameTicks(fps);
  const snapped = snapTicks(time, fps);
  const at = snapped - item.start < min ? item.start : itemEnd(item) - snapped < min ? itemEnd(item) : snapped;
  const before = at === item.start;
  const local = Math.min(at - item.start, item.duration - frame);
  const { width, height } = project.settings;
  const pose = item.transform.track ? placementAt(item.transform, local, width, height) : null;
  const pin = pose && pinnedQuad(item.transform, local, width, height);
  const {
    link: _link,
    reverse: _reverse,
    speedRamp: _ramp,
    stabilize: _stabilize,
    gap: _gap,
    ...still
  } = mapAnimated(
    item,
    (value) => ({ value: valueAt(value, local) }),
    () => null,
  );
  const freeze: ClipItem = {
    ...still,
    transform: pose
      ? {
          ...still.transform,
          x: { value: pose.x / width - 0.5 },
          y: { value: pose.y / height - 0.5 },
          scale: { value: pose.scale },
          rotation: { value: pose.rotation },
          ...(pin && { pin: scaleQuad(pin, 1 / width, 1 / height) }),
        }
      : still.transform,
    id: uuidv4(),
    start: at,
    duration: Math.max(min, snapTicks(hold, fps)),
    sourceIn: frameSourceTime(item, item.start + local, fps, sourceFps),
    speed: 1,
    freeze: true,
    transitionIn: before ? item.transitionIn : null,
    fadeIn: 0,
    fadeOut: 0,
    animIn: null,
    animOut: null,
  };
  const split = before
    ? updateItem<ClipItem>(project, id, (current) => withGap({ ...current, transitionIn: null }, 0))
    : splitItem(project, id, at);
  const placed =
    location.kind === 'video' && location.trackIndex === 0
      ? insertMainClips(split, [freeze], location.index + (before ? 0 : 1), before ? gapOf(item) : 0)
      : rippleInsert(split, location.kind, location.trackIndex, freeze);
  return [tidy(placed), freeze.id];
};

export interface EditTrack {
  kind: TrackKind;
  trackIndex: number;
}

export const editTrackFor = (project: VideoProject, selection: Array<string>, kind: TrackKind): EditTrack => {
  const selected = selection
    .map((id) => locateItem(project, id))
    .find((location) => location?.kind === kind && !location.track.locked);
  const tracks = tracksOf(project, kind);
  const unlocked = tracks.findIndex((track) => !track.locked);
  return { kind, trackIndex: selected?.trackIndex ?? (unlocked < 0 ? tracks.length : unlocked) };
};

const sparingLocked = (project: VideoProject, edit: (project: VideoProject) => VideoProject) => {
  const links = new Map(
    [...project.videoTracks.slice(1), ...project.audioTracks]
      .filter((track) => track.locked)
      .flatMap((track) =>
        (track.items as Array<TimelineItem>).flatMap((item) => (item.link ? [[item.id, item.link] as const] : [])),
      ),
  );
  if (links.size === 0) return edit(project);
  const edited = edit(setLinks(project, (item) => (links.has(item.id) ? undefined : null)));
  return setLinks(edited, (item) => links.get(item.id) ?? null);
};

const itemsOn = (project: VideoProject, kind: TrackKind, trackIndex: number) =>
  (tracksOf(project, kind)[trackIndex]?.items ?? []) as Array<TimelineItem>;

const followsMain = (project: VideoProject, location: ItemLocation) =>
  !onMain(location) &&
  linkedIds(project, [location.item.id]).some((id) => {
    const partner = locateItem(project, id);
    return !!partner && onMain(partner);
  });

const crossing = (items: Array<TimelineItem>, time: Ticks) =>
  items.filter((item) => item.start < time && time < itemEnd(item));

const cutTrack = (project: VideoProject, { kind, trackIndex }: EditTrack, time: Ticks) =>
  crossing(itemsOn(project, kind, trackIndex), time).reduce((current, item) => {
    const location = locateItem(current, item.id);
    if (!location) return current;
    return followsMain(current, location) ? splitOne(current, item.id, time) : splitItem(current, item.id, time);
  }, project);

const insertOnMain = (project: VideoProject, clip: ClipItem, time: Ticks) => {
  const items = mainTrack(project).items;
  const index = items.filter((item) => item.start < time).length;
  const previousEnd = index > 0 ? itemEnd(items[index - 1]) : 0;
  const next = items[index];
  const room = next ? withMainGap(project, next.id, Math.max(0, next.start - Math.max(time, previousEnd))) : project;
  return insertMainClips(room, [clip], index, Math.max(0, time - previousEnd));
};

const insertAt = (project: VideoProject, item: ClipItem | AudioItem, target: EditTrack, time: Ticks): VideoProject => {
  const { kind, trackIndex } = target;
  const cut = cutTrack(project, target, time);
  const blocking = crossing(itemsOn(cut, kind, trackIndex), time).at(-1);
  const at = !blocking ? time : time - blocking.start < itemEnd(blocking) - time ? blocking.start : itemEnd(blocking);
  const placed = { ...item, start: at };
  if (isMainTrack(kind, trackIndex)) return tidy(insertOnMain(cut, placed as ClipItem, at));
  if (trackIndex >= tracksOf(cut, kind).length) return tidy(placeItem(cut, placed, null, true));
  return tidy(rippleInsert(cut, kind, trackIndex, placed));
};

const overwriteAt = (
  project: VideoProject,
  item: ClipItem | AudioItem,
  target: EditTrack,
  time: Ticks,
  durations: MediaDurations,
): VideoProject => {
  const { kind, trackIndex } = target;
  const end = time + item.duration;
  const min = minItemDuration(project.settings.fps);
  const cut = cutTrack(cutTrack(project, target, end), target, time);
  const touched = itemsOn(cut, kind, trackIndex).filter((other) => other.start < end && itemEnd(other) > time);
  const head = (other: TimelineItem) => Math.max(0, time - other.start);
  const tail = (other: TimelineItem) => Math.max(0, itemEnd(other) - end);
  const solo = (id: string) => {
    const location = locateItem(cut, id);
    return !!location && followsMain(cut, location);
  };
  const drop = new Set(
    touched
      .filter((other) => head(other) < min && tail(other) < min)
      .flatMap((other) => (solo(other.id) ? [other.id] : linkedIds(cut, [other.id]))),
  );
  const trimmed = touched
    .filter((other) => !drop.has(other.id))
    .reduce((current, other) => {
      const now = locateItem(current, other.id)?.item;
      if (!now) return current;
      const edge = head(other) >= min ? 'end' : 'start';
      const edgeTime = edge === 'end' ? itemEnd(now) - (itemEnd(other) - time) : now.start + (end - other.start);
      return solo(other.id)
        ? trimOne(current, other.id, edge, edgeTime, durations(now), false)
        : trimItem(current, other.id, edge, edgeTime, durations);
    }, cut);
  if (!isMainTrack(kind, trackIndex)) {
    return tidy(placeOn(removeItemsKeepTracks(trimmed, [...drop]), { ...item, start: time }, trackIndex));
  }
  const kept = mainTrack(cut).items.filter((other) => !drop.has(other.id));
  const isBefore = (other: TimelineItem) => itemEnd(other) <= time || (touched.includes(other) && head(other) >= min);
  const index = kept.filter(isBefore).length;
  const following = kept.find((other) => !isBefore(other));
  const cleared = removeItems(trimmed, [...drop]);
  const items = mainTrack(cleared).items;
  const previousEnd = index > 0 ? itemEnd(items[index - 1]) : 0;
  const placed = insertMainClips(
    cleared,
    [{ ...(item as ClipItem), start: time }],
    index,
    Math.max(0, time - previousEnd),
  );
  const landed = locateItem(placed, item.id)?.item;
  if (!following || !landed) return tidy(placed);
  return tidy(withMainGap(placed, following.id, Math.max(0, Math.max(following.start, end) - itemEnd(landed))));
};

export const insertItemAt = (project: VideoProject, item: ClipItem | AudioItem, target: EditTrack, time: Ticks) =>
  sparingLocked(project, (current) => insertAt(current, item, target, time));

export const overwriteItemAt = (
  project: VideoProject,
  item: ClipItem | AudioItem,
  target: EditTrack,
  time: Ticks,
  durations: MediaDurations,
) => sparingLocked(project, (current) => overwriteAt(current, item, target, time, durations));

const snapItem = (item: TimelineItem, fps: FrameRate, ripple: boolean): TimelineItem => {
  const start = snapTicks(item.start, fps);
  const duration = ripple
    ? Math.max(minItemDuration(fps), snapTicks(item.duration, fps))
    : Math.max(minItemDuration(fps), snapTicks(itemEnd(item), fps) - start);
  const snapped = {
    ...item,
    start,
    duration,
    fadeIn: snapTicks(item.fadeIn, fps),
    fadeOut: snapTicks(item.fadeOut, fps),
    ...(gapOf(item) > 0 ? { gap: snapTicks(gapOf(item), fps) } : {}),
  } as TimelineItem;
  const withTransition =
    snapped.type === 'clip' && snapped.transitionIn
      ? {
          ...snapped,
          transitionIn: {
            ...snapped.transitionIn,
            duration: Math.max(frameTicks(fps), snapTicks(snapped.transitionIn.duration, fps)),
          },
        }
      : snapped;
  return clampFades(withTransition, fps);
};

export const withFrameRate = (project: VideoProject, fps: FrameRate): VideoProject =>
  tidy({
    ...project,
    settings: { ...project.settings, fps },
    videoTracks: project.videoTracks.map((track, index) => ({
      ...track,
      items: track.items.map((item) => snapItem(item, fps, index === 0) as VisualItem),
    })),
    audioTracks: project.audioTracks.map((track) => ({
      ...track,
      items: track.items.map((item) => snapItem(item, fps, false) as AudioItem),
    })),
    markers: project.markers.map((marker) => ({ ...marker, time: snapTicks(marker.time, fps) })),
    captions: project.captions && {
      ...project.captions,
      items: project.captions.items.map((caption) => {
        const start = snapTicks(caption.start, fps);
        return {
          ...caption,
          start,
          duration: Math.max(frameTicks(fps), snapTicks(caption.start + caption.duration, fps) - start),
        };
      }),
    },
  });

export interface KeyRef {
  channel: string;
  time: Ticks;
}

export interface KeyMark {
  time: Ticks;
  keys: Array<KeyRef>;
}

const LOOK_CHANNEL = 'look:';
export const SPEED_CHANNEL = 'speed';

const valueChannels = (item: TimelineItem): Array<[string, Animated]> => [
  ...('transform' in item
    ? TRANSFORM_KEYS.map((key): [string, Animated] => [`transform.${key}`, item.transform[key]])
    : []),
  ...('volume' in item ? [['volume', item.volume] as [string, Animated]] : []),
  ...('opacity' in item ? [['opacity', item.opacity] as [string, Animated]] : []),
  ...((item.type === 'clip' || item.type === 'audio') && isRamped(item)
    ? [[SPEED_CHANNEL, speedOf(item)] as [string, Animated]]
    : []),
];

const withValue = (item: TimelineItem, channel: string, map: (value: Animated) => Animated): TimelineItem => {
  const [head, key] = channel.split('.');
  if (head === 'transform' && 'transform' in item) {
    const transformKey = key as (typeof TRANSFORM_KEYS)[number];
    return { ...item, transform: { ...item.transform, [transformKey]: map(item.transform[transformKey]) } };
  }
  if (head === 'volume' && 'volume' in item) return { ...item, volume: map(item.volume) };
  if (head === 'opacity' && 'opacity' in item) return { ...item, opacity: map(item.opacity) };
  return item;
};

export const lookChannelPath = (channel: string) =>
  channel.startsWith(LOOK_CHANNEL) ? channel.slice(LOOK_CHANNEL.length) : null;

const shownFrame = (item: TimelineItem, fps: FrameRate, sourceFps?: number) =>
  item.type === 'clip' && item.reverse ? sourceFrameTicks(fps, sourceFps) : 0;

const sourceLocal = (item: ClipItem, seconds: number, fps: FrameRate, sourceFps?: number) =>
  timelineTimeOf(item, secondsToTicks(seconds) + shownFrame(item, fps, sourceFps), fps) - item.start;

const visibleSpan = (item: TimelineItem, span: Array<Ticks> | undefined): [Ticks, Ticks] | null => {
  if (!span) return null;
  const from = Math.max(0, Math.min(...span));
  const to = Math.min(item.duration, Math.max(...span));
  return to > from ? [from, to] : null;
};

const anchoredTicks = (project: VideoProject, item: TimelineItem, anchor: TrackAnchor) => {
  const clip = locateItem(project, anchor.clip)?.item;
  return clip?.type === 'clip'
    ? (seconds: number) => clip.start - item.start + sourceLocal(clip, seconds, project.settings.fps)
    : null;
};

const spanIn = (
  item: TimelineItem,
  track: MotionTrack | null | undefined,
  toTicks: ((seconds: number) => Ticks) | null,
) => visibleSpan(item, toTicks ? trackSpan(track)?.map(toTicks) : undefined);

export const layerTrackSpan = (project: VideoProject, item: TimelineItem) => {
  const track = 'transform' in item ? item.transform.track : null;
  return spanIn(item, track, track?.anchor ? anchoredTicks(project, item, track.anchor) : secondsToTicks);
};

export const maskTrackSpan = (
  project: VideoProject,
  item: TimelineItem,
  track: MotionTrack | null | undefined,
  sourceFps?: number,
) =>
  spanIn(
    item,
    track,
    track?.anchor
      ? anchoredTicks(project, item, track.anchor)
      : item.type === 'clip'
        ? (seconds: number) => sourceLocal(item, seconds, project.settings.fps, sourceFps)
        : secondsToTicks,
  );

export const trackedSpans = (project: VideoProject, item: TimelineItem, sourceFps?: number): Array<[Ticks, Ticks]> =>
  [
    layerTrackSpan(project, item),
    ...((lookOf(project, item)?.masks ?? []) as Array<TrackedContainer>).map((container) =>
      maskTrackSpan(project, item, container.track, sourceFps),
    ),
  ].filter((span): span is [Ticks, Ticks] => span !== null);

export const keyframeMarks = (project: VideoProject, item: TimelineItem): Array<KeyMark> => {
  const fps = project.settings.fps;
  const look = hasLook(item) ? lookOf(project, item) : null;
  const refs: Array<KeyRef & { local: Ticks }> = [
    ...valueChannels(item).flatMap(([channel, value]) =>
      (value.keys ?? []).map((key) => ({ channel, time: key.time, local: key.time })),
    ),
    ...(look && hasLook(item)
      ? Object.entries(channelsOf(look)).flatMap(([path, keys]) =>
          keys.map((key) => ({
            channel: `${LOOK_CHANNEL}${path}`,
            time: key.time,
            local: timelineTimeOf(item, key.time, fps) - item.start,
          })),
        )
      : []),
  ].filter((ref) => ref.local >= 0 && ref.local <= item.duration);
  const tolerance = frameTicks(fps) / 2;
  const marks: Array<KeyMark> = [];
  refs
    .sort((a, b) => a.local - b.local)
    .forEach(({ local, ...ref }) => {
      const last = marks.at(-1);
      if (last && local - last.time <= tolerance) last.keys.push(ref);
      else marks.push({ time: local, keys: [ref] });
    });
  return marks;
};

export const isMarkAt = (mark: KeyMark, time: Ticks, fps: FrameRate) =>
  Math.abs(mark.time - time) <= frameTicks(fps) / 2;

export const channelGroup = (channel: string) => {
  const path = lookChannelPath(channel);
  return path === null ? channel : `${LOOK_CHANNEL}${channelGroupOf(path)}`;
};

export const groupHeads = (refs: Array<KeyRef>) =>
  refs.filter(
    (ref, index) => refs.findIndex((other) => channelGroup(other.channel) === channelGroup(ref.channel)) === index,
  );

export const groupMembers = (project: VideoProject, item: TimelineItem, refs: Array<KeyRef>): Array<KeyRef> => {
  const look = hasLook(item) ? lookOf(project, item) : null;
  const channels = look ? Object.keys(channelsOf(look)).map((path) => `${LOOK_CHANNEL}${path}`) : [];
  return refs.flatMap((ref) => {
    const members = channels.filter((channel) => channelGroup(channel) === channelGroup(ref.channel));
    return members.length > 0 ? members.map((channel) => ({ channel, time: ref.time })) : [ref];
  });
};

const editKeys = (
  project: VideoProject,
  id: string,
  keys: Array<KeyRef>,
  editValue: (value: Animated, key: KeyRef) => Animated,
  editLook: (look: Adjustments, path: string, key: KeyRef) => Adjustments,
): VideoProject => {
  const item = locateItem(project, id)?.item;
  if (!item) return project;
  const edited = keys.reduce(
    (current, key) =>
      lookChannelPath(key.channel) === null
        ? withValue(current, key.channel, (value) => editValue(value, key))
        : current,
    item,
  );
  const values = edited === item ? project : updateItem<TimelineItem>(project, id, () => edited);
  const speedKeys = keys.filter((key) => key.channel === SPEED_CHANNEL);
  const timed = locateItem(values, id)?.item;
  const next =
    speedKeys.length > 0 && (timed?.type === 'clip' || timed?.type === 'audio')
      ? setSpeedCurve(
          values,
          id,
          speedKeys.reduce((value, key) => editValue(value, key), speedOf(timed)),
          sourceLength(timed, values.settings.fps),
        )
      : values;
  const look = hasLook(item) ? lookOf(project, item) : null;
  if (!look) return next;
  const changed = keys.reduce((current, key) => {
    const path = lookChannelPath(key.channel);
    return path === null ? current : editLook(current, path, key);
  }, look);
  return changed === look ? next : assignLook(next, id, changed)[0];
};

export const removeKeyframes = (project: VideoProject, id: string, keys: Array<KeyRef>) =>
  editKeys(
    project,
    id,
    keys,
    (value, key) => removeKeyAt(value, key.time, 0),
    (look, path, key) => removeKeys(look, [path], key.time, 0),
  );

export const clearKeyframes = (project: VideoProject, id: string, key: KeyRef) =>
  editKeys(
    project,
    id,
    [key],
    (value) => ({ value: valueAt(value, key.time) }),
    (look, path) => stopAnimating(look, [path], key.time),
  );

export const channelAnimated = (project: VideoProject, item: TimelineItem, channel: string): Animated | null => {
  const path = lookChannelPath(channel);
  if (path === null) return valueChannels(item).find(([name]) => name === channel)?.[1] ?? null;
  const look = hasLook(item) ? lookOf(project, item) : null;
  const keys = look ? channelsOf(look)[path] : undefined;
  return look && keys ? { value: numericLeaves(look).get(path) ?? 0, keys } : null;
};

export const setChannelKeys = (project: VideoProject, id: string, channel: string, keys: Array<Keyframe>) => {
  const item = locateItem(project, id)?.item;
  if (!item) return project;
  const tolerance = frameTicks(project.settings.fps) / 2;
  return editKeys(
    project,
    id,
    groupMembers(project, item, [{ channel, time: 0 }]),
    (value) => ({ ...value, keys }),
    (look, path) =>
      withChannelKeys(
        look,
        path,
        `${LOOK_CHANNEL}${path}` === channel ? keys : withEaseOf(channelsOf(look)[path] ?? [], keys, tolerance),
      ),
  );
};

export const easeKeyframes = (project: VideoProject, id: string, keys: Array<KeyRef>, preset: EasePreset) =>
  editKeys(
    project,
    id,
    keys,
    (value, key) => setEaseAt(value, key.time, 0, preset),
    (look, path, key) => easeKeys(look, [path], key.time, 0, preset),
  );

export const keyframeEase = (project: VideoProject, item: TimelineItem, keys: Array<KeyRef>): EaseChoice | null => {
  const choices = new Set(
    keys.map((key) => {
      const value = channelAnimated(project, item, key.channel);
      return value ? easeAt(value, key.time, 0) : null;
    }),
  );
  return choices.size === 1 ? [...choices][0] : null;
};

export const toggleKeyframesAt = (project: VideoProject, id: string, local: Ticks) => {
  const item = locateItem(project, id)?.item;
  if (!item) return project;
  const fps = project.settings.fps;
  const mark = keyframeMarks(project, item).find((candidate) => isMarkAt(candidate, local, fps));
  if (mark) return removeKeyframes(project, id, mark.keys);
  const look = hasLook(item) ? lookOf(project, item) : null;
  const lookTime = hasLook(item) ? lookTimeOf(item, item.start + local, fps) : local;
  const tolerance = frameTicks(fps) / 2;
  const keys = [
    ...valueChannels(item)
      .filter(([channel, value]) => channel !== SPEED_CHANNEL && isAnimated(value))
      .map(([channel]) => ({ channel, time: local })),
    ...Object.keys(look ? channelsOf(look) : {}).map((path) => ({ channel: `${LOOK_CHANNEL}${path}`, time: lookTime })),
  ];
  return editKeys(
    project,
    id,
    keys,
    (value, key) => toggleKeyAt(value, key.time, tolerance),
    (current, path, key) => addKeys(current, [path], key.time, tolerance),
  );
};

export const moveKeyframes = (project: VideoProject, id: string, mark: KeyMark, local: Ticks) => {
  const item = locateItem(project, id)?.item;
  if (!item) return project;
  const fps = project.settings.fps;
  const target = Math.max(0, Math.min(item.duration, snapTicks(local, fps)));
  const lookTarget = hasLook(item) ? lookTimeOf(item, item.start + target, fps) : target;
  const tolerance = frameTicks(fps) / 2;
  return editKeys(
    project,
    id,
    mark.keys,
    (value, key) => moveKeyAt(value, key.time, target, tolerance),
    (look, path, key) => moveKeys(look, [path], key.time, lookTarget, tolerance),
  );
};
