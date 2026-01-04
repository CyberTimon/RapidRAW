# RapidRAW Rewrite Progress Checklist

## Phase 1: Foundation
**Goal**: Get the app shell running with basic navigation

### 1.1 Entry Point & App Shell
| Task | Status | Parallelizable |
|------|--------|----------------|
| `src/main.tsx` - React entry point with Blac provider | [x] Done | - |
| `src/App.tsx` - Minimal shell with view switching | [x] Done | - |
| `src/styles.css` - Global styles and Tailwind setup | [x] Done | - |

### 1.2 Core Blocs
| Task | Status | Parallelizable |
|------|--------|----------------|
| `AppBloc` - View navigation, theme, window state | [x] Done | Agent A |
| `SettingsBloc` - Persistent user settings | [x] Done | Agent B |
| `TauriService` - All Tauri invoke wrappers | [x] Done | Agent C |
| `UIBloc` - UI visibility state (panels, sidebars) | [x] Done | Agent B |

### 1.3 Layout System
| Task | Status | Parallelizable |
|------|--------|----------------|
| `types/layout.ts` - Layout configuration types | [x] Done | Agent A |
| `LayoutRenderer` - Recursive layout component | [x] Done | Agent B |
| `SplitLayout` - Resizable split panes | [x] Done | Agent A |
| `StackLayout` - Vertical/horizontal stack | [x] Done | Agent A |
| `Resizer` primitive for panel resizing | [x] Done | Agent C |
| `config/layouts/explore.ts` - Explore view layout config | [x] Done | - |
| `config/layouts/edit.ts` - Edit view layout config | [x] Done | - |

### 1.4 Type Definitions
| Task | Status | Parallelizable |
|------|--------|----------------|
| `types/adjustments.ts` - Adjustment types | [x] Done | Agent A |
| `types/library.ts` - ImageFile, filters, sorting | [x] Done | Agent B |
| `types/editor.ts` - Editor types | [x] Done | Agent C |

### 1.5 Views (with Layout)
| Task | Status | Parallelizable |
|------|--------|----------------|
| `ExploreView` - Using LayoutRenderer | [x] Done | - |
| `EditView` - Using LayoutRenderer | [x] Done | - |
| `CommunityView` - Placeholder component | [x] Done | - |

---

## Phase 2: Library View (Explore)
**Goal**: Browse folders and view image thumbnails

### 2.1 Library Blocs
| Task | Status | Parallelizable |
|------|--------|----------------|
| `LibraryBloc` - Image list, folder state | [x] Done | Agent A |
| `FolderBloc` - Folder tree navigation | [x] Done | Agent B |
| `SelectionBloc` - Multi-select state | [x] Done | Agent C |
| `ThumbnailBloc` - Thumbnail cache | [x] Done | Agent A |
| `FilterBloc` - Filter criteria | [x] Done | Agent B |
| `SortBloc` - Sort criteria | [x] Done | Agent B |
| `SearchBloc` - Search/indexing state | [x] Done | Agent C |
| `RatingsBloc` - Image ratings cache | [x] Done | Agent C |

### 2.2 Library Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `WelcomeScreen` - Home/splash screen | [x] Done | Agent A |
| `FolderTree` - Folder navigation | [x] Done | Agent B |
| `GalleryGrid` - Virtualized image grid | [x] Done | Agent C |
| `GalleryControls` - Search, filter, sort | [x] Done | Agent A |
| `ImageCard` - Single thumbnail | [x] Done | Agent B |
| `Filmstrip` - Horizontal thumbnail strip | [x] Done | Agent C |

### 2.3 Primitives (as needed)
| Task | Status | Parallelizable |
|------|--------|----------------|
| `Button` primitive | [x] Done | Agent A |
| `Input` primitive | [x] Done | Agent B |
| `Dropdown` primitive | [x] Done | Agent C |
| `Slider` primitive (for thumbnail size) | [x] Done | Agent A |

---

## Phase 3: Editor View (Edit)
**Goal**: Open and edit images with adjustments

### 3.1 Editor Blocs
| Task | Status | Parallelizable |
|------|--------|----------------|
| `EditorBloc` - Selected image state | [x] Done | Agent A |
| `AdjustmentsBloc` - All adjustments | [x] Done | Agent B |
| `HistoryBloc` - Undo/redo | [x] Done | Agent C |
| `PreviewBloc` - Preview URLs, histogram | [x] Done | Agent A |
| `ZoomBloc` - Zoom/pan state | [x] Done | Agent B |
| `FullscreenBloc` - Fullscreen mode state | [x] Done | Agent C |

