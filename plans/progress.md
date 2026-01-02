# App.tsx Refactoring Progress

## Status: Phase 2 Evaluation Complete - Major Refactoring Still Needed

See [app-refactor.md](./app-refactor.md) for full updated plan.

---

## Current Metrics (Re-evaluated)

| Metric | Original | Current | Target | Progress |
|--------|----------|---------|--------|----------|
| App.tsx lines | 3,625 | 3,183 | < 300 | 12% |
| Editor.tsx props | 18 | 18 | 0-2 | 0% |
| MainLibrary.tsx props | 17 | 17 | 0-2 | 0% |
| BottomBar.tsx props | 17 | 17 | 0-2 | 0% |
| Context menu lines | ~600 | ~600 | 0 | 0% |

---

## Phase 1: New Cubits & State Migration (COMPLETE)

### 1.1 ExportImportCubit - DONE
- [x] Create `src/cubits/ExportImportCubit.ts`
- [x] Move `exportState` and `importState` from App.tsx
- [x] Move export/import handlers
- [x] Update `src/cubits/index.ts` exports
- [x] Update components to use cubit (ExportPanel, LibraryExportPanel)

### 1.2 UICubit - DONE
- [x] Create `src/cubits/UICubit.ts`
- [x] Move panel width/height state
- [x] Move `isResizing` state
- [x] Move `isLibraryExportPanelVisible`
- [x] Move `libraryScrollTop`
- [x] Move resize handler logic
- [x] Wire up in App.tsx

### 1.3 ComfyUICubit - DONE
- [x] Create `src/cubits/ComfyUICubit.ts`
- [x] Move `isComfyUiConnected`
- [x] Move `isGeneratingAi`
- [x] Move `aiModelDownloadStatus`
- [x] Move ComfyUI polling logic (auto-init in constructor)
- [x] Update components to use cubit (AIPanel, AIControls, MasksPanel, MaskControls)

### 1.4 ClipboardCubit - DONE
- [x] Create `src/cubits/ClipboardCubit.ts`
- [x] Move `copiedFilePaths`
- [x] Move `isCopied` / `isPasted` feedback
- [x] Move copy/paste adjustment handlers
- [x] Move paste files handler
- [x] Update components to use cubit (BottomBar)

### 1.5 IndexingCubit - DONE
- [x] Create `src/cubits/IndexingCubit.ts`
- [x] Move `isIndexing`
- [x] Move `indexingProgress`
- [x] Wire up in App.tsx

### 1.6 Cubit Method Extensions - PARTIAL
- [x] NavigationCubit: refreshAllFolderTrees, togglePinFolder
- [x] EditorCubit: applyStraighten, applyAutoAdjustments, applyLut, deleteMaskContainer, deleteAiPatch
- [x] MasksCubit: generateAiMask, generateAiForegroundMask, generateAiSkyMask
- [x] LibraryCubit: setupEventListeners, thumbnail handling

---

## Phase 2: Handler Migration to Cubits (NOT STARTED)

### P0 - High Impact (~480 lines to remove)

| Handler | Location | Target Cubit | Lines | Status |
|---------|----------|--------------|-------|--------|
| `handleImageSelect` | App:1204-1249 | EditorCubit.selectImage() | ~50 | TODO |
| `executeDelete` | App:1251-1325 | LibraryCubit.deleteSelectedImages() | ~75 | TODO |
| `handleRate` | App:1462-1506 | LibraryCubit.rateImages() | ~45 | TODO |
| `handleSetColorLabel` | App:1508-1545 | LibraryCubit.setColorLabels() | ~40 | TODO |
| `handleSelectSubfolder` | App:975-1097 | NavigationCubit.selectSubfolder() | ~120 | TODO |
| `handleGenerativeReplace` | App:512-568 | ComfyUICubit.generativeReplace() | ~55 | TODO |
| `handleQuickErase` | App:570-660 | ComfyUICubit.quickErase() | ~90 | TODO |

### P1 - Medium Impact (~220 lines)

