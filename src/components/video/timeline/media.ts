import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../../types/invokes';
import { getVideo, useVideoStore } from '../../../store/useVideoStore';
import { ensureTitleRasters } from '../../../store/videoView';
import { isSequencePath, sequenceIdOf } from '../../../utils/video/nesting';
import { sequenceProject, withRevision } from '../../../utils/video/revisions';

const MEDIA_TILES = 64;
const SEQUENCE_TILES = 24;
const SPRITE_HEIGHT = 96;
const WAVEFORM_WIDTH = 2048;
const WAVEFORM_HEIGHT = 96;
const MAX_IDLE_IMAGES = 12;
const TRIM_DELAY_MS = 1000;

export interface Filmstrip {
  tiles: Array<ImageBitmap>;
  aspect: number;
}

interface MediaImages {
  sprite: Filmstrip;
  waveform: string;
}

type MediaImageKind = keyof MediaImages;

interface CachedImage<K extends MediaImageKind> {
  value: Promise<MediaImages[K] | null>;
  ready?: MediaImages[K] | null;
  users: number;
  ticket: number;
  deflicker: boolean;
}

type Caches = { [K in MediaImageKind]: Map<string, CachedImage<K>> };

const caches: Caches = { sprite: new Map(), waveform: new Map() };

let tickets = 0;

const sequenceStrip = async (path: string): Promise<ArrayBuffer> => {
  const { project, useProxies } = getVideo();
  const id = sequenceIdOf(path);
  if (!project || !id) throw new Error(`Unknown sequence ${path}`);
  const nested = sequenceProject(project, id);
  const { width, height } = nested.settings;
  const titleKeys = await ensureTitleRasters(nested, SPRITE_HEIGHT);
  return withRevision(nested, (revision) =>
    invoke<ArrayBuffer>(Invokes.VideoSequenceFilmstrip, {
      request: {
        revision,
        count: SEQUENCE_TILES,
        view: {
          targetResolution: Math.round((SPRITE_HEIGHT * Math.max(width, height)) / Math.max(1, height)),
          contentPath: path,
          titleKeys,
          useProxies,
          lookOverrides: {},
        },
      },
    }),
  );
};

const sliceSprite = async (bytes: ArrayBuffer, count: number): Promise<Filmstrip> => {
  const sprite = await createImageBitmap(new Blob([bytes]));
  const edge = (index: number) => Math.round((index * sprite.width) / count);
  try {
    const tiles = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        createImageBitmap(sprite, edge(index), 0, Math.max(1, edge(index + 1) - edge(index)), sprite.height),
      ),
    );
    return { tiles, aspect: sprite.width / count / Math.max(1, sprite.height) };
  } finally {
    sprite.close();
  }
};

const loaders: {
  [K in MediaImageKind]: (path: string, ticket: number, deflicker: boolean) => Promise<MediaImages[K]>;
} = {
  sprite: async (path, ticket, deflicker) =>
    isSequencePath(path)
      ? sliceSprite(await sequenceStrip(path), SEQUENCE_TILES)
      : sliceSprite(
          await invoke<ArrayBuffer>(Invokes.VideoFilmstrip, {
            path,
            count: MEDIA_TILES,
            height: SPRITE_HEIGHT,
            deflicker,
            ticket,
          }),
          MEDIA_TILES,
        ),
  waveform: async (path, ticket) =>
    URL.createObjectURL(
      new Blob([
        await invoke<ArrayBuffer>(Invokes.VideoWaveform, {
          path,
          width: WAVEFORM_WIDTH,
          height: WAVEFORM_HEIGHT,
          ticket,
        }),
      ]),
    ),
};

const disposers: { [K in MediaImageKind]: (value: MediaImages[K]) => void } = {
  sprite: (strip) => strip.tiles.forEach((tile) => tile.close()),
  waveform: (url) => URL.revokeObjectURL(url),
};

const fill = <K extends MediaImageKind>(entry: CachedImage<K>, kind: K, path: string) => {
  entry.ready = undefined;
  entry.ticket = isSequencePath(path) ? 0 : (tickets += 1);
  entry.value = loaders[kind](path, entry.ticket, entry.deflicker)
    .catch(() => null)
    .then((value) => (entry.ready = value));
};

export const retryMediaImages = (path: string) =>
  (Object.keys(caches) as Array<MediaImageKind>).forEach((kind) =>
    caches[kind].forEach((entry, key) => {
      if (entry.ready === null && key.startsWith(`${path}|`)) fill(entry as CachedImage<typeof kind>, kind, path);
    }),
  );

const acquire = <K extends MediaImageKind>(kind: K, path: string, key: string, deflicker: boolean) => {
  const cache = caches[kind] as Map<string, CachedImage<K>>;
  let entry = cache.get(key);
  if (!entry) {
    entry = { value: Promise.resolve(null), users: 0, ticket: 0, deflicker };
    fill(entry, kind, path);
  }
  entry.users += 1;
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
};

let trimTimer = 0;

const trimIdle = () => {
  trimTimer = 0;
  (Object.keys(caches) as Array<MediaImageKind>).forEach(<K extends MediaImageKind>(kind: K) => {
    const cache = caches[kind] as Map<string, CachedImage<K>>;
    const idle = [...cache].filter(([, entry]) => entry.users <= 0);
    idle.slice(0, Math.max(0, idle.length - MAX_IDLE_IMAGES)).forEach(([key, entry]) => {
      cache.delete(key);
      void entry.value.then((value) => value && disposers[kind](value));
    });
  });
};

const release = <K extends MediaImageKind>(kind: K, key: string) => {
  const cache = caches[kind] as Map<string, CachedImage<K>>;
  const entry = cache.get(key);
  if (entry) entry.users -= 1;
  if (entry && entry.users <= 0 && entry.ready === undefined && entry.ticket) {
    cache.delete(key);
    void invoke(Invokes.VideoCancelStrip, { ticket: entry.ticket }).catch(() => undefined);
    void entry.value.then((value) => value && disposers[kind](value));
  }
  if (!trimTimer) trimTimer = window.setTimeout(trimIdle, TRIM_DELAY_MS);
};

export function useMediaImage<K extends MediaImageKind>(
  kind: K,
  path: string,
  enabled: boolean,
  revision = '',
): MediaImages[K] | null {
  const active = enabled && !(kind === 'waveform' && isSequencePath(path));
  const deflicker = useVideoStore(
    (state) =>
      kind === 'sprite' && !!state.project?.media.some((media) => media.path === path && media.timelapse?.deflicker),
  );
  const key = `${path}|${revision}${deflicker ? '|deflicker' : ''}`;
  const [image, setImage] = useState(() => ({
    path,
    value: ((caches[kind] as Map<string, CachedImage<K>>).get(key)?.ready ?? null) as MediaImages[K] | null,
  }));
  const shown = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (shown.current) release(kind, shown.current);
      shown.current = null;
    },
    [kind],
  );

  useEffect(() => {
    if (!active) return;
    let alive = true;
    let pending = true;
    void acquire(kind, path, key, deflicker).then((value) => {
      if (!alive) return;
      pending = false;
      const previous = shown.current;
      shown.current = key;
      setImage({ path, value });
      if (previous) release(kind, previous);
    });
    return () => {
      alive = false;
      if (pending) release(kind, key);
    };
  }, [kind, path, key, active, deflicker]);

  return active && image.path === path ? image.value : null;
}
