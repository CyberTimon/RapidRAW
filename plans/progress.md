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
- [x] Update modal components to use cubit (All 10 modals complete)
- [x] Remove modal state from App.tsx (All modal useState removed)

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

### Session 3 Continued - 2024-12-30

**Completed**:
- Integrated `ModalsCubit` into `ImportSettingsModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` for `isOpen` and `sourcePaths`
  - Derives `fileCount` from `sourcePaths.length`
  - Removed `isOpen`, `onClose`, and `fileCount` props, kept only `onSave` callback
  - Added `handleClose` using `modalsCubit.closeImport()`
- Updated `App.tsx` for ImportSettingsModal
  - Removed `isImportModalOpen`, `importTargetFolder`, `importSourcePaths` useState
  - Updated `handleImportFiles` to use `modalsCubit.openImport(targetPath, selected)`
  - Updated `handleStartImport` to read `targetFolder` and `sourcePaths` from cubit state
  - Updated `isAnyModalOpen` to use `modalsState.import.isOpen`
  - Simplified `<ImportSettingsModal onSave={...} />` render

- Integrated `ModalsCubit` into `CopyPasteSettingsModal.tsx`
  - Component now uses `useBloc(ModalsCubit)` for `isOpen`
  - Kept `settings` and `onSave` props (settings come from appSettings)
  - Added `handleClose` using `modalsCubit.closeCopyPasteSettings()`
- Updated `App.tsx` for CopyPasteSettingsModal
  - Removed `isCopyPasteSettingsModalOpen` useState
  - Updated Controls/ExportPanel to use `modalsCubit.openCopyPasteSettings()`
  - Updated `isAnyModalOpen` to use `modalsState.copyPasteSettings.isOpen`
  - Simplified `<CopyPasteSettingsModal settings={...} onSave={...} />` render

**State Removed from App.tsx (this session)**:
- `isImportModalOpen` useState
- `importTargetFolder` useState
- `importSourcePaths` useState
- `isCopyPasteSettingsModalOpen` useState

**Total State Removed from App.tsx (all sessions)**:
- `confirmModalState` (Session 2)
- `isCreateFolderModalOpen` (Session 3)
- `isRenameFolderModalOpen` (Session 3)
- `isRenameFileModalOpen` (Session 3)
- `renameTargetPaths` (Session 3)
- `isImportModalOpen` (Session 3)
- `importTargetFolder` (Session 3)
- `importSourcePaths` (Session 3)
- `isCopyPasteSettingsModalOpen` (Session 3)

**All Simple Modals Completed**:
- ConfirmModal
- CreateFolderModal
- RenameFolderModal
- RenameFileModal
- ImportSettingsModal
- CopyPasteSettingsModal

**Remaining Complex Modals** (require more state management):
- PanoramaModal
- DenoiseModal
- CullingModal
- CollageModal

**Notes**:
- CopyPasteSettingsModal keeps `settings` prop since it's external data from appSettings
- Pre-existing TypeScript errors remain unrelated to migration

**Next Steps**:
1. Integrate complex modals (Panorama, Denoise, Culling, Collage) if desired
2. Move to SettingsCubit integration for greater impact
3. Begin NavigationCubit integration for folder tree state

### Session 4 - 2024-12-30

**Started**: Phase 4 - Component Integration (Complex Modals + SettingsCubit)

**Completed - Complex Modals**:
- Integrated `ModalsCubit` into `PanoramaModal.tsx`
  - Uses `useBloc(ModalsCubit)` for `isOpen`, `error`, `finalImageBase64`, `progressMessage`, `stitchingSourcePaths`
  - Kept `onOpenFile`, `onSave` props (callbacks)
  - Removed event handlers from App.tsx, now uses `modalsCubit.updatePanoramaProgress()`, `setPanoramaResult()`, `setPanoramaError()`

- Integrated `ModalsCubit` into `DenoiseModal.tsx`
  - Uses `useBloc(ModalsCubit)` for `isOpen`, `isProcessing`, `previewBase64`, `originalBase64`, `error`, `progressMessage`, `targetPath`
  - Kept `onDenoise`, `onSave`, `onOpenFile` props (callbacks)
  - Removed event handlers from App.tsx, now uses `modalsCubit.updateDenoiseState()`

- Integrated `ModalsCubit` into `CullingModal.tsx`
  - Uses `useBloc(ModalsCubit)` for `isOpen`, `pathsToCull`, `suggestions`, `progress`, `error`
  - Kept `thumbnails`, `onApply` props
  - Removed event handlers from App.tsx, now uses `modalsCubit.updateCullingProgress()`, `setCullingSuggestions()`, `setCullingError()`

