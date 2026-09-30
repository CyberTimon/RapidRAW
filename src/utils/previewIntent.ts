import { invoke } from '@tauri-apps/api/core';

export type PreviewLane = 'main' | 'overlay' | 'uncropped';

const revisions: Record<PreviewLane, number> = { main: 0, overlay: 0, uncropped: 0 };
let acceptedMainAttempt = 0;

export function isPreviewSuperseded(error: unknown) {
  const message =
    typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
  return message.includes('PREVIEW_SUPERSEDED');
}

export function latestPreviewRevision(lane: PreviewLane) {
  return revisions[lane];
}

export function acceptMainPreviewAttempt(inputRevision: number | null, renderAttempt: number | null) {
  if (typeof inputRevision !== 'number' || typeof renderAttempt !== 'number' || inputRevision !== revisions.main)
    return false;
  if (renderAttempt < acceptedMainAttempt) return false;
  acceptedMainAttempt = renderAttempt;
  return true;
}

// This is intentionally independent of the serialized render queue. A newer
// input can stop native work while the previous invoke is still unresolved.
export function reservePreviewRevision(lane: PreviewLane, expectedGeneration: number | null) {
  const inputRevision = ++revisions[lane];
  if (lane === 'main') acceptedMainAttempt = 0;
  if (typeof expectedGeneration === 'number') {
    void invoke('set_preview_intent', { expectedGeneration, lane, inputRevision }).catch((error) => {
      if (!isPreviewSuperseded(error)) console.error('Failed to update preview intent:', error);
    });
  }
  return inputRevision;
}

export function invalidatePreviewRevisions(expectedGeneration: number | null) {
  reservePreviewRevision('main', expectedGeneration);
  reservePreviewRevision('overlay', expectedGeneration);
  reservePreviewRevision('uncropped', expectedGeneration);
}
