import { v4 as uuidv4 } from 'uuid';
import {
  AudioTrack,
  ClipItem,
  MediaInfo,
  MediaRef,
  Sequence,
  Ticks,
  TimelineItem,
  VideoProject,
  VideoTrack,
} from '../../types/video';
import {
  advanceStart,
  gapOf,
  insertMainClips,
  placeItem,
  relinker,
  removeItemsKeepTracks,
  splitOne,
  tidy,
  updateItem,
  withGap,
} from './edit';
import { allItems, createClipItem, hashString, itemEnd, locateItem, lookOf, mainTrack, mediaOf } from './model';
import { fpsValue, ticksToSeconds } from './time';

const ROOT = 'root';
const PREFIX = 'sequence:';

export const isSequencePath = (path: string) => path.startsWith(PREFIX);

const openId = (project: VideoProject) => project.open?.at(-1) ?? ROOT;

const currentSequence = (project: VideoProject): Sequence => ({
  videoTracks: project.videoTracks,
  audioTracks: project.audioTracks,
  markers: project.markers,
  captions: project.captions,
  range: project.range ?? null,
});

const swap = (project: VideoProject, id: string, open: Array<string>): VideoProject => {
  const target = project.sequences?.[id];
  if (!target) return project;
  const rest = Object.entries(project.sequences ?? {}).filter(([key]) => key !== id);
  return {
    ...project,
    ...target,
    sequences: Object.fromEntries([...rest, [openId(project), currentSequence(project)]]),
    open: open.length > 0 ? open : undefined,
  };
};

export const enterSequence = (project: VideoProject, id: string) =>
  id === openId(project) ? project : swap(project, id, [...(project.open ?? []), id]);

export const leaveSequence = (project: VideoProject) =>
  project.open?.length ? swap(project, project.open.at(-2) ?? ROOT, project.open.slice(0, -1)) : project;

export const rootProject = (project: VideoProject): VideoProject =>
  project.open?.length ? rootProject(leaveSequence(project)) : project;

export const openedAt = (project: VideoProject, open: Array<string> | undefined): VideoProject => {
  const path = open ?? [];
  if ((project.open ?? []).join('/') === path.join('/')) return project;
  let opened = rootProject(project);
  for (const id of path) {
    const entered = enterSequence(opened, id);
    if (entered === opened) break;
    opened = entered;
  }
  return opened;
};

export const openSequences = (project: VideoProject) =>
  (project.open ?? []).map((id) => ({ id, name: mediaOf(project, id)?.name ?? '' }));

const sequenceOf = (project: VideoProject, id: string): Sequence | null =>
  id === openId(project) ? currentSequence(project) : (project.sequences?.[id] ?? null);

export const sequenceIdOf = (path: string) => (isSequencePath(path) ? path.slice(PREFIX.length) : null);

export const sequenceRevision = (project: VideoProject, id: string) => {
  const sequence = sequenceOf(project, id);
  if (!sequence) return '';
  const looks = allItems(sequence).map((item) => lookOf(project, item));
  const tracks = sequence.videoTracks.map(({ height: _height, ...track }) => track);
  return hashString(JSON.stringify([tracks, looks, project.settings]));
};

export const sequenceInfo = (project: VideoProject, ref: MediaRef): MediaInfo | null => {
  const sequence = ref.kind === 'sequence' ? sequenceOf(project, ref.id) : null;
  if (!sequence) return null;
  const items = allItems(sequence);
  return {
    duration: ticksToSeconds(Math.max(0, ...items.map(itemEnd))),
    width: project.settings.width,
    height: project.settings.height,
    fps: fpsValue(project.settings.fps),
    hasVideo: true,
    hasAudio: items.some((item) => item.type === 'clip' || item.type === 'audio'),
    codec: null,
    audioCodec: null,
    bitRate: null,
    hdr: false,
    isStill: false,
    isRaw: false,
  };
};

