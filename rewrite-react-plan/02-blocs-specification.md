# Blocs Specification

This document details all the Blac state containers (Cubits/Vertices) needed for the RapidRAW rewrite.

## Bloc Hierarchy

```
blocs/
  app/
    AppBloc.ts              # App-level state (view, theme, window)
    SettingsBloc.ts         # Persistent user settings
    UIBloc.ts               # UI visibility state (panels, sidebars)
  
  library/
    LibraryBloc.ts          # Image list and folder state
    FolderBloc.ts           # Folder tree navigation
    SelectionBloc.ts        # Multi-select state
    FilterBloc.ts           # Filter criteria
    SortBloc.ts             # Sort criteria
    SearchBloc.ts           # Search/indexing state
    ThumbnailBloc.ts        # Thumbnail cache
    RatingsBloc.ts          # Image ratings cache
  
  editor/
    EditorBloc.ts           # Currently editing image state
    AdjustmentsBloc.ts      # All image adjustments
    HistoryBloc.ts          # Undo/redo stack
    PreviewBloc.ts          # Preview image URLs
    ZoomBloc.ts             # Zoom/pan state
    FullscreenBloc.ts       # Fullscreen mode state
  
  panels/
    PanelBloc.ts            # Active panel state
    CropBloc.ts             # Crop tool state
    MasksBloc.ts            # Mask editing state
    PresetsBloc.ts          # Presets management
    ExportBloc.ts           # Export settings/progress
    AIBloc.ts               # AI features state
    MetadataBloc.ts         # EXIF/metadata display
  
  modals/
    ModalBloc.ts            # Modal visibility registry
  
  services/
    TauriService.ts         # Tauri invoke wrapper
    KeyboardService.ts      # Keyboard shortcuts
    ContextMenuService.ts   # Context menu state
    ClipboardService.ts     # Copy/paste state
```

---

## App Blocs

### AppBloc

Manages application-level state including active view and window state.

```typescript
// blocs/app/AppBloc.ts
import { Cubit, blac, borrow } from '@blac/core';

export type ViewId = 'explore' | 'edit' | 'community';

interface AppState {
  activeView: ViewId;
  isWindowFullScreen: boolean;
  isInitialized: boolean;
  error: string | null;
}

@blac({ keepAlive: true })
export class AppBloc extends Cubit<AppState> {
  constructor() {
    super({
      activeView: 'explore',
      isWindowFullScreen: false,
      isInitialized: false,
      error: null,
    });
  }

  setActiveView = (view: ViewId) => {
    this.patch({ activeView: view });
  };

  navigateToEditor = () => this.setActiveView('edit');
  navigateToLibrary = () => this.setActiveView('explore');
  navigateToCommunity = () => this.setActiveView('community');

  setWindowFullScreen = (isFullScreen: boolean) => {
    this.patch({ isWindowFullScreen: isFullScreen });
  };

  initialize = async () => {
    try {
      const settings = borrow(SettingsBloc);
      await settings.load();
      this.patch({ isInitialized: true });
    } catch (error) {
      this.patch({ error: `Initialization failed: ${error}` });
    }
  };

  setError = (error: string | null) => {
    this.patch({ error });
  };

  clearError = () => this.setError(null);
}
```

### SettingsBloc

Manages persistent user settings synced with Tauri backend.

