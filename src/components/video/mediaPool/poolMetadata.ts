import { useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
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