- Integrated `ModalsCubit` into `CollageModal.tsx`
  - Uses `useBloc(ModalsCubit)` for `isOpen`, `sourceImages`
  - Kept `onSave`, `thumbnails` props

**State Removed from App.tsx (Session 4)**:
- `panoramaModalState` useState + `PanoramaModalState` interface
- `denoiseModalState` useState + `DenoiseModalState` interface
- `cullingModalState` useState + `CullingModalState` interface
- `collageModalState` useState + `CollageModalState` interface

**All 10 Modals Now Complete**:
- ConfirmModal ✓
- CreateFolderModal ✓
- RenameFolderModal ✓
- RenameFileModal ✓
- ImportSettingsModal ✓
- CopyPasteSettingsModal ✓
- PanoramaModal ✓
- DenoiseModal ✓
- CullingModal ✓
- CollageModal ✓

**Notes**:
- `isAnyModalOpen` in App.tsx now uses `modalsState.panorama.isOpen`, `modalsState.culling.isOpen`, `modalsState.collage.isOpen`
- Event listeners for panorama/denoise/culling now call cubit methods instead of setting local state
- Pre-existing TypeScript errors remain unrelated to migration

**Next Steps**:
1. Begin SettingsCubit integration into SettingsPanel.tsx
2. Migrate settings state from App.tsx to SettingsCubit
3. Update components (MainLibrary, BottomBar, FolderTree) to use SettingsCubit

### Session 5 - 2024-12-30

**Started**: Phase 4 - Component Integration (SettingsCubit)

**Completed**:
- Added missing properties to `AppSettings` interface:
  - `aiProvider?: string`
  - `taggingShortcuts?: string[]`
  - `transparent?: boolean`
  - `copyPasteSettings?: any`

- Added new methods to `SettingsCubit`:
  - `setAiProvider()`
  - `setTransparent()`
  - `setTaggingShortcuts()`
  - `setCopyPasteSettings()`
  - `setDecorations()`

- Integrated `SettingsCubit` into `SettingsPanel.tsx`:
  - Added `useBloc(SettingsCubit)` hook
  - Removed `appSettings` and `onSettingsChange` props
  - Replaced all `onSettingsChange()` calls with appropriate cubit methods:
    - Theme changes → `settingsCubit.setTheme()`
    - Adaptive theme → `settingsCubit.setAdaptiveEditorTheme()`
    - EXIF reading → `settingsCubit.setEnableExifReading()`
    - AI tagging → `settingsCubit.setEnableAiTagging()`
    - Zoom HiFi → `settingsCubit.setEnableZoomHifi()`
    - Adjustment visibility → `settingsCubit.setAdjustmentVisibility()`
    - Tagging shortcuts → `settingsCubit.setTaggingShortcuts()`
    - AI provider → `settingsCubit.setAiProvider()`
    - ComfyUI address → `settingsCubit.setComfyuiAddress()`
    - ComfyUI config → `settingsCubit.setComfyuiWorkflowConfig()`
    - Transparency → `settingsCubit.setTransparent()`
    - Processing settings → `settingsCubit.updateAppSettings()`

- Updated `MainLibrary.tsx`:
  - Removed `appSettings` and `onSettingsChange` props from SettingsPanel usage

- Updated `App.tsx`:
  - Added `useBloc(SettingsCubit)` hook
  - Added useEffect to call `settingsCubit.loadSettings()` on mount

**Props Removed from SettingsPanel**:
- `appSettings` (now from cubit)
- `onSettingsChange` (now uses cubit methods)

**Architecture Notes**:
- App.tsx still maintains local state for backward compatibility with other components
- SettingsCubit automatically saves settings via debounced auto-save when state changes
- SettingsPanel reads from and writes to SettingsCubit directly
- This is an incremental migration - full state consolidation can happen in future sessions

**Pre-existing TypeScript Errors** (unrelated to migration):
- `Uint8Array` / `BlobPart` type incompatibility in App.tsx
- `ComfyUIWorkflowConfig` missing properties in SettingsPanel.tsx
- Various implicit `any` types
- `Input` component missing `readOnly` prop support

**Next Steps**:
1. Continue migrating components to read from SettingsCubit:
   - MainLibrary (for filter/sort criteria, thumbnail settings)
   - BottomBar (for thumbnailAspectRatio)
   - FolderTree (for UI visibility)
2. Eventually consolidate App.tsx local state with SettingsCubit
3. Begin NavigationCubit integration
