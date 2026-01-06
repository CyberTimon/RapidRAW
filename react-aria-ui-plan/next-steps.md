# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 1)
**Current Phase:** Phase 1 - Foundation Setup
**Next Task:** Install dependencies and configure Vite

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

### Phase 1 Tasks (if not complete):
1. Install `react-aria-components` and `@react-aria/optimize-locales-plugin`
2. Update `vite.config.ts` with locale optimization
3. Create `src/primitives/aria-utils.ts` with shared utilities
4. Verify build works

### Phase 2 Tasks (after Phase 1):
Start with **Button** component - it's the simplest and most foundational.

---

## Commands to Run

```bash
# Install dependencies
npm install react-aria-components
npm install @react-aria/optimize-locales-plugin --save-dev

# Optional: better variant management
npm install tailwind-variants

# Check bundle size before migration
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
