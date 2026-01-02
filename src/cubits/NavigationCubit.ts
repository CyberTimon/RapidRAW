import { Cubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { Invokes, LibraryViewMode } from '../components/ui/AppProperties';

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  hasChildren: boolean;
}

export interface NavigationState {
  rootPath: string | null;
  currentFolderPath: string | null;
  expandedFolders: Set<string>;
  folderTree: FolderNode | null;
  pinnedFolderTrees: FolderNode[];
  pinnedFolders: string[];
  activeView: 'library' | 'editor' | 'community';
  activeTreeSection: string | null;
  isTreeLoading: boolean;
  libraryViewMode: LibraryViewMode;
}

const defaultState: NavigationState = {
  rootPath: null,
  currentFolderPath: null,
  expandedFolders: new Set(),
  folderTree: null,
  pinnedFolderTrees: [],
  pinnedFolders: [],
  activeView: 'library',
  activeTreeSection: 'current',
  isTreeLoading: false,
  libraryViewMode: LibraryViewMode.Flat,
};

@blac({ keepAlive: true })
export class NavigationCubit extends Cubit<NavigationState> {
  constructor() {
    super(defaultState);
  }

  // Computed getters
  get isInEditorView(): boolean {
    return this.state.activeView === 'editor';
  }

  get isInLibraryView(): boolean {
    return this.state.activeView === 'library';
  }

  get hasRootPath(): boolean {
    return this.state.rootPath !== null;
  }

  // Root path management
  setRootPath = async (path: string) => {
    this.patch({
      rootPath: path,
      currentFolderPath: path,
      isTreeLoading: true,
    });

    try {
      const treeData = await invoke<FolderNode>(Invokes.GetFolderTree, { path });
      this.patch({
        folderTree: treeData,
        isTreeLoading: false,
      });
    } catch (error) {
      console.error('Failed to load folder tree:', error);
      this.patch({ isTreeLoading: false });
    }
  };

  clearRootPath = () => {
    this.emit(defaultState);
  };

  // Folder selection
  selectFolder = (path: string) => {
    this.patch({ currentFolderPath: path });
  };

  // Folder expansion
  toggleFolderExpanded = (path: string) => {
    this.update((state) => {
      const newExpanded = new Set(state.expandedFolders);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      return { ...state, expandedFolders: newExpanded };
    });
  };

  expandFolder = (path: string) => {
    this.update((state) => {
      const newExpanded = new Set(state.expandedFolders);
      newExpanded.add(path);
      return { ...state, expandedFolders: newExpanded };
    });
  };

  collapseFolder = (path: string) => {
    this.update((state) => {
      const newExpanded = new Set(state.expandedFolders);
      newExpanded.delete(path);
      return { ...state, expandedFolders: newExpanded };
    });
  };

  setExpandedFolders = (folders: string[]) => {
    this.patch({ expandedFolders: new Set(folders) });
  };

  // View management
  setActiveView = (view: 'library' | 'editor' | 'community') => {
    this.patch({ activeView: view });
  };

  switchToEditor = () => {
    this.patch({ activeView: 'editor' });
  };

  switchToLibrary = () => {
    this.patch({ activeView: 'library' });
  };

  switchToCommunity = () => {
    this.patch({ activeView: 'community' });
  };

  // Tree section
  setActiveTreeSection = (section: string | null) => {
    this.patch({ activeTreeSection: section });
  };

  // Pinned folders
  setPinnedFolders = (folders: string[]) => {
    this.patch({ pinnedFolders: folders });
  };

  addPinnedFolder = (path: string) => {
    if (this.state.pinnedFolders.includes(path)) return;
    this.update((state) => ({
      ...state,
      pinnedFolders: [...state.pinnedFolders, path],
    }));
  };

  removePinnedFolder = (path: string) => {
    this.update((state) => ({
      ...state,
      pinnedFolders: state.pinnedFolders.filter((p) => p !== path),
      pinnedFolderTrees: state.pinnedFolderTrees.filter((t) => t.path !== path),
    }));
  };

  loadPinnedFolderTrees = async () => {
    if (this.state.pinnedFolders.length === 0) {
      this.patch({ pinnedFolderTrees: [] });
      return;
    }

    try {
      const trees = await invoke<FolderNode[]>(Invokes.GetPinnedFolderTrees, {
        paths: this.state.pinnedFolders,
      });
      this.patch({ pinnedFolderTrees: trees });
    } catch (error) {
      console.error('Failed to load pinned folder trees:', error);
    }
  };

