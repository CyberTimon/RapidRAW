export interface PreviewTraceEvent {
  stage: string;
  at: number;
  session: number;
  generation: number | null;
  revision: number;
  attempt: number;
  tier: 'quick' | 'detail' | 'full' | 'unknown';
  durationMs?: number;
  resolution?: number;
}

const MAX_EVENTS = 512;
const events: PreviewTraceEvent[] = [];
const jpegUrls = new Map<string, Omit<PreviewTraceEvent, 'stage' | 'at'>>();
const pendingLogs: PreviewTraceEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastCacheSampleAt = -Infinity;

interface NativePreviewCacheUsage {
  generationBefore: number;
  generationAfter: number;
  decoded: Record<string, number>;
  transportedAssets: Record<string, number>;
}

declare global {
  interface Window {
    __rapidrawPreviewTrace?: { read: () => PreviewTraceEvent[]; clear: () => void };
  }
}

function enabled() {
  if (typeof window === 'undefined') return false;
  try {
    return import.meta.env?.VITE_PREVIEW_TRACE === '1' || window.localStorage.getItem('rapidraw:previewTrace') === '1';
  } catch {
    return false;
  }
}

function flushLogs() {
  flushTimer = null;
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs.splice(0, pendingLogs.length);
  void invoke('frontend_log', { level: 'info', message: `PREVIEW_TRACE ${JSON.stringify(batch)}` }).catch(() => {});
  const now = performance.now();
  if (now - lastCacheSampleAt >= 2000) {
    lastCacheSampleAt = now;
    void invoke<NativePreviewCacheUsage>('get_preview_cache_usage')
      .then((native) => {
        if (native.generationBefore !== native.generationAfter) return;
        return invoke('frontend_log', {
          level: 'info',
          message: `PREVIEW_CACHE ${JSON.stringify({ native, frontend: globalImageCache.getStats() })}`,
        });
      })
      .catch(() => {});
  }
}

export function clearPreviewDiagnostics() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  pendingLogs.length = 0;
  jpegUrls.clear();
}

export function tracePreview(event: Omit<PreviewTraceEvent, 'at'>) {
  if (!enabled()) return;
  const entry = { ...event, at: performance.now() };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  pendingLogs.push(entry);
  if (pendingLogs.length >= 64) {
    if (flushTimer) clearTimeout(flushTimer);
    flushLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, 500);
  }
  window.__rapidrawPreviewTrace = {
    read: () => [...events],
    clear: () => {
      events.length = 0;
      clearPreviewDiagnostics();
    },
  };
}

export function traceJpegUrl(url: string, identity: Omit<PreviewTraceEvent, 'stage' | 'at'>) {
  if (!enabled()) return;
  if (jpegUrls.size >= 32) jpegUrls.delete(jpegUrls.keys().next().value!);
  jpegUrls.set(url, identity);
}

export function traceJpegPresented(url: string) {
  const identity = jpegUrls.get(url);
  if (!identity) return;
  jpegUrls.delete(url);
  if (identity.revision !== latestPreviewRevision('main')) return;
  const decodedAt = performance.now();
  tracePreview({ ...identity, stage: 'jpeg-decoded' });
  requestAnimationFrame(() => {
    if (identity.revision === latestPreviewRevision('main')) {
      tracePreview({ ...identity, stage: 'jpeg-present-proxy', durationMs: performance.now() - decodedAt });
    }
  });
}
import { invoke } from '@tauri-apps/api/core';
import { globalImageCache } from './ImageLRUCache';
import { latestPreviewRevision } from './previewIntent';
