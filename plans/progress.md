# Migration Progress Tracker

## Status Legend
- [ ] Not started
- [x] Completed
- [~] In progress

---

## Phase 1: Foundation

### 1.1 TauriService
- [x] Create `src/cubits/TauriService.ts`
- [x] Wrap all invoke calls
- [ ] Test service instantiation

### 1.2 ModalsCubit
- [x] Create `src/cubits/ModalsCubit.ts`
- [x] Define modal state interfaces
- [x] Implement open/close methods
- [~] Update modal components to use cubit (ConfirmModal done)
- [~] Remove modal state from App.tsx (confirmModalState removed)

### 1.3 SettingsCubit
- [x] Create `src/cubits/SettingsCubit.ts`
- [x] Implement settings loading
- [x] Implement debounced saving
- [ ] Update components to use cubit
- [ ] Remove settings state from App.tsx

### 1.4 Infrastructure
- [x] Create `src/cubits/index.ts` barrel export
- [x] Verify BlaC packages installed

---

## Phase 2: Library Domain

### 2.1 NavigationCubit
- [x] Create `src/cubits/NavigationCubit.ts`
- [x] Migrate folder tree state
- [ ] Update FolderTree component
- [ ] Remove navigation state from App.tsx

### 2.2 LibraryCubit
- [x] Create `src/cubits/LibraryCubit.ts`
- [x] Migrate image list state
- [x] Migrate thumbnail state
- [x] Implement sortedImageList getter
- [ ] Update MainLibrary component
- [ ] Delete useThumbnails hook
- [ ] Remove library state from App.tsx

---

## Phase 3: Editor Domain

### 3.1 EditorCubit
- [x] Create `src/cubits/EditorCubit.ts`
- [x] Migrate adjustments with history
- [x] Migrate zoom/pan state
- [ ] Update Editor component
- [ ] Delete useHistoryState hook
- [ ] Remove editor state from App.tsx

### 3.2 MasksCubit
- [x] Create `src/cubits/MasksCubit.ts`
- [x] Migrate mask UI state (active mask, brush settings)
- [ ] Update MasksPanel component
- [ ] Remove mask state from App.tsx

### 3.3 AiPatchesCubit
- [~] Skipped - AI patches are stored within `adjustments.aiPatches`
- [~] Active AI patch state could be added to MasksCubit if needed

---

## Phase 4: Cleanup

### 4.1 Prop Drilling Removal
- [ ] Update all components to use useBloc
- [ ] Remove props from component interfaces
- [ ] Simplify App.tsx

### 4.2 Optimization
- [ ] Convert to useBlocActions where appropriate
- [ ] Refactor useKeyboardShortcuts
- [ ] Type safety audit

### 4.3 Testing
- [ ] Verify all features work
- [ ] Check for memory leaks
- [ ] Performance testing

---

## Session Log

### Session 1 - 2024-12-30

**Started**: Phase 1-3 - Creating all cubits

**Completed**:
- Created `plans/` directory with documentation
- Updated tsconfig.json for decorator support
- Created `src/cubits/` directory

**Phase 1 Cubits Created**:
- `TauriService.ts` - StatelessCubit wrapping 70+ Tauri invoke calls
- `ModalsCubit.ts` - 10 modal types with typed state interfaces
- `SettingsCubit.ts` - App settings with auto-save via system events

**Phase 2 Cubits Created**:
- `NavigationCubit.ts` - Folder tree, navigation, pinned folders, view switching
- `LibraryCubit.ts` - Image list, thumbnails, selection, sorting/filtering with computed `sortedImageList` getter

**Phase 3 Cubits Created**:
- `EditorCubit.ts` - Adjustments with history (undo/redo), zoom/pan, preview URLs
- `MasksCubit.ts` - Active mask state, brush settings, mask copy/paste

**Infrastructure**:
- `index.ts` - Barrel export for all cubits and types

**Notes**:
- All cubits created and type-safe
- Component integration deferred to Phase 4
- AI patches stored in adjustments, separate cubit not needed
- Total: 7 cubits ready for integration

**Next Steps**:
1. Begin integrating cubits into components
2. Start with simpler components (e.g., SettingsPanel)
3. Gradually remove useState from App.tsx

**Files Created**:
```
src/cubits/
├── index.ts           # Barrel export
├── TauriService.ts    # Tauri backend wrapper
├── ModalsCubit.ts     # Modal states
├── SettingsCubit.ts   # App settings
├── NavigationCubit.ts # Folder/view navigation
├── LibraryCubit.ts    # Library/image list
├── EditorCubit.ts     # Editor/adjustments
└── MasksCubit.ts      # Mask UI state
```

### Session 2 - 2024-12-30

