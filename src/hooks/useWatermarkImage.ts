import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../types/invokes';
import { WatermarkSource, WatermarkSourceKind } from '../types/export';

const TEXT_DEBOUNCE_MS = 150;

export interface WatermarkImage {
  url: string;
  aspect: number;
}

let cached: { key: string; source: WatermarkSource; promise: Promise<WatermarkImage | null> } | null = null;
let revision = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const loadWatermarkImage = (source: WatermarkSource) => {
  const key = JSON.stringify(source);
  if (cached?.key === key) return cached.promise;
  const previous = cached?.promise;
  const promise = invoke<ArrayBuffer>(Invokes.LoadWatermarkPreview, { source })
    .then((bytes) => {
      const view = new DataView(bytes);
      const width = view.getUint32(0, true);
      const height = view.getUint32(4, true);
      return width > 0 && height > 0
        ? { url: URL.createObjectURL(new Blob([bytes.slice(8)], { type: 'image/png' })), aspect: width / height }
        : null;
    })
    .catch(() => null);
  cached = { key, source, promise };
  if (previous) promise.finally(() => previous.then((image) => image && URL.revokeObjectURL(image.url)));
  return promise;
};

export const reloadWatermarkImage = () => {
  if (!cached) return;
  const previous = cached;
  cached = null;
  loadWatermarkImage(previous.source).finally(() =>
    previous.promise.then((image) => image && URL.revokeObjectURL(image.url)),
  );
  revision += 1;
  listeners.forEach((listener) => listener());
};

export function useWatermarkImage(source: WatermarkSource | null): WatermarkImage | null | undefined {
  const currentRevision = useSyncExternalStore(subscribe, () => revision);
  const key = source ? JSON.stringify(source) : null;
  const [loaded, setLoaded] = useState<{ key: string; kind: WatermarkSourceKind; image: WatermarkImage | null } | null>(
    null,
  );

  useEffect(() => {
    if (!key) return;
    const requested: WatermarkSource = JSON.parse(key);
    let active = true;
    const load = () =>
      loadWatermarkImage(requested).then((image) => {
        if (active) setLoaded({ key, kind: requested.kind, image });
      });
    const timer = window.setTimeout(load, requested.kind === WatermarkSourceKind.Text ? TEXT_DEBOUNCE_MS : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [key, currentRevision]);

  if (!source || !loaded) return undefined;
  if (loaded.key === key) return loaded.image;
  return source.kind === WatermarkSourceKind.Text && loaded.kind === WatermarkSourceKind.Text
    ? loaded.image
    : undefined;
}
