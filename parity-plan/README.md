# RapidRAW Feature Parity Plan

This plan tracks the implementation of missing features from the legacy codebase (`src_legacy_deprecated_reference/`) into the new architecture (`src/`).

## Overview

The new codebase has the core architecture in place (BlaC state management, layout system, primitives) but is missing many features that existed in the legacy version. This plan prioritizes and tracks the implementation of these features.

## Priority Levels

- **P0 (Critical)**: Core functionality that blocks basic usage
- **P1 (High)**: Important features for daily workflow
- **P2 (Medium)**: Nice-to-have features that enhance UX
- **P3 (Low)**: Advanced/niche features

---

## Phase 1: Settings & Configuration (P0)

The Settings panel is critical for app configuration and was only a placeholder.

### 1.1 SettingsPanel Module
Create a full settings panel with:
- General settings (theme, transparency, EXIF reading)
- Adjustments visibility toggles
- Processing settings (preview resolution, backend, RAW highlight recovery)
- Data management (clear cache, clear sidecars, view logs)
- Keyboard shortcuts reference

### 1.2 Theme System
- Theme definitions (dark, light, grey, green, blue, sepia, snow, arctic)
- Theme switching with CSS variable updates
- Splash image mapping per theme

---

## Phase 2: Essential Modals (P0-P1)

### 2.1 Core Modals (P0)
| Modal | Priority | Purpose |
|-------|----------|---------|
| `ConfirmModal` | P0 | Generic confirmation dialog (used everywhere) |
| `RenameFileModal` | P0 | Rename image files |
| `CreateFolderModal` | P0 | Create new folders |

### 2.2 Workflow Modals (P1)
| Modal | Priority | Purpose |
|-------|----------|---------|
| `AddPresetModal` | P1 | Save current adjustments as preset |
| `RenamePresetModal` | P1 | Rename existing preset |
| `RenameFolderModal` | P1 | Rename folders |
| `CopyPasteSettingsModal` | P1 | Configure which adjustments to copy/paste |
| `ImportSettingsModal` | P1 | Import adjustments from .rrdata file |

### 2.3 Advanced Modals (P2)
| Modal | Priority | Purpose |
|-------|----------|---------|
| `DenoiseModal` | P2 | AI-powered denoising options |
| `CullingModal` | P2 | AI-assisted photo culling/selection |
| `PanoramaModal` | P2 | Panorama stitching interface |
| `CollageModal` | P2 | Photo collage creation |

---

## Phase 3: Missing UI Primitives (P1)

### 3.1 Color Controls
| Component | Priority | Purpose |
|-----------|----------|---------|
| `ColorWheel` | P1 | HSL color grading wheel for shadows/midtones/highlights |

### 3.2 File Pickers
| Component | Priority | Purpose |
|-----------|----------|---------|
| `ImagePicker` | P1 | Select image file (watermarks, overlays) |
| `LUTControl` | P2 | LUT file selection and preview |

---

## Phase 4: Editor Enhancements (P1)

### 4.1 Canvas & Rendering
| Feature | Priority | Purpose |
|---------|----------|---------|
| GPU-accelerated canvas | P1 | WebGPU/WebGL rendering pipeline |
| Zoom/pan gestures | P1 | Smooth zoom and pan controls |
| Before/after comparison | P1 | Toggle to show original image |

### 4.2 Mask Tools
| Feature | Priority | Purpose |
|---------|----------|---------|
| `MaskControls` | P1 | Brush size, feather, opacity controls |
| Mask brush painting | P1 | Paint masks directly on canvas |
| AI mask generation | P1 | Subject, sky, foreground detection |

### 4.3 AI Tools
| Feature | Priority | Purpose |
|---------|----------|---------|
| `AIControls` | P2 | AI tool interface |
| Generative replace | P2 | AI-powered object replacement |
| ComfyUI integration | P2 | Connect to local ComfyUI server |

---

## Phase 5: Context & Hooks (P1)

### 5.1 Context Providers
| Context | Priority | Purpose |
|---------|----------|---------|
| Context menu system | P1 | Right-click menus throughout app |
| Tagging submenu | P1 | Quick tag assignment menu |

### 5.2 Custom Hooks
| Hook | Priority | Purpose |
|------|----------|---------|
| `useKeyboardShortcuts` | P1 | Global keyboard shortcut handling |
| `useHistoryState` | P1 | Undo/redo state management |
| `useImageRenderSize` | P2 | Calculate optimal render dimensions |

---

## Phase 6: Utilities & Types (P1-P2)

### 6.1 Utilities
| Utility | Priority | Purpose |
|---------|----------|---------|
| `themes.ts` | P1 | Theme definitions and CSS variable mapping |
| `maskUtils.ts` | P1 | Mask manipulation (blur, invert, combine) |
| `palette.ts` | P2 | Extract color palette from image |

### 6.2 Type Definitions
| Types | Priority | Purpose |
|-------|----------|---------|
| Export/Import types | P1 | File formats, export settings, watermark config |
| App-wide constants | P1 | Invokes, enums, shared constants |

---

## Phase 7: Window & Platform (P2)

### 7.1 Window Components
| Component | Priority | Purpose |
|-----------|----------|---------|
| `TitleBar` | P2 | Custom title bar with window controls |
| Traffic light positioning | P2 | macOS window button alignment |

### 7.2 Platform Integration
| Feature | Priority | Purpose |
|---------|----------|---------|
| Native file dialogs | P1 | Open/save file dialogs via Tauri |
| Clipboard integration | P1 | Copy/paste images and adjustments |
| Drag and drop | P2 | Drag files into app |

---

## Phase 8: Authentication (P3)

### 8.1 Clerk Integration
| Feature | Priority | Purpose |
|---------|----------|---------|
| Sign in/out | P3 | User authentication |
| User profile | P3 | Display user info in settings |
| Cloud sync prep | P3 | Prepare for cloud features |

---

## Implementation Order

### Sprint 1: Foundation (Phases 1-2.1)
1. SettingsPanel with all sections
2. Theme system with all 8 themes
3. ConfirmModal, RenameFileModal, CreateFolderModal

### Sprint 2: Workflow (Phases 2.2, 3, 5)
1. Preset modals (Add, Rename)
2. CopyPasteSettingsModal
3. ColorWheel component
4. Keyboard shortcuts hook
5. Context menu system

### Sprint 3: Editor (Phase 4)
1. MaskControls component
2. Before/after toggle
3. Improved zoom/pan

### Sprint 4: Advanced (Phases 2.3, 6, 7)
1. AI modals (Denoise, Culling)
2. Utility functions
3. TitleBar component

### Sprint 5: Polish (Phase 8)
1. Authentication (if needed)
2. Platform-specific polish
3. Performance optimization

---

## Technical Notes

### State Management
All new features should use BlaC (Cubit pattern):
- Create Bloc/Cubit classes in `src/blocs/`
- Use `useBloc` hook in components
- Follow existing patterns (see `AdjustmentsBloc`, `SettingsBloc`)

### Styling
- Use Tailwind CSS classes
- Follow established patterns (no animations, Poppins font)
- Use CSS variables for theming
- Reference `src/styles.css` for global styles

### File Organization
- Modals go in `src/modules/modals/`
- UI primitives go in `src/primitives/`
- Utilities go in `src/utils/`
- Types go in `src/types/`

### Tauri Integration
- Use `TauriService` for all Rust backend calls
- Define invoke names in a constants file
- Handle errors gracefully with user feedback