**Started**: Phase 4 - Component Integration (ModalsCubit)

**Completed**:
- Integrated `ModalsCubit` into `ConfirmModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` instead of props
  - Removed all props from component interface
- Updated `App.tsx` to use ModalsCubit
  - Added `useBloc(ModalsCubit)` hook
  - Replaced `setConfirmModalState()` with `modalsCubit.openConfirm()`
  - Removed `confirmModalState` useState
  - Removed `ConfirmModalState` interface
  - Updated `isAnyModalOpen` to use `modalsState.confirm.isOpen`
  - Simplified `<ConfirmModal />` render (no props)
- Updated `SettingsPanel.tsx` to use ModalsCubit
  - Added `useBloc(ModalsCubit)` hook
  - Replaced 5 `setConfirmModalState()` calls with `modalsCubit.openConfirm()`
  - Removed local `confirmModalState` useState
  - Removed `ConfirmModalState` interface
  - Simplified `<ConfirmModal />` render (no props)

**Pattern Established**:
```tsx
// Before (props-based)
function ConfirmModal({ isOpen, onClose, title, message, ... }) { ... }
<ConfirmModal {...confirmModalState} onClose={closeConfirmModal} />

// After (cubit-based)
function ConfirmModal() {
  const [modals, modalsCubit] = useBloc(ModalsCubit);
  const { isOpen, title, message, ... } = modals.confirm;
  // ...
}
<ConfirmModal />
```

**Notes**:
- Pre-existing TypeScript errors in codebase (Uint8Array, Input props, etc.) are unrelated to this migration
- ConfirmModal is now a "self-contained" component - no props needed
- Same ModalsCubit instance shared across App.tsx and SettingsPanel

**Next Steps**:
1. Continue with remaining modals (CreateFolderModal, RenameFolderModal, etc.)
2. Or pivot to SettingsCubit integration for greater impact

### Session 3 - 2024-12-30

**Started**: Phase 4 - Component Integration (Continuing ModalsCubit)

**Completed**:
- Integrated `ModalsCubit` into `CreateFolderModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` instead of props for `isOpen`
  - Removed `isOpen` and `onClose` props, kept only `onSave` callback
  - Added `handleClose` using `modalsCubit.closeCreateFolder()`
- Updated `App.tsx` for CreateFolderModal
  - Removed `isCreateFolderModalOpen` useState
  - Updated context menu to use `modalsCubit.openCreateFolder(targetPath)`
  - Parent path now stored in cubit state instead of `folderActionTarget`
  - Updated `handleCreateFolder` to read `parentPath` from cubit state
  - Updated `isAnyModalOpen` to use `modalsState.createFolder.isOpen`
  - Simplified `<CreateFolderModal onSave={...} />` render

- Integrated `ModalsCubit` into `RenameFolderModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` for `isOpen` and `currentName`
  - Removed all props except `onSave` callback
  - Added `handleClose` using `modalsCubit.closeRenameFolder()`
- Updated `App.tsx` for RenameFolderModal
  - Removed `isRenameFolderModalOpen` useState
  - Updated context menu to use `modalsCubit.openRenameFolder(targetPath, currentName)`
  - Updated `handleRenameFolder` to read `path` from cubit state
  - Updated `isAnyModalOpen` to use `modalsState.renameFolder.isOpen`
  - Simplified `<RenameFolderModal onSave={...} />` render

- Integrated `ModalsCubit` into `RenameFileModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` for `isOpen` and `paths`
  - Removed all props except `onSave` callback
  - Added `handleClose` using `modalsCubit.closeRenameFile()`
- Updated `App.tsx` for RenameFileModal
  - Removed `isRenameFileModalOpen` and `renameTargetPaths` useState
  - Updated `handleRenameFiles` to use `modalsCubit.openRenameFile(paths)`
  - Updated `handleSaveRename` to read paths from cubit state
  - Updated `isAnyModalOpen` to use `modalsState.renameFile.isOpen`
  - Simplified `<RenameFileModal onSave={...} />` render

**State Removed from App.tsx**:
- `isCreateFolderModalOpen` useState
- `isRenameFolderModalOpen` useState
- `isRenameFileModalOpen` useState
- `renameTargetPaths` useState

**Notes**:
- PresetsPanel has its own local CreateFolderModal usage for preset folders - left as-is
- `folderActionTarget` state still used for rename folder operation (stores path)
- Pre-existing TypeScript errors remain unrelated to migration

**Next Steps**:
1. Continue with ImportSettingsModal integration
2. Continue with CopyPasteSettingsModal integration
3. Remaining complex modals: PanoramaModal, DenoiseModal, CullingModal, CollageModal
