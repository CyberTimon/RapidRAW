import { Cubit } from '@blac/core';
import type { ImageFile, RawStatusFilter, RAW_EXTENSIONS } from '../../types/library';

interface FilterState {
  minRating: number;
  colors: string[];
  rawStatus: RawStatusFilter;
}

const RAW_EXTS = [
  'raw', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'pef',
  'raf', 'rw2', 'dng', 'rwl', 'srw', 'x3f', 'erf', 'mrw', 'dcr', '3fr',
  'mef', 'mos', 'kdc', 'fff', 'iiq',
];

export class FilterBloc extends Cubit<FilterState> {
  constructor() {
    super({
      minRating: 0,
      colors: [],
      rawStatus: 'all',
    });
  }

  setMinRating = (rating: number) => {
    this.patch({ minRating: Math.max(0, Math.min(5, rating)) });
  };

  toggleColor = (color: string) => {
    const colors = this.state.colors.includes(color)
      ? this.state.colors.filter((c) => c !== color)
      : [...this.state.colors, color];
    this.patch({ colors });
  };

  setColors = (colors: string[]) => {
    this.patch({ colors });
  };

  setRawStatus = (status: RawStatusFilter) => {
    this.patch({ rawStatus: status });
  };

  clearFilters = () => {
    this.emit({ minRating: 0, colors: [], rawStatus: 'all' });
  };

  applyFilters = (images: ImageFile[], ratings: Record<string, number>): ImageFile[] => {
    return images.filter((image) => {
      // Rating filter
      if (this.state.minRating > 0) {
        const rating = ratings[image.path] || 0;
        if (this.state.minRating === 5) {
          if (rating !== 5) return false;
        } else {
          if (rating < this.state.minRating) return false;
        }
      }

      // Color filter
      if (this.state.colors.length > 0) {
        const imageColor = image.tags?.find((t) => t.startsWith('color:'))?.substring(6);
        const hasMatch = imageColor && this.state.colors.includes(imageColor);
        const matchesNone = !imageColor && this.state.colors.includes('none');
        if (!hasMatch && !matchesNone) return false;
      }

      // RAW status filter
      if (this.state.rawStatus !== 'all') {
        const ext = image.extension.toLowerCase();
        const isRaw = RAW_EXTS.includes(ext);
        if (this.state.rawStatus === 'raw' && !isRaw) return false;
        if (this.state.rawStatus === 'nonRaw' && isRaw) return false;
      }

      return true;
    });
  };

  get isActive(): boolean {
    return (
      this.state.minRating > 0 ||
      this.state.colors.length > 0 ||
      this.state.rawStatus !== 'all'
    );
  }

  get activeFilterCount(): number {
    let count = 0;
    if (this.state.minRating > 0) count++;
    if (this.state.colors.length > 0) count++;
    if (this.state.rawStatus !== 'all') count++;
    return count;
  }
}
