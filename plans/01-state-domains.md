# State Domains and Cubit Definitions

## Domain Architecture

The application state is organized into 7 primary domains:

```
+------------------+     +------------------+     +------------------+
|  NavigationCubit |     |   LibraryCubit   |     |   EditorCubit    |
|   (keepAlive)    |     |   (keepAlive)    |     |    (shared)      |
+------------------+     +------------------+     +------------------+
         |                       |                       |
         +-------+---------------+---------------+-------+
                 |                               |
         +-------v-------+               +-------v-------+
         | SettingsCubit |               |  MasksCubit   |
         |  (keepAlive)  |               |   (shared)    |
         +---------------+               +---------------+
                                                 |
                                         +-------v-------+
                                         | AiPatchesCubit|
                                         |   (shared)    |
                                         +---------------+

+------------------+     +------------------+
|   ModalsCubit    |     |   TauriService   |
|    (shared)      |     |   (keepAlive)    |
+------------------+     +------------------+
```

## Domain Definitions

### 1. NavigationCubit (keepAlive)

**Purpose**: Manages folder navigation, view state, and folder tree.

**Current App.tsx state being migrated**:
- `rootPath`
- `currentFolderPath`
- `expandedFolders`
- `activeView`
- `folderTree`
- `isTreeLoading`

```typescript
interface NavigationState {
  rootPath: string | null;
  currentFolderPath: string | null;
  expandedFolders: Set<string>;
  activeView: 'library' | 'editor';
  folderTree: FolderNode | null;
  isTreeLoading: boolean;
}

@blac({ keepAlive: true })
class NavigationCubit extends Cubit<NavigationState> {
  constructor() {
    super({
      rootPath: null,
      currentFolderPath: null,
      expandedFolders: new Set(),
      activeView: 'library',
      folderTree: null,
      isTreeLoading: false,
    });
  }

  setRootPath = (path: string) => {
    this.patch({ rootPath: path, currentFolderPath: path });
  };

  selectFolder = (path: string) => {
    this.patch({ currentFolderPath: path });
    // Notify library to load images
    const library = LibraryCubit.get();
    library.loadImages(path);
  };

  toggleFolderExpanded = (path: string) => {
    this.update(state => {
      const newExpanded = new Set(state.expandedFolders);
      if (newExpanded.has(path)) {
        newExpanded.delete(path);
      } else {
        newExpanded.add(path);
      }
      return { ...state, expandedFolders: newExpanded };
    });
  };

  setActiveView = (view: 'library' | 'editor') => {
    this.patch({ activeView: view });
  };

  loadFolderTree = async () => {
    if (!this.state.rootPath) return;
    this.patch({ isTreeLoading: true });
    const tauri = TauriService.get();
    const tree = await tauri.getFolderTree(this.state.rootPath);
    this.patch({ folderTree: tree, isTreeLoading: false });
  };
}
```

---

### 2. LibraryCubit (keepAlive)

**Purpose**: Manages image list, thumbnails, selection, and sorting/filtering.

**Current App.tsx state being migrated**:
- `imageList`
- `thumbnails`
- `multiSelectedPaths`
- `libraryActivePath`
- `sortCriteria`
- `filterCriteria`
- `searchCriteria`
- `isViewLoading`

