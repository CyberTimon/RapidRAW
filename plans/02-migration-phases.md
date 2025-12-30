# Migration Phases

## Overview

This document outlines the gradual migration from the current `useState`-based architecture to BlaC. Each phase can be completed independently and validated before moving to the next.

## Prerequisites

Before starting migration:

1. Install dependencies:
   ```bash
   pnpm add @blac/core @blac/react
   ```

2. Create cubits directory:
   ```
   src/
     cubits/
       index.ts           # Re-exports all cubits
       NavigationCubit.ts
       LibraryCubit.ts
       EditorCubit.ts
       MasksCubit.ts
       AiPatchesCubit.ts
       SettingsCubit.ts
       ModalsCubit.ts
       TauriService.ts
   ```

3. Ensure tsconfig.json has decorator support (already done):
   ```json
   {
     "experimentalDecorators": true,
     "emitDecoratorMetadata": true
   }
   ```

---

## Phase 1: Foundation (Low Risk)

**Goal**: Establish infrastructure and migrate isolated, low-risk state.

**Duration**: 1-2 days

### Step 1.1: Create TauriService

Create `src/cubits/TauriService.ts`:
- Wrap all `invoke()` calls
- No state changes required in App.tsx yet
- Components can start using TauriService alongside existing code

```typescript
// src/cubits/TauriService.ts
import { StatelessCubit, blac } from '@blac/core';
import { invoke } from '@tauri-apps/api/core';

@blac({ keepAlive: true })
export class TauriService extends StatelessCubit {
  getImageList = (path: string) => invoke('get_image_list', { path });
  // ... other methods
}
```

**Validation**:
- [ ] TauriService can be resolved: `TauriService.resolve()`
- [ ] All invoke calls work through service
- [ ] No changes to existing functionality

### Step 1.2: Create ModalsCubit

Create `src/cubits/ModalsCubit.ts`:
- Migrate all modal open/close state
- Update modal components to use `useBloc(ModalsCubit)`
- Remove modal state from App.tsx

**App.tsx state to remove**:
```typescript
// Remove these
const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
const [isRenameFolderModalOpen, setIsRenameFolderModalOpen] = useState(false);
const [confirmModalState, setConfirmModalState] = useState<ConfirmModalState>(...);
// etc.
```

**Component updates**:
```typescript
// Before
function CreateFolderModal({ isOpen, onClose, parentPath }) { ... }

// After
function CreateFolderModal() {
  const [modals, modalsCubit] = useBloc(ModalsCubit);
  const { isOpen, parentPath } = modals.createFolder;
  // ...
}
```

**Validation**:
- [ ] All modals open/close correctly
- [ ] Modal state persists across renders
- [ ] No regressions in modal behavior

### Step 1.3: Create SettingsCubit

Create `src/cubits/SettingsCubit.ts`:
- Migrate `appSettings` and `theme` state
- Implement auto-save with debounce
- Load settings on app start

**App.tsx state to remove**:
```typescript
// Remove these
const [appSettings, setAppSettings] = useState<AppSettings>(defaultAppSettings);
const [theme, setTheme] = useState<ThemeName>('dark');
```

**Validation**:
- [ ] Settings load on app start
- [ ] Settings persist after changes
- [ ] Theme changes apply correctly

---

## Phase 2: Library Domain

**Goal**: Migrate all library/navigation state.

**Duration**: 2-3 days

### Step 2.1: Create NavigationCubit

Create `src/cubits/NavigationCubit.ts`:
- Migrate folder tree state
- Migrate navigation state (rootPath, currentFolderPath, expandedFolders)
- Update FolderTree component

**App.tsx state to remove**:
```typescript
// Remove these
const [rootPath, setRootPath] = useState<string | null>(null);
const [currentFolderPath, setCurrentFolderPath] = useState<string | null>(null);
const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
const [activeView, setActiveView] = useState<'library' | 'editor'>('library');
const [isTreeLoading, setIsTreeLoading] = useState(false);
```

**Component updates**:
```typescript
// Before
function FolderTree({ 
  rootPath, 
  expandedFolders, 
  onFolderSelect, 
  onToggleExpand 
}) { ... }

// After
function FolderTree() {
  const [nav, navCubit] = useBloc(NavigationCubit);
  return (
    <TreeView
      rootPath={nav.rootPath}
      expandedFolders={nav.expandedFolders}
      onSelect={navCubit.selectFolder}
      onToggle={navCubit.toggleFolderExpanded}
    />
  );
}
```

**Validation**:
- [ ] Folder tree loads correctly
- [ ] Folder expansion persists
- [ ] Navigation between folders works

