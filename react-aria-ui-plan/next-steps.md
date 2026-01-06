# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 8)
**Current Phase:** Phase 3 - Advanced Components
**Next Task:** Evaluate Context Menu / Tooltip / Slider

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

### CollapsibleSection Migration Complete!
- CollapsibleSection migrated to React Aria Disclosure
- Backward compatible: all existing props preserved
- Smooth height animation preserved
- Keyboard activation (Space/Enter) handled by React Aria

### Phase 3 Remaining Tasks
Evaluate and migrate remaining advanced components:

1. **Context Menu** - Check if project uses context menus that need migration
2. **Tooltip** - Check if project needs tooltips
3. **Slider** (Phase 4) - Evaluate if custom slider should stay or use React Aria hooks

For each:
1. Search codebase for existing usage
2. Decide: migrate to React Aria, keep custom, or skip
3. If migrating, follow same pattern as previous components

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
- [ ] Commit changes with descriptive message

### Session 8 Notes
- CollapsibleSection migration completed using React Aria Disclosure
- Complex component with controlled/uncontrolled modes, visibility toggle, reset button
- Kept max-height animation using MutationObserver to watch data-expanded attribute
- Removed internal hover state, using CSS group-hover instead
- No changes needed to consuming components (25 usages)

---

## Quick Reference Links

- [React Aria Components](https://react-aria.adobe.com/)
- [Getting Started Guide](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Examples](https://react-aria.adobe.com/getting-started#tailwind-example)
- [Component List](https://react-aria.adobe.com/react-aria/getting-started.html)
