# RapidRAW Styling Update Progress Checklist

## Phase 0: Layout Structure
**Goal**: Match legacy view layouts exactly

### 0.1 Layout Configuration
| Task | Status | Notes |
|------|--------|-------|
| Update explore.ts with legacy pixel values | [x] Done | Left: 256px (200-500), Right: 320px (280-600), Bottom: 40px |
| Update edit.ts with legacy pixel values | [x] Done | Filmstrip: 144px (100-400), Right panel: 368px (320 content + 48 tabs) |
| Create community.ts layout config | [x] Done | Same left sidebar, no right panel, bottom bar |
| Add BottomBar module | [x] Done | Fixed type errors, added to registry |
| Add LibraryExportPanel module | [x] Done | Export panel for library view |

### 0.2 View Layout Structure
| View | Left Panel | Center | Right Panel | Bottom | Status |
|------|------------|--------|-------------|--------|--------|
| Welcome | Hidden | WelcomeScreen | Hidden | Hidden | [x] Done |
| Explore | FolderTree (256px) | GalleryControls + GalleryGrid | LibraryExport (320px, hidden) | BottomBar (40px) | [x] Done |
| Edit | FolderTree (256px) | ImagePreview + Filmstrip (144px) | PanelSwitcher (368px) | BottomBar (40px) | [x] Done |
| Community | FolderTree (256px) | CommunityBrowser | Hidden | BottomBar (40px) | [x] Done |

### 0.3 Legacy Panel Sizes Reference
```
Left Panel (FolderTree):
  - Default: 256px
  - Min: 200px, Max: 500px
  - Collapsed: 32px

Right Panel (Adjustments/Export):
  - Default: 320px
  - Min: 280px, Max: 600px

Bottom Panel (Filmstrip):
  - Default: 144px
  - Min: 100px, Max: 400px

Bottom Toolbar:
  - Fixed: 40px
```

---

## Phase 1: Global Styles
**Goal**: Fix CSS foundation to match legacy theming system

### 1.1 CSS Variables & Base Styles
| Task | Status | Notes |
|------|--------|-------|
| Fix CSS variables to RGB triplet format | [x] Done | Changed from hex to `R G B` format |
| Update font-family to Poppins | [x] Done | Was Inter, now Poppins |
| Add slider track/thumb CSS classes | [x] Done | `.slider-input` styles |
| Add text-shadow-shiny utility | [x] Done | `text-shadow: 0 0 18px rgba(255, 255, 255, 0.35)` |
| Match scrollbar styling | [x] Done | 10px width, text-secondary thumb |

---

## Phase 2: Primitives
**Goal**: Update base UI components to match legacy design

### 2.1 Core Primitives
| Task | Status | Notes |
|------|--------|-------|
| `Button` - Remove transitions, add shadow-shiny | [x] Done | Variants: primary, surface, ghost, destructive |
| `Slider` - Match legacy native range input | [x] Done | Click-to-edit, shift+scroll, hover-to-reset label |
| `Input` - Simplify to match legacy | [x] Done | Simple input with error state |
| `Dropdown` - Remove Framer Motion | [x] Done | Static dropdown with backdrop blur |
| `CollapsibleSection` - Add visibility toggle | [x] Done | Supports controlled/uncontrolled modes |
| `Modal` - Match legacy backdrop styling | [x] Done | `bg-black/30 backdrop-blur-sm` |
| `Switch` - Create new component | [x] Done | No animations, position-based toggle |

---

## Phase 3: Adjustment Controls
**Goal**: Ensure adjustment modules match legacy styling

