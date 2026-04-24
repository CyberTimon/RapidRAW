import type { Adjustments } from './adjustments';

export interface ImageCacheEntry {
  adjustments: Adjustments;
  histogram: any;
  waveform: any;
  finalPreviewUrl: string | null;
  uncroppedPreviewUrl: string | null;
  selectedImage: any;
  originalSize: { width: number; height: number };
  previewSize: { width: number; height: number };
}

export class ImageLRUCache {
  private maxSize: number;
  private cache = new Map<string, ImageCacheEntry>();
  private protectedBlobUrls = new Set<string>();

  constructor(maxSize = 20) {
    this.maxSize = maxSize;
  }

  get(key: string): ImageCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    this.cache.delete(key);
    this.cache.set(key, entry);

    if (entry.finalPreviewUrl) this.protectedBlobUrls.delete(entry.finalPreviewUrl);
    if (entry.uncroppedPreviewUrl) this.protectedBlobUrls.delete(entry.uncroppedPreviewUrl);

    return entry;
  }

  set(key: string, entry: ImageCacheEntry): void {
    if (this.cache.has(key)) {
      this.cleanupEntry(this.cache.get(key)!, entry);
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cleanupEntry(this.cache.get(lruKey)!);
        this.cache.delete(lruKey);
      }
    }

    if (entry.finalPreviewUrl?.startsWith('blob:')) {
      this.protectedBlobUrls.add(entry.finalPreviewUrl);
    }
    if (entry.uncroppedPreviewUrl?.startsWith('blob:')) {
      this.protectedBlobUrls.add(entry.uncroppedPreviewUrl);
    }

    this.cache.set(key, entry);
  }

  isProtected(url: string): boolean {
    return this.protectedBlobUrls.has(url);
  }

  delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.cleanupEntry(entry);
      this.cache.delete(key);
    }
  }

  deleteByPrefix(prefix: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key === prefix || key.startsWith(prefix + '?vc=')) {
        this.delete(key);
      }
    }
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      this.cleanupEntry(entry);
    }
    this.cache.clear();
    this.protectedBlobUrls.clear();
  }

  private cleanupEntry(old: ImageCacheEntry, replacement?: ImageCacheEntry): void {
    const revokeIfUnused = (url: string | null) => {
      if (!url?.startsWith('blob:')) return;
      const reused = replacement && (replacement.finalPreviewUrl === url || replacement.uncroppedPreviewUrl === url);
      if (!reused) {
        this.protectedBlobUrls.delete(url);
        URL.revokeObjectURL(url);
      }
    };
    revokeIfUnused(old.finalPreviewUrl);
    revokeIfUnused(old.uncroppedPreviewUrl);
  }
}