### Step 2.2: Create LibraryCubit

Create `src/cubits/LibraryCubit.ts`:
- Migrate image list state
- Migrate thumbnail state (integrate useThumbnails logic)
- Migrate selection state
- Migrate sort/filter state
- Implement computed `sortedImageList` getter

**App.tsx state to remove**:
```typescript
// Remove these
const [imageList, setImageList] = useState<ImageInfo[]>([]);
const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
const [multiSelectedPaths, setMultiSelectedPaths] = useState<string[]>([]);
const [libraryActivePath, setLibraryActivePath] = useState<string | null>(null);
const [sortCriteria, setSortCriteria] = useState<SortCriteria>(...);
const [filterCriteria, setFilterCriteria] = useState<FilterCriteria>(...);
const [searchCriteria, setSearchCriteria] = useState('');
const [isViewLoading, setIsViewLoading] = useState(false);
```

**Replace 170-line useMemo**:
```typescript
// Before (App.tsx)
const sortedImageList = useMemo(() => {
  // 170 lines of sorting/filtering logic
}, [imageList, sortCriteria, filterCriteria, searchCriteria, ...]);

// After (LibraryCubit)
class LibraryCubit extends Cubit<LibraryState> {
  get sortedImageList(): ImageInfo[] {
    // Same logic, but as a cached getter
  }
}

// Component usage
const [library] = useBloc(LibraryCubit);
const images = library.sortedImageList; // Auto-tracked!
```

**Validation**:
- [ ] Images load when folder selected
- [ ] Thumbnails generate progressively
- [ ] Selection works (single, multi, shift-click)
- [ ] Sorting works correctly
- [ ] Filtering works correctly
- [ ] Search works correctly

### Step 2.3: Delete useThumbnails Hook

After LibraryCubit is working:
- Delete `src/hooks/useThumbnails.tsx`
- Thumbnail logic now lives in `LibraryCubit.loadThumbnails()`

---

## Phase 3: Editor Domain

**Goal**: Migrate all editor state including adjustments, masks, and AI.

**Duration**: 3-4 days

### Step 3.1: Create EditorCubit

Create `src/cubits/EditorCubit.ts`:
- Migrate adjustment state with history (replace useHistoryState)
- Migrate zoom/pan state
- Migrate crop state
- Migrate full screen state
- Implement undo/redo with computed getters

**App.tsx state to remove**:
```typescript
// Remove these
const [selectedImage, setSelectedImage] = useState<string | null>(null);
const { state: adjustments, setState: setAdjustments, undo, redo, ... } = useHistoryState(...);
const [zoom, setZoom] = useState(1);
const [pan, setPan] = useState({ x: 0, y: 0 });
const [crop, setCrop] = useState<CropState | null>(null);
const [isFullScreen, setIsFullScreen] = useState(false);
const [isAdjusting, setIsAdjusting] = useState(false);
const [copiedAdjustments, setCopiedAdjustments] = useState<Partial<Adjustments> | null>(null);
```

**Validation**:
- [ ] Image loads in editor
- [ ] Adjustments apply and save
- [ ] Undo/redo works
- [ ] Zoom/pan works
- [ ] Crop works
- [ ] Full screen toggle works

### Step 3.2: Delete useHistoryState Hook

After EditorCubit is working:
- Delete `src/hooks/useHistoryState.tsx`
- History logic now lives in `EditorCubit`

### Step 3.3: Create MasksCubit

Create `src/cubits/MasksCubit.ts`:
- Migrate mask containers from adjustments
- Migrate active mask state
- Migrate brush settings
- Migrate AI mask generation state

**App.tsx state to remove**:
```typescript
// Remove these
const [activeMaskContainerId, setActiveMaskContainerId] = useState<string | null>(null);
const [activeMaskId, setActiveMaskId] = useState<string | null>(null);
const [brushSettings, setBrushSettings] = useState<BrushSettings>(...);
const [isGeneratingAiMask, setIsGeneratingAiMask] = useState(false);
```

**Note**: Mask containers currently live in `adjustments.maskContainers`. This will move to `MasksCubit` but sync with EditorCubit when saving.

**Validation**:
- [ ] Mask containers CRUD works
- [ ] Brush painting works
- [ ] AI mask generation works
- [ ] Mask adjustments apply correctly

### Step 3.4: Create AiPatchesCubit

Create `src/cubits/AiPatchesCubit.ts`:
- Migrate AI patch containers
- Migrate generation state
- Handle async generation with progress

