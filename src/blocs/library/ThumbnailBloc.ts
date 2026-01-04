import { Cubit } from '@blac/core';
import { LRUCache, revokeBlobUrl } from '../../utils/LRUCache';

const DEFAULT_MAX_THUMBNAILS = 500;

interface ThumbnailState {
  thumbnails: Record<string, string>;
  pending: string[];
  isGenerating: boolean;
  cacheSize: number;
  maxCacheSize: number;
}

export class ThumbnailBloc extends Cubit<ThumbnailState> {
  private cache: LRUCache<string, string>;

  constructor(maxCacheSize = DEFAULT_MAX_THUMBNAILS) {
    super({
      thumbnails: {},
      pending: [],
      isGenerating: false,
      cacheSize: 0,
      maxCacheSize,
    });

    this.cache = new LRUCache<string, string>(maxCacheSize, revokeBlobUrl);
  }

  requestThumbnails = (paths: string[]) => {
    const newPaths = paths.filter((path) => !this.cache.has(path));
    if (newPaths.length === 0) return;

    this.emit({
      ...this.state,
      pending: [...new Set([...this.state.pending, ...newPaths])],
      isGenerating: true,
    });

    // TODO: Wire up with TauriService
    // const tauri = borrow(TauriService);
    // await tauri.generateThumbnailsProgressive(newPaths);
  };

  setThumbnail = (path: string, data: string) => {
    this.cache.set(path, data);
    this.syncStateFromCache();
    this.emit({
      ...this.state,
      thumbnails: this.cache.toRecord(),
      pending: this.state.pending.filter((p) => p !== path),
      isGenerating: this.state.pending.length > 1,
      cacheSize: this.cache.size,
    });
  };

  setThumbnails = (thumbnails: Record<string, string>) => {
    for (const [path, data] of Object.entries(thumbnails)) {
      this.cache.set(path, data);
    }
    this.syncStateFromCache();
  };

  private syncStateFromCache = () => {
    this.emit({
      ...this.state,
      thumbnails: this.cache.toRecord(),
      cacheSize: this.cache.size,
    });
  };

  getThumbnail = (path: string): string | undefined => {
    return this.cache.get(path);
  };

  hasThumbnail = (path: string): boolean => {
    return this.cache.has(path);
  };

  isPending = (path: string): boolean => {
    return this.state.pending.includes(path);
  };

  removeThumbnail = (path: string) => {
    this.cache.delete(path);
    this.syncStateFromCache();
  };

  clearCache = () => {
    this.cache.clear();
    this.emit({
      thumbnails: {},
      pending: [],
      isGenerating: false,
      cacheSize: 0,
      maxCacheSize: this.state.maxCacheSize,
    });
  };

  setMaxCacheSize = (size: number) => {
    this.cache.setMaxSize(size);
    this.emit({
      ...this.state,
      maxCacheSize: size,
      thumbnails: this.cache.toRecord(),
      cacheSize: this.cache.size,
    });
  };

  get cacheSize(): number {
    return this.cache.size;
  }

  get pendingCount(): number {
    return this.state.pending.length;
  }
}