### 3.1 Adjustment Modules
| Task | Status | Notes |
|------|--------|-------|
| `ExposureControls` vs `Basic.tsx` | [x] Done | ToneMapperSwitch styled, no animations |
| `ColorControls` vs `Color.tsx` | [x] Done | White Balance + Presence sections match |
| `ToneCurves` vs `Curves.tsx` | [x] Done | Channel buttons, grid overlay |
| `DetailControls` vs `Details.tsx` | [x] Done | Sharpening, Noise Reduction |
| `EffectsControls` vs `Effects.tsx` | [x] Done | Vignette, Grain, Dehaze |
| `HSLControls` - Review styling | [x] Done | Color swatches, per-color sliders |
| `LensCorrections` - Review styling | [x] Done | Distortion, CA correction |

---

## Phase 4: Panel Modules
**Goal**: Match panel layouts and tab styling

### 4.1 Panel Structure
| Task | Status | Notes |
|------|--------|-------|
| `AdjustmentsPanel` vs `ControlsPanel.tsx` | [x] Done | CollapsibleSection layout |
| `PanelSwitcher` vs `RightPanelSwitcher.tsx` | [x] Done | Fixed to vertical layout, tabs on right |
| `CropPanel` vs `CropPanel.tsx` | [x] Done | Aspect ratio buttons, rotation |
| `MasksPanel` vs `MasksPanel.tsx` | [x] Done | Mask layer list |
| `PresetsPanel` vs `PresetsPanel.tsx` | [x] Done | Preset grid/list |
| `ExportPanel` vs `ExportPanel.tsx` | [x] Done | Format buttons, quality slider |
| `MetadataPanel` vs `MetadataPanel.tsx` | [x] Done | EXIF grid, GPS map |
| `AIPanel` vs `AIPanel.tsx` | [x] Done | Tool buttons, prompt input |

---

## Phase 5: Library Modules
**Goal**: Match explore view component styling

### 5.1 Library Components
| Task | Status | Notes |
|------|--------|-------|
| `FolderTree` vs `FolderTree.tsx` | [x] Done | Simplified, no Framer Motion |
| `GalleryGrid` vs `MainLibrary.tsx` | [x] Done | Virtualized grid, selection rings |
| `GalleryControls` vs header in `MainLibrary.tsx` | [x] Done | Search, filter, sort buttons |
| `Filmstrip` vs `Filmstrip.tsx` | [x] Done | Horizontal scroll, selection |
| `ImageCard` - Review styling | [x] Done | Aspect ratio, hover state |
| `WelcomeScreen` - Review styling | [x] Done | Splash image, open folder |

---

## Phase 6: Editor Modules
**Goal**: Match edit view component styling

### 6.1 Editor Components
| Task | Status | Notes |
|------|--------|-------|
| `ImagePreview` vs `Editor.tsx` | [x] Done | Canvas container, loading overlay |
| `EditorToolbar` vs `EditorToolbar.tsx` | [x] Done | Tool buttons, undo/redo |
| `FullscreenViewer` vs `FullScreenViewer.tsx` | [x] Done | Backdrop, navigation |
| `ImageHistogram` - Review styling | [x] Done | Canvas rendering |
| `ImageWaveform` vs `Waveform.tsx` | [x] Done | Channel display modes |
| `ZoomControls` - Review styling | [x] Done | Zoom slider, fit/fill buttons |

---

## Phase 7: Modals
**Goal**: Ensure modal consistency

### 7.1 Modal Components
| Task | Status | Notes |
|------|--------|-------|
| `AboutModal` - Review layout | [x] Done | Logo, version, links |
| `ExportProgressModal` - Review styling | [x] Done | Progress bar, cancel button |
| `KeyboardShortcutsModal` - Review layout | [x] Done | Shortcut categories, keys |

---

## Summary Statistics

| Phase | Total Tasks | Completed | Remaining |
|-------|-------------|-----------|-----------|
| Phase 0: Layouts | 9 | 9 | 0 |
| Phase 1: Global Styles | 5 | 5 | 0 |
| Phase 2: Primitives | 7 | 7 | 0 |
| Phase 3: Adjustments | 7 | 7 | 0 |
| Phase 4: Panels | 8 | 8 | 0 |
| Phase 5: Library | 6 | 6 | 0 |
| Phase 6: Editor | 6 | 6 | 0 |
| Phase 7: Modals | 3 | 3 | 0 |
| **TOTAL** | **51** | **51** | **0** |

