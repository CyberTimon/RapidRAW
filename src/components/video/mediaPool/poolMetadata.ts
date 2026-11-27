import { useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { toast } from 'react-toastify';
import { Invokes } from '../../../types/invokes';
import { ImageFile, ImageFlag } from '../../../types/library';
import { MediaRef } from '../../../types/video';
import { useLibraryStore } from '../../../store/useLibraryStore';

export interface PoolMeta {
  rating: number;
  flag: ImageFlag | null;
  tags: Array<string> | null;
  modified: number;
}

interface PoolMetaState {
  files: Record<string, PoolMeta>;
  captured: Record<string, string | null>;
}

const EXIF_CHUNK_SIZE = 250;

export const usePoolMeta = create<PoolMetaState>(() => ({ files: {}, captured: {} }));

const requested = new Set<string>();
const dated = new Set<string>();

const sameTags = (a: Array<string> | null, b: Array<string> | null) => (a ?? []).join('\n') === (b ?? []).join('\n');

const withLibrary = (meta: PoolMeta, image: ImageFile, ratings: Record<string, number>): PoolMeta => {
  const next = {
    ...meta,
    rating: ratings[image.path] ?? image.rating ?? 0,
    flag: image.flag ?? null,
    tags: image.tags,
  };
  return next.rating === meta.rating && next.flag === meta.flag && sameTags(next.tags, meta.tags) ? meta : next;
};

const loadFiles = async (paths: Array<string>) => {
  const todo = paths.filter((path) => !requested.has(path));
  if (todo.length === 0) return;
  todo.forEach((path) => requested.add(path));
  try {
    const files = await invoke<Array<ImageFile>>(Invokes.GetAlbumImages, { paths: todo });
    const { imageList, imageRatings } = useLibraryStore.getState();
    const shown = new Map(imageList.map((image) => [image.path, image]));
    const loaded = files.map((file): [string, PoolMeta] => {
      const meta = { rating: file.rating ?? 0, flag: file.flag ?? null, tags: file.tags, modified: file.modified };
      const image = shown.get(file.path);
      return [file.path, image ? withLibrary(meta, image, imageRatings) : meta];
    });
    usePoolMeta.setState((state) => ({ files: { ...state.files, ...Object.fromEntries(loaded) } }));
  } catch (err) {
    todo.forEach((path) => requested.delete(path));
    console.error('Failed to load media metadata:', err);
  }
};

const loadCaptured = async (paths: Array<string>) => {
  const todo = paths.filter((path) => !dated.has(path));
  todo.forEach((path) => dated.add(path));
  for (let index = 0; index < todo.length; index += EXIF_CHUNK_SIZE) {
    const chunk = todo.slice(index, index + EXIF_CHUNK_SIZE);
    try {
      const exif = await invoke<Record<string, Record<string, string>>>(Invokes.ReadExifForPaths, { paths: chunk });
      const found = chunk.map((path): [string, string | null] => [path, exif[path]?.DateTimeOriginal ?? null]);
      usePoolMeta.setState((state) => ({ captured: { ...state.captured, ...Object.fromEntries(found) } }));
    } catch (err) {
      chunk.forEach((path) => dated.delete(path));
      console.error('Failed to read capture dates:', err);
    }
  }
};

useLibraryStore.subscribe((state, previous) => {
  if (requested.size === 0 || (state.imageList === previous.imageList && state.imageRatings === previous.imageRatings))
    return;
  const { files } = usePoolMeta.getState();
  let next: Record<string, PoolMeta> | null = null;
  for (const image of state.imageList) {
    const meta = files[image.path];
    if (!meta) continue;
    const merged = withLibrary(meta, image, state.imageRatings);
    if (merged === meta) continue;
    next ??= { ...files };
    next[image.path] = merged;
  }
  if (next) usePoolMeta.setState({ files: next });
});

const patchMedia = (
  paths: Array<string>,
  patch: (meta: PoolMeta) => PoolMeta,
  image: (image: ImageFile) => ImageFile,
  rating?: number,
) => {
  const changed = new Set(paths);
  usePoolMeta.setState((state) => ({
    files: Object.fromEntries(
      Object.entries(state.files).map(([path, meta]) => [path, changed.has(path) ? patch(meta) : meta]),
    ),
  }));
  useLibraryStore.getState().setLibrary((state) => ({
    imageList: state.imageList.map((entry) => (changed.has(entry.path) ? image(entry) : entry)),
    ...(rating === undefined
      ? {}
      : { imageRatings: { ...state.imageRatings, ...Object.fromEntries(paths.map((path) => [path, rating])) } }),
  }));
};

const metaOf = (path: string | undefined) => (path ? usePoolMeta.getState().files[path] : undefined);

const colorOf = (tags: Array<string> | null | undefined) =>
  tags?.find((tag) => tag.startsWith('color:'))?.slice('color:'.length) ?? null;

const withColor = (tags: Array<string> | null, color: string | null) => [
  ...(tags ?? []).filter((tag) => !tag.startsWith('color:')),
  ...(color ? [`color:${color}`] : []),
];

export const rateMedia = (paths: Array<string>, rating: number) => {
  if (paths.length === 0) return;
  const first = metaOf(paths[0]);
  const next = rating === (first?.rating ?? 0) && first?.flag !== ImageFlag.Reject ? 0 : rating;
  const unreject = <T extends { flag?: ImageFlag | null }>(entry: T): T =>
    next > 0 && entry.flag === ImageFlag.Reject ? { ...entry, flag: null } : entry;
  patchMedia(paths, (meta) => unreject({ ...meta, rating: next }), unreject, next);
  invoke(Invokes.SetRatingForPaths, { paths, rating: next }).catch((err) => {
    console.error(err);
    toast.error(`Failed to apply rating: ${err}`);
  });
};

export const flagMedia = (paths: Array<string>, flag: ImageFlag | null) => {
  if (paths.length === 0) return;
  patchMedia(
    paths,
    (meta) => ({ ...meta, flag }),
    (image) => ({ ...image, flag }),
  );
  invoke(Invokes.SetFlagForPaths, { paths, flag }).catch((err) => {
    console.error(err);
    toast.error(`Failed to update flag: ${err}`);
  });
};

export const toggleMediaFlag = (paths: Array<string>, flag: ImageFlag) =>
  flagMedia(paths, metaOf(paths[0])?.flag === flag ? null : flag);

export const labelMedia = async (paths: Array<string>, color: string | null) => {
  if (paths.length === 0) return;
  const next = color !== null && color === colorOf(metaOf(paths[0])?.tags) ? null : color;
  try {
    await invoke(Invokes.SetColorLabelForPaths, { paths, color: next });
    patchMedia(
      paths,
      (meta) => ({ ...meta, tags: withColor(meta.tags, next) }),
      (image) => ({ ...image, tags: withColor(image.tags ?? null, next) }),
    );
  } catch (err) {
    toast.error(`Failed to set color label: ${err}`);
  }
};

const joinPaths = (media: Array<MediaRef>, include: (media: MediaRef) => boolean) =>
  media
    .filter(include)
    .map((entry) => entry.path)
    .join('\n');

export const usePoolMetadata = (media: Array<MediaRef>, wantsDates: boolean) => {
  const files = usePoolMeta((state) => state.files);
  const captured = usePoolMeta((state) => state.captured);
  const filePaths = useMemo(() => joinPaths(media, (entry) => entry.kind !== 'sequence'), [media]);
  const stillPaths = useMemo(() => joinPaths(media, (entry) => entry.kind === 'image'), [media]);

  useEffect(() => {
    if (filePaths) void loadFiles(filePaths.split('\n'));
  }, [filePaths]);

  useEffect(() => {
    if (wantsDates && stillPaths) void loadCaptured(stillPaths.split('\n'));
  }, [wantsDates, stillPaths]);

  return { files, captured };
};