```typescript
// blocs/app/SettingsBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import { TauriService } from '../services/TauriService';

interface AppSettings {
  theme: string;
  lastRootPath: string | null;
  lastFolderState: FolderState | null;
  pinnedFolders: string[];
  editorPreviewResolution: number;
  enableZoomHifi: boolean;
  enableAiTagging: boolean;
  enableExifReading: boolean;
  thumbnailSize: 'small' | 'medium' | 'large';
  thumbnailAspectRatio: 'cover' | 'contain';
  copyPasteSettings: CopyPasteSettings;
  comfyuiAddress?: string;
  adaptiveEditorTheme?: boolean;
}

interface SettingsState {
  settings: AppSettings;
  isLoading: boolean;
  isSaving: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  lastRootPath: null,
  lastFolderState: null,
  pinnedFolders: [],
  editorPreviewResolution: 2560,
  enableZoomHifi: true,
  enableAiTagging: false,
  enableExifReading: true,
  thumbnailSize: 'medium',
  thumbnailAspectRatio: 'cover',
  copyPasteSettings: { mode: 'merge', includedAdjustments: [] },
};

@blac({ keepAlive: true })
export class SettingsBloc extends Cubit<SettingsState> {
  constructor() {
    super({
      settings: DEFAULT_SETTINGS,
      isLoading: false,
      isSaving: false,
    });
  }

  load = async () => {
    this.patch({ isLoading: true });
    try {
      const tauri = borrow(TauriService);
      const settings = await tauri.loadSettings();
      this.patch({
        settings: { ...DEFAULT_SETTINGS, ...settings },
        isLoading: false,
      });
    } catch (error) {
      console.error('Failed to load settings:', error);
      this.patch({ isLoading: false });
    }
  };

  save = async () => {
    this.patch({ isSaving: true });
    try {
      const tauri = borrow(TauriService);
      await tauri.saveSettings(this.state.settings);
    } catch (error) {
      console.error('Failed to save settings:', error);
    } finally {
      this.patch({ isSaving: false });
    }
  };

  updateSettings = (partial: Partial<AppSettings>) => {
    this.update(state => ({
      ...state,
      settings: { ...state.settings, ...partial },
    }));
    this.save();
  };

  // Convenience getters
  get theme() { return this.state.settings.theme; }
  get lastRootPath() { return this.state.settings.lastRootPath; }
  get pinnedFolders() { return this.state.settings.pinnedFolders; }
}
```

### UIBloc

Manages UI visibility and panel sizes.

```typescript
// blocs/app/UIBloc.ts
import { Cubit, blac } from '@blac/core';

interface UIPanelState {
  visible: boolean;
  size: number;
  collapsed: boolean;
}

interface UIState {
  leftSidebar: UIPanelState;
  rightPanel: UIPanelState;
  bottomPanel: UIPanelState;
  isResizing: boolean;
}

@blac({ keepAlive: true })
export class UIBloc extends Cubit<UIState> {
  constructor() {
    super({
      leftSidebar: { visible: true, size: 256, collapsed: false },
      rightPanel: { visible: true, size: 320, collapsed: false },
      bottomPanel: { visible: true, size: 144, collapsed: false },
      isResizing: false,
    });
  }

  toggleLeftSidebar = () => {
    this.update(state => ({
      ...state,
      leftSidebar: { ...state.leftSidebar, visible: !state.leftSidebar.visible },
    }));
  };

  toggleRightPanel = () => {
    this.update(state => ({
      ...state,
      rightPanel: { ...state.rightPanel, visible: !state.rightPanel.visible },
    }));
  };

  toggleBottomPanel = () => {
    this.update(state => ({
      ...state,
      bottomPanel: { ...state.bottomPanel, visible: !state.bottomPanel.visible },
    }));
  };

  setLeftSidebarSize = (size: number) => {
    this.update(state => ({
      ...state,
      leftSidebar: { ...state.leftSidebar, size: Math.max(200, Math.min(500, size)) },
    }));
  };

  setRightPanelSize = (size: number) => {
    this.update(state => ({
      ...state,
      rightPanel: { ...state.rightPanel, size: Math.max(280, Math.min(600, size)) },
    }));
  };

  setBottomPanelSize = (size: number) => {
    this.update(state => ({
      ...state,
      bottomPanel: { ...state.bottomPanel, size: Math.max(100, Math.min(400, size)) },
    }));
  };

  setResizing = (isResizing: boolean) => {
    this.patch({ isResizing });
  };
}
```

---

## Library Blocs

### LibraryBloc

Core library state managing image lists and folder navigation.

