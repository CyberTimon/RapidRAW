import { Cubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  ImageFile,
  Invokes,
  FilterCriteria,
  SortCriteria,
  SortDirection,
  RawStatus,
  SupportedTypes,
} from '../components/ui/AppProperties';

export interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

export interface LibraryState {
  imageList: ImageFile[];
  imageRatings: Record<string, number>;
  thumbnails: Record<string, string>;
  multiSelectedPaths: string[];
  libraryActivePath: string | null;
  sortCriteria: SortCriteria;
  filterCriteria: FilterCriteria;
  searchCriteria: SearchCriteria;
  supportedTypes: SupportedTypes | null;
  isLoading: boolean;
  isThumbnailsLoading: boolean;
  thumbnailProgress: { current: number; total: number } | null;
  scrollTop: number;
}

const defaultFilterCriteria: FilterCriteria = {
  colors: [],
  rating: 0,
  rawStatus: RawStatus.All,
};

const defaultSortCriteria: SortCriteria = {
  key: 'name',
  order: SortDirection.Ascending,
};

const defaultSearchCriteria: SearchCriteria = {
  tags: [],
  text: '',
  mode: 'OR',
};

const defaultState: LibraryState = {
  imageList: [],
  imageRatings: {},
  thumbnails: {},
  multiSelectedPaths: [],
  libraryActivePath: null,
  sortCriteria: defaultSortCriteria,
  filterCriteria: defaultFilterCriteria,
  searchCriteria: defaultSearchCriteria,
  supportedTypes: null,
  isLoading: false,
  isThumbnailsLoading: false,
  thumbnailProgress: null,
  scrollTop: 0,
};

@blac({ keepAlive: true })
export class LibraryCubit extends Cubit<LibraryState> {
  private unlistenFns: UnlistenFn[] = [];
  private listenersSetup = false;

  constructor() {
    super(defaultState);
    this.loadSupportedTypes();
  }

  setupEventListeners = async () => {
    if (this.listenersSetup) return;
    this.listenersSetup = true;

    const unlistenThumbnail = await listen('thumbnail-generated', (event: any) => {
      const { path, data, rating } = event.payload;
      if (data) {
        this.setThumbnail(path, data);
      }
      if (rating !== undefined) {
        this.setImageRating(path, rating);
      }
    });

    this.unlistenFns = [unlistenThumbnail];
  };

  dispose = () => {
    this.unlistenFns.forEach((fn) => fn());
    this.unlistenFns = [];
    this.listenersSetup = false;
  };

  // Computed getters
  get imagePathList(): string[] {
    return this.state.imageList.map((f) => f.path);
  }

  get selectedCount(): number {
    return this.state.multiSelectedPaths.length;
  }

  get hasSelection(): boolean {
    return this.state.multiSelectedPaths.length > 0;
  }

  get sortedImageList(): ImageFile[] {
    const {
      imageList,
      filterCriteria,
      sortCriteria,
      searchCriteria,
      imageRatings,
      supportedTypes,
    } = this.state;

    // Filter by rating, raw status, and color
    const filteredList = imageList.filter((image) => {
      // Rating filter
      if (filterCriteria.rating > 0) {
        const rating = imageRatings[image.path] || 0;
        if (filterCriteria.rating === 5) {
          if (rating !== 5) return false;
        } else {
          if (rating < filterCriteria.rating) return false;
        }
      }

      // Raw status filter
      if (filterCriteria.rawStatus && filterCriteria.rawStatus !== RawStatus.All && supportedTypes) {
        const extension = image.path.split('.').pop()?.toLowerCase() || '';
        const isRaw = supportedTypes.raw?.includes(extension);

        if (filterCriteria.rawStatus === RawStatus.RawOnly && !isRaw) {
          return false;
        }
        if (filterCriteria.rawStatus === RawStatus.NonRawOnly && isRaw) {
          return false;
        }
      }

      // Color filter
      if (filterCriteria.colors && filterCriteria.colors.length > 0) {
        const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);
        const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
        const matchesNone = !imageColor && filterCriteria.colors.includes('none');

        if (!hasMatchingColor && !matchesNone) {
          return false;
        }
      }

      return true;
    });

    // Filter by search
    const { tags: searchTags, text: searchText, mode: searchMode } = searchCriteria;
    const lowerCaseSearchText = searchText.trim().toLowerCase();

