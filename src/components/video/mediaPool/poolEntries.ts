import { SortDirection } from '../../../types/library';
import { MediaBin, MediaInfo, MediaKind, MediaPoolView, MediaRef } from '../../../types/video';
import { folderOf } from '../../../store/useVideoStore';
import { matchesColorFilter, matchesFlagFilter, matchesRatingFilter } from '../../../hooks/useSortedLibrary';
import { MediaScope, binOfMedia, childBins, parentOf } from '../../../utils/video/bins';
import { matchesQuery, mediaName } from './media';
import { PoolMeta } from './poolMetadata';
import { PoolFilters } from './poolView';

export type PoolTile =
  { type: 'media'; media: MediaRef } | { type: 'bin'; bin: MediaBin; count: number } | { type: 'draft' };

export interface PoolHeader {
  key: string;
  kind?: MediaKind;
  folder?: string;
  count: number;
  collapsed: boolean;
}

export interface PoolBlock {
  header: PoolHeader | null;
  tiles: Array<PoolTile>;
}

export interface PoolContent {
  blocks: Array<PoolBlock>;
  isEmpty: boolean;
}

interface PoolSource {
  project: MediaScope;
  location: string | null;
  query: string;
  filters: PoolFilters;
  view: MediaPoolView;
  used: ReadonlySet<string>;
  files: Record<string, PoolMeta>;
  captured: Record<string, string | null>;
  info: Record<string, MediaInfo>;
  collapsed: Record<string, true>;
  hasDraft: boolean;
}

const KIND_ORDER: Array<MediaKind> = ['video', 'image', 'audio', 'sequence'];
const EXIF_DATE = /^(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const exifTime = (value: string | null | undefined) => {
  const match = value?.match(EXIF_DATE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
};

const matchesFilters = (source: PoolSource, media: MediaRef) => {
  const { filters, files, used } = source;
  const meta = files[media.path];
  return (
    (filters.show === 'all' || !used.has(media.id)) &&
    (filters.kind === 'all' || media.kind === filters.kind) &&
    matchesRatingFilter(meta?.rating ?? 0, filters.rating, filters.ratingOperator) &&
    matchesFlagFilter(meta?.flag ?? null, filters.flag) &&
    matchesColorFilter(meta?.tags, filters.colors)
  );
};

const sortValue = (source: PoolSource, media: MediaRef): number | string | null => {
  switch (source.view.sort) {
    case 'name':
      return mediaName(media);
    case 'date': {
      const captured =
        media.kind === 'image'
          ? exifTime(source.captured[media.path])
          : media.kind === 'video'
            ? exifTime(source.info[media.path]?.captured)
            : null;
      const modified = source.files[media.path]?.modified;
      return captured ?? (modified ? modified * 1000 : null);
    }
    case 'duration':
      return media.kind === 'image' ? 0 : (source.info[media.path]?.duration ?? 0);
    case 'type':
      return KIND_ORDER.indexOf(media.kind);
    default:
      return null;
  }
};

const sortMedia = (source: PoolSource, media: Array<MediaRef>) => {
  const sign = source.view.order === SortDirection.Descending ? -1 : 1;
  const order = new Map(source.project.media.map((entry, index) => [entry.id, index]));
  const keyed = media.map((entry) => ({
    entry,
    value: sortValue(source, entry),
    name: mediaName(entry),
    index: order.get(entry.id) ?? 0,
  }));
  keyed.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value !== b.value) return a.value === null ? 1 : -1;
    } else if (a.value !== b.value) {
      const compared =
        typeof a.value === 'string' ? collator.compare(a.value, String(b.value)) : a.value - (b.value as number);
      if (compared !== 0) return sign * compared;
    }
    if (source.view.sort === 'type') {
      const byName = collator.compare(a.name, b.name);
      if (byName !== 0) return byName;
    }
    return sign * (a.index - b.index);
  });
  return keyed.map(({ entry }) => entry);
};

const groupOf = (source: PoolSource, media: MediaRef) => {
  if (source.view.group === 'type') return { key: `type:${media.kind}`, kind: media.kind };
  if (media.kind === 'sequence') return { key: 'folder:', kind: media.kind };
  const folder = folderOf(media.path);
  return { key: `folder:${folder}`, folder };
};

export const folderLabel = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

const groupBlocks = (source: PoolSource, media: Array<MediaRef>): Array<PoolBlock> => {
  const groups = new Map<string, { header: Omit<PoolHeader, 'count' | 'collapsed'>; media: Array<MediaRef> }>();
  for (const entry of media) {
    const group = groupOf(source, entry);
    const existing = groups.get(group.key);
    if (existing) existing.media.push(entry);
    else groups.set(group.key, { header: group, media: [entry] });
  }
  const ordered = [...groups.values()].sort(({ header: a }, { header: b }) => {
    if (a.folder !== undefined && b.folder !== undefined)
      return collator.compare(folderLabel(a.folder), folderLabel(b.folder)) || a.folder.localeCompare(b.folder);
    if (a.folder !== undefined || b.folder !== undefined) return a.folder !== undefined ? -1 : 1;
    return KIND_ORDER.indexOf(a.kind ?? 'video') - KIND_ORDER.indexOf(b.kind ?? 'video');
  });
  return ordered.map(({ header, media: grouped }) => {
    const collapsed = !!source.collapsed[header.key];
    return {
      header: { ...header, count: grouped.length, collapsed },
      tiles: collapsed ? [] : grouped.map((entry) => ({ type: 'media' as const, media: entry })),
    };
  });
};

const binTiles = (source: PoolSource): Array<PoolTile> => {
  const { project, location } = source;
  const counts = new Map<string, number>();
  const count = (id: string | null) => {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  project.media.forEach((media) => count(binOfMedia(project, media)));
  (project.bins ?? []).forEach((bin) => count(parentOf(project, bin)));
  const bins = childBins(project, location)
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((bin): PoolTile => ({ type: 'bin', bin, count: counts.get(bin.id) ?? 0 }));
  return source.hasDraft ? [{ type: 'draft' }, ...bins] : bins;
};

const locatedMedia = (project: MediaScope, location: string | null) =>
  project.media.filter((media) => binOfMedia(project, media) === location);

export const buildPoolContent = (source: PoolSource): PoolContent => {
  const { project, location, query, files, view } = source;
  const searching = query.length > 0;
  const scoped = searching ? project.media : locatedMedia(project, location);
  const bins = searching ? [] : binTiles(source);
  const visible = sortMedia(
    source,
    scoped.filter((media) => matchesFilters(source, media) && matchesQuery(media, query, files[media.path]?.tags)),
  );
  const isEmpty = bins.length === 0 && scoped.length === 0;
  if (view.group === 'none') {
    const tiles = [...bins, ...visible.map((media): PoolTile => ({ type: 'media', media }))];
    return { blocks: tiles.length > 0 ? [{ header: null, tiles }] : [], isEmpty };
  }
  return {
    blocks: [...(bins.length > 0 ? [{ header: null, tiles: bins }] : []), ...groupBlocks(source, visible)],
    isEmpty,
  };
};
