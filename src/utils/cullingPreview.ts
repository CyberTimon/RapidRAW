import { invoke } from '@tauri-apps/api/core';
import { Invokes, ImageFile } from '../components/ui/AppProperties';
import { useProcessStore } from '../store/useProcessStore';

const inFlightPreviews = new Map<string, Promise<string>>();

type PreviewAdjustments = Record<string, unknown> & { is_null?: boolean };

interface CullingMetadata {
  adjustments?: PreviewAdjustments;
}

async function generatePreview(path: string, adjustments: Record<string, unknown>): Promise<string> {
  const bytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, {
    path,
    jsAdjustments: adjustments,
  });
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
  return URL.createObjectURL(blob);
}

export async function ensureCullingPreview(image: ImageFile): Promise<string> {
  const process = useProcessStore.getState();
  const thumbKey = process.thumbnails[image.path] || '';
  const cached = process.previews[image.path];
  if (cached?.thumbKey === thumbKey) {
    process.setPreview(image.path, cached.url, thumbKey);
    return cached.url;
  }

  const requestKey = `${image.path}\u0000${thumbKey}`;
  const pending = inFlightPreviews.get(requestKey);
  if (pending) return pending;

  const request = (async () => {
    let url: string;
    try {
      const metadata = await invoke<CullingMetadata>(Invokes.LoadMetadata, { path: image.path });
      const adjustments =
        metadata?.adjustments && !metadata.adjustments.is_null ? metadata.adjustments : ({} as Record<string, unknown>);
      url = await generatePreview(image.path, adjustments);
    } catch (error) {
      console.warn(`Adjusted culling preview failed for ${image.path}; using the source preview.`, error);
      url = await generatePreview(image.path, {});
    }

    useProcessStore.getState().setPreview(image.path, url, thumbKey);
    return url;
  })();

  inFlightPreviews.set(requestKey, request);
  try {
    return await request;
  } finally {
    inFlightPreviews.delete(requestKey);
  }
}

export function prefetchCullingPreviews(images: ImageFile[]): void {
  images.forEach((image) => {
    void ensureCullingPreview(image).catch((error) => {
      console.warn(`Failed to prefetch culling preview for ${image.path}:`, error);
    });
  });
}
