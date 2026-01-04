import { Cubit } from '@blac/core';

interface ThumbnailState {
  thumbnails: Record<string, string>;
  pending: string[];
  isGenerating: boolean;
}

export class ThumbnailBloc extends Cubit<ThumbnailState> {
  constructor() {
    super({
      thumbnails: {},
      pending: [],
      isGenerating: false,
    });
  }

  requestThumbnails = (paths: string[]) => {
    const newPaths = paths.filter((path) => !this.state.thumbnails[path]);
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
    this.emit({
      ...this.state,
      thumbnails: { ...this.state.thumbnails, [path]: data },
      pending: this.state.pending.filter((p) => p !== path),
      isGenerating: this.state.pending.length > 1,
    });
  };

  setThumbnails = (thumbnails: Record<string, string>) => {
    this.emit({
      ...this.state,
      thumbnails: { ...this.state.thumbnails, ...thumbnails },
    });
  };

  getThumbnail = (path: string): string | undefined => {
    return this.state.thumbnails[path];
  };

  hasThumbnail = (path: string): boolean => {
    return path in this.state.thumbnails;
  };

  isPending = (path: string): boolean => {
    return this.state.pending.includes(path);
  };

  removeThumbnail = (path: string) => {
    const { [path]: _, ...rest } = this.state.thumbnails;
    this.emit({
      ...this.state,
      thumbnails: rest,
    });
  };

  clearCache = () => {
    this.emit({
      thumbnails: {},
      pending: [],
      isGenerating: false,
    });
  };

  get cacheSize(): number {
    return Object.keys(this.state.thumbnails).length;
  }

  get pendingCount(): number {
    return this.state.pending.length;
  }
}