| Handler | Location | Target Cubit | Lines | Status |
|---------|----------|--------------|-------|--------|
| `handleFullResolutionLogic` | App:1654-1705 | EditorCubit.requestFullRes() | ~50 | TODO |
| `handleZoomChange` | App:1707-1756 | EditorCubit.handleZoom() | ~50 | TODO |
| `handlePasteAdjustments` | App:1410-1460 | ClipboardCubit (already there) | ~50 | Wire up |
| `handleMultiSelectClick` | App:2036-2078 | LibraryCubit.handleMultiSelect() | ~40 | TODO |
| `handlePasteFiles` | App:1588-1606 | ClipboardCubit (already there) | ~20 | Wire up |

---

## Phase 3: Context Menu Extraction (NOT STARTED)

### P0 - Critical (~600 lines to extract)

| Context Menu | Location | Approach | Lines | Status |
|--------------|----------|----------|-------|--------|
| `handleThumbnailContextMenu` | App:2415-2737 | Extract to utility | ~320 | TODO |
| `handleEditorContextMenu` | App:2337-2413 | Extract to utility | ~75 | TODO |
| `handleFolderTreeContextMenu` | App:2797-2911 | Extract to utility | ~115 | TODO |
| `handleMainLibraryContextMenu` | App:2913-2961 | Extract to utility | ~50 | TODO |

**Recommended approach**: Create `src/utils/contextMenus.ts` with pure functions that take cubits and return menu items.

---

## Phase 4: Component Prop Elimination (NOT STARTED)

### P0 - Critical Components

| Component | Current Props | Target | Status |
|-----------|---------------|--------|--------|
| Editor.tsx | 18 props | 0-2 | TODO |
| MainLibrary.tsx | 17 props | 0-2 | TODO |
| BottomBar.tsx | 17 props | 0-2 | TODO |
| ImageCanvas.tsx | 12 props | 0-4 | TODO |

**Strategy**: Each component should use `useBloc()` / `useBlocActions()` directly instead of receiving callbacks via props.

---

## Phase 5: Inter-Cubit Communication (NOT STARTED)

Current issue: MasksCubit receives EditorCubit as a method parameter instead of using BlaC's `.get()` pattern.

| Cubit | Current | Target | Status |
|-------|---------|--------|--------|
| MasksCubit | Receives EditorCubit as param | Use `EditorCubit.get()` | TODO |
| ClipboardCubit | - | Use `EditorCubit.get()` for adjustments | TODO |

---

## Phase 6: Layout Components (NOT STARTED)

| Component | Status | Notes |
|-----------|--------|-------|
| AppLayout.tsx | TODO | Extract main grid layout |
| LeftPanel.tsx | TODO | FolderTree + resize handle |
| RightPanelContainer.tsx | DONE | Already extracted |

---

## Files Created (All Phases)

- `src/cubits/ExportImportCubit.ts`
- `src/cubits/UICubit.ts`
- `src/cubits/ComfyUICubit.ts`
- `src/cubits/ClipboardCubit.ts`
- `src/cubits/IndexingCubit.ts`
- `src/components/layout/RightPanelContainer.tsx`

---

## Blockers / Notes

1. **TypeScript errors in codebase**: Multiple TS errors exist in App.tsx, SettingsPanel.tsx, MainLibrary.tsx that are unrelated to refactoring
2. **No inter-cubit `.get()` usage**: Currently cubits don't use BlaC's recommended patterns for cross-cubit communication
3. **Context menus are the biggest single target**: ~600 lines can be extracted to a utility file

---

## Next Priority Actions

1. **Extract context menus** to `src/utils/contextMenus.ts` (~600 lines)
2. **Move `handleSelectSubfolder`** to NavigationCubit (~120 lines)
3. **Move `handleImageSelect`** to EditorCubit (~50 lines)
4. **Refactor Editor.tsx** to use cubits directly (eliminate 18 props)
5. **Refactor MainLibrary.tsx** to use cubits directly (eliminate 17 props)

---

