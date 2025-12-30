# RapidRAW State Management Refactoring Plan

## Overview

This plan outlines the gradual migration of RapidRAW's state management from the current monolithic `App.tsx` with 90+ `useState` declarations to a domain-driven architecture using BlaC (Block Architecture for React).

## Current Problems

1. **Monolithic App.tsx**: 4000+ lines with 90+ `useState` declarations
2. **Extreme prop drilling**: Components receive 30-50+ props
3. **No clear state domains**: All state mixed in one component
4. **Duplicated state logic**: Export settings duplicated across panels
5. **Complex derived state**: 170-line `useMemo` for `sortedImageList`
6. **Poor testability**: State logic tightly coupled to components

## Solution: BlaC Architecture

BlaC provides:
- **Cubit**: Simple state container with direct mutations
- **Vertex**: Event-driven state container (Bloc pattern)
- **Automatic dependency tracking**: Proxy-based re-render optimization
- **Instance management**: Shared/isolated instances with ref counting

## Configuration

### TypeScript Decorators

`tsconfig.json` has been updated with:
```json
{
  "experimentalDecorators": true,
  "emitDecoratorMetadata": true
}
```

### Installation

```bash
pnpm add @blac/core @blac/react
```

## Migration Approach

**Gradual migration** - One domain at a time while keeping existing `useState` code working.

## Documentation Structure

- `00-overview.md` - This file (overview and key decisions)
- `01-state-domains.md` - Domain definitions and Cubit designs
- `02-migration-phases.md` - Phase-by-phase implementation plan

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration approach | Gradual | Lower risk, can validate each domain |
| Decorators | Enabled | Cleaner syntax with `@blac()` |
| State persistence | Existing only | Keep current Tauri storage patterns |
| DevTools | Not now | Can add later if needed |

## Timeline Estimate

| Phase | Scope | Effort |
|-------|-------|--------|
| Phase 1 | Foundation (Settings, Modals, Tauri) | 1-2 days |
| Phase 2 | Library Domain | 2-3 days |
| Phase 3 | Editor Domain | 3-4 days |
| Phase 4 | Cleanup & Testing | 2-3 days |

Total: ~2 weeks for full migration
