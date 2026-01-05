# RapidRAW Styling Update Plan

## Executive Summary

This document outlines a comprehensive plan to update the new refactored RapidRAW React codebase (`src/`) to match the visual design of the legacy implementation (`src_legacy_deprecated_reference/`). The goal is to achieve design parity while maintaining the clean architecture established during the rewrite.

## Key Principles

1. **No Animations** - All animations and transitions are removed for now
2. **Legacy Design Parity** - Visual styling should match the legacy implementation as closely as possible
3. **Tailwind + CSS Variables** - Use the established theming system with CSS variables and Tailwind utilities
4. **No Framer Motion** - Avoid Framer Motion dependency; use CSS-only or no animations
5. **Match Legacy Layouts** - Panel sizes, positions, and structure should match legacy exactly

---

## Table of Contents

1. [Layout Structure](#layout-structure)
2. [Current State Analysis](#current-state-analysis)
3. [Theming System](#theming-system)
4. [Component Checklist](#component-checklist)
5. [Migration Strategy](#migration-strategy)

---

## Layout Structure

### Legacy Panel Sizes

| Panel | Default | Min | Max | Collapsed |
|-------|---------|-----|-----|-----------|
| Left Panel (FolderTree) | 256px | 200px | 500px | 32px |
| Right Panel (Adjustments) | 320px | 280px | 600px | - |
| Filmstrip | 144px | 100px | 400px | - |
| Bottom Toolbar | 40px (fixed) | - | - | - |
| Panel Switcher | 48px (fixed) | - | - | - |
| Gallery Controls | 60px (fixed) | - | - | - |

### View Layouts

#### Welcome Screen (No Folder Open)
- **Left Panel**: Hidden
- **Center**: WelcomeScreen component (full width)
- **Right Panel**: Hidden
- **Bottom Bar**: Hidden

#### Explore View (Library)
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬─────────────────────────────────────────────────┬─────┤
│     │         GalleryControls (60px)                  │     │
│ 256 ├─────────────────────────────────────────────────┤ 320 │
│ px  │               GalleryGrid                       │ px  │
│     │                 (flex)                          │ opt │
├─────┼─────────────────────────────────────────────────┼─────┤
│     │             BottomBar (40px)                    │     │
└─────┴─────────────────────────────────────────────────┴─────┘
```
- **Left Panel**: FolderTree (256px, collapsible to 32px)
- **Center**: GalleryControls (60px) + GalleryGrid (flex)
- **Right Panel**: LibraryExportPanel (320px, hidden by default)
- **Bottom Bar**: 40px toolbar (no filmstrip)

#### Edit View
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬─────────────────────────────────────────────┬────┬────┤
│     │              ImagePreview                   │    │    │
│ 256 │                 (flex)                      │ 320│ 48 │
│ px  ├─────────────────────────────────────────────┤ px │ px │
│     │           Filmstrip (144px)                 │    │    │
│     ├─────────────────────────────────────────────┤    │    │
│     │             BottomBar (40px)                │    │    │
└─────┴─────────────────────────────────────────────┴────┴────┘
```
- **Left Panel**: FolderTree (256px, collapsible)
- **Center**: ImagePreview (flex) + Filmstrip (144px) + BottomBar (40px)
- **Right Panel**: ActivePanel (320px) + PanelSwitcher (48px vertical tabs)

#### Community View
```
┌─────────────────────────────────────────────────────────────┐
│                           TitleBar                          │
├─────┬───────────────────────────────────────────────────────┤
│ 256 │              CommunityBrowser                         │
│ px  │                   (flex)                              │
│     ├───────────────────────────────────────────────────────┤
│     │              BottomBar (40px)                         │
└─────┴───────────────────────────────────────────────────────┘
```
- **Left Panel**: FolderTree (256px, collapsible)
- **Center**: CommunityBrowser (flex)
- **Right Panel**: Hidden
- **Bottom Bar**: 40px toolbar (no filmstrip)

---

## Current State Analysis

### Legacy Design Patterns

The legacy codebase uses these key design patterns:

| Pattern | Description |
|---------|-------------|
| **CSS Variables** | RGB triplet format for Tailwind alpha support (e.g., `--color-accent: 255 255 255`) |
| **Font** | Poppins as primary font family |
| **Shadows** | `shadow-shiny` for button glow effects |
| **Text Effects** | `text-shadow-shiny` for glowing text |
| **Backdrop Blur** | `backdrop-blur-md` on dropdowns and modals |
| **Border Radius** | `rounded-md` (8px), `rounded-lg` (15px) |

### Key Styling Differences Found

| Component | Legacy Pattern | New Pattern (to fix) |
|-----------|----------------|---------------------|
| Button | `shadow-shiny`, `font-semibold` | Missing shadow, wrong font weight |
| Slider | Native range input with CSS styling | Custom div-based implementation |
| Dropdown | Framer Motion animations | Static (correct, no animations) |
| CollapsibleSection | Eye toggle visibility | Added visibility support |
| Modal | `bg-black/30 backdrop-blur-sm` | Matched |

---

## Theming System

### CSS Variable Structure

The legacy uses RGB triplet format for Tailwind's alpha-value syntax support:

```css
:root {
  /* Primary backgrounds - rgba() format with separate opacity */
  --color-bg-primary-rgb: 45, 45, 45;
  --opacity-bg-primary: 0.6;
  --color-bg-secondary-rgb: 34, 34, 34;
  --opacity-bg-secondary: 0.75;
  
  /* Other colors - space-separated RGB for Tailwind */
  --color-surface: 30 30 30;
  --color-card-active: 43 43 43;
  --color-button-text: 0 0 0;
  --color-text-primary: 232 234 237;
  --color-text-secondary: 158 158 158;
  --color-accent: 255 255 255;
  --color-border-color: 74 74 74;
  --color-hover-color: 255 255 255;
}
```

### Available Themes

| Theme ID | Name | Splash Image |
|----------|------|--------------|
| `dark` | Dark | `/splash-dark.jpg` |
| `light` | Light | `/splash-light.jpg` |
| `grey` | Grey | `/splash-grey.jpg` |
| `mutedGreen` | Muted Green | `/splash-green.jpg` |
| `blue` | Blue | `/splash-blue.jpg` |
| `sepia` | Sepia | `/splash-sepia.jpg` |
| `snow` | Snow | `/splash-snow.jpg` |
| `arctic` | Arctic | `/splash-arctic.jpg` |

---

## Component Categories

### 1. Primitives (`src/primitives/`)

Core UI building blocks:

| Component | Status | Notes |
|-----------|--------|-------|
| Button | Updated | Variants: primary, surface, ghost, destructive |
| Slider | Updated | Native range input, click-to-edit, shift+scroll |
| Input | Updated | Simple text input with error state |
| Dropdown | Updated | No animations, backdrop blur |
| CollapsibleSection | Updated | Supports controlled/uncontrolled, visibility toggle |
| Modal | Updated | Portal-based, backdrop blur |
| Switch | **NEW** | Toggle switch component |
| Resizer | Existing | Panel resize handles |

### 2. Adjustment Controls (`src/modules/adjustments/`)

Slider-based adjustment panels:

| Component | Legacy File | Status |
|-----------|------------|--------|
| ExposureControls | `adjustments/Basic.tsx` | Needs comparison |
| ColorControls | `adjustments/Color.tsx` | Needs comparison |
| ToneCurves | `adjustments/Curves.tsx` | Needs comparison |
| DetailControls | `adjustments/Details.tsx` | Needs comparison |
| EffectsControls | `adjustments/Effects.tsx` | Needs comparison |
| HSLControls | N/A (new) | Needs comparison |
| LensCorrections | N/A (new) | Needs comparison |

### 3. Panel Modules (`src/modules/panels/`)

Right sidebar panels:

| Component | Legacy File | Status |
|-----------|------------|--------|
| AdjustmentsPanel | `panel/right/ControlsPanel.tsx` | Needs comparison |
| PanelSwitcher | `panel/right/RightPanelSwitcher.tsx` | Needs comparison |
| CropPanel | `panel/right/CropPanel.tsx` | Needs comparison |
| MasksPanel | `panel/right/MasksPanel.tsx` | Needs comparison |
| PresetsPanel | `panel/right/PresetsPanel.tsx` | Needs comparison |
| ExportPanel | `panel/right/ExportPanel.tsx` | Needs comparison |
| MetadataPanel | `panel/right/MetadataPanel.tsx` | Needs comparison |
| AIPanel | `panel/right/AIPanel.tsx` | Needs comparison |

### 4. Library Modules (`src/modules/library/`)

Explore view components:

| Component | Legacy File | Status |
|-----------|------------|--------|
| FolderTree | `panel/FolderTree.tsx` | Needs comparison |
| GalleryGrid | `panel/MainLibrary.tsx` | Needs comparison |
| GalleryControls | `panel/MainLibrary.tsx` (header) | Needs comparison |
| Filmstrip | `panel/Filmstrip.tsx` | Needs comparison |
| ImageCard | N/A (extracted) | Needs comparison |
| WelcomeScreen | N/A (new) | Needs comparison |

### 5. Editor Modules (`src/modules/editor/`)

Edit view components:

| Component | Legacy File | Status |
|-----------|------------|--------|
| ImagePreview | `panel/Editor.tsx` | Needs comparison |
| EditorToolbar | `panel/editor/EditorToolbar.tsx` | Needs comparison |
| FullscreenViewer | `panel/editor/FullScreenViewer.tsx` | Needs comparison |
| ImageHistogram | N/A (extracted) | Needs comparison |
| ImageWaveform | `panel/editor/Waveform.tsx` | Needs comparison |
| ZoomControls | N/A (extracted) | Needs comparison |

### 6. Modals (`src/modules/modals/`)

Dialog components:

| Component | Legacy File | Status |
|-----------|------------|--------|
| AboutModal | N/A (new) | Needs comparison |
| ExportProgressModal | N/A (new) | Needs comparison |
| KeyboardShortcutsModal | N/A (new) | Needs comparison |

---

## Migration Strategy

### Phase 1: Global Styles (COMPLETED)

1. ~~Fix CSS variables to match legacy RGB triplet format~~
2. ~~Update font-family to Poppins~~
3. ~~Add slider track/thumb CSS classes~~
4. ~~Add text-shadow-shiny utility~~
5. ~~Remove all transition/animation CSS~~

### Phase 2: Primitives (COMPLETED)

1. ~~Update Button - remove animations, add shadow-shiny~~
2. ~~Update Slider - match legacy native range input~~
3. ~~Update Input - simplify to match legacy~~
4. ~~Update Dropdown - remove Framer Motion~~
5. ~~Update CollapsibleSection - add visibility toggle~~
6. ~~Update Modal - match legacy backdrop styling~~
7. ~~Add Switch component~~

### Phase 3: Adjustment Controls (TODO)

1. Compare ExposureControls with legacy Basic.tsx
2. Compare ColorControls with legacy Color.tsx
3. Compare ToneCurves with legacy Curves.tsx
4. Compare DetailControls with legacy Details.tsx
5. Compare EffectsControls with legacy Effects.tsx
6. Review HSLControls styling
7. Review LensCorrections styling

### Phase 4: Panel Modules (TODO)

1. Compare AdjustmentsPanel layout
2. Compare PanelSwitcher tab styling
3. Compare each panel's internal layout

### Phase 5: Library Modules (TODO)

1. Compare FolderTree styling
2. Compare GalleryGrid/ImageCard styling
3. Compare Filmstrip styling
4. Compare GalleryControls header

### Phase 6: Editor Modules (TODO)

1. Compare ImagePreview canvas styling
2. Compare EditorToolbar buttons
3. Compare FullscreenViewer overlay
4. Review histogram/waveform styling

### Phase 7: Modals (TODO)

1. Review all modal layouts
2. Ensure consistent button placement
3. Check backdrop/blur styling

---

## Files Reference

### Key Files to Modify

```
src/
├── styles.css                    # Global CSS (UPDATED)
├── primitives/
│   ├── Button.tsx               # UPDATED
│   ├── Slider.tsx               # UPDATED
│   ├── Input.tsx                # UPDATED
│   ├── Dropdown.tsx             # UPDATED
│   ├── CollapsibleSection.tsx   # UPDATED
│   ├── Modal.tsx                # UPDATED
│   └── Switch.tsx               # NEW
├── modules/
│   ├── adjustments/             # TODO
│   ├── panels/                  # TODO
│   ├── library/                 # TODO
│   ├── editor/                  # TODO
│   └── modals/                  # TODO
```

### Legacy Reference (DO NOT IMPORT)

```
src_legacy_deprecated_reference/
├── styles.css                    # Legacy global CSS
├── components/
│   ├── ui/                      # Legacy primitives
│   ├── adjustments/             # Legacy adjustment controls
│   ├── panel/                   # Legacy panels
│   └── modals/                  # Legacy modals
├── utils/
│   └── themes.tsx               # Theme definitions
```

---

## Progress Summary

| Phase | Tasks | Completed | Remaining |
|-------|-------|-----------|-----------|
| Phase 1: Global Styles | 5 | 5 | 0 |
| Phase 2: Primitives | 7 | 7 | 0 |
| Phase 3: Adjustments | 7 | 0 | 7 |
| Phase 4: Panels | 8 | 0 | 8 |
| Phase 5: Library | 6 | 0 | 6 |
| Phase 6: Editor | 6 | 0 | 6 |
| Phase 7: Modals | 3 | 0 | 3 |
| **TOTAL** | **42** | **12** | **30** |

**Progress: ~29% complete**
