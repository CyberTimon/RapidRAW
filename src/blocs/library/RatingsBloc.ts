import { Cubit, borrow } from '@blac/core';
import { TauriService } from '../services/TauriService';

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

  setRating = (path: string, rating: number, persist = false) => {
    const clampedRating = Math.max(0, Math.min(5, rating));
    this.emit({
      ...this.state,
      ratings: { ...this.state.ratings, [path]: clampedRating },
    });

    if (persist) {
      const tauri = borrow(TauriService);
      tauri.saveMetadataAndUpdateThumbnail(path, { rating: clampedRating } as never).catch((error) => {
        console.error('Failed to persist rating:', error);
      });
    }
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

  setColorLabel = (path: string, color: string, persist = false) => {
    this.emit({
      ...this.state,
      colorLabels: { ...this.state.colorLabels, [path]: color },
    });

    if (persist) {
      const tauri = borrow(TauriService);
      tauri.setColorLabelForPaths([path], color).catch((error: unknown) => {
        console.error('Failed to persist color label:', error);
      });
    }
  };

  getColorLabel = (path: string): string | undefined => {
    return this.state.colorLabels[path];
  };

  clearColorLabel = (path: string) => {
    const { [path]: _removed, ...rest } = this.state.colorLabels;
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
