# React Aria Migration - Tasks & Checklist

## Phase 1: Foundation Setup
**Status:** Complete
**Estimated Duration:** 1 day

### 1.1 Install Dependencies
- [x] Install `react-aria-components`
- [x] Install `@react-aria/optimize-locales-plugin` (dev)
- [x] Install `tailwind-variants` (optional, for cleaner variant management)
- [x] Verify no version conflicts in package.json

### 1.2 Configure Build
- [x] Update `vite.config.js` with locale optimization plugin
- [x] Configure supported locales (start with `en-US`)
- [x] Test build succeeds with new config
- [ ] Check bundle size baseline before migration

### 1.3 Create Foundation Files
- [x] Create `src/primitives/aria-utils.ts` with shared utilities
- [ ] Create `src/providers/AriaProvider.tsx` (if router integration needed)
- [ ] Add Tailwind plugin config for React Aria states (if needed)
- [ ] Create `src/primitives/index-aria.ts` for new exports

### 1.4 Validation
- [ ] Run dev server, confirm no errors
- [x] Run build, confirm no errors
- [ ] Check bundle size increase is acceptable (<10KB at this stage)

---

## Phase 2: Core Primitives Migration
**Status:** Not Started
**Estimated Duration:** 3-4 days

### 2.1 Button Component
- [ ] Create new `Button.tsx` using React Aria
- [ ] Preserve all existing variants (primary, secondary, surface, ghost, destructive)
- [ ] Preserve all existing sizes (sm, md, lg, icon, icon-sm)
- [ ] Add `isPressed` visual feedback
- [ ] Add `isFocusVisible` focus ring
- [ ] Add `isLoading` state (optional enhancement)
- [ ] Test keyboard activation (Space/Enter)
- [ ] Test disabled state
- [ ] Update all Button imports across codebase
- [ ] Delete old Button implementation

### 2.2 Select/Dropdown Component
- [ ] Create new `Select.tsx` using React Aria
- [ ] Implement `ListBox` with options
- [ ] Implement `Popover` for dropdown menu
- [ ] Add keyboard navigation (arrows, typeahead)
- [ ] Add `Check` icon for selected item
- [ ] Preserve existing API (`value`, `options`, `onChange`)
- [ ] Export alias `Dropdown` for backward compatibility
- [ ] Test with screen reader (VoiceOver)
- [ ] Test keyboard-only navigation
- [ ] Update all Dropdown imports across codebase
- [ ] Delete old Dropdown implementation

### 2.3 Modal/Dialog Component
- [ ] Create new `Modal.tsx` using React Aria
- [ ] Implement `ModalOverlay` with backdrop
- [ ] Implement `Dialog` with focus management
- [ ] Add entry/exit animations
- [ ] Preserve all size variants (sm, md, lg, xl, full)
- [ ] Preserve `isDismissable` behavior
- [ ] Implement `ConfirmModal` variant
- [ ] Implement `InputModal` variant
- [ ] Test focus trap (tab should stay in modal)
- [ ] Test escape key closes modal
- [ ] Test backdrop click closes modal (when enabled)
- [ ] Test screen reader announcements
- [ ] Update all Modal imports across codebase
- [ ] Delete old Modal implementation

### 2.4 Switch Component
- [ ] Create new `Switch.tsx` using React Aria
- [ ] Style track and thumb with Tailwind
- [ ] Add `isSelected` visual state
- [ ] Add label support
- [ ] Test keyboard toggle (Space)
- [ ] Test screen reader announcements
- [ ] Update all Switch imports across codebase
- [ ] Delete old Switch implementation

### 2.5 Input/TextField Component
- [ ] Create new `Input.tsx` using React Aria
- [ ] Implement `TextField` with `Label`
- [ ] Add `FieldError` for validation
- [ ] Add `Text` for description
- [ ] Preserve icon slots (left/right)
- [ ] Add `isInvalid` visual state
- [ ] Test screen reader label association
- [ ] Update all Input imports across codebase
- [ ] Delete old Input implementation

### 2.6 Phase 2 Validation
- [ ] All primitive tests pass (if applicable)
- [ ] Visual regression check (compare screenshots)
- [ ] Accessibility audit on migrated components
- [ ] Bundle size check (should be <30KB increase)

---