    const filteredBySearch =
      searchTags.length === 0 && lowerCaseSearchText === ''
        ? filteredList
        : filteredList.filter((image: ImageFile) => {
            const lowerCaseImageTags = (image.tags || []).map((t) => t.toLowerCase().replace('user:', ''));
            const filename = image?.path?.split(/[\\/]/)?.pop()?.toLowerCase() || '';

            let tagsMatch = true;
            if (searchTags.length > 0) {
              const lowerCaseSearchTags = searchTags.map((t) => t.toLowerCase());
              if (searchMode === 'OR') {
                tagsMatch = lowerCaseSearchTags.some((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              } else {
                tagsMatch = lowerCaseSearchTags.every((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              }
            }

            let textMatch = true;
            if (lowerCaseSearchText !== '') {
              textMatch =
                filename.includes(lowerCaseSearchText) ||
                lowerCaseImageTags.some((t) => t.includes(lowerCaseSearchText));
            }

            return tagsMatch && textMatch;
          });

    // Sort
    const list = [...filteredBySearch];
    list.sort((a, b) => {
      const { key, order } = sortCriteria;
      let comparison = 0;

      const compareNullable = (valA: any, valB: any) => {
        if (valA !== null && valB !== null) {
          if (valA < valB) return -1;
          if (valA > valB) return 1;
          return 0;
        }
        if (valA !== null) return -1;
        if (valB !== null) return 1;
        return 0;
      };

      const parseShutter = (val: string | undefined): number | null => {
        if (!val) return null;
        const cleanVal = val.replace(/s/i, '').trim();
        const parts = cleanVal.split('/');
        if (parts.length === 2) {
          const num = parseFloat(parts[0]);
          const den = parseFloat(parts[1]);
          return den !== 0 ? num / den : null;
        }
        const numVal = parseFloat(cleanVal);
        return isNaN(numVal) ? null : numVal;
      };

      const parseAperture = (val: string | undefined): number | null => {
        if (!val) return null;
        const match = val.match(/(\d+(\.\d+)?)/);
        const numVal = match ? parseFloat(match[0]) : null;
        return numVal === null || isNaN(numVal) ? null : numVal;
      };

      const parseFocalLength = (val: string | undefined): number | null => {
        if (!val) return null;
        const match = val.match(/(\d+(\.\d+)?)/);
        if (!match) return null;
        const numVal = parseFloat(match[0]);
        return isNaN(numVal) ? null : numVal;
      };

      switch (key) {
        case 'date_taken': {
          const dateA = a.exif?.DateTimeOriginal;
          const dateB = b.exif?.DateTimeOriginal;
          comparison = compareNullable(dateA, dateB);
          if (comparison === 0) comparison = a.modified - b.modified;
          break;
        }
        case 'iso': {
          const getIso = (exif: { [key: string]: string } | null): number | null => {
            if (!exif) return null;
            const isoStr = exif.PhotographicSensitivity || exif.ISOSpeedRatings;
            if (!isoStr) return null;
            const isoNum = parseInt(isoStr, 10);
            return isNaN(isoNum) ? null : isoNum;
          };
          const isoA = getIso(a.exif);
          const isoB = getIso(b.exif);
          comparison = compareNullable(isoA, isoB);
          break;
        }
        case 'shutter_speed': {
          const shutterA = parseShutter(a.exif?.ExposureTime);
          const shutterB = parseShutter(b.exif?.ExposureTime);
          comparison = compareNullable(shutterA, shutterB);
          break;
        }
        case 'aperture': {
          const apertureA = parseAperture(a.exif?.FNumber);
          const apertureB = parseAperture(b.exif?.FNumber);
          comparison = compareNullable(apertureA, apertureB);
          break;
        }
        case 'focal_length': {
          const focalA = parseFocalLength(a.exif?.FocalLength);
          const focalB = parseFocalLength(b.exif?.FocalLength);
          comparison = compareNullable(focalA, focalB);
          break;
        }
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
          break;
        default:
          comparison = a.path.localeCompare(b.path);
          break;
      }

      return order === SortDirection.Ascending ? comparison : -comparison;
    });

    return list;
  }

  // Load supported file types
  private loadSupportedTypes = async () => {
    try {
      const types = await invoke<SupportedTypes>(Invokes.GetSupportedFileTypes);
      this.patch({ supportedTypes: types });
    } catch (error) {
      console.error('Failed to load supported types:', error);
    }
  };

  // Image list management
  setImageList = (images: ImageFile[]) => {
    this.patch({ imageList: images });
  };

  loadImages = async (folderPath: string, recursive = false) => {
    this.patch({ isLoading: true, imageList: [], thumbnails: {} });

    try {
      const command = recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;
      const files = await invoke<ImageFile[]>(command, { path: folderPath });
      this.patch({ imageList: files, isLoading: false });
    } catch (error) {
      console.error('Failed to load images:', error);
      this.patch({ isLoading: false });
    }
  };

  refreshImages = async (folderPath: string, recursive = false) => {
    await this.loadImages(folderPath, recursive);
  };

  // Thumbnail management
  setThumbnail = (path: string, thumbnailUrl: string) => {
    this.update((state) => ({
      ...state,
      thumbnails: { ...state.thumbnails, [path]: thumbnailUrl },
    }));
  };

  setThumbnails = (thumbnails: Record<string, string>) => {
    this.patch({ thumbnails });
  };

  clearThumbnails = () => {
    this.patch({ thumbnails: {} });
  };

  // Selection management
  setSelection = (paths: string[]) => {
    this.patch({ multiSelectedPaths: paths });
  };

  addToSelection = (path: string) => {
    if (this.state.multiSelectedPaths.includes(path)) return;
    this.update((state) => ({
      ...state,
      multiSelectedPaths: [...state.multiSelectedPaths, path],
    }));
  };

  removeFromSelection = (path: string) => {
    this.update((state) => ({
      ...state,
      multiSelectedPaths: state.multiSelectedPaths.filter((p) => p !== path),
    }));
  };

  toggleSelection = (path: string) => {
    if (this.state.multiSelectedPaths.includes(path)) {
      this.removeFromSelection(path);
    } else {
      this.addToSelection(path);
    }
  };

  selectAll = () => {
    this.patch({ multiSelectedPaths: this.imagePathList });
  };

  clearSelection = () => {
    this.patch({ multiSelectedPaths: [] });
  };

  selectRange = (startPath: string, endPath: string) => {
    const paths = this.imagePathList;
    const startIndex = paths.indexOf(startPath);
    const endIndex = paths.indexOf(endPath);

    if (startIndex === -1 || endIndex === -1) return;

    const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const rangePaths = paths.slice(from, to + 1);

    this.patch({ multiSelectedPaths: rangePaths });
  };

  // Library active path (for keyboard navigation)
  setLibraryActivePath = (path: string | null) => {
    this.patch({ libraryActivePath: path });
  };

  // Sorting
  setSortCriteria = (criteriaOrUpdater: SortCriteria | ((prev: SortCriteria) => SortCriteria)) => {
    if (typeof criteriaOrUpdater === 'function') {
      this.update((state) => ({
        ...state,
        sortCriteria: criteriaOrUpdater(state.sortCriteria),
      }));
    } else {
      this.patch({ sortCriteria: criteriaOrUpdater });
    }
  };

  setSortKey = (key: string) => {
    this.update((state) => ({
      ...state,
      sortCriteria: { ...state.sortCriteria, key },
    }));
  };

  toggleSortDirection = () => {
    this.update((state) => ({
      ...state,
      sortCriteria: {
        ...state.sortCriteria,
        order: state.sortCriteria.order === SortDirection.Ascending
          ? SortDirection.Descening
          : SortDirection.Ascending,
      },
    }));
  };

  // Filtering
  setFilterCriteria = (criteriaOrUpdater: Partial<FilterCriteria> | ((prev: FilterCriteria) => FilterCriteria)) => {
    if (typeof criteriaOrUpdater === 'function') {
      this.update((state) => ({
        ...state,
        filterCriteria: criteriaOrUpdater(state.filterCriteria),
      }));
    } else {
      this.update((state) => ({
        ...state,
        filterCriteria: { ...state.filterCriteria, ...criteriaOrUpdater },
      }));
    }
  };

  setRatingFilter = (rating: number) => {
    this.update((state) => ({
      ...state,
      filterCriteria: { ...state.filterCriteria, rating },
    }));
  };

  setRawStatusFilter = (rawStatus: RawStatus) => {
    this.update((state) => ({
      ...state,
      filterCriteria: { ...state.filterCriteria, rawStatus },
    }));
  };

  setColorFilter = (colors: string[]) => {
    this.update((state) => ({
      ...state,
      filterCriteria: { ...state.filterCriteria, colors },
    }));
  };

  clearFilters = () => {
    this.patch({ filterCriteria: defaultFilterCriteria });
  };

  // Search
  setSearchCriteria = (criteria: SearchCriteria) => {
    this.patch({ searchCriteria: criteria });
  };

  setSearchText = (text: string) => {
    this.update((state) => ({
      ...state,
      searchCriteria: { ...state.searchCriteria, text },
    }));
  };

  setSearchTags = (tags: string[]) => {
    this.update((state) => ({
      ...state,
      searchCriteria: { ...state.searchCriteria, tags },
    }));
  };

  setSearchMode = (mode: 'AND' | 'OR') => {
    this.update((state) => ({
      ...state,
      searchCriteria: { ...state.searchCriteria, mode },
    }));
  };

  clearSearch = () => {
    this.patch({ searchCriteria: defaultSearchCriteria });
  };

  // Ratings
  setImageRating = (path: string, rating: number) => {
    this.update((state) => ({
      ...state,
      imageRatings: { ...state.imageRatings, [path]: rating },
    }));
  };

  setImageRatings = (ratings: Record<string, number>) => {
    this.patch({ imageRatings: ratings });
  };

  // Scroll position
  setScrollTop = (scrollTop: number) => {
    this.patch({ scrollTop });
  };

  // Remove image from list (after delete)
  removeImages = (paths: string[]) => {
    const pathSet = new Set(paths);
    this.update((state) => ({
      ...state,
      imageList: state.imageList.filter((img) => !pathSet.has(img.path)),
      multiSelectedPaths: state.multiSelectedPaths.filter((p) => !pathSet.has(p)),
      libraryActivePath: state.libraryActivePath && pathSet.has(state.libraryActivePath)
        ? null
        : state.libraryActivePath,
    }));
  };

  // Update image in list (after metadata change)
  updateImage = (path: string, updates: Partial<ImageFile>) => {
    this.update((state) => ({
      ...state,
      imageList: state.imageList.map((img) =>
        img.path === path ? { ...img, ...updates } : img
      ),
    }));
  };

  // Clear all state
  clear = () => {
    this.emit({
      ...defaultState,
      supportedTypes: this.state.supportedTypes, // Keep supported types
    });
  };
}