```typescript
// blocs/library/LibraryBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import { TauriService } from '../services/TauriService';
import type { ImageFile } from '../../types/library';

interface LibraryState {
  rootPath: string | null;
  currentFolderPath: string | null;
  images: ImageFile[];
  viewMode: 'flat' | 'recursive';
  isLoading: boolean;
  error: string | null;
}

@blac({ keepAlive: true })
export class LibraryBloc extends Cubit<LibraryState> {
  constructor() {
    super({
      rootPath: null,
      currentFolderPath: null,
      images: [],
      viewMode: 'flat',
      isLoading: false,
      error: null,
    });
  }

  openFolder = async (path: string, isNewRoot = false) => {
    this.patch({ isLoading: true, error: null });
    
    try {
      const tauri = borrow(TauriService);
      
      // Clear selection when changing folders
      borrow(SelectionBloc).clearSelection();
      
      // Load folder tree if new root
      if (isNewRoot) {
        await borrow(FolderBloc).loadTree(path);
      }
      
      // Load images based on view mode
      const images = this.state.viewMode === 'recursive'
        ? await tauri.listImagesRecursive(path)
        : await tauri.listImagesInDir(path);
      
      this.patch({
        currentFolderPath: path,
        rootPath: isNewRoot ? path : this.state.rootPath,
        images,
        isLoading: false,
      });
      
      // Update settings
      if (isNewRoot) {
        borrow(SettingsBloc).updateSettings({ lastRootPath: path });
      }
      
      // Start background indexing
      tauri.startBackgroundIndexing(path);
      
      // Generate thumbnails
      borrow(ThumbnailBloc).generateForImages(images);
      
    } catch (error) {
      this.patch({
        error: `Failed to load folder: ${error}`,
        isLoading: false,
      });
    }
  };

  refresh = async () => {
    if (!this.state.currentFolderPath) return;
    await this.openFolder(this.state.currentFolderPath);
  };

  setViewMode = async (mode: 'flat' | 'recursive') => {
    this.patch({ viewMode: mode });
    await this.refresh();
  };

  updateImage = (path: string, updates: Partial<ImageFile>) => {
    this.update(state => ({
      ...state,
      images: state.images.map(img =>
        img.path === path ? { ...img, ...updates } : img
      ),
    }));
  };

  // Computed: sorted and filtered images
  get sortedFilteredImages(): ImageFile[] {
    const filter = borrow(FilterBloc);
    const sort = borrow(SortBloc);
    const ratings = borrow(RatingsBloc);
    const search = borrow(SearchBloc);
    
    let result = [...this.state.images];
    
    // Apply filters
    result = filter.applyFilters(result, ratings.state.ratings);
    
    // Apply search
    result = search.applySearch(result);
    
    // Apply sort
    result = sort.applySort(result, ratings.state.ratings);
    
    return result;
  }

  goHome = () => {
    this.emit({
      rootPath: null,
      currentFolderPath: null,
      images: [],
      viewMode: 'flat',
      isLoading: false,
      error: null,
    });
  };
}
```

### SelectionBloc

Manages multi-selection state.

```typescript
// blocs/library/SelectionBloc.ts
import { Cubit, blac } from '@blac/core';

interface SelectionState {
  selectedPaths: string[];
  activePath: string | null;  // Last clicked item
  anchorPath: string | null;  // For shift-click range selection
}

@blac({ keepAlive: true })
export class SelectionBloc extends Cubit<SelectionState> {
  constructor() {
    super({
      selectedPaths: [],
      activePath: null,
      anchorPath: null,
    });
  }

  // Simple click - select single item
  selectSingle = (path: string) => {
    this.emit({
      selectedPaths: [path],
      activePath: path,
      anchorPath: path,
    });
  };

  // Ctrl+click - toggle item in selection
  toggleSelection = (path: string) => {
    const isSelected = this.state.selectedPaths.includes(path);
    const newSelection = isSelected
      ? this.state.selectedPaths.filter(p => p !== path)
      : [...this.state.selectedPaths, path];
    
    this.emit({
      selectedPaths: newSelection,
      activePath: path,
      anchorPath: isSelected ? this.state.anchorPath : path,
    });
  };

  // Shift+click - range selection
  selectRange = (path: string, allPaths: string[]) => {
    if (!this.state.anchorPath) {
      this.selectSingle(path);
      return;
    }
    
    const anchorIndex = allPaths.indexOf(this.state.anchorPath);
    const currentIndex = allPaths.indexOf(path);
    
    if (anchorIndex === -1 || currentIndex === -1) {
      this.selectSingle(path);
      return;
    }
    
    const start = Math.min(anchorIndex, currentIndex);
    const end = Math.max(anchorIndex, currentIndex);
    const rangePaths = allPaths.slice(start, end + 1);
    
    this.patch({
      selectedPaths: Array.from(new Set([...this.state.selectedPaths, ...rangePaths])),
      activePath: path,
    });
  };

  // Select all
  selectAll = (allPaths: string[]) => {
    this.patch({
      selectedPaths: allPaths,
      activePath: allPaths[allPaths.length - 1] || null,
    });
  };

  // Clear selection
  clearSelection = () => {
    this.emit({
      selectedPaths: [],
      activePath: null,
      anchorPath: null,
    });
  };

  // Handle click with modifiers
  handleClick = (path: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, allPaths: string[]) => {
    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;
    
    if (isShift && this.state.anchorPath) {
      this.selectRange(path, allPaths);
    } else if (isCtrl) {
      this.toggleSelection(path);
    } else {
      this.selectSingle(path);
    }
  };

  get hasSelection(): boolean {
    return this.state.selectedPaths.length > 0;
  }

  get isSingleSelection(): boolean {
    return this.state.selectedPaths.length === 1;
  }

  get selectionCount(): number {
    return this.state.selectedPaths.length;
  }
}
```

