import type { TFunction } from 'i18next';
import { Track, TimelineItem, VideoProject } from '../../types/video';
import { INITIAL_ADJUSTMENTS } from '../adjustments';
import { describeHistoryChange, isSameValue } from '../editHistory';
import { allItems, itemEnd } from './model';

type ItemChange = 'move' | 'trim' | 'speed' | 'transition' | 'edit';
type ItemAction = ItemChange | 'add' | 'delete';

const FIELD_CHANGES: Partial<Record<string, ItemChange>> = {
  start: 'move',
  gap: 'move',
  duration: 'trim',
  sourceIn: 'trim',
  speed: 'speed',
  speedRamp: 'speed',
  transitionIn: 'transition',
};

const LOOK_FIELD = 'look';

const changesOf = (before: TimelineItem, after: TimelineItem) =>
  new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(
        (key) =>
          key !== LOOK_FIELD && !isSameValue(before[key as keyof TimelineItem], after[key as keyof TimelineItem]),
      )
      .map((key) => FIELD_CHANGES[key] ?? 'edit'),
  );

const itemsLabel = (action: ItemAction, items: Array<TimelineItem>, t: TFunction) => {
  const shown = items.filter(
    (item) =>
      item.type !== 'audio' || !item.link || !items.some((other) => other.type !== 'audio' && other.link === item.link),
  );
  return t(`video.history.${action}`, { count: shown.length, type: t(`video.inspector.types.${shown[0].type}`) });
};

const itemLabel = (before: VideoProject, after: VideoProject, t: TFunction) => {
  const previous = new Map(allItems(before).map((item) => [item.id, item]));
  const next = allItems(after);
  const nextIds = new Set(next.map((item) => item.id));
  const added = next.filter((item) => !previous.has(item.id));
  const removed = [...previous.values()].filter((item) => !nextIds.has(item.id));
  const changed = next.flatMap((item) => {
    const old = previous.get(item.id);
    const changes = old && old !== item ? changesOf(old, item) : null;
    return changes?.size ? [{ item, changes }] : [];
  });
  if (added.length > 0 && removed.length > 0) return t('video.history.timeline');
  if (removed.length > 0) {
    const isJoin = removed.every((item) =>
      changed.some(({ item: kept }) => kept.type === item.type && itemEnd(kept) === itemEnd(item)),
    );
    return isJoin ? t('video.history.join') : itemsLabel('delete', removed, t);
  }
  if (added.length > 0) {
    const isSplit = added.every((item) =>
      changed.some(({ item: cut }) => cut.type === item.type && itemEnd(cut) === item.start),
    );
    return isSplit ? t('video.history.split') : itemsLabel('add', added, t);
  }
  if (changed.length === 0) return null;
  const edited = changed.filter(({ changes }) => [...changes].some((change) => change !== 'move'));
  if (edited.length === 0)
    return itemsLabel(
      'move',
      changed.map(({ item }) => item),
      t,
    );
  const kinds = new Set(edited.flatMap(({ changes }) => [...changes].filter((change) => change !== 'move')));
  return itemsLabel(
    kinds.size === 1 ? [...kinds][0] : 'edit',
    edited.map(({ item }) => item),
    t,
  );
};

const lookLabel = (before: VideoProject, after: VideoProject) => {
  const id = Object.keys(after.looks).find((key) => after.looks[key] !== before.looks[key]);
  return id ? describeHistoryChange(before.looks[id] ?? INITIAL_ADJUSTMENTS, after.looks[id]) : null;
};

const countLabel = (before: number, after: number, t: TFunction, kind: 'marker' | 'media') =>
  t(`video.history.${kind}.${after > before ? 'add' : after < before ? 'delete' : 'edit'}`);

const rangeLabel = (before: VideoProject, after: VideoProject, t: TFunction) => {
  if (!after.range) return t('video.timeline.clearRange');
  return after.range.start !== before.range?.start ? t('video.timeline.setIn') : t('video.timeline.setOut');
};

const trackStates = (project: VideoProject) =>
  JSON.stringify(
    ([...project.videoTracks, ...project.audioTracks] as Array<Track<TimelineItem>>).map(
      ({ items: _items, height: _height, ...state }) => state,
    ),
  );

const depth = (project: VideoProject) => project.open?.length ?? 0;

const sequenceCount = (project: VideoProject) => Object.keys(project.sequences ?? {}).length;

const binsLabel = (before: VideoProject, after: VideoProject, t: TFunction) => {
  const was = before.bins ?? [];
  const now = after.bins ?? [];
  if (now.length !== was.length)
    return t(now.length > was.length ? 'video.mediaPool.history.newBin' : 'video.mediaPool.history.deleteBin');
  const names = new Map(was.map((bin) => [bin.id, bin.name]));
  return t(
    now.some((bin) => names.get(bin.id) !== bin.name)
      ? 'video.mediaPool.history.renameBin'
      : 'video.mediaPool.history.moveBin',
  );
};

const movesBins = (before: VideoProject, after: VideoProject) =>
  after.media.length === before.media.length &&
  after.media.some((media, index) => (media.bin ?? null) !== (before.media[index]?.bin ?? null));

export const describeProjectChange = (before: VideoProject, after: VideoProject, t: TFunction): string => {
  if (depth(after) !== depth(before)) return t('video.history.timeline');
  if (sequenceCount(after) !== sequenceCount(before))
    return t(sequenceCount(after) > sequenceCount(before) ? 'video.history.nest' : 'video.history.unnest');
  return (
    itemLabel(before, after, t) ??
    (after.looks !== before.looks ? lookLabel(before, after) : null) ??
    (after.captions !== before.captions ? t('video.history.captions') : null) ??
    (after.markers !== before.markers ? countLabel(before.markers.length, after.markers.length, t, 'marker') : null) ??
    (after.range !== before.range ? rangeLabel(before, after, t) : null) ??
    (after.bins !== before.bins ? binsLabel(before, after, t) : null) ??
    (after.media !== before.media && movesBins(before, after) ? t('video.mediaPool.history.moveToBin') : null) ??
    (after.media !== before.media ? countLabel(before.media.length, after.media.length, t, 'media') : null) ??
    (after.settings !== before.settings ? t('video.history.settings') : null) ??
    (trackStates(after) !== trackStates(before) ? t('video.history.tracks') : null) ??
    t('video.history.project')
  );
};
