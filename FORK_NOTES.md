# Fork notes (SandeepSubba/RapidRAW)

This fork tracks the upstream project [`CyberTimon/RapidRAW`](https://github.com/CyberTimon/RapidRAW)
and adds a small set of custom changes on top. This file documents what we
changed and how to re-apply it cleanly when upstream releases a new version.

## Git remotes

```
origin  -> https://github.com/CyberTimon/RapidRAW.git   (upstream / the original author)
fork    -> https://github.com/SandeepSubba/RapidRAW.git  (this fork)
```

> If `origin` points at the fork on your machine, rename it: `git remote rename
> origin fork` and add upstream as `git remote add origin https://github.com/CyberTimon/RapidRAW.git`.

## Branches

| Branch | Contents | Purpose |
| ------ | -------- | ------- |
| `custom-shortcuts` | backend hardening + refactors **+ the adjustment shortcuts** + this doc | The full fork — **run and rebase this one.** |
| `code-analysis-fixes` | backend hardening + refactors only | Clean subset to open as a PR to upstream. Does **not** include the personal shortcut feature. |

The two share the same 3 fix/refactor commits, so opening the PR from
`code-analysis-fixes` keeps the personal shortcuts out of the contribution.

## Custom changes in this fork

All changes are kept **small, isolated, and additive** specifically so they
survive upstream updates with minimal merge friction.

### 1. Capture One–style adjustment shortcuts  (`feat:` commit)
Increase/decrease keyboard shortcuts for the core tonal & color sliders, shown
in **Settings → Controls → Adjustments** and fully remappable.

| File | Change | Conflict risk |
| ---- | ------ | ------------- |
| `src/utils/keyboardUtils.ts` | adds the `adjustments` section + the `ADJUSTMENT_NUDGES` table, spread into `KEYBIND_DEFINITIONS` | low (additive) |
| `src/hooks/useKeyboardShortcuts.ts` | one generated handler per nudge, after the `actions` map | low (additive) |
| `src/i18n/locales/en.json` | section label + action labels | low (additive) |

To change/extend: edit the single `ADJUSTMENT_NUDGES` array in
`keyboardUtils.ts` (combo, target adjustment key, step, clamp range). The
dispatcher and the keybind UI are both driven from it, so nothing else needs
to change.

### 2. Metadata export-naming tokens + single-image file naming  (`feat:` commit)
Export filename templates gain metadata tokens that mirror the Metadata panel's
editable fields, the File Naming section shows for single-image export (not just
batch), and unknown tokens fall back to the default template.

| File | Change | Conflict risk |
| ---- | ------ | ------------- |
| `src-tauri/src/file_management.rs` | `{title}`/`{author}`/`{copyright}`/`{comments}` substitution + `sanitize_filename_component` + `generate_export_filename` command | low (additive) |
| `src-tauri/src/lib.rs` | registers `generate_export_filename` | low (additive) |
| `src/components/ui/ExportImportProperties.tsx` | new token list entries + `DEFAULT_FILENAME_TEMPLATE` + `sanitizeFilenameTemplate` | low (additive) |
| `src/components/panel/right/ExportPanel.tsx` | show naming UI for single image; resolve single-image name via backend | low |
| `src/hooks/useExportSettings.ts` | sanitize template on preset apply | low |
| `src/components/ui/AppProperties.tsx` | `GenerateExportFilename` invoke enum entry | low (additive) |

To add a metadata token: add the substitution in `generate_filename_from_template`
and the `{token}` string to `FILENAME_VARIABLES`.

### 3. Backend hardening + refactors  (`fix:` / `refactor:` commits)
See the `code-analysis-fixes` branch / the open PR to upstream. These are
candidates to be merged upstream; if they are, drop them from the fork.

## Updating when upstream releases a new version

```bash
# 1. Get the latest upstream code
git fetch origin

# 2. Replay our custom commits on top of the new upstream main
git checkout custom-shortcuts
git rebase origin/main

# 3. If a conflict appears (rare, since our changes are additive), fix the
#    file, then:
git add <file>
git rebase --continue

# 4. Reinstall deps in case package.json changed upstream, then test
npm install
npm start

# 5. Update the fork
git push --force-with-lease fork custom-shortcuts
```

Because the feature lives in one additive commit, the usual outcome of step 2
is a clean replay with no conflicts. If upstream ever restructures
`keyboardUtils.ts` or `useKeyboardShortcuts.ts`, the only fix-up needed is to
re-add the `ADJUSTMENT_NUDGES` block and its dispatch loop — both are clearly
commented in the source.

## Build / run

```bash
npm install        # Node.js LTS + Rust toolchain required
npm run typecheck  # note: upstream has pre-existing strict-tsc errors; the
                   # Vite/esbuild build does not gate on them
npm start          # tauri dev — builds the Rust backend and launches the app
```