```typescript
interface LibraryState {
  imageList: ImageInfo[];
  thumbnails: Record<string, string>;
  multiSelectedPaths: string[];
  libraryActivePath: string | null;
  sortCriteria: SortCriteria;
  filterCriteria: FilterCriteria;
  searchQuery: string;
  isLoading: boolean;
  thumbnailProgress: { current: number; total: number } | null;
}

@blac({ keepAlive: true })
class LibraryCubit extends Cubit<LibraryState> {
  constructor() {
    super({
      imageList: [],
      thumbnails: {},
      multiSelectedPaths: [],
      libraryActivePath: null,
      sortCriteria: { field: 'name', direction: 'asc' },
      filterCriteria: { rating: null, flag: null, tags: [] },
      searchQuery: '',
      isLoading: false,
      thumbnailProgress: null,
    });
  }

  // Computed getter - replaces 170-line useMemo in App.tsx
  get sortedImageList(): ImageInfo[] {
    const { imageList, sortCriteria, filterCriteria, searchQuery } = this.state;
    
    let filtered = imageList;
    
    // Apply filters
    if (filterCriteria.rating !== null) {
      filtered = filtered.filter(img => img.rating >= filterCriteria.rating!);
    }
    if (filterCriteria.flag !== null) {
      filtered = filtered.filter(img => img.flag === filterCriteria.flag);
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(img => 
        img.name.toLowerCase().includes(query)
      );
    }
    
    // Apply sorting
    return [...filtered].sort((a, b) => {
      const direction = sortCriteria.direction === 'asc' ? 1 : -1;
      switch (sortCriteria.field) {
        case 'name':
          return direction * a.name.localeCompare(b.name);
        case 'date':
          return direction * (a.dateModified - b.dateModified);
        case 'size':
          return direction * (a.size - b.size);
        case 'rating':
          return direction * ((a.rating ?? 0) - (b.rating ?? 0));
        default:
          return 0;
      }
    });
  }

  get selectedCount(): number {
    return this.state.multiSelectedPaths.length;
  }

  loadImages = async (folderPath: string) => {
    this.patch({ isLoading: true });
    const tauri = TauriService.get();
    const images = await tauri.getImageList(folderPath);
    this.patch({ imageList: images, isLoading: false });
    this.loadThumbnails(images);
  };

  private loadThumbnails = async (images: ImageInfo[]) => {
    const tauri = TauriService.get();
    for (let i = 0; i < images.length; i++) {
      const thumb = await tauri.generateThumbnail(images[i].path);
      this.update(state => ({
        ...state,
        thumbnails: { ...state.thumbnails, [images[i].path]: thumb },
        thumbnailProgress: { current: i + 1, total: images.length },
      }));
    }
    this.patch({ thumbnailProgress: null });
  };

  setSelection = (paths: string[]) => {
    this.patch({ multiSelectedPaths: paths });
  };

  toggleSelection = (path: string, isShiftKey = false, isCtrlKey = false) => {
    this.update(state => {
      if (isCtrlKey) {
        const newSelection = state.multiSelectedPaths.includes(path)
          ? state.multiSelectedPaths.filter(p => p !== path)
          : [...state.multiSelectedPaths, path];
        return { ...state, multiSelectedPaths: newSelection };
      }
      // Handle shift-click range selection...
      return { ...state, multiSelectedPaths: [path] };
    });
  };

  selectAll = () => {
    this.patch({ multiSelectedPaths: this.state.imageList.map(img => img.path) });
  };

  clearSelection = () => {
    this.patch({ multiSelectedPaths: [] });
  };

  setSortCriteria = (criteria: SortCriteria) => {
    this.patch({ sortCriteria: criteria });
  };

  setFilterCriteria = (criteria: FilterCriteria) => {
    this.patch({ filterCriteria: criteria });
  };

  setSearchQuery = (query: string) => {
    this.patch({ searchQuery: query });
  };
}
```

---

### 3. EditorCubit (shared)

**Purpose**: Manages current image editing state, adjustments, and history.

**Current App.tsx state being migrated**:
- `selectedImage`
- `adjustments` (via useHistoryState)
- `zoom`
- `pan`
- `crop`
- `isFullScreen`
- `isAdjusting`
- `copiedAdjustments`
- `libraryActiveAdjustments`

