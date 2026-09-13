import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useProcessStore } from '../store/useProcessStore';
import { Invokes } from '../components/ui/AppProperties';
import { enqueuePreviewDetail, needsOriginalDetail } from '../utils/previewDetailQueue';
import { queueThumbnails } from './thumbnailRequests';

export function useCullingPreview(path: string, zoom: number, previewFit: number | null) {
  const thumbnail = useProcessStore((s) => s.thumbnails[path]);
  const medium = useProcessStore((s) => s.mediumThumbnails[path]);
  const revision = medium || thumbnail || '';
  const [detail, setDetail] = useState<{ revision: string; url: string } | null>(null);
  const [previewExhausted, setPreviewExhausted] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [failedRevision, setFailedRevision] = useState<string | null>(null);

  useEffect(() => {
    if (medium) return;
    setPreviewExhausted(false);
    let attempts = 0;
    const request = () => {
      if (attempts++ < 3) void queueThumbnails([path], true).catch(console.error);
      else setPreviewExhausted(true);
    };
    request();
    const timer = setInterval(request, 6000);
    return () => clearInterval(timer);
  }, [path, medium, thumbnail]);

  useEffect(() => {
    setDetail(null);
    setFailedRevision(null);
  }, [path, revision]);

  useEffect(
    () => () => {
      if (detail) URL.revokeObjectURL(detail.url);
    },
    [detail],
  );

  const needsDetail =
    !!medium && previewFit !== null && needsOriginalDetail(zoom, previewFit, window.devicePixelRatio || 1);
  useEffect(() => {
    if (!needsDetail) setDetail(null);
  }, [needsDetail]);

  useEffect(() => {
    if (!needsDetail || detail?.revision === revision || failedRevision === revision) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoadingDetail(true);
      void enqueuePreviewDetail(controller.signal, async () => {
        const metadata = await invoke<{ adjustments?: unknown }>(Invokes.LoadMetadata, { path });
        if (controller.signal.aborted) return;
        return invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
          path,
          jsAdjustments: metadata.adjustments ?? {},
        });
      })
        .then((bytes) => {
          if (!bytes || controller.signal.aborted) return;
          setDetail({ revision, url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })) });
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setFailedRevision(revision);
            console.error('Original detail unavailable; retaining saved preview', error);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingDetail(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      setLoadingDetail(false);
    };
  }, [path, revision, needsDetail, zoom, detail, failedRevision]);

  return {
    src: detail?.revision === revision ? detail.url : medium || thumbnail,
    previewSrc: medium || thumbnail,
    isLoading: (!medium && !previewExhausted) || loadingDetail,
  };
}