### FilterBloc & SortBloc

```typescript
// blocs/library/FilterBloc.ts
import { Cubit, blac } from '@blac/core';
import type { ImageFile } from '../../types/library';

interface FilterState {
  minRating: number;        // 0-5, 0 = show all
  colors: string[];         // Color label filter
  rawStatus: 'all' | 'raw' | 'nonRaw';
}

@blac({ keepAlive: true })
export class FilterBloc extends Cubit<FilterState> {
  constructor() {
    super({
      minRating: 0,
      colors: [],
      rawStatus: 'all',
    });
  }

  setMinRating = (rating: number) => {
    this.patch({ minRating: rating });
  };

  toggleColor = (color: string) => {
    const colors = this.state.colors.includes(color)
      ? this.state.colors.filter(c => c !== color)
      : [...this.state.colors, color];
    this.patch({ colors });
  };

  setColors = (colors: string[]) => {
    this.patch({ colors });
  };

  setRawStatus = (status: 'all' | 'raw' | 'nonRaw') => {
    this.patch({ rawStatus: status });
  };

  clearFilters = () => {
    this.emit({ minRating: 0, colors: [], rawStatus: 'all' });
  };

  applyFilters = (images: ImageFile[], ratings: Record<string, number>): ImageFile[] => {
    return images.filter(image => {
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
        const imageColor = image.tags?.find(t => t.startsWith('color:'))?.substring(6);
        const hasMatch = imageColor && this.state.colors.includes(imageColor);
        const matchesNone = !imageColor && this.state.colors.includes('none');
        if (!hasMatch && !matchesNone) return false;
      }
      
      // RAW status filter
      if (this.state.rawStatus !== 'all') {
        const ext = image.path.split('.').pop()?.toLowerCase() || '';
        const isRaw = RAW_EXTENSIONS.includes(ext);
        if (this.state.rawStatus === 'raw' && !isRaw) return false;
        if (this.state.rawStatus === 'nonRaw' && isRaw) return false;
      }
      
      return true;
    });
  };

  get isActive(): boolean {
    return this.state.minRating > 0 || 
           this.state.colors.length > 0 || 
           this.state.rawStatus !== 'all';
  }
}

// blocs/library/SortBloc.ts
import { Cubit, blac } from '@blac/core';

type SortKey = 'name' | 'date' | 'rating' | 'date_taken' | 'iso' | 'shutter_speed' | 'aperture' | 'focal_length';
type SortDirection = 'asc' | 'desc';

interface SortState {
  key: SortKey;
  direction: SortDirection;
}

@blac({ keepAlive: true })
export class SortBloc extends Cubit<SortState> {
  constructor() {
    super({
      key: 'name',
      direction: 'asc',
    });
  }

  setKey = (key: SortKey) => {
    this.patch({ key });
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
          comparison = a.path.localeCompare(b.path);
          break;
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (ratings[a.path] || 0) - (ratings[b.path] || 0);
          break;
        case 'date_taken':
          comparison = (a.exif?.DateTimeOriginal || '').localeCompare(b.exif?.DateTimeOriginal || '');
          break;
        // ... other sort keys
      }
      
      return this.state.direction === 'asc' ? comparison : -comparison;
    });
    
    return sorted;
  };
}
```