### 3.2 Editor Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `ImagePreview` - Main canvas with layers | [x] Done | Agent A |
| `EditorToolbar` - Actions, show original, undo/redo | [x] Done | Agent B |
| `ZoomControls` - Zoom slider | [x] Done | Agent C |
| `Filmstrip` integration for editor | [x] Done | Agent A |
| `ImageHistogram` - Histogram display | [x] Done | Agent B |
| `ImageWaveform` - Waveform display | [x] Done | Agent C |

### 3.3 Adjustment Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `ExposureControls` - Basic tone controls | [x] Done | Agent A |
| `ColorControls` - WB, saturation, vibrance | [x] Done | Agent B |
| `ToneCurves` - Curves editor | [x] Done | Agent C |
| `DetailControls` - Sharpening, NR | [x] Done | Agent A |
| `EffectsControls` - Vignette, grain, dehaze | [x] Done | Agent B |
| `HSLControls` - HSL color tuning | [x] Done | Agent C |
| `LensCorrections` - Distortion, chromatic aberration | [x] Done | Agent A |

### 3.4 Panel Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `AdjustmentsPanel` - Container with collapsible sections | [x] Done | Agent A |
| `PanelSwitcher` - Tab navigation | [x] Done | Agent B |
| `PanelBloc` - Active panel state | [x] Done | Agent C |

---

## Phase 4: Advanced Features
**Goal**: Crop, masks, presets, export, AI

### 4.1 Panel Blocs
| Task | Status | Parallelizable |
|------|--------|----------------|
| `CropBloc` - Crop, rotate, straighten | [x] Done | Agent A |
| `MasksBloc` - Mask editing state | [x] Done | Agent B |
| `PresetsBloc` - Preset management | [x] Done | Agent C |
| `ExportBloc` - Export settings, progress | [x] Done | Agent A |
| `AIBloc` - AI features state | [x] Done | Agent B |
| `MetadataBloc` - EXIF/metadata display | [x] Done | Agent C |

### 4.2 Panel Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `CropPanel` - Crop controls | [x] Done | Agent A |
| `MasksPanel` - Mask editing UI | [x] Done | Agent B |
| `PresetsPanel` - Preset browser | [x] Done | Agent C |
| `ExportPanel` - Export settings | [x] Done | Agent A |
| `MetadataPanel` - EXIF display | [x] Done | Agent B |
| `AIPanel` - AI tools | [x] Done | Agent C |

### 4.3 Modal System
| Task | Status | Parallelizable |
|------|--------|----------------|
| `ModalBloc` - Modal visibility registry | [ ] TODO | Agent A |
| `Modal` primitive | [ ] TODO | Agent B |
| Individual modal components | [ ] TODO | Agent C |

### 4.4 Metadata Modules
| Task | Status | Parallelizable |
|------|--------|----------------|
| `RatingControl` - Star rating widget | [ ] TODO | Agent A |
| `ColorLabel` - Color label picker | [ ] TODO | Agent B |
| `TagEditor` - Tag management | [ ] TODO | Agent C |

---

## Phase 5: Polish
**Goal**: Feature parity, performance, testing

### 5.1 Remaining Features
| Task | Status | Parallelizable |
|------|--------|----------------|
| Community presets view (full implementation) | [ ] TODO | Agent A |
| Fullscreen viewer | [ ] TODO | Agent B |
| Keyboard shortcuts system | [ ] TODO | Agent C |
| Context menus | [ ] TODO | Agent A |
| All modals | [ ] TODO | Agent B |

### 5.2 Services
| Task | Status | Parallelizable |
|------|--------|----------------|
| `KeyboardService` - Keyboard shortcuts | [ ] TODO | Agent A |
| `ContextMenuService` - Context menu state | [ ] TODO | Agent B |
| `ClipboardService` - Copy/paste state | [ ] TODO | Agent C |

### 5.3 Performance
| Task | Status | Parallelizable |
|------|--------|----------------|
| Virtualization optimization | [ ] TODO | Agent A |
| Lazy loading for modules | [ ] TODO | Agent B |
| Memory management for previews | [ ] TODO | Agent C |

