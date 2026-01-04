# RapidRAW React Frontend Rewrite Plan

## Executive Summary

This document outlines a comprehensive plan to rewrite the RapidRAW React frontend with a modular, customizable architecture that separates concerns between layout, configuration, and content modules. The rewrite will heavily leverage the Blac state management library to house all business logic, while keeping React components as pure rendering templates.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Architecture Goals](#architecture-goals)
3. [Project Structure](#project-structure)
4. [Layer Architecture](#layer-architecture)
5. [View System](#view-system)
6. [Module System](#module-system)
7. [Layout System](#layout-system)
8. [State Management with Blac](#state-management-with-blac)
9. [Tauri Integration](#tauri-integration)
10. [Migration Strategy](#migration-strategy)

---

## Rewrite Approach

This is a **full rewrite** - not a migration. The legacy code has been moved to `src_legacy_deprecated_reference/` for reference only. The new `src/` directory starts fresh with the architecture described in this document.

### Why Full Rewrite?

1. The existing codebase has fundamental architectural issues that can't be incrementally fixed
2. The tight coupling makes it impossible to extract reusable components
3. Starting fresh allows us to establish proper patterns from the beginning
4. The legacy code serves as a reference for business logic and Tauri integration

### Legacy Code Reference

The old code is preserved at `src_legacy_deprecated_reference/` and should be used to:
- Understand existing Tauri invoke commands and their parameters
- Reference business logic for adjustments, masks, export, etc.
- Copy utility functions and constants as needed
- Understand the current UI/UX patterns

**Do NOT import from `src_legacy_deprecated_reference/`** - only use it as documentation.

---

## Legacy Code Analysis (Reference)

The legacy codebase had these issues (preserved in `src_legacy_deprecated_reference/`):

1. **Monolithic App.tsx**: ~4000+ lines with 100+ useState, 50+ useCallback, 20+ useEffect
2. **Tight Coupling**: Components receive 20-40+ props each
3. **React Anti-patterns**: Heavy hook usage for state synchronization
4. **No Separation of Concerns**: Layout, logic, and presentation all mixed

### Legacy Component Inventory (for reference)

```
src_legacy_deprecated_reference/
  App.tsx                    # Monolithic main component (~4000 lines)
  main.tsx                   # React entry point
  styles.css                 # Global styles
  
  components/
    adjustments/             # Adjustment UI components
      Basic.tsx              # Reference for exposure/tone controls
      Color.tsx              # Reference for color/WB controls
      Curves.tsx             # Reference for curves editor
      Details.tsx            # Reference for sharpening/NR
      Effects.tsx            # Reference for vignette/grain
    
    modals/                  # Modal dialogs (12 total)
    panel/                   # Main panel components
    ui/                      # UI primitives (can copy patterns)
  
  hooks/                     # Custom hooks (reference for logic)
  utils/                     # Utilities (can copy as needed)
```

### Tauri Integration Points

The following Tauri invoke commands are used:

- **Image Processing**: `load_image`, `apply_adjustments`, `generate_fullscreen_preview`, `export_image`
- **File Management**: `list_images_in_dir`, `copy_files`, `move_files`, `delete_files`, `rename_files`
- **Metadata**: `load_metadata`, `save_metadata_and_update_thumbnail`
- **AI Features**: `generate_ai_subject_mask`, `invoke_generative_replace`
- **Settings**: `load_settings`, `save_settings`, `load_presets`, `save_presets`
- **Events**: `preview-update-final`, `histogram-update`, `export-progress`, etc.

---

## Architecture Goals

1. **Modular UI**: Components can be rearranged, hidden, or resized by users
2. **Clean Separation**: Layout components handle structure, modules handle content
3. **Centralized State**: All business logic lives in Blac cubits/vertices
4. **Minimal React Hooks**: Only `useBloc` and `useBlocActions` for state access
5. **Configuration-Driven**: UI layout defined by configuration objects
6. **Testable**: Business logic testable without React components
7. **Type-Safe**: Full TypeScript coverage with strict types

---

## Project Structure

```
src/
  index.tsx                  # App entry point
  App.tsx                    # Minimal shell - layout orchestration only
  
  blocs/                     # All business logic (Blac state containers)
    app/
      AppBloc.ts             # App-level state (theme, settings, etc.)
      SettingsBloc.ts        # User settings management
    
    library/
      LibraryBloc.ts         # Image library state
      FolderBloc.ts          # Folder tree and navigation
      ThumbnailBloc.ts       # Thumbnail generation/caching
      SelectionBloc.ts       # Multi-select state
      FilterBloc.ts          # Filtering and sorting
      SearchBloc.ts          # Search/indexing state
    
    editor/
      EditorBloc.ts          # Main editor state
      AdjustmentsBloc.ts     # Image adjustments
      HistoryBloc.ts         # Undo/redo management
      PreviewBloc.ts         # Preview generation
      ZoomBloc.ts            # Zoom/pan state
    
    panels/
      CropBloc.ts            # Crop panel state
      MasksBloc.ts           # Masks panel state
      PresetsBloc.ts         # Presets management
      ExportBloc.ts          # Export state
      AIBloc.ts              # AI features state
    
    modals/
      ModalBloc.ts           # Modal visibility state
      ConfirmBloc.ts         # Confirmation dialogs
    
    services/
      TauriService.ts        # Tauri invoke wrapper (StatelessCubit)
      KeyboardService.ts     # Keyboard shortcuts
      ContextMenuService.ts  # Context menu management
  
  layouts/                   # Layout components (structure only)
    AppShell.tsx             # Main app shell with title bar
    SplitLayout.tsx          # Resizable split panes
    PanelLayout.tsx          # Panel container with tabs
    GridLayout.tsx           # Grid-based layout for library
    ToolbarLayout.tsx        # Horizontal toolbar container
  
  views/                     # View compositions
    ExploreView/
      ExploreView.tsx        # Explore/library view composition
      ExploreLayout.config.ts # Layout configuration
    EditView/
      EditView.tsx           # Editor view composition
      EditLayout.config.ts   # Layout configuration
    CommunityView/
      CommunityView.tsx      # Community presets view
  
  modules/                   # Content modules (the "molecules")
    library/
      GalleryGrid.tsx        # Image grid display
      GalleryControls.tsx    # Sort, filter, search UI
      FolderTree.tsx         # Folder navigation
      Filmstrip.tsx          # Horizontal thumbnail strip
      ImageCard.tsx          # Single image thumbnail
    
    editor/
      ImagePreview.tsx       # Main image canvas
      ImageHistogram.tsx     # Histogram display
      ImageWaveform.tsx      # Waveform display
      EditorToolbar.tsx      # Editor action buttons
      ZoomControls.tsx       # Zoom slider and buttons
    
    adjustments/
      ExposureControls.tsx   # Basic exposure controls
      ColorControls.tsx      # Color/WB controls
      ToneCurves.tsx         # Curves editor
      DetailControls.tsx     # Sharpening/NR controls
      EffectsControls.tsx    # Vignette/grain controls
      HSLControls.tsx        # HSL color tuning
    
    panels/
      AdjustmentsPanel.tsx   # Adjustments container
      CropPanel.tsx          # Crop controls
      MasksPanel.tsx         # Mask editing
      PresetsPanel.tsx       # Preset browser/editor
      ExportPanel.tsx        # Export settings
      MetadataPanel.tsx      # EXIF/metadata display
      AIPanel.tsx            # AI features
    
    metadata/
      RatingControl.tsx      # Star rating
      ColorLabel.tsx         # Color label picker
      TagEditor.tsx          # Tag management
    
    common/
      LoadingSpinner.tsx
      ErrorMessage.tsx
      ContextMenu.tsx
  
  primitives/                # Base UI components (atoms)
    Button.tsx
    Slider.tsx
    Input.tsx
    Switch.tsx
    Dropdown.tsx
    Tabs.tsx
    Tooltip.tsx
    Modal.tsx
    Popover.tsx
    Resizer.tsx
    ColorWheel.tsx
  
  config/
    layout.config.ts         # Default layout configurations
    shortcuts.config.ts      # Keyboard shortcuts
    themes.config.ts         # Theme definitions
  
  types/
    adjustments.ts           # Adjustment types
    library.ts               # Library types
    editor.ts                # Editor types
    tauri.ts                 # Tauri command types
  
  utils/
    tauri.ts                 # Tauri helpers
    image.ts                 # Image utilities
    color.ts                 # Color utilities
```

---

## Layer Architecture

The architecture follows a strict layering model:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Views Layer                              │
│   (Composes layouts + modules based on configuration)          │
│   ExploreView, EditView, CommunityView                         │
├─────────────────────────────────────────────────────────────────┤
│                       Layouts Layer                             │
│   (Structure and positioning only - no business logic)         │
│   AppShell, SplitLayout, PanelLayout, GridLayout               │
├─────────────────────────────────────────────────────────────────┤
│                       Modules Layer                             │
│   (Content components - connect to blocs for state)            │
│   GalleryGrid, ImagePreview, ExposureControls, etc.            │
├─────────────────────────────────────────────────────────────────┤
│                      Primitives Layer                           │
│   (Pure UI components - no state, just props)                  │
│   Button, Slider, Input, Switch, Modal, etc.                   │
├─────────────────────────────────────────────────────────────────┤
│                       Blocs Layer                               │
│   (All business logic and state management)                    │
│   LibraryBloc, EditorBloc, AdjustmentsBloc, etc.               │
├─────────────────────────────────────────────────────────────────┤
│                      Services Layer                             │
│   (Tauri integration, keyboard, context menu)                  │
│   TauriService, KeyboardService, ContextMenuService            │
└─────────────────────────────────────────────────────────────────┘
```

### Layer Rules

1. **Views** can import: Layouts, Modules, Blocs
2. **Layouts** can import: Other Layouts, Primitives (NO blocs, NO modules)
3. **Modules** can import: Other Modules, Primitives, Blocs
4. **Primitives** can import: Other Primitives only
5. **Blocs** can import: Other Blocs, Services, Types
6. **Services** can import: Other Services, Types

---

## View System

### View Definitions

```typescript
// types/views.ts
export type ViewId = 'explore' | 'edit' | 'community';

export interface ViewDefinition {
  id: ViewId;
  name: string;
  layout: LayoutConfig;
  keyboardContext: string;
}
```

### Explore View (Library/Browser)

Purpose: Browse, filter, sort, tag, and rate images

```typescript
// views/ExploreView/ExploreLayout.config.ts
export const exploreLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'left-sidebar',
      size: 256,
      minSize: 200,
      maxSize: 500,
      collapsible: true,
      modules: ['folder-tree']
    },
    {
      id: 'main-content',
      flex: 1,
      layout: {
        type: 'stack',
        children: [
          {
            id: 'toolbar',
            height: 60,
            modules: ['gallery-controls']
          },
          {
            id: 'gallery',
            flex: 1,
            modules: ['gallery-grid']
          }
        ]
      }
    },
    {
      id: 'right-sidebar',
      size: 320,
      minSize: 280,
      maxSize: 600,
      collapsible: true,
      visible: false, // Optional export panel
      modules: ['library-export-panel']
    }
  ]
};
```

### Edit View (Image Editor)

Purpose: Edit individual images with adjustments, masks, AI features

```typescript
// views/EditView/EditLayout.config.ts
export const editLayout: LayoutConfig = {
  type: 'split',
  direction: 'horizontal',
  panels: [
    {
      id: 'editor-main',
      flex: 1,
      layout: {
        type: 'stack',
        children: [
          {
            id: 'editor-content',
            flex: 1,
            modules: ['image-preview', 'editor-toolbar', 'waveform-overlay']
          },
          {
            id: 'filmstrip',
            height: 144,
            collapsible: true,
            modules: ['filmstrip', 'bottom-bar']
          }
        ]
      }
    },
    {
      id: 'right-panel',
      size: 320,
      minSize: 280,
      maxSize: 600,
      collapsible: true,
      modules: ['panel-switcher', 'active-panel']
    }
  ]
};
```

---

## Module System

### Module Definition

```typescript
// types/modules.ts
export interface ModuleDefinition {
  id: string;
  name: string;
  component: React.ComponentType;
  defaultSize?: { width?: number; height?: number };
  resizable?: boolean;
  closable?: boolean;
  dependencies?: string[];  // Required blocs
}

// Module registry
export const moduleRegistry: Record<string, ModuleDefinition> = {
  'folder-tree': {
    id: 'folder-tree',
    name: 'Folder Tree',
    component: FolderTreeModule,
    resizable: true,
    dependencies: ['FolderBloc', 'LibraryBloc']
  },
  'gallery-grid': {
    id: 'gallery-grid',
    name: 'Gallery',
    component: GalleryGridModule,
    dependencies: ['LibraryBloc', 'ThumbnailBloc', 'SelectionBloc']
  },
  'image-preview': {
    id: 'image-preview',
    name: 'Image Preview',
    component: ImagePreviewModule,
    dependencies: ['EditorBloc', 'PreviewBloc', 'ZoomBloc']
  },
  'exposure-controls': {
    id: 'exposure-controls',
    name: 'Exposure',
    component: ExposureControlsModule,
    dependencies: ['AdjustmentsBloc']
  },
  // ... more modules
};
```

### Module Example: Exposure Controls

```typescript
// modules/adjustments/ExposureControls.tsx
import { useBloc } from '@blac/react';
import { AdjustmentsBloc } from '../../blocs/editor/AdjustmentsBloc';
import { Slider } from '../../primitives/Slider';

export function ExposureControls() {
  const [adjustments, bloc] = useBloc(AdjustmentsBloc);
  
  return (
    <div className="exposure-controls">
      <Slider
        label="Exposure"
        value={adjustments.exposure}
        min={-5}
        max={5}
        step={0.01}
        onChange={bloc.setExposure}
      />
      <Slider
        label="Contrast"
        value={adjustments.contrast}
        min={-100}
        max={100}
        onChange={bloc.setContrast}
      />
      <Slider
        label="Highlights"
        value={adjustments.highlights}
        min={-100}
        max={100}
        onChange={bloc.setHighlights}
      />
      <Slider
        label="Shadows"
        value={adjustments.shadows}
        min={-100}
        max={100}
        onChange={bloc.setShadows}
      />
      <Slider
        label="Whites"
        value={adjustments.whites}
        min={-100}
        max={100}
        onChange={bloc.setWhites}
      />
      <Slider
        label="Blacks"
        value={adjustments.blacks}
        min={-100}
        max={100}
        onChange={bloc.setBlacks}
      />
    </div>
  );
}
```

---

## Layout System

### Layout Types

```typescript
// types/layout.ts
export type LayoutType = 'split' | 'stack' | 'tabs' | 'grid';

export interface BaseLayoutConfig {
  type: LayoutType;
  id?: string;
}

export interface SplitLayoutConfig extends BaseLayoutConfig {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  panels: PanelConfig[];
}

export interface StackLayoutConfig extends BaseLayoutConfig {
  type: 'stack';
  children: (PanelConfig | LayoutConfig)[];
}

export interface TabsLayoutConfig extends BaseLayoutConfig {
  type: 'tabs';
  tabs: TabConfig[];
  activeTab?: string;
}

export interface GridLayoutConfig extends BaseLayoutConfig {
  type: 'grid';
  columns: number;
  gap: number;
  items: GridItemConfig[];
}

export interface PanelConfig {
  id: string;
  size?: number;        // Fixed size in pixels
  flex?: number;        // Flex grow factor
  minSize?: number;
  maxSize?: number;
  collapsible?: boolean;
  visible?: boolean;
  modules?: string[];   // Module IDs to render
  layout?: LayoutConfig; // Nested layout
}

export type LayoutConfig = 
  | SplitLayoutConfig 
  | StackLayoutConfig 
  | TabsLayoutConfig 
  | GridLayoutConfig;
```

### Layout Components

```typescript
// layouts/SplitLayout.tsx
interface SplitLayoutProps {
  config: SplitLayoutConfig;
  children?: React.ReactNode;
  renderPanel: (panelId: string) => React.ReactNode;
}

export function SplitLayout({ config, renderPanel }: SplitLayoutProps) {
  const isVertical = config.direction === 'vertical';
  
  return (
    <div className={`split-layout ${config.direction}`}>
      {config.panels.map((panel, index) => (
        <React.Fragment key={panel.id}>
          {index > 0 && (
            <Resizer
              direction={isVertical ? 'horizontal' : 'vertical'}
              onResize={(delta) => handleResize(panel.id, delta)}
            />
          )}
          <div
            className="split-panel"
            style={{
              [isVertical ? 'height' : 'width']: panel.size,
              flex: panel.flex,
              minWidth: !isVertical ? panel.minSize : undefined,
              maxWidth: !isVertical ? panel.maxSize : undefined,
              minHeight: isVertical ? panel.minSize : undefined,
              maxHeight: isVertical ? panel.maxSize : undefined,
            }}
          >
            {renderPanel(panel.id)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
```

---

## State Management with Blac

### Core Blocs

#### AppBloc - Application-level State

```typescript
// blocs/app/AppBloc.ts
import { Cubit, blac } from '@blac/core';

interface AppState {
  activeView: 'explore' | 'edit' | 'community';
  theme: string;
  isWindowFullScreen: boolean;
}

@blac({ keepAlive: true })
export class AppBloc extends Cubit<AppState> {
  constructor() {
    super({
      activeView: 'explore',
      theme: 'dark',
      isWindowFullScreen: false,
    });
  }

  setActiveView = (view: AppState['activeView']) => {
    this.patch({ activeView: view });
  };

  setTheme = (theme: string) => {
    this.patch({ theme });
  };

  setWindowFullScreen = (isFullScreen: boolean) => {
    this.patch({ isWindowFullScreen: isFullScreen });
  };
}
```

#### LibraryBloc - Image Library State

```typescript
// blocs/library/LibraryBloc.ts
import { Cubit, blac, borrow } from '@blac/core';
import type { ImageFile, SortCriteria, FilterCriteria } from '../../types/library';

interface LibraryState {
  rootPath: string | null;
  currentFolderPath: string | null;
  images: ImageFile[];
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
      isLoading: false,
      error: null,
    });
  }

  loadFolder = async (path: string, isNewRoot = false) => {
    this.patch({ isLoading: true, error: null });
    
    try {
      const tauri = borrow(TauriService);
      const images = await tauri.listImagesInDir(path);
      
      this.patch({
        currentFolderPath: path,
        rootPath: isNewRoot ? path : this.state.rootPath,
        images,
        isLoading: false,
      });
    } catch (error) {
      this.patch({
        error: `Failed to load folder: ${error}`,
        isLoading: false,
      });
    }
  };

  refreshImages = async () => {
    if (!this.state.currentFolderPath) return;
    await this.loadFolder(this.state.currentFolderPath);
  };

  // Computed getters - use borrow() for cross-bloc access (auto-tracked)
  get sortedImages(): ImageFile[] {
    const filter = borrow(FilterBloc);
    const sort = borrow(SortBloc);
    return sortAndFilter(this.state.images, sort.state, filter.state);
  }
}
```

#### AdjustmentsBloc - Image Adjustments

```typescript
// blocs/editor/AdjustmentsBloc.ts
import { Cubit, borrow } from '@blac/core';
import type { Adjustments } from '../../types/adjustments';
import { INITIAL_ADJUSTMENTS } from '../../config/adjustments';
import debounce from 'lodash.debounce';

interface AdjustmentsState extends Adjustments {
  isDirty: boolean;
  isSaving: boolean;
}

export class AdjustmentsBloc extends Cubit<AdjustmentsState> {
  private debouncedApply: ReturnType<typeof debounce>;
  private debouncedSave: ReturnType<typeof debounce>;
  
  constructor() {
    super({
      ...INITIAL_ADJUSTMENTS,
      isDirty: false,
      isSaving: false,
    });
    
    this.debouncedApply = debounce(this.applyToBackend, 50);
    this.debouncedSave = debounce(this.saveToFile, 300);
    
    this.onSystemEvent('stateChanged', () => {
      if (this.state.isDirty) {
        this.debouncedApply();
        this.debouncedSave();
      }
    });
  }

  // Individual setters for each adjustment
  setExposure = (value: number) => this.updateAdjustment('exposure', value);
  setContrast = (value: number) => this.updateAdjustment('contrast', value);
  setHighlights = (value: number) => this.updateAdjustment('highlights', value);
  setShadows = (value: number) => this.updateAdjustment('shadows', value);
  setWhites = (value: number) => this.updateAdjustment('whites', value);
  setBlacks = (value: number) => this.updateAdjustment('blacks', value);
  setBrightness = (value: number) => this.updateAdjustment('brightness', value);
  setSaturation = (value: number) => this.updateAdjustment('saturation', value);
  setTemperature = (value: number) => this.updateAdjustment('temperature', value);
  setTint = (value: number) => this.updateAdjustment('tint', value);
  setVibrance = (value: number) => this.updateAdjustment('vibrance', value);
  setClarity = (value: number) => this.updateAdjustment('clarity', value);
  setDehaze = (value: number) => this.updateAdjustment('dehaze', value);
  setSharpness = (value: number) => this.updateAdjustment('sharpness', value);
  
  private updateAdjustment = <K extends keyof Adjustments>(key: K, value: Adjustments[K]) => {
    // Record history before update - use borrow() for cross-bloc access
    borrow(HistoryBloc).recordState(this.state);
    
    this.patch({ [key]: value, isDirty: true } as Partial<AdjustmentsState>);
  };

  private applyToBackend = async () => {
    try {
      const tauri = borrow(TauriService);
      await tauri.applyAdjustments(this.state);
    } catch (error) {
      console.error('Failed to apply adjustments:', error);
    }
  };

  private saveToFile = async () => {
    const editor = borrow(EditorBloc);
    if (!editor.state.selectedImagePath) return;
    
    this.patch({ isSaving: true });
    try {
      const tauri = borrow(TauriService);
      await tauri.saveMetadata(editor.state.selectedImagePath, this.state);
    } catch (error) {
      console.error('Failed to save:', error);
    } finally {
      this.patch({ isSaving: false, isDirty: false });
    }
  };

  loadFromImage = (adjustments: Partial<Adjustments>) => {
    this.emit({
      ...INITIAL_ADJUSTMENTS,
      ...adjustments,
      isDirty: false,
      isSaving: false,
    });
  };

  resetAll = () => {
    borrow(HistoryBloc).recordState(this.state);
    this.emit({
      ...INITIAL_ADJUSTMENTS,
      rating: this.state.rating, // Preserve rating
      isDirty: true,
      isSaving: false,
    });
  };
}
```

#### HistoryBloc - Undo/Redo

```typescript
// blocs/editor/HistoryBloc.ts
import { Cubit, borrow } from '@blac/core';
import type { Adjustments } from '../../types/adjustments';

interface HistoryState {
  past: Adjustments[];
  future: Adjustments[];
  maxHistory: number;
}

export class HistoryBloc extends Cubit<HistoryState> {
  constructor() {
    super({
      past: [],
      future: [],
      maxHistory: 50,
    });
  }

  get canUndo(): boolean {
    return this.state.past.length > 0;
  }

  get canRedo(): boolean {
    return this.state.future.length > 0;
  }

  recordState = (state: Adjustments) => {
    this.update(current => ({
      ...current,
      past: [...current.past.slice(-current.maxHistory), state],
      future: [], // Clear future on new action
    }));
  };

  undo = () => {
    if (!this.canUndo) return;
    
    const adjustments = borrow(AdjustmentsBloc);
    const currentState = { ...adjustments.state };
    const previousState = this.state.past[this.state.past.length - 1];
    
    this.update(current => ({
      ...current,
      past: current.past.slice(0, -1),
      future: [currentState, ...current.future],
    }));
    
    adjustments.loadFromImage(previousState);
  };

  redo = () => {
    if (!this.canRedo) return;
    
    const adjustments = borrow(AdjustmentsBloc);
    const currentState = { ...adjustments.state };
    const nextState = this.state.future[0];
    
    this.update(current => ({
      ...current,
      past: [...current.past, currentState],
      future: current.future.slice(1),
    }));
    
    adjustments.loadFromImage(nextState);
  };

  clear = () => {
    this.emit({ past: [], future: [], maxHistory: 50 });
  };
}
```

### TauriService - Stateless Service

```typescript
// blocs/services/TauriService.ts
import { StatelessCubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import type { ImageFile, Adjustments, AppSettings } from '../../types';

@blac({ keepAlive: true })
export class TauriService extends StatelessCubit {
  private listeners: UnlistenFn[] = [];

  // Image Operations
  loadImage = (path: string) => invoke<LoadImageResult>('load_image', { path });
  
  applyAdjustments = (adjustments: Adjustments) => 
    invoke('apply_adjustments', { jsAdjustments: adjustments });
  
  generateFullscreenPreview = (adjustments: Adjustments) =>
    invoke<Uint8Array>('generate_fullscreen_preview', { jsAdjustments: adjustments });

  // File Operations
  listImagesInDir = (path: string) => 
    invoke<ImageFile[]>('list_images_in_dir', { path });
  
  listImagesRecursive = (path: string) =>
    invoke<ImageFile[]>('list_images_recursive', { path });
  
  copyFiles = (sourcePaths: string[], destinationFolder: string) =>
    invoke('copy_files', { sourcePaths, destinationFolder });
  
  moveFiles = (sourcePaths: string[], destinationFolder: string) =>
    invoke('move_files', { sourcePaths, destinationFolder });
  
  deleteFiles = (paths: string[]) =>
    invoke('delete_files_from_disk', { paths });

  // Metadata
  loadMetadata = (path: string) =>
    invoke<Metadata>('load_metadata', { path });
  
  saveMetadata = (path: string, adjustments: Adjustments) =>
    invoke('save_metadata_and_update_thumbnail', { path, adjustments });

  // Settings
  loadSettings = () => invoke<AppSettings>('load_settings');
  saveSettings = (settings: AppSettings) => invoke('save_settings', { settings });

  // Event Subscriptions
  onPreviewUpdate = (callback: (data: Uint8Array) => void) =>
    this.addListener('preview-update-final', callback);
  
  onHistogramUpdate = (callback: (data: HistogramData) => void) =>
    this.addListener('histogram-update', callback);
  
  onThumbnailGenerated = (callback: (data: ThumbnailEvent) => void) =>
    this.addListener('thumbnail-generated', callback);

  private addListener = async <T>(event: string, callback: (data: T) => void) => {
    const unlisten = await listen<T>(event, (e) => callback(e.payload));
    this.listeners.push(unlisten);
    return unlisten;
  };

  cleanup = () => {
    this.listeners.forEach(unlisten => unlisten());
    this.listeners = [];
  };
}
```

---

## Tauri Integration

### Event Subscription Pattern

```typescript
// App.tsx - Minimal shell
import { useEffect } from 'react';
import { useBlocActions } from '@blac/react';
import { TauriService } from './blocs/services/TauriService';
import { PreviewBloc } from './blocs/editor/PreviewBloc';
import { ThumbnailBloc } from './blocs/library/ThumbnailBloc';

function App() {
  const tauri = useBlocActions(TauriService);
  const preview = useBlocActions(PreviewBloc);
  const thumbnails = useBlocActions(ThumbnailBloc);
  
  useEffect(() => {
    // Set up Tauri event listeners
    tauri.onPreviewUpdate((data) => {
      preview.setPreviewData(data);
    });
    
    tauri.onThumbnailGenerated(({ path, data, rating }) => {
      thumbnails.updateThumbnail(path, data, rating);
    });
    
    tauri.onHistogramUpdate((data) => {
      preview.setHistogram(data);
    });
    
    return () => tauri.cleanup();
  }, []);
  
  return <AppShell />;
}
```

---

## Implementation Plan

This is a full rewrite starting from an empty `src/` directory. The legacy code at `src_legacy_deprecated_reference/` serves only as reference.

### Phase 1: Foundation

**Goal**: Get the app shell running with basic navigation

1. **Entry Point & App Shell**
   - `src/main.tsx` - React entry point with Blac provider
   - `src/App.tsx` - Minimal shell with Tauri event setup
   - `src/styles.css` - Global styles and Tailwind setup

2. **Core Blocs**
   - `AppBloc` - View navigation, theme, window state
   - `SettingsBloc` - Persistent user settings
   - `TauriService` - All Tauri invoke wrappers

3. **Layout System**
   - `LayoutRenderer` - Recursive layout component
   - `SplitLayout`, `StackLayout` - Basic layout primitives
   - `Resizer` primitive for panel resizing

4. **Type Definitions**
   - `types/adjustments.ts` - Adjustment types (copy from legacy)
   - `types/library.ts` - ImageFile, filters, sorting
   - `types/layout.ts` - Layout configuration types

### Phase 2: Library View (Explore)

**Goal**: Browse folders and view image thumbnails

1. **Library Blocs**
   - `LibraryBloc` - Image list, folder state
   - `FolderBloc` - Folder tree navigation
   - `SelectionBloc` - Multi-select state
   - `ThumbnailBloc` - Thumbnail cache
   - `FilterBloc`, `SortBloc`, `SearchBloc`

2. **Library Modules**
   - `WelcomeScreen` - Home/splash screen
   - `FolderTree` - Folder navigation
   - `GalleryGrid` - Virtualized image grid
   - `GalleryControls` - Search, filter, sort
   - `ImageCard` - Single thumbnail

3. **Primitives (as needed)**
   - `Button`, `Input`, `Dropdown`
   - `Slider` (for thumbnail size)

### Phase 3: Editor View (Edit)

**Goal**: Open and edit images with adjustments

1. **Editor Blocs**
   - `EditorBloc` - Selected image state
   - `AdjustmentsBloc` - All adjustments
   - `HistoryBloc` - Undo/redo
   - `PreviewBloc` - Preview URLs, histogram
   - `ZoomBloc` - Zoom/pan state

2. **Editor Modules**
   - `ImagePreview` - Main canvas with layers
   - `EditorToolbar` - Actions, show original, undo/redo
   - `ZoomControls` - Zoom slider
   - `Filmstrip` - Horizontal thumbnail strip

3. **Adjustment Modules**
   - `ExposureControls` - Basic tone controls
   - `ColorControls` - WB, saturation, vibrance
   - `ToneCurves` - Curves editor
   - `DetailControls` - Sharpening, NR
   - `EffectsControls` - Vignette, grain, dehaze

4. **Panel Modules**
   - `AdjustmentsPanel` - Container with collapsible sections
   - `PanelSwitcher` - Tab navigation

### Phase 4: Advanced Features

**Goal**: Crop, masks, presets, export, AI

1. **Panel Blocs**
   - `CropBloc` - Crop, rotate, straighten
   - `MasksBloc` - Mask editing state
   - `PresetsBloc` - Preset management
   - `ExportBloc` - Export settings, progress
   - `AIBloc` - AI features state

2. **Panel Modules**
   - `CropPanel` - Crop controls
   - `MasksPanel` - Mask editing UI
   - `PresetsPanel` - Preset browser
   - `ExportPanel` - Export settings
   - `MetadataPanel` - EXIF display
   - `AIPanel` - AI tools

3. **Modal System**
   - `ModalBloc` - Modal visibility registry
   - `Modal` primitive
   - Individual modal components

### Phase 5: Polish

**Goal**: Feature parity, performance, testing

1. **Remaining Features**
   - Community presets view
   - Fullscreen viewer
   - Keyboard shortcuts
   - Context menus
   - All modals

2. **Performance**
   - Virtualization optimization
   - Lazy loading
   - Memory management for previews

3. **Testing & QA**
   - Bloc unit tests
   - Integration testing
   - Bug fixes

---

## Key Benefits

1. **Maintainability**: Clear separation of concerns makes code easier to understand and modify
2. **Testability**: Blocs can be tested independently of React components
3. **Performance**: Blac's proxy-based tracking ensures minimal re-renders
4. **Flexibility**: Layout configuration allows easy UI customization
5. **Scalability**: Modular structure supports adding new features easily
6. **Developer Experience**: Centralized state makes debugging easier
