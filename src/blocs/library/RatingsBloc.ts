import { Cubit } from '@blac/core';

interface RatingsState {
  ratings: Record<string, number>;
  colorLabels: Record<string, string>;
}

export class RatingsBloc extends Cubit<RatingsState> {
  constructor() {
    super({
      ratings: {},
      colorLabels: {},
    });
  }

  setRating = (path: string, rating: number) => {
    const clampedRating = Math.max(0, Math.min(5, rating));
    this.emit({
      ...this.state,
      ratings: { ...this.state.ratings, [path]: clampedRating },
    });

    // TODO: Wire up with TauriService to persist
    // const tauri = borrow(TauriService);
    // tauri.setRating(path, clampedRating);
  };

  getRating = (path: string): number => {
    return this.state.ratings[path] || 0;
  };

  incrementRating = (path: string) => {
    const current = this.getRating(path);
    if (current < 5) {
      this.setRating(path, current + 1);
    }
  };

  decrementRating = (path: string) => {
    const current = this.getRating(path);
    if (current > 0) {
      this.setRating(path, current - 1);
    }
  };

  clearRating = (path: string) => {
    this.setRating(path, 0);
  };

  setColorLabel = (path: string, color: string) => {
    this.emit({
      ...this.state,
      colorLabels: { ...this.state.colorLabels, [path]: color },
    });

    // TODO: Wire up with TauriService to persist
    // const tauri = borrow(TauriService);
    // tauri.setColorLabel(path, color);
  };

  getColorLabel = (path: string): string | undefined => {
    return this.state.colorLabels[path];
  };

  clearColorLabel = (path: string) => {
    const { [path]: _, ...rest } = this.state.colorLabels;
    this.emit({
      ...this.state,
      colorLabels: rest,
    });
  };

  setRatingsFromThumbnails = (data: Array<{ path: string; rating: number }>) => {
    const ratings = { ...this.state.ratings };
    data.forEach(({ path, rating }) => {
      if (rating > 0) {
        ratings[path] = rating;
      }
    });
    this.emit({ ...this.state, ratings });
  };

  bulkSetRating = (paths: string[], rating: number) => {
    const ratings = { ...this.state.ratings };
    paths.forEach((path) => {
      ratings[path] = Math.max(0, Math.min(5, rating));
    });
    this.emit({ ...this.state, ratings });
  };

  bulkSetColorLabel = (paths: string[], color: string) => {
    const colorLabels = { ...this.state.colorLabels };
    paths.forEach((path) => {
      colorLabels[path] = color;
    });
    this.emit({ ...this.state, colorLabels });
  };

  clear = () => {
    this.emit({ ratings: {}, colorLabels: {} });
  };
}
