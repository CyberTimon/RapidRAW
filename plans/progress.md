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
- [ ] Update modal components to use cubit
- [ ] Remove modal state from App.tsx

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
- [ ] Create `src/cubits/NavigationCubit.ts`
- [ ] Migrate folder tree state
- [ ] Update FolderTree component
- [ ] Remove navigation state from App.tsx

### 2.2 LibraryCubit
- [ ] Create `src/cubits/LibraryCubit.ts`
- [ ] Migrate image list state
- [ ] Migrate thumbnail state
- [ ] Implement sortedImageList getter
- [ ] Update MainLibrary component
- [ ] Delete useThumbnails hook
- [ ] Remove library state from App.tsx

---

## Phase 3: Editor Domain

### 3.1 EditorCubit
- [ ] Create `src/cubits/EditorCubit.ts`
- [ ] Migrate adjustments with history
- [ ] Migrate zoom/pan state
- [ ] Update Editor component
- [ ] Delete useHistoryState hook
- [ ] Remove editor state from App.tsx

### 3.2 MasksCubit
- [ ] Create `src/cubits/MasksCubit.ts`
- [ ] Migrate mask containers
- [ ] Update MasksPanel component
- [ ] Remove mask state from App.tsx

### 3.3 AiPatchesCubit
- [ ] Create `src/cubits/AiPatchesCubit.ts`
- [ ] Migrate AI patch containers
- [ ] Update AIPanel component
- [ ] Remove AI state from App.tsx

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

**Started**: Phase 1 - Foundation

**Completed**:
- Created `plans/` directory with documentation
- Updated tsconfig.json for decorator support
- Created `src/cubits/` directory
- Created `TauriService.ts` - StatelessCubit wrapping all Tauri invoke calls
- Created `ModalsCubit.ts` - Cubit managing all modal states
- Created `index.ts` barrel export

**In Progress**:
- Phase 1 complete for cubit creation
- Next: Update components to use cubits

**Notes**:
- Found Invokes enum in `src/components/ui/AppProperties.tsx`
- Modal state interfaces defined in App.tsx (lines 131-182)
- AppSettings interface in AppProperties.tsx (lines 133-156)
- TauriService wraps 70+ invoke commands
- ModalsCubit handles 10 modal types with typed state interfaces
- SettingsCubit has auto-save on state changes via system events

**Files Created**:
- `src/cubits/TauriService.ts` - StatelessCubit for Tauri backend
- `src/cubits/ModalsCubit.ts` - All modal states
- `src/cubits/SettingsCubit.ts` - App settings with persistence
- `src/cubits/index.ts` - Barrel export