```typescript
interface EditorState {
  selectedImagePath: string | null;
  adjustments: Adjustments;
  history: Adjustments[];
  historyIndex: number;
  zoom: number;
  pan: { x: number; y: number };
  crop: CropState | null;
  isFullScreen: boolean;
  isAdjusting: boolean;
  copiedAdjustments: Partial<Adjustments> | null;
}

class EditorCubit extends Cubit<EditorState> {
  private debouncedSave: ReturnType<typeof debounce>;

  constructor() {
    super({
      selectedImagePath: null,
      adjustments: defaultAdjustments,
      history: [defaultAdjustments],
      historyIndex: 0,
      zoom: 1,
      pan: { x: 0, y: 0 },
      crop: null,
      isFullScreen: false,
      isAdjusting: false,
      copiedAdjustments: null,
    });

    this.debouncedSave = debounce(this.saveAdjustments, 500);
  }

  // Computed getters
  get canUndo(): boolean {
    return this.state.historyIndex > 0;
  }

  get canRedo(): boolean {
    return this.state.historyIndex < this.state.history.length - 1;
  }

  get currentAdjustments(): Adjustments {
    return this.state.history[this.state.historyIndex];
  }

  selectImage = async (path: string) => {
    this.patch({ selectedImagePath: path, isAdjusting: true });
    
    // Load saved adjustments for this image
    const tauri = TauriService.get();
    const saved = await tauri.loadAdjustments(path);
    const adjustments = saved ?? defaultAdjustments;
    
    this.patch({
      adjustments,
      history: [adjustments],
      historyIndex: 0,
      isAdjusting: false,
    });
  };

  setAdjustments = (updates: Partial<Adjustments>) => {
    this.update(state => {
      const newAdjustments = { ...state.adjustments, ...updates };
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      newHistory.push(newAdjustments);
      
      return {
        ...state,
        adjustments: newAdjustments,
        history: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
    
    this.debouncedSave();
  };

  private saveAdjustments = async () => {
    if (!this.state.selectedImagePath) return;
    const tauri = TauriService.get();
    await tauri.saveAdjustments(this.state.selectedImagePath, this.state.adjustments);
  };

  undo = () => {
    if (!this.canUndo) return;
    this.update(state => ({
      ...state,
      historyIndex: state.historyIndex - 1,
      adjustments: state.history[state.historyIndex - 1],
    }));
    this.debouncedSave();
  };

  redo = () => {
    if (!this.canRedo) return;
    this.update(state => ({
      ...state,
      historyIndex: state.historyIndex + 1,
      adjustments: state.history[state.historyIndex + 1],
    }));
    this.debouncedSave();
  };

  setZoom = (zoom: number) => {
    this.patch({ zoom: Math.max(0.1, Math.min(10, zoom)) });
  };

  setPan = (pan: { x: number; y: number }) => {
    this.patch({ pan });
  };

  setCrop = (crop: CropState | null) => {
    this.patch({ crop });
  };

  toggleFullScreen = () => {
    this.patch({ isFullScreen: !this.state.isFullScreen });
  };

  resetAdjustments = () => {
    this.setAdjustments(defaultAdjustments);
  };

  copyAdjustments = () => {
    this.patch({ copiedAdjustments: { ...this.state.adjustments } });
  };

  pasteAdjustments = () => {
    if (!this.state.copiedAdjustments) return;
    this.setAdjustments(this.state.copiedAdjustments);
  };
}
```

---

### 4. MasksCubit (shared)

**Purpose**: Manages mask containers, active masks, and brush settings.

**Current App.tsx state being migrated**:
- `adjustments.maskContainers` (moved to dedicated cubit)
- `activeMaskContainerId`
- `activeMaskId`
- `brushSettings`
- `isGeneratingAiMask`

