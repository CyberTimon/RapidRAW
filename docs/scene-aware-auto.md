# Scene-aware Auto

Open **Auto settings…** from the selection context menu, or the sliders button beside editor Auto. Tone and per-photo white balance run by default. Curves, Presence, Color, Color grading, and Color mixer are available under **Advanced** and remain off until enabled.

Adjust Strength, Subject brightness, Warmth, and Consistency, then choose **Update batch**. Expand lighting groups to override a classification, tune a group independently, or choose an edited reference from that group. **Undo batch** restores the pre-Auto edits for unchanged photos. **Skip edited photos** applies to new selections; later manual changes are always protected during tuning and Undo. To explicitly replace them, turn off Skip edited photos and start a new Auto operation.

Detection and correction run locally. Auto downloads the existing verified YuNet detector if necessary, without loading identity embeddings or modifying the People database. A missing detector produces a visible global-only warning. Uncertain lighting receives conservative correction. Local recovery uses editable feathered face masks; it is not full-body segmentation.

Batch metadata and write-ahead records are stored in the application data directory under `scene-auto-v1`. Analysis is cached by source modification stamp, decode settings, preserved edits, and engine version. The latest batch can be tuned or undone after reopening the app. Cancellation preserves committed photos and leaves pending photos untouched; a cancelled analysis can be restarted with a new Auto operation. Metadata/XMP errors and skipped conflicts are shown in Processing details.

## Visual release gate

Do not enable the advanced adjustment families by default from automated tests alone. Their thresholds are provisional.

1. Choose original/reference pairs covering daylight, tungsten, night, stage lighting, backlit groups, varied skin tones, silhouettes, and noisy shadows. Keep separate calibration and evaluation subsets.
2. Evaluate on copies. Compare the rendered edits against preferred references and inspect masks at full resolution for halos, noise amplification, and highlight loss.
3. Compare matched scenes with different exposure: darker subjects should receive stronger recovery while colors and subject brightness converge. Different skin tones and intentional light colors must remain distinct.
4. Exercise all four controls and group/reference overrides. Repeating Update with the same settings must not accumulate changes. Verify manual mask edits, crops, virtual copies, cancellation, and Undo after newer manual edits.
5. Time cold/warm runs of 100 and 1,000 real photos on the target machine, recording resolution/format, wall time, peak memory, per-photo failures, and whether the interface remains responsive. Analysis and application are bounded; at most two full decodes are retained for application look-ahead.
6. Approve the held-out results before enabling any advanced family by default. No real-image accuracy or event-size performance claim is established by the source tests.

## Focused checks

- Rust: `cargo +1.98 test --manifest-path src-tauri/Cargo.toml --lib auto_adjust::tests --offline`
- Frontend safety tests: bundle `src/auto/editSafety.test.ts` with the installed esbuild (Node platform), then run Node's test runner on the bundle.
- Build: `node node_modules/vite/bin/vite.js build`
- Lint only touched files; existing files have pre-existing lint diagnostics. Compare against their HEAD versions rather than changing unrelated code.

## Native photo evaluation

The native executable accepts `auto-evaluate 'manifest.json'`. Use scratch copies: this runs the real analysis, grouping, rendering, metadata writes, and thumbnail pipeline on every manifest path. The manifest contains `paths`, an `output` directory, optional `options`, and `samples` identifying the photos whose before/after JPEGs should be exported. Existing edits can be preserved separately as `<source path>.reference.json`; without one, the comparison recomputes the legacy Auto.

Run `python3 'scripts/auto-evaluation-report.py' '<output directory>'` to produce a local comparison page. An optional `preferences.json` beside the output directory maps photo numbers to review notes. The JSON report includes actual processing duration, groups, per-photo failures, detected faces, rendered statistics, and final settings. Measure native process peak memory separately with `/usr/bin/time -l`.

The supplied BTS calibration examples are 47 and 285 (poor old Auto), 132 (poor, no saved sidecar), 251 (acceptable), and 72, 131, 134, 136, 256 (preferred old Auto). Separate held-out photos are required to evaluate changes without fitting only these examples. This shoot primarily covers indoor set lighting; it cannot establish quality for all daylight, outdoor night, sunset, and silhouette cases.

## Local evaluation — September 8, 2026

Test machine: Apple M1 Pro, 8 logical cores, 16 GiB RAM, macOS 26.5.2. Native optimized development build, external-drive CR2 scratch copies, verified YuNet detector. Original photographs and edit sidecars were not used as write targets.

The 100-photo evaluation completed in **319.15 seconds** with **0 failures**, **0 reduced-capability warnings**, and 30 lighting groups. Whole-process time, including comparison exports, was 349.26 seconds; maximum resident memory was 2,506,899,456 bytes (2.33 GiB). This used mixed cached/uncached analysis, not a controlled cold-cache benchmark. A subsequent warm 12-photo calibration batch took 20.81 seconds. These are local measurements, not 1,000-photo or UI-responsiveness guarantees.

Calibration brought the 131/132 subject-brightness gap from approximately 0.268 to 0.026 on normalized rendered measurements. Recovery detection also brought backlit 17/19 within approximately 0.006. Saturated stage example 342 retained colored lighting with far less highlight clipping. These measurements describe face-region luminance, not a universal target for skin color.

Twelve additional evaluation images were reviewed separately: 10, 115, 133, 153, 169, 189, 264, 343, 395, 50, 73, and 90. Photo 153 exposed excessive high-ISO recovery. A subsequent correction caps global recovery for very dark subjects at ISO 6400 or higher and skips high-ISO local masks; 153 and 169 are therefore now regression examples rather than held-out evidence. The 100-photo timing above predates this final recovery cap.

Focused validation: 17 Rust Auto tests, four frontend safety tests, touched-file lint with no new existing-file diagnostics, native build, frontend production build, and diff/format checks. No repository-wide typecheck was run. Full interactive cancellation, Undo, virtual-copy, and mask-edit workflows still require an unlocked app session; automated checks do not establish that UI proof. The reported People command permission error was addressed by enabling the existing People capability alongside the new Auto capability.

Tone and white balance are the default Auto correction. Advanced families remain opt-in. Dark grain, strong backlight, missed faces, and mixed lighting still need visual judgment. The references do not cover the full requested outdoor daylight/night/sunset range, and 1,000 photos have not been benchmarked. Approve the comparison pages and complete interactive acceptance before broadening the defaults.

The final high-ISO regression run processed 153 and 169 in 5.3 seconds with no failures. Rendered comparisons confirmed substantially reduced washout in 153; it remains intentionally dark and visibly noisy. The recovery cap does not constitute denoising.
