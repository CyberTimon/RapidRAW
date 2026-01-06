# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 3)
**Current Phase:** Phase 2 - Core Primitives Migration
**Next Task:** Migrate Select/Dropdown component

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

### Button Migration Complete!
- Button component migrated to React Aria Components + tailwind-variants
- Backward compatible: `onClick`, `disabled`, `title` still work
- Pressed state via `data-[pressed]:` Tailwind selectors
- Focus ring via `focusRing` utility

### Phase 2 Next Task: Select/Dropdown
Migrate the Dropdown component to React Aria Select.

1. Read current `src/primitives/Dropdown.tsx` implementation
2. Create new implementation using React Aria `Select`, `ListBox`, `Popover`
3. Preserve existing API: `value`, `options`, `onChange`, `placeholder`, `disabled`
4. Add keyboard navigation (arrows, typeahead)
5. Add `Check` icon for selected item
6. Export alias `Dropdown` for backward compatibility
7. Test with keyboard navigation
8. Update all Dropdown imports if needed

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

### Session 3 Notes
- `tailwindcss-react-aria-components` plugin requires Tailwind v4, project uses v3.4
- Using `data-[pressed]:` selectors instead (works with any Tailwind version)
- Button migration was seamless, no breaking changes to existing usage

---

## Quick Reference Links

- [React Aria Components](https://react-aria.adobe.com/)
- [Getting Started Guide](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Examples](https://react-aria.adobe.com/getting-started#tailwind-example)
- [Component List](https://react-aria.adobe.com/react-aria/getting-started.html)