```typescript
interface MasksState {
  maskContainers: MaskContainer[];
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  brushSettings: BrushSettings;
  isGeneratingMask: boolean;
}

class MasksCubit extends Cubit<MasksState> {
  constructor() {
    super({
      maskContainers: [],
      activeMaskContainerId: null,
      activeMaskId: null,
      brushSettings: {
        size: 50,
        feather: 20,
        flow: 100,
        mode: 'add',
      },
      isGeneratingMask: false,
    });
  }

  get activeMaskContainer(): MaskContainer | undefined {
    return this.state.maskContainers.find(
      c => c.id === this.state.activeMaskContainerId
    );
  }

  get activeMask(): Mask | undefined {
    return this.activeMaskContainer?.masks.find(
      m => m.id === this.state.activeMaskId
    );
  }

  addMaskContainer = () => {
    const newContainer: MaskContainer = {
      id: crypto.randomUUID(),
      name: `Mask ${this.state.maskContainers.length + 1}`,
      masks: [],
      adjustments: {},
    };
    
    this.update(state => ({
      ...state,
      maskContainers: [...state.maskContainers, newContainer],
      activeMaskContainerId: newContainer.id,
    }));
  };

  removeMaskContainer = (containerId: string) => {
    this.update(state => ({
      ...state,
      maskContainers: state.maskContainers.filter(c => c.id !== containerId),
      activeMaskContainerId: state.activeMaskContainerId === containerId 
        ? null 
        : state.activeMaskContainerId,
    }));
  };

  setActiveMask = (containerId: string | null, maskId: string | null) => {
    this.patch({
      activeMaskContainerId: containerId,
      activeMaskId: maskId,
    });
  };

  addMaskToContainer = (containerId: string, mask: Mask) => {
    this.update(state => ({
      ...state,
      maskContainers: state.maskContainers.map(c =>
        c.id === containerId
          ? { ...c, masks: [...c.masks, mask] }
          : c
      ),
    }));
  };

  updateMaskContainerAdjustments = (
    containerId: string, 
    adjustments: Partial<Adjustments>
  ) => {
    this.update(state => ({
      ...state,
      maskContainers: state.maskContainers.map(c =>
        c.id === containerId
          ? { ...c, adjustments: { ...c.adjustments, ...adjustments } }
          : c
      ),
    }));
  };

  updateBrushSettings = (settings: Partial<BrushSettings>) => {
    this.update(state => ({
      ...state,
      brushSettings: { ...state.brushSettings, ...settings },
    }));
  };

  generateAiMask = async (prompt: string) => {
    this.patch({ isGeneratingMask: true });
    try {
      const tauri = TauriService.get();
      const editor = EditorCubit.get();
      const mask = await tauri.generateMask(editor.state.selectedImagePath!, prompt);
      if (this.state.activeMaskContainerId) {
        this.addMaskToContainer(this.state.activeMaskContainerId, mask);
      }
    } finally {
      this.patch({ isGeneratingMask: false });
    }
  };

  clearAll = () => {
    this.patch({
      maskContainers: [],
      activeMaskContainerId: null,
      activeMaskId: null,
    });
  };
}
```

---

### 5. AiPatchesCubit (shared)

**Purpose**: Manages AI inpainting patches and generation state.

**Current App.tsx state being migrated**:
- `adjustments.aiPatchContainers` (moved to dedicated cubit)
- `activeAiPatchContainerId`
- `activeAiSubMaskId`
- `isGeneratingAi`

```typescript
interface AiPatchesState {
  patchContainers: AiPatchContainer[];
  activeContainerId: string | null;
  activeSubMaskId: string | null;
  isGenerating: boolean;
  generationProgress: { stage: string; progress: number } | null;
}

class AiPatchesCubit extends Cubit<AiPatchesState> {
  constructor() {
    super({
      patchContainers: [],
      activeContainerId: null,
      activeSubMaskId: null,
      isGenerating: false,
      generationProgress: null,
    });
  }

  get activeContainer(): AiPatchContainer | undefined {
    return this.state.patchContainers.find(
      c => c.id === this.state.activeContainerId
    );
  }

  addPatchContainer = () => {
    const newContainer: AiPatchContainer = {
      id: crypto.randomUUID(),
      name: `AI Patch ${this.state.patchContainers.length + 1}`,
      masks: [],
      prompt: '',
      result: null,
    };
    
    this.update(state => ({
      ...state,
      patchContainers: [...state.patchContainers, newContainer],
      activeContainerId: newContainer.id,
    }));
  };

  generateReplace = async (containerId: string, prompt: string) => {
    this.patch({ isGenerating: true, generationProgress: { stage: 'preparing', progress: 0 } });
    
    try {
      const tauri = TauriService.get();
      const editor = EditorCubit.get();
      const container = this.state.patchContainers.find(c => c.id === containerId);
      
      if (!container || !editor.state.selectedImagePath) return;
      
      const result = await tauri.generativeReplace(
        editor.state.selectedImagePath,
        container.masks,
        prompt,
        (progress) => this.patch({ generationProgress: progress })
      );
      
      this.update(state => ({
        ...state,
        patchContainers: state.patchContainers.map(c =>
          c.id === containerId ? { ...c, result, prompt } : c
        ),
      }));
    } finally {
      this.patch({ isGenerating: false, generationProgress: null });
    }
  };

  clearAll = () => {
    this.patch({
      patchContainers: [],
      activeContainerId: null,
      activeSubMaskId: null,
    });
  };
}
```