**Progress: 100% complete**

---

## Session Log

| Date | Summary |
|------|---------|
| Session 1 | Phase 1 & 2 completed: Updated styles.css with proper CSS variables (RGB triplets), Poppins font, slider styles, scrollbar styles. Updated all primitives: Button (removed transitions, added shadow-shiny), Slider (native range input with legacy features), Input (simplified), Dropdown (no Framer Motion), CollapsibleSection (controlled/uncontrolled, visibility toggle), Modal (legacy backdrop). Created new Switch component. Added Phase 0 (Layouts): Updated explore.ts, edit.ts with legacy pixel values, created community.ts. |
| Session 2 | Completed Phases 0, 3-7: Fixed BottomBar.tsx type errors (activePath, selectedPaths.length, scale, toggleBottomPanel, zoomToFit), added bottom-bar to module registry, fixed PanelSwitcher to vertical layout with tabs on right (matching legacy RightPanelSwitcher), updated edit.ts layout to use single panel-switcher module (368px = 320px content + 48px tabs). Reviewed all adjustment controls, panel modules, library modules, editor modules, and modals - styling matches legacy patterns. Created LibraryExportPanel module with file format selection, quality slider, resize options, metadata controls, and export status display. |

---

## Next Session Prompt

The RapidRAW styling update is **100% complete**!

All 51 tasks across all phases have been completed:
- Phase 0: Layouts - All layout configs and modules created
- Phase 1: Global Styles - CSS variables, fonts, utilities
- Phase 2: Primitives - All UI components updated
- Phase 3-7: All adjustment, panel, library, editor, and modal modules reviewed

**Key files created/modified:**
- `src/styles.css` - CSS variables (RGB format), Poppins font, slider styles
- `src/primitives/*.tsx` - Button, Slider, Input, Dropdown, CollapsibleSection, Modal, Switch
- `src/config/layouts/*.ts` - explore, edit, community layout configs
- `src/modules/common/BottomBar.tsx` - Bottom toolbar with rating, copy/paste, zoom
- `src/modules/panels/PanelSwitcher.tsx` - Vertical tabs + dynamic panel content
- `src/modules/library/LibraryExportPanel.tsx` - Export panel for library view

**Technical patterns:**
- No animations - all Framer Motion removed
- CSS variables use RGB triplet format for Tailwind alpha support
- Font family: Poppins
- Panel sizes: 256px left, 368px right (320+48), 144px filmstrip, 40px bottom bar
The RapidRAW styling update is ~98% complete! Read @update-styles-plan/PROGRESS.md for details.

**Current State (Session 2 completed):**
- All phases (0-7) complete
- Overall: 50/51 tasks done (~98%)
- Only remaining: LibraryExportPanel module (optional, hidden by default)

**Session 2 completed:**
- Fixed BottomBar.tsx type errors (activePath, selectedPaths, scale, toggleBottomPanel, zoomToFit)
- Added bottom-bar to module registry
- Fixed PanelSwitcher to vertical layout with tabs on right (like legacy RightPanelSwitcher)
- Updated edit.ts layout to use single panel-switcher module (368px total)
- Reviewed all modules across phases 3-7 - styling matches legacy patterns

**Key files modified:**
- `src/modules/common/BottomBar.tsx` - Fixed type errors
- `src/modules/registry.tsx` - Added bottom-bar module
- `src/modules/panels/PanelSwitcher.tsx` - Vertical tabs layout
- `src/config/layouts/edit.ts` - Simplified right panel config

**Technical patterns established:**
- No animations - all Framer Motion removed
- CSS variables use RGB triplet format for Tailwind alpha
- Font family: Poppins
- Panel sizes match legacy exactly (256px left, 368px right, 144px filmstrip, 40px bottom bar)