### ThumbnailBloc

```typescript
// blocs/library/ThumbnailBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import { TauriService } from '../services/TauriService';
import type { ImageFile } from '../../types/library';

interface ThumbnailState {
  thumbnails: Record<string, string>;  // path -> base64 data URL
  isGenerating: boolean;
  pending: string[];
}

@blac({ keepAlive: true })
export class ThumbnailBloc extends Cubit<ThumbnailState> {
  constructor() {
    super({
      thumbnails: {},
      isGenerating: false,
      pending: [],
    });
  }

  generateForImages = async (images: ImageFile[]) => {
    const paths = images
      .map(img => img.path)
      .filter(path => !this.state.thumbnails[path]);
    
    if (paths.length === 0) return;
    
    this.patch({ pending: paths, isGenerating: true });
    
    const tauri = borrow(TauriService);
    await tauri.generateThumbnailsProgressive(paths);
    
    this.patch({ isGenerating: false });
  };

  updateThumbnail = (path: string, data: string, rating?: number) => {
    this.update(state => ({
      ...state,
      thumbnails: { ...state.thumbnails, [path]: data },
      pending: state.pending.filter(p => p !== path),
    }));
    
    // Update rating if provided
    if (rating !== undefined) {
      borrow(RatingsBloc).setRating(path, rating);
    }
  };

  getThumbnail = (path: string): string | undefined => {
    return this.state.thumbnails[path];
  };

  clearCache = () => {
    this.emit({ thumbnails: {}, isGenerating: false, pending: [] });
  };
}
```

---

## Editor Blocs

### EditorBloc

Main editor state for the currently selected image.

```typescript
// blocs/editor/EditorBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import { TauriService } from '../services/TauriService';
import type { SelectedImage } from '../../types/editor';

interface EditorState {
  selectedImage: SelectedImage | null;
  isLoading: boolean;
  error: string | null;
}

@blac({ keepAlive: true })
export class EditorBloc extends Cubit<EditorState> {
  constructor() {
    super({
      selectedImage: null,
      isLoading: false,
      error: null,
    });
  }

  selectImage = async (path: string) => {
    // Don't reload if same image
    if (this.state.selectedImage?.path === path) return;
    
    this.patch({ isLoading: true, error: null });
    
    // Cancel any pending operations
    borrow(AdjustmentsBloc).cancelPendingOperations();
    
    // Reset related state
    borrow(HistoryBloc).clear();
    borrow(ZoomBloc).reset();
    
    try {
      const tauri = borrow(TauriService);
      const result = await tauri.loadImage(path);
      
      const selectedImage: SelectedImage = {
        path,
        width: result.width,
        height: result.height,
        isRaw: result.is_raw,
        isReady: true,
        exif: result.exif,
        metadata: result.metadata,
        originalUrl: URL.createObjectURL(new Blob([result.original_image_bytes])),
      };
      
      this.patch({
        selectedImage,
        isLoading: false,
      });
      
      // Load adjustments for this image
      const adjustments = result.metadata?.adjustments;
      borrow(AdjustmentsBloc).loadFromImage(adjustments);
      
      // Navigate to editor view
      borrow(AppBloc).navigateToEditor();
      
      // Update selection state
      borrow(SelectionBloc).selectSingle(path);
      
    } catch (error) {
      this.patch({
        error: `Failed to load image: ${error}`,
        isLoading: false,
      });
    }
  };

  closeEditor = () => {
    // Clean up blob URL
    if (this.state.selectedImage?.originalUrl) {
      URL.revokeObjectURL(this.state.selectedImage.originalUrl);
    }
    
    this.patch({ selectedImage: null });
    borrow(AppBloc).navigateToLibrary();
  };

  get hasImage(): boolean {
    return this.state.selectedImage !== null;
  }

  get imagePath(): string | null {
    return this.state.selectedImage?.path || null;
  }

  get imageSize(): { width: number; height: number } | null {
    if (!this.state.selectedImage) return null;
    return {
      width: this.state.selectedImage.width,
      height: this.state.selectedImage.height,
    };
  }
}
```

### PreviewBloc

Manages preview image generation and display.

