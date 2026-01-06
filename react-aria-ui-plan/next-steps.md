# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 4)
**Current Phase:** Phase 2 - Core Primitives Migration
**Next Task:** Migrate Modal/Dialog component

---

## Context for AI Agent

You are continuing work on migrating RapidRAW's UI primitives from custom implementations to React Aria Components. This is an incremental migration to gain accessibility, internationalization, and robust interaction handling.

### Project Overview
- **App:** RapidRAW - A Tauri-based photo editing desktop application
- **Styling:** Tailwind CSS 3.4 with custom dark theme
- **State:** @blac (BLoC pattern)
- **Build:** Vite
- **React:** 19.2.3

### Key Files to Reference
- `react-aria-ui-plan/overview.md` - High-level migration strategy
- `react-aria-ui-plan/detailed-plan.md` - Implementation details and code examples
- `react-aria-ui-plan/tasks.md` - Checklist with progress tracking
- `react-aria-ui-plan/log.md` - Session history
- `src/primitives/` - Current component implementations

### Current Primitives Being Migrated
1. Button - Custom with variants
2. Dropdown (→ Select) - Custom select menu
3. Modal - Custom dialog with focus trap
4. Switch - Custom toggle
5. Input - Custom text field
6. CollapsibleSection (→ Disclosure)
7. Slider - Complex custom (may stay hybrid)

### What NOT to Migrate
- Resizer - Too specialized
- ImagePicker - Domain-specific
- LUTControl - Domain-specific
- ColorWheel - Evaluate separately

---

## Your Task for This Session

### Dropdown Migration Complete!
- Dropdown component migrated to React Aria Select/ListBox/Popover + tailwind-variants
- Backward compatible: `value`, `options`, `onChange`, `placeholder`, `disabled` all preserved
- Keyboard navigation (arrows, typeahead, escape) handled by React Aria
- Check icon for selected items

### Phase 2 Next Task: Modal/Dialog
Migrate the Modal component to React Aria Dialog.

1. Read current `src/primitives/Modal.tsx` implementation
2. Create new implementation using React Aria `Modal`, `ModalOverlay`, `Dialog`
3. Preserve existing API: `isOpen`, `onClose`, `title`, `size`, `isDismissable`
4. Implement focus trap (React Aria handles this)
5. Preserve size variants (sm, md, lg, xl, full)
6. Add entry/exit animations
7. Migrate ConfirmModal and InputModal variants if they exist
8. Test with keyboard (Escape to close, Tab trapped)
9. Update all Modal imports if needed

---

## Commands to Run

```bash
# Check bundle size (baseline captured: index-BH6DpnUy.js 369.61 kB gzip: 109.62 kB)
npm run build && ls -la dist/assets/*.js
```

---

## Important Notes

1. **Preserve APIs** - Keep existing prop interfaces where possible for easier migration
2. **Tailwind States** - Use React Aria's render props with Tailwind: `pressed:bg-...`, `selected:bg-...`
3. **Test Accessibility** - After each component, test with keyboard and screen reader
4. **Update tasks.md** - Check off completed items after each task
5. **Update log.md** - Add a succinct entry at end of session

---

## Session Checklist

At the end of this session:
- [x] Update `tasks.md` with completed items
- [x] Update `log.md` with session summary
- [x] Update this file (`next-steps.md`) with new context for next session
- [x] Note any blockers or decisions made

### Session 4 Notes
- Dropdown migration completed using React Aria Select pattern
- Used `w-[--trigger-width]` CSS variable for popover width matching
- ChevronDown rotation via `[[data-open]_&]:rotate-180` parent selector
- No changes needed to consuming components (7 files)

---

## Quick Reference Links

- [React Aria Components](https://react-aria.adobe.com/)
- [Getting Started Guide](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Examples](https://react-aria.adobe.com/getting-started#tailwind-example)
- [Component List](https://react-aria.adobe.com/react-aria/getting-started.html)
