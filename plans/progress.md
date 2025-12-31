# Migration Progress Tracker

## Status Legend
- [ ] Not started
- [x] Completed
- [~] In progress / Partial

---

## Phase 1: Foundation ✅

### 1.1 TauriService
- [x] Create `src/cubits/TauriService.ts` - StatelessCubit wrapping 70+ Tauri invoke calls

### 1.2 ModalsCubit
- [x] Create `src/cubits/ModalsCubit.ts` - 10 modal types with typed state interfaces
- [x] Update all modal components to use cubit
- [x] Remove modal state from App.tsx

### 1.3 SettingsCubit
- [x] Create `src/cubits/SettingsCubit.ts` - App settings with auto-save
- [x] Update components to use cubit
- [x] Remove settings state from App.tsx

### 1.4 Infrastructure
- [x] Create `src/cubits/index.ts` barrel export
- [x] Verify BlaC packages installed

---

## Phase 2: Library Domain ✅

### 2.1 NavigationCubit
- [x] Create `src/cubits/NavigationCubit.ts` - Folder tree, navigation, pinned folders
- [x] Update FolderTree component (5→3 props)
- [x] Remove navigation state from App.tsx

### 2.2 LibraryCubit
- [x] Create `src/cubits/LibraryCubit.ts` - Image list, thumbnails, selection, sorting/filtering
- [x] Implement sortedImageList getter (replaces ~170 lines of useMemo)
- [x] Update MainLibrary component (30→19 props)
- [~] useThumbnails hook kept as utility for triggering generation
- [x] Remove library state from App.tsx

---

## Phase 3: Editor Domain ✅

### 3.1 EditorCubit
- [x] Create `src/cubits/EditorCubit.ts` - ~35 fields including adjustments with history
- [x] Update Editor component (54→16 props)
- [x] Delete useHistoryState hook
- [x] Remove editor state from App.tsx

### 3.2 MasksCubit
- [x] Create `src/cubits/MasksCubit.ts` - Active mask state, brush settings, AI patches
- [x] Update MasksPanel/AIPanel components
- [x] Remove mask state from App.tsx

### 3.3 AiPatchesCubit
- [~] Skipped - AI patches stored within `adjustments.aiPatches`

---

## Phase 4: Cleanup ✅

### 4.1 Prop Drilling Removal
- [x] Editor component uses useBloc directly (54→16 props)
- [x] MainLibrary uses useBloc directly (30→19 props)
- [x] FolderTree uses useBloc directly (5→3 props)
- [x] useKeyboardShortcuts uses cubits (47→17 props)
- [x] Simplify App.tsx

### 4.2 Optimization
- [x] Delete useHistoryState hook
- [x] Move useMemo to EditorCubit getters (geometricAdjustmentsKey, visualAdjustmentsKey)
- [x] Refactor ControlsPanel to use cubits directly (15→2 props)
- [x] Refactor BottomBar to use cubits directly (30→17 props)
- [x] Convert to useBlocActions where appropriate (SettingsPanel uses useBlocActions for ModalsCubit)
- [x] Type safety audit (fixed LibraryCubit.setSortCriteria and setFilterCriteria to accept function updaters)

### 4.3 Testing
- [ ] Verify all features work
- [ ] Check for memory leaks
- [ ] Performance testing

---

## Cubits Summary

```
src/cubits/
├── index.ts           # Barrel export
├── TauriService.ts    # Tauri backend wrapper
├── ModalsCubit.ts     # 10 modal states
├── SettingsCubit.ts   # App settings with auto-save
├── NavigationCubit.ts # Folder/view navigation (10 fields)
├── LibraryCubit.ts    # Library/image list (7 fields)
├── EditorCubit.ts     # Editor/adjustments (~35 fields)
└── MasksCubit.ts      # Mask UI state (8 fields)
```

## Props Reduction Summary

| Component/Hook | Before | After | Reduction |
|----------------|--------|-------|-----------|
| Editor | 54 props | 16 props | -38 (70%) |
| MainLibrary | 30 props | 19 props | -11 (37%) |
| FolderTree | 5 props | 3 props | -2 (40%) |
| useKeyboardShortcuts | 47 props | 17 props | -30 (64%) |
| ControlsPanel | 15 props | 2 props | -13 (87%) |
| BottomBar | 30 props | 17 props | -13 (43%) |
| CropPanel | 5 props | 0 props | -5 (100%) |
| MasksPanel | 20 props | 4 props | -16 (80%) |
| AIPanel | 19 props | 8 props | -11 (58%) |
| EditorToolbar | 14 props | 3 props | -11 (79%) |
| ImageCanvas | 36 props | 14 props | -22 (61%) |