```typescript
// blocs/editor/PreviewBloc.ts
import { Cubit, blac } from '@blac/core';
import type { HistogramData } from '../../types/editor';

interface PreviewState {
  finalPreviewUrl: string | null;
  uncroppedPreviewUrl: string | null;
  fullscreenPreviewUrl: string | null;
  transformedOriginalUrl: string | null;
  histogram: HistogramData | null;
  isAdjusting: boolean;
}

@blac({ keepAlive: true })
export class PreviewBloc extends Cubit<PreviewState> {
  constructor() {
    super({
      finalPreviewUrl: null,
      uncroppedPreviewUrl: null,
      fullscreenPreviewUrl: null,
      transformedOriginalUrl: null,
      histogram: null,
      isAdjusting: false,
    });
  }

  setFinalPreview = (data: Uint8Array) => {
    const blob = new Blob([data], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    
    // Revoke old URL
    if (this.state.finalPreviewUrl) {
      setTimeout(() => URL.revokeObjectURL(this.state.finalPreviewUrl!), 5000);
    }
    
    this.patch({ finalPreviewUrl: url, isAdjusting: false });
  };

  setUncroppedPreview = (data: Uint8Array) => {
    const blob = new Blob([data], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    
    if (this.state.uncroppedPreviewUrl) {
      setTimeout(() => URL.revokeObjectURL(this.state.uncroppedPreviewUrl!), 5000);
    }
    
    this.patch({ uncroppedPreviewUrl: url });
  };

  setHistogram = (histogram: HistogramData) => {
    this.patch({ histogram });
  };

  setAdjusting = (isAdjusting: boolean) => {
    this.patch({ isAdjusting });
  };

  clear = () => {
    // Revoke all URLs
    [this.state.finalPreviewUrl, this.state.uncroppedPreviewUrl, 
     this.state.fullscreenPreviewUrl, this.state.transformedOriginalUrl]
      .filter(Boolean)
      .forEach(url => URL.revokeObjectURL(url!));
    
    this.emit({
      finalPreviewUrl: null,
      uncroppedPreviewUrl: null,
      fullscreenPreviewUrl: null,
      transformedOriginalUrl: null,
      histogram: null,
      isAdjusting: false,
    });
  };
}
```

### ZoomBloc

```typescript
// blocs/editor/ZoomBloc.ts
import { Cubit, blac } from '@blac/core';

interface ZoomState {
  scale: number;
  positionX: number;
  positionY: number;
  isFullResolution: boolean;
  isLoadingFullRes: boolean;
}

export class ZoomBloc extends Cubit<ZoomState> {
  constructor() {
    super({
      scale: 1,
      positionX: 0,
      positionY: 0,
      isFullResolution: false,
      isLoadingFullRes: false,
    });
  }

  setScale = (scale: number) => {
    this.patch({ scale: Math.max(0.1, Math.min(20, scale)) });
  };

  setPosition = (x: number, y: number) => {
    this.patch({ positionX: x, positionY: y });
  };

  setTransform = (scale: number, x: number, y: number) => {
    this.emit({
      ...this.state,
      scale: Math.max(0.1, Math.min(20, scale)),
      positionX: x,
      positionY: y,
    });
  };

  fitToWindow = () => {
    this.emit({
      scale: 1,
      positionX: 0,
      positionY: 0,
      isFullResolution: false,
      isLoadingFullRes: false,
    });
  };

  zoom100Percent = () => {
    // This needs image size info from EditorBloc
    // Will be calculated based on display size vs original size
  };

  zoomIn = () => {
    this.setScale(this.state.scale * 1.2);
  };

  zoomOut = () => {
    this.setScale(this.state.scale / 1.2);
  };

  reset = () => {
    this.emit({
      scale: 1,
      positionX: 0,
      positionY: 0,
      isFullResolution: false,
      isLoadingFullRes: false,
    });
  };

  setFullResolution = (enabled: boolean) => {
    this.patch({ isFullResolution: enabled });
  };

  setLoadingFullRes = (loading: boolean) => {
    this.patch({ isLoadingFullRes: loading });
  };
}
```

---

## Panel Blocs

### PanelBloc

Manages active panel state in the editor.