**App.tsx state to remove**:
```typescript
// Remove these
const [activeAiPatchContainerId, setActiveAiPatchContainerId] = useState<string | null>(null);
const [activeAiSubMaskId, setActiveAiSubMaskId] = useState<string | null>(null);
const [isGeneratingAi, setIsGeneratingAi] = useState(false);
```

**Validation**:
- [ ] AI patch containers CRUD works
- [ ] Generative replace works
- [ ] Progress updates display correctly

---

## Phase 4: Cleanup and Optimization

**Goal**: Remove legacy code, optimize performance, add tests.

**Duration**: 2-3 days

### Step 4.1: Remove Prop Drilling

Update all components to use `useBloc` directly instead of receiving props:

**Before**:
```tsx
// App.tsx
<Editor
  adjustments={adjustments}
  setAdjustments={setAdjustments}
  zoom={zoom}
  setZoom={setZoom}
  // ... 40 more props
/>

// Editor.tsx
function Editor({ adjustments, setAdjustments, zoom, setZoom, ... }: EditorProps) {
  // ...
}
```

**After**:
```tsx
// App.tsx
<Editor />

// Editor.tsx
function Editor() {
  const [editor, editorCubit] = useBloc(EditorCubit);
  const [masks] = useBloc(MasksCubit);
  // ...
}
```

### Step 4.2: Optimize with useBlocActions

Identify components that only call actions (no state reading):

```tsx
// Before
function ResetButton() {
  const [_, editorCubit] = useBloc(EditorCubit);
  return <button onClick={editorCubit.resetAdjustments}>Reset</button>;
}

// After - no subscription, never re-renders from state changes
function ResetButton() {
  const editorCubit = useBlocActions(EditorCubit);
  return <button onClick={editorCubit.resetAdjustments}>Reset</button>;
}
```

### Step 4.3: Update useKeyboardShortcuts

The hook currently receives 40+ parameters. Refactor to use cubits:

**Before**:
```typescript
useKeyboardShortcuts({
  adjustments,
  setAdjustments,
  undo,
  redo,
  zoom,
  setZoom,
  // ... 35 more
});
```

**After**:
```typescript
function useKeyboardShortcuts() {
  const editor = useBlocActions(EditorCubit);
  const library = useBlocActions(LibraryCubit);
  const navigation = useBlocActions(NavigationCubit);
  const modals = useBlocActions(ModalsCubit);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'z' && e.metaKey) {
        e.shiftKey ? editor.redo() : editor.undo();
      }
      // ...
    };
    // ...
  }, []);
}
```

### Step 4.4: Clean Up App.tsx

After all migrations:
- Remove unused imports
- Remove deleted state variables
- App.tsx should be significantly smaller (target: <500 lines)

### Step 4.5: Type Safety Audit

- Ensure all Cubit state interfaces are strictly typed
- Remove any `any` types
- Add JSDoc comments to public methods

---

## Rollback Strategy

Each phase is independent. If issues arise:

1. **Revert single file**: Cubits can be deleted and original useState restored
2. **Feature flag**: Add conditional to switch between old/new implementation
3. **Parallel running**: Both systems can coexist during migration

Example feature flag:
```typescript
const USE_BLAC_LIBRARY = true;

function LibraryView() {
  if (USE_BLAC_LIBRARY) {
    const [library] = useBloc(LibraryCubit);
    return <ImageGrid images={library.sortedImageList} />;
  }
  
  // Legacy implementation
  return <ImageGrid images={sortedImageList} />;
}
```

---

## Testing Checklist

After each phase, verify:

- [ ] App starts without errors
- [ ] Hot reload works
- [ ] State changes trigger re-renders
- [ ] State persists where expected (settings, adjustments)
- [ ] Navigation between views works
- [ ] All modals function correctly
- [ ] Keyboard shortcuts work
- [ ] Export functionality works
- [ ] No memory leaks (check devtools)

---

## Dependencies Between Phases

```
Phase 1 (Foundation)
    │
    ├── TauriService (no deps)
    ├── ModalsCubit (no deps)
    └── SettingsCubit (depends on TauriService)
           │
           v
Phase 2 (Library)
    │
    ├── NavigationCubit (depends on LibraryCubit, TauriService)
    └── LibraryCubit (depends on TauriService)
           │
           v
Phase 3 (Editor)
    │
    ├── EditorCubit (depends on TauriService)
    ├── MasksCubit (depends on EditorCubit, TauriService)
    └── AiPatchesCubit (depends on EditorCubit, TauriService)
           │
           v
Phase 4 (Cleanup)
```
