# React Aria UI Migration Overview

## Executive Summary

This document outlines the plan to migrate RapidRAW's custom UI primitives to React Aria Components, gaining accessibility, internationalization, and robust interaction handling while preserving the app's custom dark theme and Tailwind-based styling.

## Decision: React Aria (NOT React Spectrum)

| Option | Verdict | Reason |
|--------|---------|--------|
| **React Spectrum** | No | Enforces Adobe's design system; incompatible with custom theming |
| **React Aria** | Yes | Headless/unstyled; works with Tailwind; full accessibility |

## Current State

### Existing Primitives (`src/primitives/`)

| Component | Lines | Accessibility | Notes |
|-----------|-------|---------------|-------|
| Button | 46 | Basic | Missing press states, loading |
| Slider | 214 | Partial | Custom wheel scroll, inline edit, reset |
| Dropdown | 106 | Partial | Missing keyboard nav, typeahead |
| Modal | 300 | Partial | Has focus trap, missing full management |
| Switch | ~40 | Basic | Standard toggle |
| Input | ~50 | Basic | Standard text input |
| CollapsibleSection | ~60 | Minimal | Missing ARIA disclosure pattern |
| ColorWheel | ~30 | N/A | Wrapper around @uiw/react-color-wheel |
| Resizer | ~80 | Minimal | Specialized drag handle |
| ImagePicker | ~100 | Minimal | File picker |
| LUTControl | ~80 | Minimal | LUT file picker |

### Tech Stack Compatibility

| Aspect | Current | React Aria Compatibility |
|--------|---------|-------------------------|
| Styling | Tailwind CSS 3.4 | Native support via render props |
| Build | Vite | Plugin available (`unplugin-parcel-macros`) |
| React | 19.2.3 | Fully supported |
| State | @blac (BLoC) | No conflicts |
| Platform | Tauri desktop | Works in any React env |

## Goals

1. **Accessibility First** - WCAG 2.1 AA compliance
2. **Preserve Design** - Keep existing dark theme and Tailwind styling
3. **Incremental Migration** - Component by component, no big bang
4. **Minimize Disruption** - Maintain same public APIs where possible
5. **Reduce Maintenance** - Leverage battle-tested interaction code

## Non-Goals

- Changing the visual design system
- Migrating specialized components (Resizer, ImagePicker, LUTControl)
- Adding new features during migration (separate effort)

## Success Criteria

- [ ] All migrated components pass accessibility audit
- [ ] Keyboard navigation works for all interactive components
- [ ] Screen reader announces component states correctly
- [ ] No visual regressions from current design
- [ ] Bundle size increase < 50KB gzipped
- [ ] All existing tests pass (if applicable)

## Timeline Estimate

| Phase | Duration | Components |
|-------|----------|------------|
| 1. Foundation | 1 day | Setup, provider, utilities |
| 2. Core Primitives | 3-4 days | Button, Select, Modal, Switch, Input |
| 3. Advanced | 2 days | Disclosure, Menu, Tooltip |
| 4. Specialized | 1 day | Slider (hybrid), ColorWheel evaluation |
| 5. Cleanup | 1 day | Remove old code, documentation |

**Total: ~8-10 days** (can be spread across multiple sessions)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Slider complexity | High | Keep custom, use React Aria hooks only |
| Bundle size | Medium | Use locale optimization plugin |
| API changes | Medium | Create adapter components |
| Learning curve | Low | Follow official Tailwind examples |

## References

- [React Aria Components Docs](https://react-aria.adobe.com/)
- [React Aria Getting Started](https://react-aria.adobe.com/getting-started)
- [Tailwind Starter Kit](https://react-aria.adobe.com/getting-started#tailwind-example)