## Pre-existing TypeScript Errors (unrelated to migration)
- `Uint8Array` / `BlobPart` type incompatibility
- `Spread types may only be created from object types`
- `react-image-crop` / `react-window` missing type declarations

---

## Session Log

### Sessions 1-4 (2024-12-30): Foundation & Modal Integration
- Created all 7 cubits with type-safe interfaces
- Integrated ModalsCubit into all 10 modals (ConfirmModal, CreateFolderModal, RenameFolderModal, RenameFileModal, ImportSettingsModal, CopyPasteSettingsModal, PanoramaModal, DenoiseModal, CullingModal, CollageModal)
- Removed modal useState from App.tsx

### Sessions 5-6 (2024-12-30): Settings & Library Integration
- Integrated SettingsCubit into SettingsPanel
- Made LibraryCubit single source of truth for library state
- Removed sync useEffects and dual-state pattern

### Sessions 7-10 (2024-12-30): Single Source of Truth
- Made all cubits the authoritative source for their domains
- Enhanced ModalsCubit with additional state for complex modals
- NavigationCubit, SettingsCubit, MasksCubit all now single source of truth
- Removed all local useState declarations from App.tsx for these domains

### Session 11 (2024-12-31): EditorCubit Integration
- Made EditorCubit single source of truth (~35 fields)
- Created wrapper setters for backward compatibility
- Built-in debounced history management

### Session 12 (2024-12-31): Cleanup
- Refactored useKeyboardShortcuts to use cubits directly (47→17 props)
- Deleted useHistoryState hook
- Cleaned up unused imports in App.tsx

### Session 13 (2024-12-31): Editor Prop Drilling Removal
- Editor component now uses useBloc(EditorCubit) and useBloc(MasksCubit) directly
- Reduced Editor props from 54 to 16 (70% reduction)

### Session 14 (2024-12-31): MainLibrary & FolderTree Prop Drilling Removal
- MainLibrary now uses useBloc(SettingsCubit) and useBloc(NavigationCubit) directly (30→19 props)
- FolderTree now uses useBloc(SettingsCubit) for visibility state (5→3 props)

### Session 15 (2024-12-31): Sub-component Refactoring
- Added computed getters to EditorCubit: `geometricAdjustmentsKey`, `visualAdjustmentsKey`
- Replaced useMemo in App.tsx with EditorCubit getters
- ControlsPanel now uses useBloc(EditorCubit) and useBloc(SettingsCubit) directly (15→2 props, 87% reduction)
- BottomBar now uses useBloc(EditorCubit), useBloc(LibraryCubit), useBloc(SettingsCubit) directly (30→17 props, 43% reduction)
- CropPanel now uses useBloc(EditorCubit) directly (5→0 props, 100% reduction)
- MasksPanel now uses useBloc(EditorCubit), useBloc(MasksCubit), useBloc(SettingsCubit) directly (20→4 props, 80% reduction)
- Fixed MaskControlsProps to accept nullable histogram and selectedImage types
- AIPanel now uses useBloc(EditorCubit), useBloc(MasksCubit) directly (19→8 props, 58% reduction)
- Fixed AIControlsProps to accept nullable selectedImage type
- EditorToolbar now uses useBloc(EditorCubit) directly (14→3 props, 79% reduction)
- ImageCanvas now uses useBloc(EditorCubit), useBloc(MasksCubit) directly (36→14 props, 61% reduction)

### Session 16 (2024-12-31): Phase 4 Cleanup Complete
- Converted SettingsPanel to use useBlocActions for ModalsCubit (no state subscription needed)
- Fixed LibraryCubit.setSortCriteria to accept function updaters
- Fixed LibraryCubit.setFilterCriteria to accept function updaters
- Type safety audit complete - all migration-related errors resolved
- App.tsx cleanup verified - wrapper setters retained for code organization

---

## Future Optimization Opportunities
1. Remove remaining wrapper setters in App.tsx (currently kept for code organization)