```typescript
// blocs/panels/PanelBloc.ts
import { Cubit, blac } from '@blac/core';

export type PanelId = 'adjustments' | 'metadata' | 'crop' | 'masks' | 'presets' | 'export' | 'ai';

interface PanelState {
  activePanel: PanelId | null;
  previousPanel: PanelId | null;
  collapsedSections: Record<string, boolean>;
}

@blac({ keepAlive: true })
export class PanelBloc extends Cubit<PanelState> {
  constructor() {
    super({
      activePanel: 'adjustments',
      previousPanel: null,
      collapsedSections: {},
    });
  }

  setActivePanel = (panel: PanelId | null) => {
    if (panel === this.state.activePanel) {
      // Toggle off if clicking same panel
      this.patch({
        activePanel: null,
        previousPanel: this.state.activePanel,
      });
    } else {
      this.patch({
        activePanel: panel,
        previousPanel: this.state.activePanel,
      });
    }
  };

  togglePanel = (panel: PanelId) => {
    this.setActivePanel(this.state.activePanel === panel ? null : panel);
  };

  // Keyboard shortcuts
  showAdjustments = () => this.setActivePanel('adjustments');
  showCrop = () => this.setActivePanel('crop');
  showMasks = () => this.setActivePanel('masks');
  showPresets = () => this.setActivePanel('presets');
  showMetadata = () => this.setActivePanel('metadata');
  showExport = () => this.setActivePanel('export');
  showAI = () => this.setActivePanel('ai');

  toggleSection = (section: string) => {
    this.update(state => ({
      ...state,
      collapsedSections: {
        ...state.collapsedSections,
        [section]: !state.collapsedSections[section],
      },
    }));
  };

  isSectionCollapsed = (section: string): boolean => {
    return this.state.collapsedSections[section] ?? false;
  };
}
```

---

## Service Blocs

### TauriService

See previous section for full implementation.

### KeyboardService

```typescript
// blocs/services/KeyboardService.ts
import { StatelessCubit, blac } from '@blac/core';

type ShortcutHandler = () => void;

interface Shortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  context?: string;  // Only active in certain contexts
}

@blac({ keepAlive: true })
export class KeyboardService extends StatelessCubit {
  private shortcuts: Shortcut[] = [];
  private activeContext: string = 'global';

  registerShortcut = (shortcut: Shortcut) => {
    this.shortcuts.push(shortcut);
  };

  unregisterShortcut = (key: string, ctrl = false, shift = false) => {
    this.shortcuts = this.shortcuts.filter(s => 
      !(s.key === key && s.ctrl === ctrl && s.shift === shift)
    );
  };

  setContext = (context: string) => {
    this.activeContext = context;
  };

  handleKeyDown = (event: KeyboardEvent) => {
    // Don't handle if input is focused
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

    const key = event.key.toLowerCase();
    const ctrl = event.ctrlKey || event.metaKey;
    const shift = event.shiftKey;
    const alt = event.altKey;

    const matchingShortcut = this.shortcuts.find(s => 
      s.key.toLowerCase() === key &&
      (s.ctrl ?? false) === ctrl &&
      (s.shift ?? false) === shift &&
      (s.alt ?? false) === alt &&
      (!s.context || s.context === this.activeContext || s.context === 'global')
    );

    if (matchingShortcut) {
      event.preventDefault();
      matchingShortcut.handler();
    }
  };

  initialize = () => {
    window.addEventListener('keydown', this.handleKeyDown);
  };

  cleanup = () => {
    window.removeEventListener('keydown', this.handleKeyDown);
  };
}
```

### ContextMenuService

```typescript
// blocs/services/ContextMenuService.ts
import { Cubit, blac } from '@blac/core';

interface MenuOption {
  label?: string;
  icon?: React.ComponentType;
  onClick?: () => void;
  disabled?: boolean;
  isDestructive?: boolean;
  submenu?: MenuOption[];
  type?: 'separator';
}

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  options: MenuOption[];
}

@blac({ keepAlive: true })
export class ContextMenuService extends Cubit<ContextMenuState> {
  constructor() {
    super({
      isOpen: false,
      x: 0,
      y: 0,
      options: [],
    });
  }

  show = (x: number, y: number, options: MenuOption[]) => {
    this.emit({
      isOpen: true,
      x,
      y,
      options,
    });
  };

  hide = () => {
    this.patch({ isOpen: false });
  };
}
```