## Phase 3: Advanced Components
**Status:** Not Started
**Estimated Duration:** 2 days

### 3.1 CollapsibleSection → Disclosure
- [ ] Create new `CollapsibleSection.tsx` using React Aria Disclosure
- [ ] Add expand/collapse animation
- [ ] Add chevron rotation indicator
- [ ] Preserve `defaultExpanded` prop
- [ ] Test keyboard activation (Space/Enter)
- [ ] Update all CollapsibleSection imports
- [ ] Delete old implementation

### 3.2 Context Menu → Menu
- [ ] Evaluate existing context menu usage in codebase
- [ ] Create new `ContextMenu.tsx` using React Aria Menu
- [ ] Support separator items
- [ ] Support icon items
- [ ] Add keyboard navigation
- [ ] Test right-click trigger (if used)
- [ ] Update all context menu usage
- [ ] Delete old implementation

### 3.3 Tooltip
- [ ] Create new `Tooltip.tsx` using React Aria
- [ ] Configure delay (300ms default)
- [ ] Support placement variants
- [ ] Add entry/exit animations
- [ ] Test keyboard focus shows tooltip
- [ ] Add to components that need tooltips

### 3.4 Phase 3 Validation
- [ ] All advanced component tests pass
- [ ] Accessibility audit on new components
- [ ] Bundle size check

---

## Phase 4: Specialized Components
**Status:** Not Started
**Estimated Duration:** 1 day

### 4.1 Slider (Hybrid Approach)
- [ ] Evaluate if full migration is needed
- [ ] Option A: Keep custom, add ARIA attributes manually
- [ ] Option B: Use `useSlider` hook from react-aria
- [ ] Preserve wheel scroll behavior
- [ ] Preserve inline value editing
- [ ] Preserve reset on double-click
- [ ] Test keyboard control (arrows)
- [ ] Document any API changes

### 4.2 ColorWheel Evaluation
- [ ] Research React Aria ColorWheel from `@react-spectrum/color`
- [ ] Compare features with current `@uiw/react-color-wheel`
- [ ] Decision: migrate or keep current
- [ ] If migrate: implement new ColorWheel
- [ ] If keep: add ARIA attributes to wrapper

### 4.3 Keep As-Is (No Migration)
- [ ] Resizer - Document as intentionally custom
- [ ] ImagePicker - Document as intentionally custom
- [ ] LUTControl - Document as intentionally custom

### 4.4 Phase 4 Validation
- [ ] Slider accessibility tested
- [ ] ColorWheel decision documented
- [ ] All specialized components working

---

## Phase 5: Cleanup & Documentation
**Status:** Not Started
**Estimated Duration:** 1 day

### 5.1 Code Cleanup
- [ ] Remove all deprecated component files
- [ ] Remove unused dependencies
- [ ] Clean up `src/primitives/index.ts` exports
- [ ] Remove any temporary adapter code

### 5.2 Testing
- [ ] Run full test suite
- [ ] Manual testing of all components
- [ ] Cross-browser testing (Chrome, Firefox, Safari)
- [ ] Screen reader testing (VoiceOver, NVDA if available)

### 5.3 Documentation
- [ ] Update component documentation (if exists)
- [ ] Document any API changes
- [ ] Create migration notes for team
- [ ] Update README if needed

### 5.4 Final Validation
- [ ] Final bundle size comparison (target: <50KB increase)
- [ ] Lighthouse accessibility score (target: 100)
- [ ] No console errors/warnings
- [ ] All features working as expected

---

## Progress Summary

| Phase | Status | Completion |
|-------|--------|------------|
| Phase 1: Foundation | Complete | 90% |
| Phase 2: Core Primitives | Not Started | 0% |
| Phase 3: Advanced Components | Not Started | 0% |
| Phase 4: Specialized | Not Started | 0% |
| Phase 5: Cleanup | Not Started | 0% |
| **Overall** | **In Progress** | **15%** |

---

## Session Progress Log

_Updated after each work session_

| Date | Session | Tasks Completed | Notes |
|------|---------|-----------------|-------|
| 2026-01-06 | Session 1 | Planning complete | Created migration plan and task list |
| 2026-01-06 | Session 2 | Phase 1 foundation | Dependencies installed, Vite configured, aria-utils.ts created |