---

### 6. SettingsCubit (keepAlive)

**Purpose**: Manages app settings, theme, and user preferences.

**Current App.tsx state being migrated**:
- `appSettings`
- `theme`

```typescript
interface SettingsState {
  theme: ThemeName;
  appSettings: AppSettings;
}

@blac({ keepAlive: true })
class SettingsCubit extends Cubit<SettingsState> {
  private debouncedSave: ReturnType<typeof debounce>;

  constructor() {
    super({
      theme: 'dark',
      appSettings: defaultAppSettings,
    });

    this.debouncedSave = debounce(this.saveSettings, 500);
    this.loadSettings();
  }

  private loadSettings = async () => {
    const tauri = TauriService.connect(); // Use connect() to ensure exists
    const settings = await tauri.loadSettings();
    if (settings) {
      this.patch({
        theme: settings.theme ?? 'dark',
        appSettings: settings,
      });
    }
  };

  private saveSettings = async () => {
    const tauri = TauriService.get();
    await tauri.saveSettings({
      ...this.state.appSettings,
      theme: this.state.theme,
    });
  };

  setTheme = (theme: ThemeName) => {
    this.patch({ theme });
    this.debouncedSave();
  };

  updateSettings = (settings: Partial<AppSettings>) => {
    this.update(state => ({
      ...state,
      appSettings: { ...state.appSettings, ...settings },
    }));
    this.debouncedSave();
  };

  resetSettings = () => {
    this.patch({
      theme: 'dark',
      appSettings: defaultAppSettings,
    });
    this.debouncedSave();
  };
}
```

---

### 7. ModalsCubit (shared)

**Purpose**: Manages all modal open/close states.

**Current App.tsx state being migrated**:
- `isCreateFolderModalOpen`
- `isRenameFolderModalOpen`
- `confirmModalState`
- `panoramaModalState`
- `denoiseModalState`
- `cullingModalState`
- `collageModalState`

```typescript
interface ModalsState {
  createFolder: { isOpen: boolean; parentPath?: string };
  renameFolder: { isOpen: boolean; path?: string; currentName?: string };
  renameFile: { isOpen: boolean; path?: string; currentName?: string };
  confirm: ConfirmModalState;
  panorama: { isOpen: boolean; images?: string[] };
  denoise: { isOpen: boolean; imagePath?: string };
  culling: CullingModalState;
  collage: { isOpen: boolean; images?: string[] };
  export: { isOpen: boolean };
  copyPasteSettings: { isOpen: boolean };
  importSettings: { isOpen: boolean };
  addPreset: { isOpen: boolean };
  renamePreset: { isOpen: boolean; presetId?: string; currentName?: string };
}

const defaultModalsState: ModalsState = {
  createFolder: { isOpen: false },
  renameFolder: { isOpen: false },
  renameFile: { isOpen: false },
  confirm: { isOpen: false, title: '', message: '', onConfirm: () => {} },
  panorama: { isOpen: false },
  denoise: { isOpen: false },
  culling: { isOpen: false, pathsToCull: [], suggestions: null, progress: null, error: null },
  collage: { isOpen: false },
  export: { isOpen: false },
  copyPasteSettings: { isOpen: false },
  importSettings: { isOpen: false },
  addPreset: { isOpen: false },
  renamePreset: { isOpen: false },
};

class ModalsCubit extends Cubit<ModalsState> {
  constructor() {
    super(defaultModalsState);
  }

  // Create folder modal
  openCreateFolder = (parentPath: string) => {
    this.patch({ createFolder: { isOpen: true, parentPath } });
  };

  closeCreateFolder = () => {
    this.patch({ createFolder: { isOpen: false } });
  };

  // Rename folder modal
  openRenameFolder = (path: string, currentName: string) => {
    this.patch({ renameFolder: { isOpen: true, path, currentName } });
  };

  closeRenameFolder = () => {
    this.patch({ renameFolder: { isOpen: false } });
  };

  // Confirm modal
  openConfirm = (title: string, message: string, onConfirm: () => void) => {
    this.patch({ confirm: { isOpen: true, title, message, onConfirm } });
  };

  closeConfirm = () => {
    this.patch({ confirm: { ...defaultModalsState.confirm } });
  };

  // Panorama modal
  openPanorama = (images: string[]) => {
    this.patch({ panorama: { isOpen: true, images } });
  };

  closePanorama = () => {
    this.patch({ panorama: { isOpen: false } });
  };

  // Denoise modal
  openDenoise = (imagePath: string) => {
    this.patch({ denoise: { isOpen: true, imagePath } });
  };

  closeDenoise = () => {
    this.patch({ denoise: { isOpen: false } });
  };

  // Generic close all
  closeAll = () => {
    this.emit(defaultModalsState);
  };
}
```

