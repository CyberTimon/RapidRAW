# Dependency Analysis

**Last Updated:** 2026-01-06

This document analyzes all dependencies in RapidRAW and provides recommendations for cleanup.

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| Active dependencies (keep) | 17 | Keep |
| Legacy-only dependencies | 11 | Can remove |
| Unused dependencies | 3 | Can remove |
| **Total removable** | **14** | **Remove** |

---

## Dependencies in Active Use (`src/`)

These packages are imported in the active codebase and must be kept.

### Core Framework

| Package | Version | Usage | Notes |
|---------|---------|-------|-------|
| `react` | ^19.2.3 | Core | React framework |
| `react-dom` | ^19.2.3 | Core | React DOM rendering |

### State Management

| Package | Version | Files | Notes |
|---------|---------|-------|-------|
| `@blac/core` | ^2.0.0-rc-16 | 51 | BLoC pattern state management |
| `@blac/react` | ^2.0.0-rc-16 | 51 | React hooks for BLoC |

### UI Components & Styling

| Package | Version | Files | Notes |
|---------|---------|-------|-------|
| `react-aria-components` | ^1.14.0 | Primitives | Accessibility components (newly migrated) |
| `tailwind-variants` | ^3.2.2 | Primitives | Variant styling utility |
| `tailwind-merge` | ^3.4.0 | Primitives | Tailwind class merging |
| `lucide-react` | ^0.562.0 | 26 | Icon library |

### Virtualization

| Package | Version | Files | Notes |
|---------|---------|-------|-------|
| `@tanstack/react-virtual` | ^3.13.16 | 3 | Virtual scrolling (GalleryGrid, Filmstrip, CommunityView) |

### Utilities

| Package | Version | Files | Notes |
|---------|---------|-------|-------|
| `uuid` | ^13.0.0 | 1 | UUID generation (maskUtils.ts) |

### Tauri Platform

| Package | Version | Notes |
|---------|---------|-------|
| `@tauri-apps/api` | ^2.9.1 | Core Tauri APIs |
| `@tauri-apps/plugin-dialog` | ^2.4.2 | File dialogs |
| `@tauri-apps/plugin-os` | ^2.3.2 | OS information |
| `@tauri-apps/plugin-process` | ^2.3.1 | Process management |
| `@tauri-apps/plugin-shell` | ^2.3.3 | Shell commands |

---

## Dependencies Only Used in Legacy Code

These packages are only imported in `src_legacy_deprecated_reference/` and can be removed.

| Package | Version | Legacy Files | Recommendation |
|---------|---------|--------------|----------------|
| `@clerk/clerk-react` | ^5.59.2 | 2 (SettingsPanel, App) | **REMOVE** - Auth not in active code |
| `@dnd-kit/core` | ^6.3.1 | 1 (PresetsPanel) | **REMOVE** - Drag-drop not in active code |
| `clsx` | ^2.1.1 | 20 | **REMOVE** - Replaced by tailwind-variants |
| `framer-motion` | ^12.23.26 | 22 | **REMOVE** - Animations not in active code |
| `konva` | ^10.0.12 | 1 (ImageCanvas) | **REMOVE** - Canvas not in active code |
| `react-konva` | ^19.2.1 | 1 (ImageCanvas) | **REMOVE** - Canvas not in active code |
| `react-draggable` | ^4.5.0 | 1 (Waveform) | **REMOVE** - Dragging not in active code |
| `react-image-crop` | ^11.0.10 | 4 | **REMOVE** - Cropping not in active code |
| `react-virtualized-auto-sizer` | ^1.0.26 | 1 (MainLibrary) | **REMOVE** - Superseded by @tanstack/react-virtual |
| `react-window` | ^1.8.11 | 1 (MainLibrary) | **REMOVE** - Superseded by @tanstack/react-virtual |
| `react-zoom-pan-pinch` | ^3.7.0 | 2 (Editor, FullScreenViewer) | **REMOVE** - Zoom/pan not in active code |

---

## Dependencies Not Used Anywhere

These packages are not imported in any file (active or legacy).

| Package | Version | Recommendation | Notes |
|---------|---------|----------------|-------|
| `@blac/devtools-connect` | 2.0.0-rc.17 | **REMOVE** | Dev tools - not imported |
| `@blac/devtools-ui` | 2.0.0-rc.17 | **REMOVE** | Dev tools - not imported |
| `lodash.debounce` | ^4.0.8 | **REMOVE** | Not imported (can use native setTimeout) |

---

## Dev Dependencies

All dev dependencies appear to be in active use for the build toolchain:

| Package | Purpose | Status |
|---------|---------|--------|
| `@eslint/js` | ESLint config | Keep |
| `@react-aria/optimize-locales-plugin` | Locale optimization for React Aria | Keep |
| `@tauri-apps/cli` | Tauri CLI | Keep |
| `@testing-library/*` | Testing utilities | Keep |
| `@types/*` | TypeScript types | Keep |
| `@vitejs/plugin-react` | Vite React plugin | Keep |
| `@vitest/coverage-v8` | Test coverage | Keep |
| `autoprefixer` | CSS autoprefixer | Keep |
| `eslint` | Linting | Keep |
| `jsdom` | DOM testing | Keep |
| `postcss` | CSS processing | Keep |
| `tailwindcss` | CSS framework | Keep |
| `typescript` | TypeScript compiler | Keep |
| `typescript-eslint` | TypeScript ESLint | Keep |
| `vite` | Build tool | Keep |
| `vitest` | Test runner | Keep |

**Note:** `@types/lodash.debounce` can be removed if `lodash.debounce` is removed.

---

## Removal Instructions

To remove unused dependencies, run:

```bash
pnpm remove \
  @blac/devtools-connect \
  @blac/devtools-ui \
  @clerk/clerk-react \
  @dnd-kit/core \
  clsx \
  framer-motion \
  konva \
  lodash.debounce \
  react-draggable \
  react-image-crop \
  react-konva \
  react-virtualized-auto-sizer \
  react-window \
  react-zoom-pan-pinch

# Also remove the type definition
pnpm remove -D @types/lodash.debounce
```

**Expected impact:**
- Reduced `node_modules` size
- Potentially smaller bundle (tree-shaking should already exclude unused code)
- Cleaner dependency list
- Fewer security vulnerabilities to track

---

## Alternatives Considered

### clsx → tailwind-variants
- `clsx` was used for conditional class names
- `tailwind-variants` provides the same functionality plus variant support
- Migration complete - all active code uses `tailwind-variants`

### react-window / react-virtualized-auto-sizer → @tanstack/react-virtual
- Legacy code used `react-window` for virtualization
- Active code uses `@tanstack/react-virtual` (TanStack Virtual)
- TanStack Virtual is more modern, smaller, and better maintained

### framer-motion → CSS animations / React Aria
- Legacy code used `framer-motion` for animations
- Active code uses:
  - CSS transitions (Tailwind)
  - React Aria's built-in animation support (`data-[entering]`, `data-[exiting]`)
- No need for a heavy animation library

---

## Future Considerations

### Packages to watch
- `uuid` - Could potentially use `crypto.randomUUID()` (native) if browser support is sufficient
- `@tanstack/react-virtual` - Excellent choice, actively maintained

### If re-adding features from legacy
- **Auth:** Consider alternatives to Clerk (Supabase Auth, Auth.js, etc.)
- **Drag-and-drop:** @dnd-kit is still a good choice if needed
- **Canvas:** Consider native Canvas API or PixiJS as alternatives to Konva
- **Animations:** CSS animations or Motion One (lighter than framer-motion)
