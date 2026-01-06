# Next Steps - AI Agent Context Prompt

**Last Updated:** 2026-01-06 (Session 9)
**Current Phase:** Phase 4 - Specialized Components
**Next Task:** ColorWheel evaluation, then Phase 5 Cleanup

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

### Migration Status

#### Completed (Phases 1-3)
- **Button** - React Aria Button + tailwind-variants
- **Dropdown** - React Aria Select/ListBox/Popover
- **Modal** - React Aria Dialog/ModalOverlay (includes ConfirmModal, InputModal)
- **Switch** - React Aria Switch (now uses Tooltip)
- **Input** - React Aria Input
- **CollapsibleSection** - React Aria Disclosure
- **Tooltip** - React Aria Tooltip (NEW in Session 9)
- **ContextMenu** - React Aria Menu (UI refactor, keeps BLoC state)

#### Kept Custom
- **Slider** - Too many domain-specific features (inline edit, wheel scroll, reset)
- **Resizer** - Too specialized
- **ImagePicker** - Domain-specific
- **LUTControl** - Domain-specific

#### Needs Evaluation
- **ColorWheel** - Currently uses `@uiw/react-color-wheel`, evaluate React Aria alternative

---

## Your Task for This Session

### Phase 4: ColorWheel Evaluation

1. **Research** React Aria ColorWheel from `@react-spectrum/color`
2. **Compare** features with current `@uiw/react-color-wheel`
3. **Decision:** migrate or keep current
4. **If migrate:** implement new ColorWheel
5. **If keep:** document decision

### Phase 5: Cleanup & Documentation

If ColorWheel evaluation is complete:

1. **Code Cleanup**
   - Remove any unused imports
   - Clean up `src/primitives/index.ts` exports
   - Verify no deprecated code remains

2. **Testing**
   - Manual testing of all migrated components
   - Verify keyboard navigation works
   - Check focus management

3. **Final Validation**
   - Run build: `npm run build`
   - Compare bundle size to baseline (109.62 kB gzip)
   - Target: <50KB increase overall

---

## Commands to Run

```bash
# Check bundle size (baseline: index-BH6DpnUy.js 369.61 kB gzip: 109.62 kB)
npm run build && ls -la dist/assets/*.js
```

---

## Important Notes

1. **Preserve APIs** - Keep existing prop interfaces where possible
2. **Tailwind States** - Use React Aria's render props with Tailwind
3. **Test Accessibility** - Keyboard and screen reader testing
4. **Update tasks.md** - Check off completed items
5. **Update log.md** - Add succinct entry at end of session

---

## Session Checklist

At the end of this session:
- [ ] Update `tasks.md` with completed items
- [ ] Update `log.md` with session summary
- [ ] Update this file (`next-steps.md`) with new context
- [ ] Note any blockers or decisions made
- [ ] Commit changes with descriptive message

### Session 9 Notes
- Created Tooltip component with React Aria (fast 200ms delay, animations)
- Updated Switch to use Tooltip instead of native title attribute
- Refactored ContextMenu UI to use React Aria Menu components
- Kept ContextMenuService BLoC for state management
- Decided to keep Slider as custom (too many domain-specific features)
- Phase 3 complete, Phase 4 in progress

---

## Quick Reference Links

- [React Aria Components](https://react-aria.adobe.com/)
- [Getting Started Guide](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Examples](https://react-aria.adobe.com/getting-started#tailwind-example)
- [ColorArea/ColorWheel](https://react-spectrum.adobe.com/react-spectrum/ColorWheel.html)