---

### 8. TauriService (keepAlive, StatelessCubit)

**Purpose**: Wrapper for all Tauri backend communication.

```typescript
@blac({ keepAlive: true })
class TauriService extends StatelessCubit {
  // File operations
  getImageList = (path: string): Promise<ImageInfo[]> => 
    invoke(Invokes.GetImageList, { path });

  getFolderTree = (path: string): Promise<FolderNode> => 
    invoke(Invokes.GetFolderTree, { path });

  // Thumbnail operations
  generateThumbnail = (path: string): Promise<string> => 
    invoke(Invokes.GenerateThumbnail, { path });

  // Settings
  loadSettings = (): Promise<AppSettings | null> => 
    invoke(Invokes.LoadSettings);

  saveSettings = (settings: AppSettings): Promise<void> => 
    invoke(Invokes.SaveSettings, settings);

  // Adjustments
  loadAdjustments = (imagePath: string): Promise<Adjustments | null> => 
    invoke(Invokes.LoadAdjustments, { path: imagePath });

  saveAdjustments = (imagePath: string, adjustments: Adjustments): Promise<void> => 
    invoke(Invokes.SaveAdjustments, { path: imagePath, adjustments });

  // Export
  exportImage = (options: ExportOptions): Promise<void> => 
    invoke(Invokes.ExportImage, options);

  // AI operations
  generateMask = (imagePath: string, prompt: string): Promise<Mask> => 
    invoke(Invokes.GenerateMask, { path: imagePath, prompt });

  generativeReplace = (
    imagePath: string, 
    masks: Mask[], 
    prompt: string,
    onProgress?: (progress: { stage: string; progress: number }) => void
  ): Promise<string> => 
    invoke(Invokes.GenerativeReplace, { path: imagePath, masks, prompt });

  // Panorama
  stitchPanorama = (images: string[]): Promise<string> => 
    invoke(Invokes.StitchPanorama, { images });

  // Denoise
  denoiseImage = (imagePath: string, strength: number): Promise<string> => 
    invoke(Invokes.DenoiseImage, { path: imagePath, strength });

  // Culling
  analyzeCulling = (images: string[]): Promise<CullingSuggestion[]> => 
    invoke(Invokes.AnalyzeCulling, { images });
}
```

---

## Inter-Cubit Dependencies

| Cubit | Depends On | Pattern |
|-------|------------|---------|
| NavigationCubit | LibraryCubit, TauriService | Event handler (.get()) |
| LibraryCubit | TauriService | Event handler (.get()) |
| EditorCubit | TauriService | Event handler (.get()) |
| MasksCubit | EditorCubit, TauriService | Event handler + Getter (.get()) |
| AiPatchesCubit | EditorCubit, TauriService | Event handler + Getter (.get()) |
| SettingsCubit | TauriService | Constructor (.connect()) |
| ModalsCubit | None | - |
| TauriService | None | - |
