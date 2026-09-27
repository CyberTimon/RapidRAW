import type { ChannelConfig } from '../components/adjustments/Curves';
import type { SelectedImage, WaveformData } from '../components/ui/AppProperties';
import type { Adjustments } from './adjustments';

export interface ImageCacheEntry {
  adjustments: Adjustments;
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  finalPreviewUrl: string | null;
  uncroppedPreviewUrl: string | null;
  selectedImage: SelectedImage;
  originalSize: { width: number; height: number };
  previewSize: { width: number; height: number };
  sourceRevision?: string;
}

const DEFAULT_SNAPSHOT_BYTES = 128 * 1024 * 1024;

/** Bounds retained snapshots by encoded bytes as well as entry count. */
export class ImageLRUCache {
  private cache = new Map<string, ImageCacheEntry>();
  private blobSizes = new Map<string, number>();
  private displayed = { key: null as string | null, urls: new Set<string>() };
  private pendingRevocations = new Map<string, ReturnType<typeof setTimeout>>();
  private evictions = 0;

  constructor(
    private readonly maxSize = 20,
    private readonly maxBytes = DEFAULT_SNAPSHOT_BYTES,
  ) {}

  get(key: string): ImageCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  peek(key: string): ImageCacheEntry | undefined {
    return this.cache.get(key);
  }

  set(key: string, entry: ImageCacheEntry): boolean {
    // Navigation can run again before the snapshot effect catches up.
    if (entry.selectedImage.path !== key || !entry.selectedImage.isReady) return false;
    const previous = this.cache.get(key);
    if (previous) this.cache.delete(key);

    // Unknown blob sizes cannot be budgeted safely. Their current displayed
    // owner may continue using them, but they do not become retained snapshots.
    if (this.measureEntries([[key, entry]]) > this.maxBytes) {
      if (previous) this.cleanupEntry(previous);
      return false;
    }

    this.cache.set(key, entry);
    while (this.cache.size > this.maxSize || this.measureEntries(this.cache) > this.maxBytes) {
      const victim = [...this.cache.keys()].find((candidate) => candidate !== key && candidate !== this.displayed.key);
      if (!victim) {
        this.cache.delete(key);
        this.cleanupEntry(entry);
        if (previous) this.cleanupEntry(previous);
        return false;
      }
      this.delete(victim);
      this.evictions++;
    }
    if (previous) this.cleanupEntry(previous);
    return true;
  }

  registerBlobSize(url: string, bytes: number) {
    if (!url.startsWith('blob:') || !Number.isFinite(bytes) || bytes < 0) return;
    this.blobSizes.set(url, bytes);
    // A fast edit may produce an accepted URL that never becomes the displayed
    // React state. Keep only a bounded set of such unowned size records.
    if (this.blobSizes.size > 512) {
      for (const candidate of this.blobSizes.keys()) {
        if (!this.isProtected(candidate)) this.blobSizes.delete(candidate);
        if (this.blobSizes.size <= 512) break;
      }
    }
  }

  setDisplayed(key: string | null, finalPreviewUrl: string | null, uncroppedPreviewUrl: string | null) {
    const previous = this.displayed.urls;
    const urls = new Set([finalPreviewUrl, uncroppedPreviewUrl].filter((url): url is string => !!url));
    this.displayed = { key, urls };
    for (const url of previous) {
      if (!urls.has(url)) this.revokeIfUnowned(url);
    }
  }

  isProtected(url: string): boolean {
    if (this.displayed.urls.has(url)) return true;
    for (const entry of this.cache.values()) {
      if (entry.finalPreviewUrl === url || entry.uncroppedPreviewUrl === url) return true;
    }
    return false;
  }

  getStats() {
    const displayedBytes = [...this.displayed.urls].reduce((total, url) => total + this.measureUrl(url), 0);
    return {
      entries: this.cache.size,
      accountedBytes: this.measureEntries(this.cache),
      maxBytes: this.maxBytes,
      displayedBytes,
      evictions: this.evictions,
    };
  }

  delete(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cleanupEntry(entry);
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key === prefix || key.startsWith(prefix + '?vc=')) this.delete(key);
    }
  }

  clear(): void {
    const entries = [...this.cache.values()];
    this.cache.clear();
    entries.forEach((entry) => this.cleanupEntry(entry));
  }

  private measureEntries(entries: Iterable<[string, ImageCacheEntry]>) {
    const seenObjects = new WeakSet<object>();
    const seenUrls = new Set<string>();
    let bytes = 0;
    for (const [key, entry] of entries) {
      bytes += key.length * 2 + 256;
      bytes += this.measureObject(entry.adjustments, seenObjects);
      bytes += this.measureObject(entry.histogram, seenObjects);
      bytes += this.measureObject(entry.waveform, seenObjects);
      bytes += this.measureObject(entry.selectedImage, seenObjects);
      bytes += this.measureObject(entry.originalSize, seenObjects);
      bytes += this.measureObject(entry.previewSize, seenObjects);
      bytes += (entry.sourceRevision?.length ?? 0) * 2;
      for (const url of [entry.finalPreviewUrl, entry.uncroppedPreviewUrl]) {
        if (url && !seenUrls.has(url)) {
          seenUrls.add(url);
          bytes += this.measureUrl(url);
        }
      }
    }
    return bytes;
  }

  private measureObject(value: unknown, seen: WeakSet<object>): number {
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (!value || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    if (Array.isArray(value)) return 32 + value.reduce((total, item) => total + this.measureObject(item, seen), 0);
    return (
      64 +
      Object.entries(value).reduce((total, [key, item]) => total + key.length * 2 + this.measureObject(item, seen), 0)
    );
  }

  private measureUrl(url: string) {
    if (url.startsWith('blob:')) return this.blobSizes.get(url) ?? Infinity;
    return url.length * 2;
  }

  private cleanupEntry(entry: ImageCacheEntry) {
    this.revokeIfUnowned(entry.finalPreviewUrl);
    this.revokeIfUnowned(entry.uncroppedPreviewUrl);
  }

  private revokeIfUnowned(url: string | null) {
    if (!url?.startsWith('blob:') || this.isProtected(url) || this.pendingRevocations.has(url)) return;
    const timer = setTimeout(() => {
      this.pendingRevocations.delete(url);
      if (this.isProtected(url)) return;
      URL.revokeObjectURL(url);
      this.blobSizes.delete(url);
    }, 500);
    this.pendingRevocations.set(url, timer);
  }
}

export const globalImageCache = new ImageLRUCache();
