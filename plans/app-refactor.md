# App.tsx Refactoring Plan (Updated)

## Current State (as of re-evaluation)

| Metric | Current | Target |
|--------|---------|--------|
| App.tsx lines | 3,183 | < 300 |
| Editor.tsx props | 18 | 0-2 |
| MainLibrary.tsx props | 17 | 0-2 |
| BottomBar.tsx props | 17 | 0-2 |
| Cubits created | 12 | - |
| Progress | ~12% reduced | 90%+ reduced |

## Problem Statement

The current `App.tsx` is ~3,183 lines and violates single responsibility principle:
- Contains ~1,500+ lines of business logic handlers that should live in cubits
- Props-drills extensively (18 props to Editor, 17 to MainLibrary)
- Context menu builders (~600 lines) are embedded in App
- Mixes UI layout with state management and event handling
- Many "wrapper" setters that just delegate to cubits

## Goals

1. **Zero prop drilling** - Components access state via `useBloc`, not props
2. **Domain separation** - Each cubit owns its domain completely
3. **Thin App.tsx** - App becomes only a layout shell (~200-300 lines)
4. **Colocation** - Related logic lives together in cubits
5. **Use BlaC patterns** - Inter-cubit communication via `.get()` / `.connect()`

## Architecture Overview

```
App.tsx (thin layout shell, ~200-300 lines)
├── Providers (ContextMenu, Theme)
├── AppLayout
│   ├── LeftPanel (FolderTree + Resizer)
│   │   └── Uses: NavigationCubit
│   ├── MainContent
│   │   ├── Editor (zero props)
│   │   │   └── Uses: EditorCubit, MasksCubit
│   │   └── MainLibrary (zero props)
│   │       └── Uses: LibraryCubit, NavigationCubit
│   ├── RightPanelContainer (already extracted)
│   │   └── Uses: EditorCubit, UICubit
│   └── BottomBar (zero props)
│       └── Uses: EditorCubit, LibraryCubit, ClipboardCubit
└── Modals (uses ModalsCubit)
```

---

## Phase 1: Handler Migration to Cubits (HIGH PRIORITY)

### 1.1 Move Image Selection Logic to EditorCubit
**Current location**: `handleImageSelect` (lines 1204-1249)
**Target**: `EditorCubit.selectImage(path: string)`
**Lines to remove**: ~50

```typescript
// EditorCubit.ts
selectImage = async (path: string) => {
  this.patch({ isViewLoading: true, error: null });
  // Clear masks, reset zoom, clear preview URLs...
  MasksCubit.get().reset();
  // Load image metadata...
}
```

### 1.2 Move File Deletion to LibraryCubit
**Current location**: `executeDelete` (lines 1251-1325)
**Target**: `LibraryCubit.deleteSelectedImages()`
**Lines to remove**: ~75

### 1.3 Move Rating/Color Label to LibraryCubit
**Current location**: `handleRate`, `handleSetColorLabel` (lines 1462-1545)
**Target**: `LibraryCubit.rateImages()`, `LibraryCubit.setColorLabels()`
**Lines to remove**: ~85

### 1.4 Move Folder Selection to NavigationCubit
**Current location**: `handleSelectSubfolder` (lines 975-1097)
**Target**: `NavigationCubit.selectSubfolder(path: string)`
**Lines to remove**: ~120

### 1.5 Move AI Operations to ComfyUICubit
**Current location**: `handleGenerativeReplace`, `handleQuickErase` (lines 512-660)
**Target**: `ComfyUICubit.generativeReplace()`, `ComfyUICubit.quickErase()`
**Lines to remove**: ~150

### 1.6 Move Full Resolution Logic to EditorCubit
**Current location**: `handleFullResolutionLogic`, `handleZoomChange` (lines 1654-1756)
**Target**: `EditorCubit.handleZoom()`, `EditorCubit.requestFullResolution()`
**Lines to remove**: ~100

### 1.7 Move Paste Adjustments to ClipboardCubit
**Current location**: `handlePasteAdjustments`, `handleCopyAdjustments` (lines 1400-1460)
**Target**: Already in ClipboardCubit, just wire up
**Lines to remove**: ~60

---

## Phase 2: Context Menu Extraction (HIGH PRIORITY)

### 2.1 Create ContextMenuBuilder Utility
**Current location**: App.tsx lines 2337-2961 (~600 lines!)
**Target**: `src/utils/contextMenus.ts` or `src/hooks/useContextMenus.ts`

```typescript
// src/utils/contextMenus.ts
export const buildThumbnailContextMenu = (
  selectedPaths: string[],
  libraryCubit: LibraryCubitType,
  clipboardCubit: ClipboardCubitType
): ContextMenuItem[] => { ... }

export const buildEditorContextMenu = (...): ContextMenuItem[] => { ... }
export const buildFolderTreeContextMenu = (...): ContextMenuItem[] => { ... }
```

Or create a hook:
```typescript
// src/hooks/useContextMenus.ts
export const useContextMenus = () => {
  const libraryCubit = useBlocActions(LibraryCubit);
  const clipboardCubit = useBlocActions(ClipboardCubit);
  
  return {
    getThumbnailMenu: (paths: string[]) => buildThumbnailContextMenu(...),
    getEditorMenu: () => buildEditorContextMenu(...),
  };
}
```

---

## Phase 3: Component Prop Elimination