## Phase 2: TauriEventsCubit

- [x] TauriService already exists for invoke calls
- [x] ComfyUICubit handles its own event listening (comfyui-status-update, ai-model-download events)
- [x] Create centralized event listener setup in App.tsx useEffect
- [x] Move preview update listeners to EditorCubit (preview-update-final, histogram-update, waveform-update)
- [x] Move thumbnail-generated listener to LibraryCubit
- [x] Move export/import progress listeners to ExportImportCubit
- [x] Move indexing listeners to IndexingCubit
- [x] Move denoise/panorama/culling events to ModalsCubit

---

## Phase 3: Component Extraction

### 3.1 AppLayout
- [ ] Create `src/components/layout/AppLayout.tsx`
- [ ] Move main grid layout from App.tsx
- [ ] Use cubits for panel visibility
- [ ] Export and use in App.tsx

### 3.2 LeftPanel
- [ ] Create `src/components/layout/LeftPanel.tsx`
- [ ] Combine FolderTree with resize handle
- [ ] Use NavigationCubit directly
- [ ] Remove props, use cubits

### 3.3 RightPanelContainer
- [x] Create `src/components/layout/RightPanelContainer.tsx`
- [x] Handle panel switching
- [x] Handle resize
- [x] Use EditorCubit for active panel

### 3.4 Update Editor.tsx
- [ ] Remove unnecessary props
- [ ] Use EditorCubit directly
- [ ] Use MasksCubit directly

### 3.5 Update MainLibrary.tsx
- [ ] Remove unnecessary props
- [ ] Use LibraryCubit directly
- [ ] Use NavigationCubit directly

### 3.6 Update BottomBar.tsx
- [x] Remove isCopied/isPasted props
- [x] Use ClipboardCubit directly

### 3.7 Update Filmstrip.tsx
- [ ] Remove unnecessary props
- [ ] Use cubits directly

### 3.8 Update FolderTree.tsx
- [x] Remove isResizing prop (uses UICubit)
- [x] Already uses NavigationCubit, SettingsCubit

### 3.9 Update Right Panel Components
- [x] ControlsPanel - uses EditorCubit (applyAutoAdjustments, applyLut), no props needed
- [x] MetadataPanel - uses EditorCubit (selectedImage), no props needed
- [ ] CropPanel - use cubits
- [x] PresetsPanel - uses EditorCubit, NavigationCubit, no props needed
- [x] AIPanel - uses ComfyUICubit, EditorCubit, MasksCubit
- [x] AIControls - uses ComfyUICubit, MasksCubit
- [x] ExportPanel - uses ExportImportCubit, EditorCubit, LibraryCubit
- [x] LibraryExportPanel - uses ExportImportCubit, LibraryCubit
- [x] MasksPanel - uses ComfyUICubit, EditorCubit, MasksCubit
- [x] MaskControls - uses ComfyUICubit, MasksCubit

---

## Phase 4: Simplify App.tsx

- [ ] Wire up new cubits (useBloc calls)
- [ ] Remove migrated state (useState calls)
- [ ] Remove migrated handlers
- [ ] Remove migrated effects
- [ ] Keep only: providers, layout, modals
- [ ] Target: < 300 lines
- [ ] Final cleanup and testing

---

## Completion Checklist

- [ ] App.tsx < 300 lines
- [ ] No component receives > 4 props
- [ ] All domain logic in cubits
- [ ] Components use `useBloc`
- [ ] Tauri events centralized
- [ ] No regressions
- [ ] Clean build (no TS errors related to refactor)

---

## Files Created

- `src/cubits/ExportImportCubit.ts` - Export/import state & handlers
- `src/cubits/UICubit.ts` - Panel widths, resize state, UI flags
- `src/cubits/ComfyUICubit.ts` - ComfyUI connection & AI generation state
- `src/cubits/ClipboardCubit.ts` - File & adjustment clipboard
- `src/cubits/IndexingCubit.ts` - Background indexing progress

---

## Notes