  // Library view mode
  setLibraryViewMode = (mode: LibraryViewMode) => {
    this.patch({ libraryViewMode: mode });
  };

  toggleLibraryViewMode = () => {
    this.patch({
      libraryViewMode:
        this.state.libraryViewMode === LibraryViewMode.Flat
          ? LibraryViewMode.Recursive
          : LibraryViewMode.Flat,
    });
  };

  // Refresh folder tree
  refreshFolderTree = async () => {
    if (!this.state.rootPath) return;

    this.patch({ isTreeLoading: true });
    try {
      const treeData = await invoke<FolderNode>(Invokes.GetFolderTree, {
        path: this.state.rootPath,
      });
      this.patch({ folderTree: treeData, isTreeLoading: false });
    } catch (error) {
      console.error('Failed to refresh folder tree:', error);
      this.patch({ isTreeLoading: false });
    }
  };

  // Refresh all folder trees (root + pinned)
  refreshAllFolderTrees = async () => {
    const promises: Promise<void>[] = [];

    // Refresh root folder tree
    if (this.state.rootPath) {
      promises.push(
        invoke<FolderNode>(Invokes.GetFolderTree, { path: this.state.rootPath })
          .then((treeData) => {
            this.patch({ folderTree: treeData });
          })
          .catch((error) => {
            console.error('Failed to refresh root folder tree:', error);
          })
      );
    }

    // Refresh pinned folder trees
    if (this.state.pinnedFolders.length > 0) {
      promises.push(
        invoke<FolderNode[]>(Invokes.GetPinnedFolderTrees, { paths: this.state.pinnedFolders })
          .then((trees) => {
            this.patch({ pinnedFolderTrees: trees });
          })
          .catch((error) => {
            console.error('Failed to refresh pinned folder trees:', error);
          })
      );
    }

    await Promise.all(promises);
  };

  // Toggle pin folder (add or remove)
  togglePinFolder = async (path: string): Promise<string[]> => {
    const isPinned = this.state.pinnedFolders.includes(path);
    let newPins: string[];

    if (isPinned) {
      newPins = this.state.pinnedFolders.filter((p) => p !== path);
      this.patch({
        pinnedFolders: newPins,
        pinnedFolderTrees: this.state.pinnedFolderTrees.filter((t) => t.path !== path),
      });
    } else {
      newPins = [...this.state.pinnedFolders, path];
      this.patch({ pinnedFolders: newPins });

      // Load updated pinned folder trees
      try {
        const trees = await invoke<FolderNode[]>(Invokes.GetPinnedFolderTrees, { paths: newPins });
        this.patch({ pinnedFolderTrees: trees });
      } catch (error) {
        console.error('Failed to load pinned folder trees:', error);
      }
    }

    return newPins;
  };

  // Direct state setters for App.tsx migration
  setFolderTree = (tree: FolderNode | null) => {
    this.patch({ folderTree: tree });
  };

  setPinnedFolderTrees = (trees: FolderNode[]) => {
    this.patch({ pinnedFolderTrees: trees });
  };

  setIsTreeLoading = (loading: boolean) => {
    this.patch({ isTreeLoading: loading });
  };

  setRootPathSimple = (path: string | null) => {
    this.patch({ rootPath: path });
  };

  setCurrentFolderPath = (path: string | null) => {
    this.patch({ currentFolderPath: path });
  };

  // Restore state from saved settings
  restoreFromSettings = (settings: {
    lastRootPath?: string | null;
    lastFolderState?: {
      currentFolderPath?: string;
      expandedFolders?: string[];
    };
    activeTreeSection?: string | null;
    pinnedFolders?: string[];
  }) => {
    if (settings.lastRootPath) {
      this.setRootPath(settings.lastRootPath);
    }

    if (settings.lastFolderState?.currentFolderPath) {
      this.patch({ currentFolderPath: settings.lastFolderState.currentFolderPath });
    }

    if (settings.lastFolderState?.expandedFolders) {
      this.setExpandedFolders(settings.lastFolderState.expandedFolders);
    }

    if (settings.activeTreeSection !== undefined) {
      this.patch({ activeTreeSection: settings.activeTreeSection });
    }

    if (settings.pinnedFolders) {
      this.setPinnedFolders(settings.pinnedFolders);
      this.loadPinnedFolderTrees();
    }
  };

  // Get current folder state for saving
  getFolderStateForSaving = () => ({
    currentFolderPath: this.state.currentFolderPath,
    expandedFolders: Array.from(this.state.expandedFolders),
  });
}
