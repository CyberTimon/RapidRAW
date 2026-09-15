import { create } from 'zustand';
import {
  FilterCriteria,
  ImageFile,
  RawStatus,
  SortCriteria,
  SortDirection,
  AlbumItem,
} from '../components/ui/AppProperties';
import { Adjustments, INITIAL_ADJUSTMENTS } from '../utils/adjustments';
import { ColumnWidths } from '../components/panel/MainLibrary';

export interface SearchCriteria {
  tags: string[];
  text: string;
  mode: 'AND' | 'OR';
}

interface LibraryState {
  // Paths & Trees
  rootPaths: string[];
  currentFolderPath: string | null;
  expandedFolders: Set<string>;
  folderTrees: any[];
  pinnedFolderTrees: any[];

  // Albums
  albumTree: AlbumItem[];
  activeAlbumId: string | null;
  expandedAlbumGroups: Set<string>;

  // Images & Selection
  imageList: Array<ImageFile>;
  imageRatings: Record<string, number>;
  multiSelectedPaths: Array<string>;
  selectionAnchorPath: string | null;
  libraryActivePath: string | null;
  libraryActiveAdjustments: Adjustments;

  // Sorting & Filtering
  sortCriteria: SortCriteria;
  filterCriteria: FilterCriteria;
  searchCriteria: SearchCriteria;

  // UI State specific to the Library View
  isTreeLoading: boolean;
  isViewLoading: boolean;
  libraryScrollTop: number;
  listColumnWidths: ColumnWidths;

  // Folder Navigation History
  folderHistory: string[];
  folderHistoryIndex: number;

  // Actions
  setLibrary: (updater: Partial<LibraryState> | ((state: LibraryState) => Partial<LibraryState>)) => void;
  clearSelection: () => void;
  pushFolderHistory: (path: string) => void;
  stepFolderHistory: (direction: 'back' | 'forward') => string | null;
  setFilterCriteria: (criteria: Partial<FilterCriteria> | ((prev: FilterCriteria) => FilterCriteria)) => void;
  setSearchCriteria: (criteria: Partial<SearchCriteria> | ((prev: SearchCriteria) => SearchCriteria)) => void;
  setSortCriteria: (criteria: Partial<SortCriteria> | ((prev: SortCriteria) => SortCriteria)) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
  rootPaths: [],
  currentFolderPath: null,
  expandedFolders: new Set<string>(),
  folderTrees: [],
  pinnedFolderTrees: [],

  albumTree: [],
  activeAlbumId: null,
  expandedAlbumGroups: new Set<string>(),

  imageList: [],
  imageRatings: {},
  multiSelectedPaths: [],
  selectionAnchorPath: null,
  libraryActivePath: null,
  libraryActiveAdjustments: INITIAL_ADJUSTMENTS,

  sortCriteria: { key: 'name', order: SortDirection.Ascending },
  filterCriteria: { colors: [], rating: 0, rawStatus: RawStatus.All },
  searchCriteria: { tags: [], text: '', mode: 'OR' },

  isTreeLoading: false,
  isViewLoading: false,
  libraryScrollTop: 0,
  listColumnWidths: {
    thumbnail: 4,
    name: 20,
    date: 15,
    rating: 8,
    color: 8,
    shutter: 10,
    aperture: 10,
    iso: 10,
    focal: 15,
  },

  folderHistory: [],
  folderHistoryIndex: -1,

  setLibrary: (updater) => set((state) => (typeof updater === 'function' ? updater(state) : updater)),

  clearSelection: () => set({ multiSelectedPaths: [], libraryActivePath: null }),

  pushFolderHistory: (path: string) =>
    set((state) => {
      if (!path) return state;
      if (state.folderHistory[state.folderHistoryIndex] === path) return state;
      const newHistory = state.folderHistory.slice(0, state.folderHistoryIndex + 1);
      newHistory.push(path);
      if (newHistory.length > 50) newHistory.shift();
      return {
        folderHistory: newHistory,
        folderHistoryIndex: newHistory.length - 1,
      };
    }),

  stepFolderHistory: (direction: 'back' | 'forward') => {
    let targetPath: string | null = null;
    set((state) => {
      if (direction === 'back' && state.folderHistoryIndex > 0) {
        const nextIdx = state.folderHistoryIndex - 1;
        targetPath = state.folderHistory[nextIdx];
        return { folderHistoryIndex: nextIdx };
      }
      if (direction === 'forward' && state.folderHistoryIndex < state.folderHistory.length - 1) {
        const nextIdx = state.folderHistoryIndex + 1;
        targetPath = state.folderHistory[nextIdx];
        return { folderHistoryIndex: nextIdx };
      }
      return state;
    });
    return targetPath;
  },

  setFilterCriteria: (criteria) =>
    set((state) => ({
      filterCriteria:
        typeof criteria === 'function' ? criteria(state.filterCriteria) : { ...state.filterCriteria, ...criteria },
    })),

  setSearchCriteria: (criteria) =>
    set((state) => ({
      searchCriteria:
        typeof criteria === 'function' ? criteria(state.searchCriteria) : { ...state.searchCriteria, ...criteria },
    })),

  setSortCriteria: (criteria) =>
    set((state) => ({
      sortCriteria:
        typeof criteria === 'function' ? criteria(state.sortCriteria) : { ...state.sortCriteria, ...criteria },
    })),
}));
