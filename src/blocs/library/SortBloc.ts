import { Cubit } from '@blac/core';
import type { ImageFile, SortKey, SortDirection } from '../../types/library';

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export class SortBloc extends Cubit<SortState> {
  constructor() {
    super({
      key: 'name',
      direction: 'asc',
    });
  }

  setKey = (key: SortKey) => {
    if (key === this.state.key) {
      this.toggleDirection();
    } else {
      this.emit({ key, direction: 'asc' });
    }
  };

  setDirection = (direction: SortDirection) => {
    this.patch({ direction });
  };

  toggleDirection = () => {
    this.patch({ direction: this.state.direction === 'asc' ? 'desc' : 'asc' });
  };

  setSort = (key: SortKey, direction: SortDirection) => {
    this.emit({ key, direction });
  };

  applySort = (images: ImageFile[], ratings: Record<string, number>): ImageFile[] => {
    const sorted = [...images].sort((a, b) => {
      let comparison = 0;

      switch (this.state.key) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (ratings[a.path] || 0) - (ratings[b.path] || 0);
          break;
        case 'date_taken': {
          const aDate = a.exif?.DateTimeOriginal || '';
          const bDate = b.exif?.DateTimeOriginal || '';
          comparison = aDate.localeCompare(bDate);
          break;
        }
        case 'iso':
          comparison = (a.exif?.ISO || 0) - (b.exif?.ISO || 0);
          break;
        case 'aperture':
          comparison = (a.exif?.FNumber || 0) - (b.exif?.FNumber || 0);
          break;
        case 'focal_length':
          comparison = (a.exif?.FocalLength || 0) - (b.exif?.FocalLength || 0);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        default:
          comparison = 0;
      }

      return this.state.direction === 'asc' ? comparison : -comparison;
    });

    return sorted;
  };

  get sortLabel(): string {
    const labels: Record<SortKey, string> = {
      name: 'Name',
      date: 'Date Modified',
      rating: 'Rating',
      date_taken: 'Date Taken',
      iso: 'ISO',
      shutter_speed: 'Shutter Speed',
      aperture: 'Aperture',
      focal_length: 'Focal Length',
      size: 'File Size',
    };
    return labels[this.state.key];
  }
}