### Decision: Keep ComfyUI polling in ComfyUICubit
The ComfyUICubit uses `@blac({ keepAlive: true })` and initializes polling in its constructor.
This centralizes all ComfyUI-related state and behavior.

### Decision: Existing cubits are well-structured
NavigationCubit, EditorCubit, MasksCubit, and LibraryCubit already have most of the methods needed.
The main work is:
1. Wiring up the new cubits in App.tsx
2. Moving some handlers that require cross-cubit coordination
3. Updating child components to use `useBloc` directly

### Components Updated (Both Sessions)
The following components now use cubits directly instead of receiving props:
- `AIPanel.tsx` - uses ComfyUICubit for isConnected, isGenerating, modelDownloadStatus
- `AIControls.tsx` - uses ComfyUICubit for isConnected, isGenerating, modelDownloadStatus + MasksCubit for isGeneratingAiMask
- `MasksPanel.tsx` - uses ComfyUICubit for modelDownloadStatus
- `MaskControls.tsx` - uses ComfyUICubit for modelDownloadStatus + MasksCubit for isGeneratingAiMask
- `BottomBar.tsx` - uses ClipboardCubit for isCopied, isPasted
- `ExportPanel.tsx` - uses ExportImportCubit, EditorCubit, LibraryCubit (no props needed)
- `LibraryExportPanel.tsx` - uses ExportImportCubit, LibraryCubit (only isVisible, onClose props)
- `ControlsPanel.tsx` - uses EditorCubit.applyAutoAdjustments, applyLut (no props needed)
- `PresetsPanel.tsx` - uses EditorCubit, NavigationCubit (no props needed)
- `MetadataPanel.tsx` - uses EditorCubit (no props needed)
- `FolderTree.tsx` - uses UICubit for isResizing (removed isResizing prop)

### EditorCubit Extended
Added new methods to EditorCubit:
- `applyAutoAdjustments()` - async method to calculate and apply auto adjustments
- `applyLut(path: string)` - async method to load and apply LUT
- `applyStraighten(angleCorrection: number)` - apply straightening and reset crop

### App.tsx Cleanup (This Session)
- Removed `handleStraighten` handler - now uses `editorCubit.applyStraighten`
- Removed unused `toggleWbPicker` wrapper (ControlsPanel uses cubit directly)
- Simplified handler delegation to cubits

### Session 2 Updates
- Created `src/components/layout/RightPanelContainer.tsx` - encapsulates all right panel logic
  - Handles panel switching with animation
  - Uses EditorCubit, UICubit, MasksCubit directly
  - Removed ~50 lines from App.tsx
- Moved `createResizeHandler` to UICubit
  - Added `createResizeHandler(panelType, startSize)` method
  - Removed ~20 lines from App.tsx
- Removed unused wrapper setters: `setLeftPanelWidth`, `setRightPanelWidth`, `setBottomPanelHeight`, `setIsResizing`
- Removed unused imports: `motion`, `AnimatePresence`, plus 8 panel component imports
- App.tsx reduced from 3625 to 3528 lines (~100 lines removed)

### Files Created/Modified (Session 2)
- Created: `src/components/layout/RightPanelContainer.tsx`
- Modified: `src/cubits/UICubit.ts` - added createResizeHandler
- Modified: `src/cubits/EditorCubit.ts` - added applyStraighten
- Modified: `src/App.tsx` - removed handlers, imports, and simplified

### Session 3 Updates
- Added new methods to EditorCubit:
  - `deleteMaskContainer(containerId)` - remove mask container from adjustments
  - `deleteAiPatch(patchId)` - remove AI patch from adjustments
  - `toggleAiPatchVisibility(patchId)` - toggle AI patch visibility
  - `updateSubMask(subMaskId, updatedData)` - update submask parameters
- Simplified App.tsx handlers:
  - `handleDeleteMaskContainer` now delegates to EditorCubit
  - `handleDeleteAiPatch` now delegates to EditorCubit
  - `handleToggleAiPatchVisibility` replaced with direct cubit method
  - `updateSubMask` replaced with direct cubit method
  - `handleDisplaySizeChange` replaced with direct cubit method
  - `handleWbPicked` simplified to inline no-op
