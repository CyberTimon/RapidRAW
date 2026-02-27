# Strict i18n rollout plan - RapidRAW

## 1) Objective

Deliver a fully enforced, CI-gated internationalization foundation for the React UI and the Tauri backend-to-frontend messaging so every visible string flows through localization keys.

Expected outcomes:

- Every UX string (buttons, tooltips, placeholders, modals, toasts, state text) relies on translation keys.
- Backend emits send only translation key identifiers and optional interpolation params.
- The localization pipeline includes ICU formatting from day one to handle plurals/genders/messages.
- CI rejects any regression related to missing/empty placeholders or backend hardcoded text.

## 2) Technical decisions

- The frontend (React + i18next) is the single source of translated content.
- The backend emits translation keys (`{ key, params }`) instead of final localized text.
- English (`en`) remains the reference locale.
- Priority locales are French (`fr`), Spanish (`es`), then English (`en`) (for fallback).
- ICU (`i18next-icu`) loads by default to cover pluralization/gender needs out of the box.
- The runtime fallback is `en`, but the CI tracks completion for `fr`/`es` primarily.
- Any failure of the localization checks blocks merges.
- Orphan keys (defined in `fr`/`es` but missing from `en`) generate warnings, not failure.

## 3) Scope v1

- Desktop app (React + Tauri channels).
- Core UI: Library, side panels, all modals (panorama, HDR, denoise, settings, metadata, AI tools), toasts, tooltips, and status labels.
- Critical backend flows: denoise progress, panorama progress/warnings/errors, HDR progress/errors, AI model downloads, export/import status.

## 4) Target architecture

- Frontend libs: `i18next`, `react-i18next`, `i18next-http-backend` (optional for lazy loading), `i18next-icu` (required from day one).
- Locale files: `src/i18n/locales/fr/*.json`, `src/i18n/locales/es/*.json`, `src/i18n/locales/en/*.json` following `namespace.section.action` naming.
- Infrastructure: `src/i18n/i18n.ts`, `scripts/i18n/check-translations.mjs`, `scripts/i18n/check-hardcoded-ui.mjs`, `scripts/i18n/check-backend-emits.mjs`.

## 5) Quality rules enforced by CI

- `R1`: No missing key in `fr` or `es` for any `en` key (blocks merge).
- `R2`: No translation value may be empty (`""`, whitespace, `null`) in `fr` or `es`.
- `R3`: Placeholder sets must match exactly between `en` and the target locale.
- `R4`: No hardcoded text in React components beyond an allowlisted set (paths, technical tokens).
- `R5`: Backend emits may not include raw text strings for localized channels.
- `R6`: Locale selection persists in AppSettings (TypeScript + Rust) and survives restart.
- `R7`: Orphan keys (present in `fr`/`es` but absent from `en`) surface as warnings only.
- `R8`: ICU formatting support is enabled by default to cover plural/gender needs.

## 6) Implementation phases and gates

### Phase 0 – Scoping (blocking prerequisite)

- Confirm release locales (fr, es, en) and list future targets.
- Define key naming conventions (`namespace.section.action` or similar).
- Set fallback policy (default `en`, explicit fail on fallback usage in CI).
- Document the allowlist of strings that remain untranslated for technical reasons.

Deliverables:

- Documented locale priority list and naming convention.
- Allowlist of non-translated strings.

Gate: Phase 1 cannot start without locale list approval.

### Phase 1 – Frontend i18n infrastructure

- Initialize `i18next` with `i18next-icu` support and wrap `<App />` in `I18nextProvider`.
- Create namespaces (`common`, `library`, `settings`, `modals`, `backend`, `errors`).
- Persist locale in `AppSettings` (TS + Rust) and expose a UI switch honoring `fr`/`es`/`en` priority.
- On startup, load persisted locale; fall back to `fr` if available, then `es`, then `en`.

Deliverables:

- Language switcher that respects priority locales.
- Locale persistence surviving relaunch.

Gate: manual verification of language switch + restart.

### Phase 2 – UI translation migration