### 3.1 Refactor Editor.tsx (18 props -> 0)
Components should use cubits directly:

```typescript
// Before (18 props!)
<Editor
  isLoading={...}
  onBackToLibrary={...}
  onContextMenu={...}
  onGenerateAiMask={...}
  // ... 14 more props
/>

// After (0 props)
<Editor />

// Inside Editor.tsx
function Editor() {
  const [editor] = useBloc(EditorCubit);
  const masks = useBlocActions(MasksCubit);
  const { getEditorMenu } = useContextMenus();
  
  // All logic via cubits
}
```

### 3.2 Refactor MainLibrary.tsx (17 props -> 0)
```typescript
// Before
<MainLibrary
  activePath={...}
  aiModelDownloadStatus={...}
  // ... 15 more props
/>

// After
<MainLibrary />

// Inside MainLibrary.tsx
function MainLibrary() {
  const [library] = useBloc(LibraryCubit);
  const [nav] = useBloc(NavigationCubit);
  const [indexing] = useBloc(IndexingCubit);
  // All state from cubits
}
```

### 3.3 Refactor BottomBar.tsx (17 props -> 0)
```typescript
// Before
<BottomBar
  isCopyDisabled={...}
  isPasteDisabled={...}
  // ... 15 more props
/>

// After
<BottomBar />
```

### 3.4 Refactor ImageCanvas.tsx (12 props)
Move mask editing callbacks into MasksCubit methods.

---

## Phase 4: Inter-Cubit Communication (Use BlaC Patterns)

Currently, MasksCubit receives EditorCubit as a parameter. This should use BlaC's `.get()` pattern:

### 4.1 Update MasksCubit to Use `.get()`
```typescript
class MasksCubit extends Cubit<MasksState> {
  generateAiMask = async (subMaskId: string, startPoint: Coord, endPoint: Coord) => {
    // Use .get() instead of parameter passing
    const editor = EditorCubit.get();
    const selectedImage = editor.state.selectedImage;
    // ...
  }
}
```

### 4.2 Add Cross-Cubit Getters
```typescript
class EditorCubit extends Cubit<EditorState> {
  get hasSelection(): boolean {
    return this.state.selectedImage !== null;
  }
  
  get currentImagePath(): string | null {
    return this.state.selectedImage?.path ?? null;
  }
}
```

---

## Phase 5: Extract Layout Components

### 5.1 Create AppLayout Component
```typescript
// src/components/layout/AppLayout.tsx
export function AppLayout() {
  const [settings] = useBloc(SettingsCubit);
  const [ui] = useBloc(UICubit);
  
  return (
    <div className="app-container">
      {settings.appSettings.uiVisibility.folderTree && <LeftPanel />}
      <MainContent />
      <RightPanelContainer />
      <BottomBar />
    </div>
  );
}
```

### 5.2 Create LeftPanel Component
```typescript
// src/components/layout/LeftPanel.tsx
export function LeftPanel() {
  const [ui] = useBloc(UICubit);
  const [nav] = useBloc(NavigationCubit);
  const { getFolderMenu } = useContextMenus();
  
  return (
    <>
      <FolderTree onContextMenu={getFolderMenu} />
      <Resizer ... />
    </>
  );
}
```

---

## Phase 6: Final App.tsx Cleanup

After all phases, App.tsx should only contain:

```typescript
function App() {
  // Minimal setup effects (theme, fullscreen listeners)
  useEffect(() => { /* theme setup */ }, []);
  
  return (
    <ContextMenuProvider>
      <TitleBar />
      <AppLayout />
      <Modals />
    </ContextMenuProvider>
  );
}
```

Target: **~200-300 lines**

---

## Implementation Priority

| Priority | Task | Impact | Effort |
|----------|------|--------|--------|
| P0 | Phase 2: Context Menu Extraction | -600 lines | Medium |
| P0 | Phase 3.1: Editor.tsx refactor | -18 props | High |
| P0 | Phase 3.2: MainLibrary.tsx refactor | -17 props | High |
| P1 | Phase 1.1-1.4: Core handler migration | -300 lines | Medium |
| P1 | Phase 3.3: BottomBar.tsx refactor | -17 props | Medium |
| P2 | Phase 1.5-1.7: AI/zoom handlers | -250 lines | Medium |
| P2 | Phase 4: Inter-cubit communication | Cleaner code | Low |
| P3 | Phase 5: Layout components | Better structure | Low |
| P3 | Phase 6: Final cleanup | Polish | Low |

---

## Success Criteria

- [ ] App.tsx < 300 lines
- [ ] Editor.tsx receives 0-2 props
- [ ] MainLibrary.tsx receives 0-2 props
- [ ] BottomBar.tsx receives 0-2 props
- [ ] No component receives > 4 props
- [ ] All domain logic lives in appropriate cubits
- [ ] Components use `useBloc` to access state
- [ ] Context menu builders extracted to utility/hook
- [ ] Inter-cubit communication uses `.get()` pattern
- [ ] Clean build (no TS errors)
- [ ] No regressions in functionality

---

## Risks & Mitigations

1. **Breaking changes** - Incremental migration, test after each step
2. **Circular dependencies** - Use `.get()` for cross-cubit access, not constructor injection
3. **Performance** - Ensure proper dependency tracking with `useBloc`, use `useBlocActions` for action-only components
4. **Stale closures** - Arrow functions in cubits, avoid capturing values in effects