### 5.4 Testing & QA
| Task | Status | Parallelizable |
|------|--------|----------------|
| Bloc unit tests | [ ] TODO | Agent A |
| Integration testing | [ ] TODO | Agent B |
| Bug fixes | [ ] TODO | All |

---

## Module Registry (for tracking)
| Module ID | Component | Status |
|-----------|-----------|--------|
| `gallery-grid` | GalleryGrid | [x] Done |
| `gallery-controls` | GalleryControls | [x] Done |
| `folder-tree` | FolderTree | [x] Done |
| `filmstrip` | Filmstrip | [x] Done |
| `welcome-screen` | WelcomeScreen | [x] Done |
| `image-preview` | ImagePreview | [x] Done |
| `image-histogram` | ImageHistogram | [x] Done |
| `image-waveform` | ImageWaveform | [x] Done |
| `editor-toolbar` | EditorToolbar | [x] Done |
| `zoom-controls` | ZoomControls | [x] Done |
| `exposure-controls` | ExposureControls | [x] Done |
| `color-controls` | ColorControls | [x] Done |
| `tone-curves` | ToneCurves | [x] Done |
| `detail-controls` | DetailControls | [x] Done |
| `effects-controls` | EffectsControls | [x] Done |
| `hsl-controls` | HSLControls | [x] Done |
| `lens-corrections` | LensCorrections | [x] Done |
| `adjustments-panel` | AdjustmentsPanel | [x] Done |
| `crop-panel` | CropPanel | [x] Done |
| `masks-panel` | MasksPanel | [x] Done |
| `presets-panel` | PresetsPanel | [x] Done |
| `export-panel` | ExportPanel | [x] Done |
| `metadata-panel` | MetadataPanel | [x] Done |
| `ai-panel` | AIPanel | [x] Done |
| `panel-switcher` | PanelSwitcher | [x] Done |
| `rating-control` | RatingControl | [ ] TODO |
| `color-label` | ColorLabel | [ ] TODO |
| `tag-editor` | TagEditor | [ ] TODO |
| `context-menu` | ContextMenu | [ ] TODO |
| `loading-spinner` | LoadingSpinner | [x] Done |
| `error-message` | ErrorMessage | [ ] TODO |

---

## Summary Statistics

| Phase | Total Tasks | Completed | Remaining |
|-------|-------------|-----------|-----------|
| Phase 1: Foundation | 19 | 19 | 0 |
| Phase 2: Library View | 18 | 18 | 0 |
| Phase 3: Editor View | 21 | 21 | 0 |
| Phase 4: Advanced Features | 16 | 12 | 4 |
| Phase 5: Polish | 13 | 0 | 13 |
| **TOTAL** | **87** | **70** | **17** |

**Progress: ~80% complete**

---

## Session Log

