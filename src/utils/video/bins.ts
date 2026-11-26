import { v4 as uuidv4 } from 'uuid';
import { MediaBin, MediaRef, VideoProject } from '../../types/video';

const NO_BINS: Array<MediaBin> = [];

export type BinScope = Pick<VideoProject, 'bins'>;
export type MediaScope = Pick<VideoProject, 'bins' | 'media'>;

export const binsOf = (project: BinScope | null | undefined) => project?.bins ?? NO_BINS;

const binIndexes = new WeakMap<Array<MediaBin>, Map<string, MediaBin>>();

export const findBin = (project: BinScope | null | undefined, id: string | null | undefined) => {
  const bins = binsOf(project);
  if (!id || bins.length === 0) return null;
  let index = binIndexes.get(bins);
  if (!index) {
    index = new Map(bins.map((bin) => [bin.id, bin]));
    binIndexes.set(bins, index);
  }
  return index.get(id) ?? null;
};

export const parentOf = (project: BinScope, bin: MediaBin) => (findBin(project, bin.parent) ? bin.parent : null);

export const binOfMedia = (project: BinScope, media: MediaRef) =>
  media.bin && findBin(project, media.bin) ? media.bin : null;

export const childBins = (project: BinScope, parent: string | null) =>
  binsOf(project).filter((bin) => parentOf(project, bin) === parent);

export const binPath = (project: BinScope, id: string | null): Array<MediaBin> => {
  const path: Array<MediaBin> = [];
  let bin = findBin(project, id);
  while (bin && !path.includes(bin)) {
    path.unshift(bin);
    bin = findBin(project, bin.parent);
  }
  return path;
};

const isWithin = (project: BinScope, id: string, ancestor: string) =>
  binPath(project, id).some((bin) => bin.id === ancestor);

export const uniqueBinName = (project: BinScope, parent: string | null, name: string) => {
  const taken = new Set(childBins(project, parent).map((bin) => bin.name));
  if (!taken.has(name)) return name;
  let suffix = 2;
  while (taken.has(`${name} ${suffix}`)) suffix++;
  return `${name} ${suffix}`;
};

const withBin = (media: MediaRef, bin: string | null): MediaRef => {
  if (bin) return { ...media, bin };
  const { bin: _bin, ...rest } = media;
  return rest;
};

export const createBin = (project: VideoProject, name: string, parent: string | null): [VideoProject, MediaBin] => {
  const bin: MediaBin = { id: uuidv4(), name, parent: findBin(project, parent) ? parent : null };
  return [{ ...project, bins: [...binsOf(project), bin] }, bin];
};

export const renameBin = (project: VideoProject, id: string, name: string): VideoProject => {
  const bin = findBin(project, id);
  if (!bin || bin.name === name) return project;
  return { ...project, bins: binsOf(project).map((entry) => (entry.id === id ? { ...entry, name } : entry)) };
};

export const deleteBin = (project: VideoProject, id: string): VideoProject => {
  const bin = findBin(project, id);
  if (!bin) return project;
  const parent = parentOf(project, bin);
  return {
    ...project,
    bins: binsOf(project).flatMap((entry) =>
      entry.id === id ? [] : [entry.parent === id ? { ...entry, parent } : entry],
    ),
    media: project.media.map((media) => (media.bin === id ? withBin(media, parent) : media)),
  };
};

export const moveMediaToBin = (project: VideoProject, ids: Array<string>, bin: string | null): VideoProject => {
  const target = findBin(project, bin) ? bin : null;
  const moving = new Set(ids);
  let changed = false;
  const media = project.media.map((entry) => {
    if (!moving.has(entry.id) || binOfMedia(project, entry) === target) return entry;
    changed = true;
    return withBin(entry, target);
  });
  return changed ? { ...project, media } : project;
};

export const canMoveBin = (project: BinScope, id: string, target: string | null) => {
  const bin = findBin(project, id);
  if (!bin || parentOf(project, bin) === target) return false;
  return target === null || (!!findBin(project, target) && !isWithin(project, target, id));
};

export const moveBin = (project: VideoProject, id: string, target: string | null): VideoProject =>
  canMoveBin(project, id, target)
    ? { ...project, bins: binsOf(project).map((bin) => (bin.id === id ? { ...bin, parent: target } : bin)) }
    : project;
