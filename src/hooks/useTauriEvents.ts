import { useEffect, useRef } from 'react';
import { borrow } from '@blac/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ThumbnailBloc } from '../blocs/library/ThumbnailBloc';
import { PreviewBloc } from '../blocs/editor/PreviewBloc';
import { RatingsBloc } from '../blocs/library/RatingsBloc';
import { isTauri } from '../utils/tauriMock';
import type { HistogramData } from '../types/editor';

interface ThumbnailEvent {
  path: string;
  data: string;
  rating: number;
}

interface ExportProgressEvent {
  current: number;
  total: number;
  currentFile: string;
}

interface IndexingProgressEvent {
  current: number;
  total: number;
}

export function useTauriEvents() {
  const isActiveRef = useRef(true);
  const listenersRef = useRef<Promise<UnlistenFn>[]>([]);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    isActiveRef.current = true;
    const listeners: Promise<UnlistenFn>[] = [];

    const thumbnailBloc = borrow(ThumbnailBloc);
    const previewBloc = borrow(PreviewBloc);
    const ratingsBloc = borrow(RatingsBloc);

    listeners.push(
      listen<Uint8Array>('preview-update-final', (event) => {
        if (!isActiveRef.current) return;
        const imageData = new Uint8Array(event.payload);
        const blob = new Blob([imageData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        previewBloc.setPreviewUrl(url);
      })
    );

    listeners.push(
      listen<Uint8Array>('preview-uncropped', (event) => {
        if (!isActiveRef.current) return;
        const imageData = new Uint8Array(event.payload);
        const blob = new Blob([imageData], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        previewBloc.setOriginalUrl(url);
      })
    );

    listeners.push(
      listen<HistogramData>('histogram-update', (event) => {
        if (!isActiveRef.current) return;
        previewBloc.setHistogram(event.payload);
      })
    );

    listeners.push(
      listen<ThumbnailEvent>('thumbnail-generated', (event) => {
        if (!isActiveRef.current) return;
        const { path, data, rating } = event.payload;
        if (data) {
          thumbnailBloc.setThumbnail(path, data);
        }
        if (rating !== undefined) {
          ratingsBloc.setRating(path, rating);
        }
      })
    );

    listeners.push(
      listen<ExportProgressEvent>('export-progress', (event) => {
        if (!isActiveRef.current) return;
        console.log('[TauriEvents] Export progress:', event.payload);
      })
    );

    listeners.push(
      listen<IndexingProgressEvent>('indexing-progress', (event) => {
        if (!isActiveRef.current) return;
        console.log('[TauriEvents] Indexing progress:', event.payload);
      })
    );

    listenersRef.current = listeners;

    return () => {
      isActiveRef.current = false;
      listeners.forEach((listenerPromise) => {
        listenerPromise.then((unlisten) => unlisten()).catch(console.error);
      });
      listenersRef.current = [];
    };
  }, []);
}