| Date | Summary |
|------|---------|
| (Initial) | Phase 1 foundation started: main.tsx, App.tsx, styles.css, AppBloc, and placeholder views created |
| Session 2 | Phase 1 completed: Added all type definitions (layout, adjustments, library, editor), core blocs (SettingsBloc, UIBloc, TauriService), full layout system (Resizer, SplitLayout, StackLayout, LayoutRenderer), and layout configs. Views updated to use LayoutRenderer. |
| Session 3 | Phase 2 library blocs completed: LibraryBloc, FolderBloc, SelectionBloc, ThumbnailBloc, FilterBloc, SortBloc, RatingsBloc. All primitives done: Button, Input, Dropdown, Slider. Library modules: WelcomeScreen, GalleryControls, LoadingSpinner. |
| Session 4 | Phase 2 nearly complete: Added remaining library modules (FolderTree, ImageCard, GalleryGrid, Filmstrip). Created module registry with lazy loading. Wired up ExploreView with conditional WelcomeScreen and moduleRenderer. Only SearchBloc remains for Phase 2. |
| Session 5 | Phase 2 complete + Phase 3 blocs done: Created SearchBloc (completing Phase 2). Added all Phase 3 editor blocs: EditorBloc, AdjustmentsBloc, HistoryBloc, PreviewBloc, ZoomBloc, FullscreenBloc. Added editor modules: ImagePreview, EditorToolbar, ZoomControls, ImageHistogram. Updated module registry. ~55% complete. |
| Session 6 | Phase 3 nearly complete: Added all adjustment modules (ExposureControls, ColorControls, DetailControls, EffectsControls, HSLControls, ToneCurves with full Bezier interpolation and performance-optimized RAF updates, LensCorrections). Added CollapsibleSection primitive. Created AdjustmentsPanel container, PanelBloc, and PanelSwitcher with tab navigation. Only ImageWaveform remains for Phase 3. ~66% complete. |
| Session 7 | Phase 3 complete + Phase 4 started: Added ImageWaveform with canvas-based rendering for RGB/Luma/individual channel display modes. Updated WaveformData type to support separate channel arrays. Created MetadataBloc, MetadataPanel (with GPS map, collapsible sections), ExportBloc (with full export settings state), and ExportPanel (with format selection, resize, metadata, color space options). Updated PanelSwitcher to route to new panels. ~71% complete. |
| Session 8 | Phase 4 mostly complete: Added CropBloc (aspect ratios, rotation, flip, straighten), CropPanel (grid presets, custom ratio, rotation slider, transform tools). Created MasksBloc (mask containers, sub-masks, brush settings), MasksPanel (creation grid, editing view, adjustments per mask). Added PresetsBloc (folders, presets, import/export), PresetsPanel (folder tree, apply presets). Created AIBloc (patches, ComfyUI status, generative fill), AIPanel (tool grid, brush settings, prompt input). Updated registry and PanelSwitcher to enable all panel tabs. ~80% complete. |

---

## Next Session Prompt

Copy and paste this prompt to continue work in the next session:

```
Continue work on the RapidRAW React frontend rewrite. Read the plan at @rewrite-react-plan/PROGRESS.md for current status.

**Current State (Session 8 completed):**
- Phase 1, 2 & 3: 100% complete
- Phase 4: 75% complete (12/16 tasks)
- Overall: ~80% complete (70/87 tasks)

**Completed this session:**
- CropBloc with aspect ratio presets, rotation (-45 to 45), orientation steps, flip H/V, straighten mode
- CropPanel with preset grid (Free, Original, 1:1, 5:4, 4:3, 3:2, 16:9, 21:9, 65:24), custom ratio inputs, rotation slider, transform tools (rotate left/right, flip H/V, straighten)
- MasksBloc with mask containers, sub-masks (brush, gradient, radial, luminosity, color, AI), brush settings, AI mask generation status
- MasksPanel with mask creation grid, mask list, editing view with sub-mask settings, per-mask adjustments (exposure, color, effects)
- PresetsBloc with folder/preset tree, add/rename/delete/duplicate, sort alphabetically, preview URLs
- PresetsPanel with folder tree, preset items with thumbnails, inline add preset/folder forms, community navigation
- AIBloc with AI patches, ComfyUI connection status, generative fill prompt/loading state
- AIPanel with connection status indicator, tool grid (Quick Erase, AI Select, Radial), brush settings, generative fill prompt input
- Updated module registry with all new panels
- Updated PanelSwitcher to route all panel tabs (all marked implemented: true)

**Key files to reference:**
- Module registry: `src/modules/registry.tsx`
- Panel modules: `src/modules/panels/*.tsx`
- Editor blocs: `src/blocs/editor/*.ts`
- Legacy reference: `src_legacy_deprecated_reference/` (DO NOT import, only reference)

**Next tasks (Phase 4 remaining):**
1. Modal system (ModalBloc + Modal primitive)
2. Metadata widgets: RatingControl, ColorLabel, TagEditor

**Phase 5 tasks (Polish):**
1. Community presets view (full implementation)
2. Fullscreen viewer
3. Keyboard shortcuts system (KeyboardService)
4. Context menus (ContextMenuService)
5. ClipboardService
6. Performance optimizations
7. Bloc unit tests

**Technical preferences established:**
- No animations - focus on functionality and performance
- HSL uses color swatches (not dropdown)
- Curves editor has full Bezier interpolation with RAF for non-blocking updates
- Use `useBloc` hook from @blac/react for state access
- All modules lazy-loaded via registry
- CollapsibleSection uses `defaultOpen` prop (not `defaultExpanded`)

**IMPORTANT:** When you finish your session, update this `## Next Session Prompt` section with current progress, completed items, and next tasks so the next session can start quickly.
```