**Optional remaining task:**
- Create LibraryExportPanel module for explore view right panel (currently hidden by default in layout)

**The styling update is essentially complete!**
```

---

## Layout Pixel Values Reference

### Legacy Panel Sizes
```typescript
// Left Panel (FolderTree)
const leftPanelWidth = 256;  // default
const leftPanelMin = 200;
const leftPanelMax = 500;
const leftPanelCollapsed = 32;

// Right Panel (Adjustments/Export)
const rightPanelWidth = 320;  // default
const rightPanelMin = 280;
const rightPanelMax = 600;

// Bottom Panel (Filmstrip)
const bottomPanelHeight = 144;  // default
const bottomPanelMin = 100;
const bottomPanelMax = 400;

// Bottom Toolbar (fixed)
const bottomToolbarHeight = 40;

// Panel Switcher (vertical tabs)
const panelSwitcherWidth = 48;

// Gallery Controls Header
const galleryControlsHeight = 60;
```

### View Layout Diagrams

**Explore View (Library):**
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬─────────────────────────────────────────────────┬─────┤
│     │         GalleryControls (60px)                  │     │
│ 256 ├─────────────────────────────────────────────────┤ 320 │
│ px  │                                                 │ px  │
│     │               GalleryGrid                       │     │
│     │                                                 │     │
├─────┼─────────────────────────────────────────────────┼─────┤
│     │             BottomBar (40px)                    │     │
└─────┴─────────────────────────────────────────────────┴─────┘
```

**Edit View:**
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬─────────────────────────────────────────────┬────┬────┤
│     │                                             │    │    │
│     │              ImagePreview                   │    │ 48 │
│     │                                             │    │ px │
│ 256 ├─────────────────────────────────────────────┤ 320│    │
│ px  │           Filmstrip (144px)                 │ px │    │
│     ├─────────────────────────────────────────────┤    │    │
│     │             BottomBar (40px)                │    │    │
└─────┴─────────────────────────────────────────────┴────┴────┘
```

**Community View:**
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬───────────────────────────────────────────────────────┤
│     │                                                       │
│ 256 │              CommunityBrowser                         │
│ px  │                                                       │
│     ├───────────────────────────────────────────────────────┤
│     │              BottomBar (40px)                         │
└─────┴───────────────────────────────────────────────────────┘
```

---

## Component Styling Patterns Reference

### Button Patterns
```tsx
// Primary (default)
"bg-accent text-button-text shadow-shiny"

// Surface variant
"bg-surface text-text-primary"

// Ghost variant
"bg-transparent text-text-primary hover:bg-surface"
```

### Slider Patterns
```tsx
// Track
"h-1.5 bg-card-active rounded-full"

// Thumb
"h-4 w-4 rounded-full bg-accent"

// Label (hover to show reset)
"text-sm font-medium text-text-secondary"
```

### CollapsibleSection Patterns
```tsx
// Container
"bg-surface rounded-lg overflow-hidden"

// Header
"px-4 py-3 hover:bg-card-active"

// Title
"text-lg font-normal text-shadow-shiny"

// Chevron
"text-accent"
```

### Modal Patterns
```tsx
// Backdrop
"fixed inset-0 bg-black/30 backdrop-blur-sm z-50"

// Content
"bg-surface rounded-lg shadow-xl p-6"

// Title
"text-lg font-semibold text-text-primary mb-4"

// Message
"text-sm text-text-secondary mb-6"

// Button row
"flex justify-end gap-3 mt-5"
```

### Dropdown Patterns
```tsx
// Trigger
"bg-bg-primary border border-border-color rounded-md px-3 py-2"

// Menu
"bg-surface/95 backdrop-blur-md rounded-lg shadow-xl p-2"

// Option (selected)
"bg-bg-primary text-text-primary font-semibold"

// Option (hover)
"hover:bg-bg-primary"
```