const references = (sequence: Sequence) =>
  allItems(sequence).flatMap((item) => (item.type === 'clip' ? [item.media] : []));

const containsSequence = (project: VideoProject, id: string, target: string, seen = new Set<string>()): boolean => {
  if (id === target) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  const sequence = sequenceOf(project, id);
  return !!sequence && references(sequence).some((child) => containsSequence(project, child, target, seen));
};

export const canPlaceSequence = (project: VideoProject, id: string) =>
  ![ROOT, ...(project.open ?? [])].some((open) => containsSequence(project, id, open));

export type NestResult = { project: VideoProject; clipId: string } | { refusal: 'empty' | 'gap' };

const shifted = <T extends TimelineItem>(items: Array<T>, ids: Set<string>, origin: Ticks) =>
  items.filter((item) => ids.has(item.id)).map((item) => ({ ...item, start: item.start - origin }));

const nextOnTrack = (project: VideoProject, id: string) => {
  const location = locateItem(project, id);
  return location ? (location.track.items[location.index + 1]?.id ?? null) : null;
};

const insideWindow = (project: VideoProject, ids: Array<string>, origin: Ticks, end: Ticks) =>
  ids.reduce(
    ({ source, inside }, id) => {
      const item = locateItem(source, id)?.item;
      if (!item || itemEnd(item) <= origin || item.start >= end) return { source, inside };
      let current = source;
      let kept = id;
      if (item.start < origin) {
        current = splitOne(current, id, origin);
        const tail = current === source ? null : nextOnTrack(current, id);
        if (tail) kept = tail;
        else current = updateItem(current, id, (head) => advanceStart(head, origin - head.start, current.settings.fps));
      }
      const trimmed = locateItem(current, kept)?.item;
      if (trimmed && itemEnd(trimmed) > end) current = splitOne(current, kept, end);
      return { source: current, inside: [...inside, kept] };
    },
    { source: project, inside: [] as Array<string> },
  );

export const nestItems = (input: VideoProject, ids: Array<string>, name: string): NestResult => {
  const located = ids.flatMap((id) => locateItem(input, id) ?? []);
  if (!located.some((location) => location.kind === 'video')) return { refusal: 'empty' };
  const main = located
    .filter((location) => location.kind === 'video' && location.trackIndex === 0)
    .sort((a, b) => a.index - b.index);
  if (main.some((location, offset) => location.index !== main[0].index + offset)) return { refusal: 'gap' };
  const latest = Math.max(...located.map(({ item }) => itemEnd(item)));
  const origin = main.length > 0 ? main[0].item.start : Math.min(...located.map(({ item }) => item.start));
  const atEnd = main.length === 0 || main[main.length - 1].index === mainTrack(input).items.length - 1;
  const end = atEnd ? latest : itemEnd(main[main.length - 1].item);
  const others = located.filter((location) => !(location.kind === 'video' && location.trackIndex === 0));
  const kept = insideWindow(
    input,
    others.map(({ item }) => item.id),
    origin,
    end,
  );
  const project = kept.source;
  const nestedIds = [...main.map(({ item }) => item.id), ...kept.inside];
  const chosen = new Set(nestedIds);
  const nested = tidy({
    ...project,
    videoTracks: project.videoTracks.map((track, index) => ({
      ...track,
      id: uuidv4(),
      items: shifted(track.items, chosen, origin).map((item, position) =>
        index === 0 && position === 0 && item.type === 'clip' ? withGap({ ...item, transitionIn: null }, 0) : item,
      ),
    })) as Array<VideoTrack>,
    audioTracks: project.audioTracks.map((track) => ({
      ...track,
      id: uuidv4(),
      items: shifted(track.items, chosen, origin),
    })) as Array<AudioTrack>,
  });
  const id = uuidv4();
  const ref: MediaRef = { id, path: `${PREFIX}${id}`, kind: 'sequence', name };
  const sequence: Sequence = {
    videoTracks: nested.videoTracks,
    audioTracks: nested.audioTracks,
    markers: [],
    captions: null,
  };
  const removed = removeItemsKeepTracks(project, nestedIds);
  const withSequence = {
    ...removed,
    media: [...removed.media, ref],
    sequences: { ...(removed.sequences ?? {}), [id]: sequence },
  };
  const first = main[0]?.item;
  const clip: ClipItem = {
    ...createClipItem(ref, sequenceInfo(withSequence, ref)!, project.settings, null),
    start: origin,
    duration: end - origin,
    transitionIn: first?.type === 'clip' ? first.transitionIn : null,
  };
  const topTrack = Math.min(
    ...located.filter((location) => location.kind === 'video').map((location) => location.trackIndex),
  );
  return {
    project:
      main.length > 0
        ? tidy(insertMainClips(withSequence, [clip], main[0].index, first ? gapOf(first) : 0))
        : tidy(placeItem(withSequence, clip, topTrack)),
    clipId: clip.id,
  };
};