- Move UI text into translation JSON (start with `MainLibrary`, `SettingsPanel`, modals, key components noted in `.github/plan`).
- Replace strings with `t('namespace.key')` calls and ensure placeholders follow ICU syntax.
- Capture tooltips, aria-labels, buttons, input placeholders.
- Maintain allowlist for untouched technical strings.

Deliverables:

- All components in scope using translation keys instead of raw text.

Gate: `scripts/i18n/check-hardcoded-ui.mjs` passes for in-scope files.

### Phase 3 – Backend message localization

- Change backend emits (panorama, denoise, hdr, AI download, exports) to send `{ key, params }` payloads instead of raw strings.
- Document the key naming under `backend.*` namespace.
- Update React listeners to call `t(payload.key, payload.params)` before updating UI state.

Deliverables:

- No backend-localized strings remain.

Gate: `scripts/i18n/check-backend-emits.mjs` reports zero raw emits.

### Phase 4 – CI automation

- Add npm scripts: `i18n:check:translations`, `i18n:check:hardcoded`, `i18n:check:backend`, `i18n:ci` (combines all).
- `i18n:check:translations` enforces missing/empty/placeholder rules for FR/ES/EN and reports warnings for orphans.
- Integrate `i18n:ci` into the main CI pipeline.

Deliverables:

- CI job failing on any rule violation.

Gate: proof-of-failure PR (intentional translation violation) causes CI to fail.

### Phase 5 – Release stabilization

- Run QA per locale (FR, ES, EN) across OSs (Linux/macOS/Windows) and themes (light/dark).
- Verify modal, tooltip, error coverage, pluralization, and UI fit.
- Record any orphan warnings for triage (non-blocking) with tickets.

Deliverables:

- QA checklist signed off for priority locales.

Gate: QA sign-off + CI green.

## 7) Translation completeness methodology

- Source of truth: `en` locale files.
- For each `en` key: verify target locale has a non-empty value of the same type and matching placeholder set (`{{var}}`).
- Track missing/empty/placeholder mismatch/type mismatch counts.
- Completion score = `(total - invalid) / total * 100`.
- Release requirement: `100%` for FR/ES.
- Dev requirement: `>=98%` with documented allowlist exceptions.
- Empty/whitespace/`TODO`/`TBD` values fail.
- Placeholder set order is irrelevant but all tokens must match.
- Orphan keys cause warnings, not failure; they generate tickets for cleanup.

## 8) Testing and validation

### Scripted checks (CI)

- `i18n:check:translations`: guard missing/empty/placeholder issues for FR/ES; warns on orphans.
- `i18n:check:hardcoded`: scans React components for literal text in the scoped directories.
- `i18n:check:backend`: ensures backend emits never carry raw strings.
- `i18n:ci`: aggregates the above and runs in CI.

### Integration tests

- Backend listeners confirm they translate payloads in the active locale.
- Language switching updates live UI texts and modal progress messages.
- Locale persistence test: change locale, restart, observe same locale.

### Manual QA

- Walk through Library, Settings, modal flows in FR/ES/EN.
- Ensure progress messages (denoise/panorama/hdr/import) show localized text.
- Verify tooltip/placeholder coverage and layout for longer translations.
- Lead special focus on pluralized messages (via ICU).
- Document orphan warnings for follow-up cleanup.

## 9) Definition of done

- All visible strings use translation keys or documented allowlist.
- Backend emits supply keys + params only.
- Locale persistence implemented (TS + Rust) with priority `fr`, `es`, fallback `en`.
- CI runs `i18n:ci` (includes ICU-aware checks) and blocks failures.
- Release locale completion is 100%; orphan warnings logged for review.
- Plan documents updated accordingly for future work (implementation awaited).

## 10) Assumptions / clarifications

- Locale priority: `fr` > `es` > `en`; release gating focuses on FR/ES, EN as fallback.
- ICU integration is required immediately to handle pluralization/gender differences.
- Orphan keys are warnings to be tracked elsewhere, not CI blockers.
- This plan documents the decisions needed before any implementation starts (all work deferred).
