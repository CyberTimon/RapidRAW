# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 2)
**Current Phase:** Phase 2 - Core Primitives Migration
**Next Task:** Migrate Button component

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

### Phase 1 Complete!
- Dependencies installed: `react-aria-components@1.14.0`, `@react-aria/optimize-locales-plugin@1.1.5`, `tailwind-variants@3.2.2`
- Vite configured with locale optimization (en-US)
- `src/primitives/aria-utils.ts` created with shared utilities

### Phase 2 Tasks:
Start with **Button** component - it's the simplest and most foundational.

1. Create new `Button.tsx` using React Aria + tailwind-variants
2. Preserve all existing variants (primary, secondary, surface, ghost, destructive)
3. Preserve all existing sizes (sm, md, lg, icon, icon-sm)
4. Add `isPressed` visual feedback
5. Add `isFocusVisible` focus ring
6. Test keyboard activation (Space/Enter)
7. Update all Button imports across codebase
8. Delete old Button implementation

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
- [ ] Update `tasks.md` with completed items
- [ ] Update `log.md` with session summary
- [ ] Update this file (`next-steps.md`) with new context for next session
- [ ] Note any blockers or decisions made

---

## Quick Reference Links

- [React Aria Components](https://react-aria.adobe.com/)
- [Getting Started Guide](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Examples](https://react-aria.adobe.com/getting-started#tailwind-example)
- [Component List](https://react-aria.adobe.com/react-aria/getting-started.html)
