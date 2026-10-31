import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../components/ui/AppProperties';
import { useProcessStore } from '../store/useProcessStore';

type SidecarMetadata = { adjustments?: Record<string, unknown> | null } | null;

async function renderPreview(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const metadata = await invoke<SidecarMetadata>(Invokes.LoadMetadata, { path });
    const adjustments = metadata?.adjustments ?? null;
    bytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, { path, jsAdjustments: adjustments });
  } catch (err) {
    console.error('Error loading culling preview with adjustments:', err);
    bytes = await invoke<Uint8Array>(Invokes.GeneratePreviewForPath, { path, jsAdjustments: null });
  }
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
}

export async function loadCullingPreview(path: string, thumbKey: string): Promise<string> {
  const url = await renderPreview(path);
  useProcessStore.getState().setPreview(path, url, thumbKey);
  return url;
}