- Removed unused wrapper setters:
  - `setCollapsibleSectionsState`
  - `setCopiedSectionAdjustments`
  - `setIsStraightenActive`
  - `setDisplaySize`
  - `setBaseRenderSize`
- App.tsx reduced from 3528 to 3496 lines (~32 more lines removed)
- Total reduction: 3625 -> 3496 lines (~130 lines removed, ~3.6%)

### Session 4 Updates
- Moved remaining event listeners from App.tsx to cubits:
  - `ai-model-download-start/finish` → ComfyUICubit (in init())
  - `thumbnail-generated` → LibraryCubit.setupEventListeners()
  - `denoise-progress/complete/error` → ModalsCubit.setupEventListeners()
  - `panorama-progress/complete/error` → ModalsCubit.setupEventListeners()
  - `culling-start/progress/complete/error` → ModalsCubit.setupEventListeners()
- Updated cubit event listener setup useEffect to include LibraryCubit and ModalsCubit
- Removed ~115 lines of event listener code from App.tsx
- Removed unused wrapper setters: `setAiModelDownloadStatus`, `setIsIndexing`, `setIndexingProgress`
- App.tsx reduced from 3412 to 3297 lines
- Total reduction: 3625 -> 3297 lines (~328 lines removed, ~9%)

### Files Modified (Session 4)
- `src/cubits/ComfyUICubit.ts` - Added ai-model-download event listeners
- `src/cubits/LibraryCubit.ts` - Added setupEventListeners(), dispose()
- `src/cubits/ModalsCubit.ts` - Added setupEventListeners(), dispose() for denoise/panorama/culling events
- `src/App.tsx` - Removed event listeners, updated cubit setup useEffect

### Session 4 Updates (continued)
- Removed duplicate `comfyui-status-update` listener from App.tsx (already in ComfyUICubit)
- Removed unused `setIsComfyUiConnected` wrapper
- Added AI mask generation methods to MasksCubit:
  - `generateAiMask(subMaskId, startPoint, endPoint, editorCubit)`
  - `generateAiForegroundMask(subMaskId, editorCubit)`
  - `generateAiSkyMask(subMaskId, editorCubit)`
- Simplified App.tsx handlers to delegate to MasksCubit methods (~74 lines removed)
- App.tsx reduced from 3297 to 3212 lines
- Total reduction: 3625 -> 3212 lines (~413 lines removed, ~11.4%)

### Files Modified (Session 4 continued)
- `src/cubits/MasksCubit.ts` - Added generateAiMask, generateAiForegroundMask, generateAiSkyMask methods
- `src/components/layout/RightPanelContainer.tsx` - Updated prop types for mask generation handlers
- `src/App.tsx` - Removed duplicate listener, simplified AI mask handlers

### Session 5 Updates
- Added methods to NavigationCubit:
  - `refreshAllFolderTrees()` - refreshes both root and pinned folder trees
  - `togglePinFolder(path)` - toggles pin status and refreshes trees, returns new pins array
- Simplified App.tsx:
  - `refreshAllFolderTrees` now delegates to NavigationCubit method
  - `handleTogglePinFolder` simplified to use NavigationCubit.togglePinFolder
  - Removed unused `handleToggleFolder` wrapper
- App.tsx reduced from 3212 to 3182 lines
- Total reduction: 3625 -> 3182 lines (~443 lines removed, ~12.2%)

### Files Modified (Session 5)
- `src/cubits/NavigationCubit.ts` - Added refreshAllFolderTrees, togglePinFolder methods
- `src/App.tsx` - Simplified folder tree handlers

### Next Steps
1. Move AI generative replace/erase handlers (complex, lower priority)
2. Create LeftPanelContainer component to encapsulate FolderTree + resize
3. Continue simplifying remaining handlers
4. Target: reduce App.tsx from 3182 to < 500 lines