export const isPlainCompound = (project: VideoProject, clip: TimelineItem) => {
  const ref = clip.type === 'clip' ? mediaOf(project, clip.media) : null;
  if (!ref || ref.kind !== 'sequence' || clip.type !== 'clip') return false;
  const plain = createClipItem(ref, sequenceInfo(project, ref)!, project.settings, null);
  const fields = [
    'speed',
    'speedRamp',
    'look',
    'transform',
    'fit',
    'blend',
    'fadeIn',
    'fadeOut',
    'volume',
    'freeze',
    'reverse',
  ] as const;
  return (
    fields.every((field) => JSON.stringify(clip[field] ?? null) === JSON.stringify(plain[field] ?? null)) &&
    !clip.animIn &&
    !clip.animOut
  );
};

const clipToWindow = <T extends TimelineItem>(item: T, from: Ticks, to: Ticks, project: VideoProject): T | null => {
  if (itemEnd(item) <= from || item.start >= to) return null;
  const head = item.start < from ? (advanceStart(item, from - item.start, project.settings.fps) as T) : item;
  return itemEnd(head) > to ? { ...head, duration: to - head.start } : head;
};

export const unnestItem = (project: VideoProject, clipId: string): VideoProject => {
  const location = locateItem(project, clipId);
  const clip = location?.item;
  if (!location || clip?.type !== 'clip' || !isPlainCompound(project, clip)) return project;
  const sequence = sequenceOf(project, clip.media);
  if (!sequence) return project;
  const from = clip.sourceIn;
  const to = from + clip.duration;
  const relink = relinker(allItems(sequence));
  const placed = <T extends TimelineItem>(items: Array<T>) =>
    items.flatMap((item) => {
      const kept = clipToWindow(item, from, to, project);
      return kept ? [relink({ ...kept, id: uuidv4(), start: kept.start - from + clip.start })] : [];
    });
  const mainItems = placed(sequence.videoTracks[0]?.items ?? []).map((item, index) =>
    index === 0 && item.type === 'clip' ? { ...item, transitionIn: clip.transitionIn } : item,
  ) as Array<ClipItem>;
  const removed = removeItemsKeepTracks(project, [clipId]);
  let next =
    location.kind === 'video' && location.trackIndex === 0
      ? insertMainClips(
          removed,
          mainItems,
          location.index,
          gapOf(clip) + Math.max(0, (mainItems[0]?.start ?? clip.start) - clip.start),
        )
      : mainItems.reduce((current, item) => placeItem(current, item, location.trackIndex), removed);
  sequence.videoTracks.slice(1).forEach((track, index) =>
    placed(track.items).forEach((item) => {
      next = placeItem(next, item, location.trackIndex + index + 1);
    }),
  );
  sequence.audioTracks.forEach((track, index) =>
    placed(track.items).forEach((item) => {
      next = placeItem(next, item, index);
    }),
  );
  return tidy(next);
};
